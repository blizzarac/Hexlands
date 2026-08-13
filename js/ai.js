// AI opponents: expand, defend, don't go bankrupt.
//
// Behaviour is shaped by two independent knobs, neither of which cheats on
// resources:
//  - difficulty (per game) controls competence: how often units act, how
//    accurately targets are ranked, whether units merge, and buying restraint.
//  - style (per AI player) controls priorities: fighting vs. farming vs.
//    turtling.
"use strict";

const AI_DIFFICULTIES = {
  easy: {
    label: "Easy",
    actChance: 0.55,  // chance each attack round happens at all
    noise: 6,         // random error added to target scoring
    merge: false,     // never combines units into higher levels
    buyCap: 1,        // max units bought per province per turn
    reserve: 15,      // coins hoarded instead of spent
  },
  normal: {
    label: "Normal",
    actChance: 0.85,
    noise: 2,
    merge: true,
    buyCap: 3,
    reserve: 5,
  },
  hard: {
    label: "Hard",
    actChance: 1.0,
    noise: 0,
    merge: true,
    buyCap: 99,
    reserve: 0,
  },
};

const AI_STYLES = {
  balanced: {
    label: "Balanced", icon: "⚖️",
    enemyValue: 3, neutralValue: 1, structureMult: 1,
    farmChance: 0.7, towerChance: 0.35, unitZeal: 1.0,
  },
  warlord: {
    label: "Warlord", icon: "⚔️",
    enemyValue: 6, neutralValue: 0.8, structureMult: 1.5,
    farmChance: 0.25, towerChance: 0.1, unitZeal: 1.0,
  },
  builder: {
    label: "Builder", icon: "🌾",
    enemyValue: 1.5, neutralValue: 2.2, structureMult: 1,
    farmChance: 1.0, towerChance: 0.25, unitZeal: 0.7,
  },
  turtle: {
    label: "Turtle", icon: "🛡️",
    enemyValue: 1.5, neutralValue: 1, structureMult: 1,
    farmChance: 0.6, towerChance: 0.9, unitZeal: 0.55,
  },
};

function aiParams(state, player) {
  return {
    diff: AI_DIFFICULTIES[state.difficulty] || AI_DIFFICULTIES.normal,
    style: AI_STYLES[state.players[player].aiStyle] || AI_STYLES.balanced,
  };
}

function runAITurn(state, player) {
  // Provinces are recreated on every recompute, so track them by capital.
  const capitals = provincesOf(state, player).map(p => p.capitalKey);
  for (const capital of capitals) {
    // The capital may have moved/vanished if an earlier province's actions
    // merged provinces; re-resolve and skip if gone.
    const province = state.provinces.find(
      p => p.owner === player && (p.capitalKey === capital || p.tiles.includes(capital)));
    if (province) runProvinceTurn(state, player, province.capitalKey);
    if (state.gameOver) return;
  }
}

function runProvinceTurn(state, player, capital) {
  const { diff, style } = aiParams(state, player);
  const resolve = () =>
    state.provinces.find(p => p.owner === player && p.capitalKey === capital) ||
    state.provinces.find(p => p.owner === player && p.tiles.includes(capital));

  // 1. Attack with existing units, best targets first. Lower difficulties
  //    have a chance to stop early, leaving units unused.
  for (let guard = 0; guard < 60; guard++) {
    if (Math.random() > diff.actChance) break;
    const province = resolve();
    if (!province) return;
    if (!attackOnce(state, player, province, diff, style)) break;
    if (!resolve()) return;
  }

  // 2. Merge idle units when that unlocks a capture nothing else can make.
  let province = resolve();
  if (province && diff.merge) tryMerge(state, player, province, diff, style);

  // 3. Spend money: farms for economy, units to expand, towers to defend.
  province = resolve();
  if (province) spendMoney(state, player, province, diff, style);

  // 4. Send leftover idle units toward the border so they defend something.
  province = resolve();
  if (province) repositionIdleUnits(state, player, province);
}

function borderTargets(state, province) {
  const targets = new Set();
  for (const k of province.tiles) {
    for (const nk of neighborKeys(k)) {
      const t = state.tiles.get(nk);
      if (t && t.owner !== province.owner) targets.add(nk);
    }
  }
  return [...targets];
}

function targetValue(state, key, player, diff, style) {
  const t = state.tiles.get(key);
  let value = t.owner === -1 ? style.neutralValue : style.enemyValue;
  if (t.structure === "capital") value += 12 * style.structureMult;
  else if (t.structure === "tower" || t.structure === "strongtower") value += 6 * style.structureMult;
  else if (t.structure === "farm") value += 6 * style.structureMult;
  if (t.unit) value += t.unit.level * 2;
  // Bonus for tiles that cut into enemy territory.
  for (const nk of neighborKeys(key)) {
    const nt = state.tiles.get(nk);
    if (nt && nt.owner !== player && nt.owner !== -1) value += 0.5;
  }
  // Imperfect play: lower difficulties mis-rank their options.
  value += (Math.random() * 2 - 1) * diff.noise;
  return value;
}

