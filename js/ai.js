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
  value += ((TERRAIN_INCOME[t.terrain] ?? 1) - 1) * 1.5; // meadows tempt, hills bore
  if (t.structure === "capital") value += 12 * style.structureMult;
  else if (t.structure === "tower") value += 6 * style.structureMult;
  else if (t.structure === "farm") value += (4 + 2 * (t.structureLevel || 1)) * style.structureMult;
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

  // Each unit can only strike targets within its movement range.
  let best = null;
  for (const uk of units) {
    const unit = state.tiles.get(uk).unit;
    const range = moveRange(unit);
    const dist = reachableWithin(state, uk, range);
    const eff = effectiveUnitLevel(state, uk);
    const seen = new Set();
    for (const [k, d] of dist) {
      if (d > range - 1) continue;
      for (const nk of neighborKeys(k)) {
        if (seen.has(nk)) continue;
        seen.add(nk);
        const t = state.tiles.get(nk);
        if (!t || t.owner === player) continue;
        if (!canCapture(state, eff, nk, player)) continue;
        const value = targetValue(state, nk, player, diff, style);
        // Prefer higher value; tiebreak toward the weaker unit.
        if (!best || value > best.value ||
            (value === best.value && unit.level < state.tiles.get(best.from).unit.level)) {
          best = { from: uk, to: nk, value };
        }
      }
    }
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
  const maxLevel = Math.max(...idle.map(k => effectiveUnitLevel(state, k)));
  if (maxLevel > maxDefense) return; // a single unit could already do the job

  // Find a pair the mover can actually walk to.
  idle.sort((a, b) => state.tiles.get(a).unit.level - state.tiles.get(b).unit.level);
  for (const a of idle) {
    const ua = state.tiles.get(a).unit;
    const dist = reachableWithin(state, a, moveRange(ua));
    for (const b of idle) {
      if (b === a || !dist.has(b)) continue;
      const combined = ua.level + state.tiles.get(b).unit.level;
      if (combined > MAX_UNIT_LEVEL || combined <= maxDefense) continue;
      // Only merge if the province can afford the heavier upkeep.
      const extraUpkeep = UNIT_UPKEEP[combined] -
        UNIT_UPKEEP[ua.level] - UNIT_UPKEEP[state.tiles.get(b).unit.level];
      if (provinceIncome(state, province) - provinceUpkeep(state, province) - extraUpkeep < 0) continue;
      if (moveUnit(state, a, b).ok) attackOnce(state, player, province, diff, style);
      return;
    }
  }
}

function spendMoney(state, player, province, diff, style) {
  // Farm first: compounding income wins long games. Build new farms while
  // there is room; once there isn't, upgrade existing ones.
  if (Math.random() < style.farmChance) {
    const spots = province.tiles.filter(k => canPlaceFarm(state, province, k));
    // Meadow farms yield +6 per level instead of +4 — take those spots first.
    const spot = spots.find(k => state.tiles.get(k).terrain === "meadow") || spots[0];
    if (spot && province.money >= farmCost(state, province) + UNIT_COST + diff.reserve) {
      buyFarm(state, province.capitalKey, spot);
    } else if (!spot) {
      const ups = province.tiles.filter(k => {
        const t = state.tiles.get(k);
        return t.structure === "farm" && (t.structureLevel || 1) < MAX_FARM_LEVEL;
      });
      const up = ups.find(k => state.tiles.get(k).terrain === "meadow") || ups[0];
      if (up) {
        const cost = FARM_UPGRADE_COSTS[(state.tiles.get(up).structureLevel || 1) + 1];
        if (province.money >= cost + UNIT_COST + diff.reserve) {
          buyFarm(state, province.capitalKey, up);
        }
      }
    }
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
  if (Math.random() < style.towerChance) {
    const nearEnemy = k => neighborKeys(k).some(nk => {
      const nt = state.tiles.get(nk);
      return nt && nt.owner !== player && nt.owner !== -1;
    });
    const spots = province.tiles.filter(k => {
      const t = state.tiles.get(k);
      if (t.unit || t.structure || t.tree || t.grave) return false;
      if (tileDefense(state, k) >= 2) return false;
      return nearEnemy(k);
    });
    // Hills make towers defend one level higher — grab those spots first.
    const spot = spots.find(k => state.tiles.get(k).terrain === "hills") || spots[0];
    if (spot && province.money >= TOWER_COST + UNIT_COST + diff.reserve) {
      buyTower(state, province.capitalKey, spot);
    } else if (!spot && province.money >= TOWER_UPGRADE_COST + UNIT_COST + diff.reserve) {
      // No room for a new tower: upgrade a frontline one to a fort instead
      // (def 3 and the +1 aura reaches two tiles).
      const up = province.tiles.find(k => {
        const t = state.tiles.get(k);
        return t.structure === "tower" && (t.structureLevel || 1) < 2 && nearEnemy(k);
      });
      if (up) buyTower(state, province.capitalKey, up);
    }
  }
}

function repositionIdleUnits(state, player, province) {
  const idle = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  if (idle.length === 0) return;

  // Distance-to-border map so interior units can march outward over turns.
  const isBorder = k => neighborKeys(k).some(nk => {
    const nt = state.tiles.get(nk);
    return nt && nt.owner !== player;
  });
  const borderDist = new Map();
  const queue = [];
  for (const k of province.tiles) {
    if (isBorder(k)) { borderDist.set(k, 0); queue.push(k); }
  }
  while (queue.length) {
    const k = queue.shift();
    const d = borderDist.get(k);
    for (const nk of neighborKeys(k)) {
      if (borderDist.has(nk) || !province.tiles.includes(nk)) continue;
      borderDist.set(nk, d + 1);
      queue.push(nk);
    }
  }

  for (const uk of idle) {
    const here = borderDist.get(uk) ?? Infinity;
    if (here === 0) continue; // already on the border
    const unit = state.tiles.get(uk).unit;
    const dist = reachableWithin(state, uk, moveRange(unit));
    let spot = null, bestD = here;
    for (const k of dist.keys()) {
      const t = state.tiles.get(k);
      if (t.unit || t.structure || t.tree || t.grave) continue;
      const d = borderDist.get(k) ?? Infinity;
      if (d < bestD) { bestD = d; spot = k; }
    }
    if (spot) moveUnit(state, uk, spot);
  }
}
