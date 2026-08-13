// A straightforward but competent AI: expand, defend, don't go bankrupt.
"use strict";

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
  const resolve = () =>
    state.provinces.find(p => p.owner === player && p.capitalKey === capital) ||
    state.provinces.find(p => p.owner === player && p.tiles.includes(capital));

  // 1. Attack with existing units, best targets first.
  for (let guard = 0; guard < 60; guard++) {
    const province = resolve();
    if (!province) return;
    if (!attackOnce(state, player, province)) break;
    capital = resolve() ? capital : null;
    if (!capital) return;
  }

  // 2. Merge idle units when that unlocks a capture nothing else can make.
  let province = resolve();
  if (province) tryMerge(state, player, province);

  // 3. Spend money: farms for economy, units to expand, towers to defend.
  province = resolve();
  if (province) spendMoney(state, player, province);

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

function targetValue(state, key, player) {
  const t = state.tiles.get(key);
  let value = t.owner === -1 ? 1 : 3;
  if (t.structure === "capital") value += 12;
  else if (t.structure === "tower" || t.structure === "strongtower") value += 6;
  else if (t.structure === "farm") value += 6;
  if (t.unit) value += t.unit.level * 2;
  // Bonus for tiles that cut into enemy territory.
  for (const nk of neighborKeys(key)) {
    const nt = state.tiles.get(nk);
    if (nt && nt.owner !== player && nt.owner !== -1) value += 0.5;
  }
  return value;
}

function attackOnce(state, player, province) {
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
    const value = targetValue(state, targetKey, player);
    if (!best || value > best.value) best = { from: capable[0], to: targetKey, value };
  }
  if (!best) return false;
  return moveUnit(state, best.from, best.to).ok;
}

function tryMerge(state, player, province) {
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
  if (moveUnit(state, a, b).ok) attackOnce(state, player, province);
}

function spendMoney(state, player, province) {
  // Farm first: compounding income wins long games.
  const fCost = farmCost(state, province);
  if (province.money >= fCost + UNIT_COST && Math.random() < 0.7) {
    const spot = province.tiles.find(k => canPlaceFarm(state, province, k));
    if (spot) buyFarm(state, province.capitalKey, spot);
  }

  // Buy units that immediately capture something.
  for (let guard = 0; guard < 20; guard++) {
    const p = state.provinces.find(x => x.id === province.id) ||
      state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
    if (!p) return;
    province = p;
    if (province.money < UNIT_COST) break;
    const net = provinceIncome(state, province) - provinceUpkeep(state, province);
    if (net - UNIT_UPKEEP[1] + 1 < 0 && province.money < 30) break;

    const targets = borderTargets(state, province)
      .filter(k => canCapture(state, 1, k, player))
      .sort((a, b) => targetValue(state, b, player) - targetValue(state, a, player));
    if (targets.length === 0) break;
    if (!buyUnit(state, province.capitalKey, targets[0]).ok) break;
  }

  // Occasionally add a tower on a threatened border tile.
  const p = state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
  if (!p) return;
  province = p;
  if (province.money >= TOWER_COST + UNIT_COST && Math.random() < 0.35) {
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