function attackOnce(state, player, province, diff, style) {
  const units = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  if (units.length === 0) return false;

  const targets = borderTargets(state, province);
  let best = null;
  for (const targetKey of targets) {
    // Prefer the weakest unit that can take the tile.
    const capable = units
      .filter(uk => canCapture(state, state.tiles.get(uk).unit.level, targetKey, player))
      .sort((a, b) => state.tiles.get(a).unit.level - state.tiles.get(b).unit.level);
    if (capable.length === 0) continue;
    const value = targetValue(state, targetKey, player, diff, style);
    if (!best || value > best.value) best = { from: capable[0], to: targetKey, value };
  }
  if (!best) return false;
  return moveUnit(state, best.from, best.to).ok;
}

function tryMerge(state, player, province, diff, style) {
  const idle = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  if (idle.length < 2) return;

  const targets = borderTargets(state, province);
  const maxDefense = Math.max(0, ...targets.map(k => tileDefense(state, k)));
  const maxLevel = Math.max(...idle.map(k => state.tiles.get(k).unit.level));
  if (maxLevel > maxDefense) return; // a single unit could already do the job

  idle.sort((a, b) => state.tiles.get(a).unit.level - state.tiles.get(b).unit.level);
  const a = idle[0], b = idle[1];
  const combined = state.tiles.get(a).unit.level + state.tiles.get(b).unit.level;
  if (combined > MAX_UNIT_LEVEL || combined <= maxDefense) return;
  // Only merge if the province can afford the heavier upkeep.
  const extraUpkeep = UNIT_UPKEEP[combined] -
    UNIT_UPKEEP[state.tiles.get(a).unit.level] - UNIT_UPKEEP[state.tiles.get(b).unit.level];
  if (provinceIncome(state, province) - provinceUpkeep(state, province) - extraUpkeep < 0) return;
  if (moveUnit(state, a, b).ok) attackOnce(state, player, province, diff, style);
}

function spendMoney(state, player, province, diff, style) {
  // Farm first: compounding income wins long games.
  const fCost = farmCost(state, province);
  if (province.money >= fCost + UNIT_COST + diff.reserve && Math.random() < style.farmChance) {
    const spot = province.tiles.find(k => canPlaceFarm(state, province, k));
    if (spot) buyFarm(state, province.capitalKey, spot);
  }

  // Buy units that immediately capture something.
  for (let bought = 0; bought < diff.buyCap; bought++) {
    if (bought > 0 && Math.random() > style.unitZeal) break;
    const p = state.provinces.find(x => x.id === province.id) ||
      state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
    if (!p) return;
    province = p;
    if (province.money < UNIT_COST + diff.reserve) break;
    const net = provinceIncome(state, province) - provinceUpkeep(state, province);
    if (net - UNIT_UPKEEP[1] + 1 < 0 && province.money < 30) break;

    const targets = borderTargets(state, province)
      .filter(k => canCapture(state, 1, k, player))
      .sort((a, b) =>
        targetValue(state, b, player, diff, style) - targetValue(state, a, player, diff, style));
    if (targets.length === 0) break;
    if (!buyUnit(state, province.capitalKey, targets[0]).ok) break;
  }

  // Add a tower on a threatened border tile.
  const p = state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
  if (!p) return;
  province = p;
  if (province.money >= TOWER_COST + UNIT_COST + diff.reserve &&
      Math.random() < style.towerChance) {
    const spot = province.tiles.find(k => {
      const t = state.tiles.get(k);
      if (t.unit || t.structure || t.tree || t.grave) return false;
      if (tileDefense(state, k) >= 2) return false;
      return neighborKeys(k).some(nk => {
        const nt = state.tiles.get(nk);
        return nt && nt.owner !== player && nt.owner !== -1;
      });
    });
    if (spot) buyTower(state, province.capitalKey, spot, false);
  }
}

function repositionIdleUnits(state, player, province) {
  const idle = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  for (const uk of idle) {
    const isBorder = k => neighborKeys(k).some(nk => {
      const nt = state.tiles.get(nk);
      return nt && nt.owner !== player;
    });
    if (isBorder(uk)) continue; // already useful where it is
    const spot = province.tiles.find(k => {
      const t = state.tiles.get(k);
      return !t.unit && !t.structure && !t.tree && !t.grave && isBorder(k);
    });
    if (spot) moveUnit(state, uk, spot);
  }
}
