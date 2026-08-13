// Core game rules: provinces, economy, combat, building.
//
// Simplifications vs. Antiyoy (documented in README):
//  - Units may reposition anywhere inside their own province in one move.
//  - Only level-1 units can be bought; higher tiers are made by merging.
"use strict";

const UNIT_COST = 10;
const UNIT_UPKEEP = [0, 2, 6, 18, 36]; // indexed by level 1..4
const TOWER_COST = 15;
const TOWER_UPGRADE_COST = 20;      // tower (def 2) -> fort (def 3, aura range 2)
const MAX_FARM_LEVEL = 3;
const FARM_BASE_COST = 12;
const FARM_COST_STEP = 2;
const FARM_INCOME = { plains: 4, meadow: 6 }; // per farm level, by terrain
const FARM_UPGRADE_COSTS = [0, 0, 20, 30]; // indexed by target level
const TREE_CHOP_REWARD = 3;
const TERRAIN_INCOME = { plains: 1, meadow: 2, hills: 0 };
const HILL_TOWER_BONUS = 1; // towers/forts built on hills defend one level higher
const TREE_SPREAD_CHANCE = 0.10; // per tree per round, one random neighbour
const START_MONEY = 10;
const MAX_UNIT_LEVEL = 4;

const PLAYER_COLORS = ["#4f8fd9", "#d9564f", "#9a6bd0", "#d9a13f", "#4fb8b8", "#d06bb0"];
const PLAYER_NAMES = ["You", "Red", "Purple", "Amber", "Teal", "Pink"];

function newGame(opts) {
  const playerCount = 1 + opts.aiCount;
  const state = {
    tiles: generateMap(opts.tileCount, playerCount),
    players: [],
    provinces: [],
    nextProvinceId: 1,
    currentPlayer: 0,
    round: 1,
    difficulty: opts.difficulty || "normal",
    gameOver: null, // 'victory' | 'defeat'
  };
  // Deal each AI a playstyle: shuffle so every game feels different, but
  // cycle through the deck so styles stay varied when there are many AIs.
  const styleDeck = Object.keys(AI_STYLES);
  for (let i = styleDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [styleDeck[i], styleDeck[j]] = [styleDeck[j], styleDeck[i]];
  }
  for (let i = 0; i < playerCount; i++) {
    state.players.push({
      id: i,
      name: PLAYER_NAMES[i],
      color: PLAYER_COLORS[i],
      isAI: i !== 0,
      aiStyle: i === 0 ? null : styleDeck[(i - 1) % styleDeck.length],
    });
  }
  recomputeProvinces(state);
  for (const p of state.provinces) p.money = START_MONEY;
  return state;
}

// ---------------------------------------------------------------------------
// Provinces

// A province is a connected group of >= 2 same-owner tiles. Called after every
// ownership change; carries treasuries across via capital tiles.
function recomputeProvinces(state) {
  const oldByCapital = new Map();
  for (const p of state.provinces) oldByCapital.set(p.capitalKey, p);

  const seen = new Set();
  const comps = [];
  for (const [k, t] of state.tiles) {
    if (t.owner < 0 || seen.has(k)) continue;
    const comp = [k];
    seen.add(k);
    const stack = [k];
    while (stack.length) {
      const ck = stack.pop();
      for (const nk of neighborKeys(ck)) {
        const nt = state.tiles.get(nk);
        if (nt && nt.owner === t.owner && !seen.has(nk)) {
          seen.add(nk);
          comp.push(nk);
          stack.push(nk);
        }
      }
    }
    comps.push(comp);
  }

  const provinces = [];
  for (const comp of comps) {
    const owner = state.tiles.get(comp[0]).owner;

    if (comp.length < 2) {
      // A lone tile cannot sustain a province: capital vanishes, units starve.
      const t = state.tiles.get(comp[0]);
      if (t.structure === "capital") t.structure = null;
      if (t.unit) { t.unit = null; t.grave = true; }
      continue;
    }

    const capitals = comp.filter(k => state.tiles.get(k).structure === "capital");
    let money = 0;
    for (const ck of capitals) {
      const op = oldByCapital.get(ck);
      if (op && op.owner === owner) money += op.money;
    }

    let capitalKey;
    if (capitals.length === 0) {
      capitalKey = pickCapitalTile(state, comp);
      const t = state.tiles.get(capitalKey);
      t.structure = "capital";
      t.structureLevel = null; // may overwrite a farm
      t.tree = null;
      t.grave = false;
    } else {
      const oldMoney = ck => {
        const op = oldByCapital.get(ck);
        return op && op.owner === owner ? op.money : -1;
      };
      capitals.sort((a, b) => oldMoney(b) - oldMoney(a));
      capitalKey = capitals[0];
      for (const extra of capitals.slice(1)) state.tiles.get(extra).structure = null;
    }

    provinces.push({
      id: state.nextProvinceId++,
      owner,
      tiles: comp,
      money,
      capitalKey,
    });
  }

  // Capitals stranded on neutral/lone tiles are already handled above;
  // ensure no capital survives outside a province.
  const provinceTiles = new Set();
  for (const p of provinces) for (const k of p.tiles) provinceTiles.add(k);
  for (const [k, t] of state.tiles) {
    if (t.structure === "capital" && !provinceTiles.has(k)) t.structure = null;
  }

  state.provinces = provinces;
}

function pickCapitalTile(state, comp) {
  let best = comp[0], bestScore = -Infinity;
  for (const k of comp) {
    const t = state.tiles.get(k);
    let score = 0;
    if (!t.structure) score += 100; else if (t.structure === "farm") score += 10;
    if (!t.unit) score += 50;
    for (const nk of neighborKeys(k)) {
      const nt = state.tiles.get(nk);
      if (nt && nt.owner === t.owner) score += 1; // prefer interior tiles
    }
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best;
}

function provinceAt(state, key) {
  return state.provinces.find(p => p.tiles.includes(key)) || null;
}

function provincesOf(state, player) {
  return state.provinces.filter(p => p.owner === player);
}

function provinceIncome(state, p) {
  let income = 0;
  for (const k of p.tiles) {
    const t = state.tiles.get(k);
    if (t.tree || t.grave) continue;
    income += TERRAIN_INCOME[t.terrain] ?? 1;
    if (t.structure === "farm") {
      income += (FARM_INCOME[t.terrain] ?? FARM_INCOME.plains) * (t.structureLevel || 1);
    }
  }
  return income;
}

function provinceUpkeep(state, p) {
  let upkeep = 0;
  for (const k of p.tiles) {
    const t = state.tiles.get(k);
    if (t.unit) upkeep += UNIT_UPKEEP[t.unit.level];
  }
  return upkeep;
}

function farmCount(state, p) {
  return p.tiles.filter(k => state.tiles.get(k).structure === "farm").length;
}

function farmCost(state, p) {
  return FARM_BASE_COST + FARM_COST_STEP * farmCount(state, p);
}

// ---------------------------------------------------------------------------
// Combat

// A friendly tower or fort boosts units standing on any of its six
// neighbouring tiles by +1 effective level (positional: the boost applies
// wherever the unit currently stands, for both defence and attacks launched
// from there).
const TOWER_AURA_BONUS = 1;

// Towers boost adjacent tiles; forts (level-2 towers) project their aura two
// tiles out, turning them into area-command structures.
function hasTowerAura(state, key, owner) {
  for (const nk of neighborKeys(key)) {
    const nt = state.tiles.get(nk);
    if (nt && nt.owner === owner && nt.structure === "tower") return true;
    for (const nnk of neighborKeys(nk)) {
      if (nnk === key) continue;
      const nnt = state.tiles.get(nnk);
      if (nnt && nnt.owner === owner && nnt.structure === "tower" &&
          (nnt.structureLevel || 1) >= 2) return true;
    }
  }
  return false;
}

function effectiveUnitLevel(state, key) {
  const t = state.tiles.get(key);
  if (!t || !t.unit) return 0;
  return t.unit.level + (hasTowerAura(state, key, t.owner) ? TOWER_AURA_BONUS : 0);
}

// Defence of a tile = highest level among defenders on it and its neighbours
// that share the tile's owner: structures (capital 1, tower 2, fort 3) and
// units at their effective (aura-boosted) level. Neutral land is undefended.
function tileDefense(state, key) {
  const t = state.tiles.get(key);
  if (!t || t.owner < 0) return 0;
  let d = 0;
  const considerKey = k => {
    const tt = state.tiles.get(k);
    if (!tt || tt.owner !== t.owner) return;
    if (tt.unit) d = Math.max(d, effectiveUnitLevel(state, k));
    if (tt.structure === "capital") d = Math.max(d, 1);
    if (tt.structure === "tower") {
      d = Math.max(d, 1 + (tt.structureLevel || 1) +
        (tt.terrain === "hills" ? HILL_TOWER_BONUS : 0));
    }
  };
  considerKey(key);
  for (const nk of neighborKeys(key)) considerKey(nk);
  return d;
}

// Capture needs a strictly higher effective level than the defence. There is
// no level-4 override: equal-or-higher defence always blocks, so tiles in a
// structure's zone can only be taken by outleveling it — and only a
// tower-boosted level 4 (effective 5) can break a plain level-4 wall.
function canCapture(state, level, targetKey, attacker) {
  const t = state.tiles.get(targetKey);
  if (!t || t.owner === attacker) return false;
  return level > tileDefense(state, targetKey);
}

// ---------------------------------------------------------------------------
// Movement

// A unit moves up to its level in steps per turn (peasant 1 ... baron 4),
// walking through friendly territory only. Occupied tiles can be passed
// through; only the landing tile is restricted.
function moveRange(unit) { return unit.level; }

// Breadth-first distances from a tile through same-owner territory, capped at
// `range` steps. Adjacent same-owner tiles are by definition one province, so
// an owner check is all the connectivity we need.
function reachableWithin(state, fromKey, range) {
  const owner = state.tiles.get(fromKey).owner;
  const dist = new Map([[fromKey, 0]]);
  const queue = [fromKey];
  while (queue.length) {
    const k = queue.shift();
    const d = dist.get(k);
    if (d >= range) continue;
    for (const nk of neighborKeys(k)) {
      if (dist.has(nk)) continue;
      const t = state.tiles.get(nk);
      if (!t || t.owner !== owner) continue;
      dist.set(nk, d + 1);
      queue.push(nk);
    }
  }
  return dist;
}

// Capture targets spend the final step: the target must border a friendly
// tile the unit can reach with one step to spare.
function canReachTarget(state, dist, range, targetKey) {
  return neighborKeys(targetKey).some(nk =>
    dist.has(nk) && dist.get(nk) <= range - 1);
}

function isAdjacentToProvince(state, province, key) {
  return neighborKeys(key).some(nk => province.tiles.includes(nk));
}

// ---------------------------------------------------------------------------
// Turn cycle

function startPlayerTurn(state, player) {
  for (const t of state.tiles.values()) {
    if (t.owner === player && t.grave) {
      t.grave = false;
      t.tree = "palm";
    }
  }
  for (const p of provincesOf(state, player)) {
    p.money += provinceIncome(state, p) - provinceUpkeep(state, p);
    if (p.money < 0) {
      // Bankruptcy: every unit in the province starves.
      for (const k of p.tiles) {
        const t = state.tiles.get(k);
        if (t.unit) { t.unit = null; t.grave = true; }
      }
      p.money = 0;
    }
  }
  for (const t of state.tiles.values()) {
    if (t.owner === player && t.unit) t.unit.moved = false;
  }
}

// Each tree gets one spread roll per round at one random neighbour, so growth
// stays gentle and slows naturally as forests fill in (interior trees mostly
// waste their roll on occupied tiles).
function growTrees(state) {
  const sprouts = [];
  for (const [k, t] of state.tiles) {
    if (!t.tree) continue;
    if (Math.random() >= TREE_SPREAD_CHANCE) continue;
    const neigh = neighborKeys(k);
    const nk = neigh[Math.floor(Math.random() * neigh.length)];
    const nt = state.tiles.get(nk);
    if (!nt || nt.tree || nt.unit || nt.structure || nt.grave) continue;
    sprouts.push([nk, t.tree]);
  }
  for (const [k, kind] of sprouts) {
    const t = state.tiles.get(k);
    if (!t.tree && !t.unit && !t.structure && !t.grave) t.tree = kind;
  }
}

function playerAlive(state, player) {
  return state.provinces.some(p => p.owner === player);
}

function checkGameOver(state) {
  if (state.gameOver) return;
  if (!playerAlive(state, 0)) {
    state.gameOver = "defeat";
    return;
  }
  const enemiesAlive = state.players.some(pl => pl.id !== 0 && playerAlive(state, pl.id));
  if (!enemiesAlive) state.gameOver = "victory";
}

// ---------------------------------------------------------------------------
// Actions. All return { ok: true } or { ok: false, reason }.

function moveUnit(state, fromKey, toKey) {
  const from = state.tiles.get(fromKey);
  if (!from || !from.unit) return { ok: false, reason: "No unit there" };
  if (from.owner !== state.currentPlayer) return { ok: false, reason: "Not your unit" };
  if (from.unit.moved) return { ok: false, reason: "Unit already acted this turn" };
  const province = provinceAt(state, fromKey);
  if (!province) return { ok: false, reason: "Unit is not in a province" };
  if (fromKey === toKey) return { ok: false, reason: "Already there" };

  const dest = state.tiles.get(toKey);
  if (!dest) return { ok: false, reason: "Not a valid tile" };

  const range = moveRange(from.unit);
  const dist = reachableWithin(state, fromKey, range);

  if (province.tiles.includes(toKey)) {
    if (!dist.has(toKey)) {
      return { ok: false, reason: `Out of range (this unit moves ${range})` };
    }
    if (dest.unit) {
      const merged = dest.unit.level + from.unit.level;
      if (merged > MAX_UNIT_LEVEL) return { ok: false, reason: "Merged unit would exceed level 4" };
      dest.unit = { level: merged, moved: dest.unit.moved };
      from.unit = null;
      return { ok: true };
    }
    if (dest.structure) return { ok: false, reason: "Tile is occupied by a building" };
    const unit = from.unit;
    from.unit = null;
    dest.unit = unit;
    unit.moved = true;
    if (dest.tree) {
      dest.tree = null;
      province.money += TREE_CHOP_REWARD;
    }
    dest.grave = false;
    return { ok: true };
  }

  if (!canReachTarget(state, dist, range, toKey)) {
    return { ok: false, reason: `Out of range (this unit moves ${range})` };
  }
  if (!canCapture(state, effectiveUnitLevel(state, fromKey), toKey, state.currentPlayer)) {
    return { ok: false, reason: "Tile is too well defended" };
  }

  const unit = from.unit;
  from.unit = null;
  dest.owner = state.currentPlayer;
  dest.unit = unit;
  dest.structure = null;
  dest.structureLevel = null;
  dest.tree = null;
  dest.grave = false;
  unit.moved = true;
  recomputeProvinces(state);
  checkGameOver(state);
  return { ok: true };
}

function buyUnit(state, provinceCapital, targetKey) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  if (province.money < UNIT_COST) return { ok: false, reason: "Not enough money" };

  const dest = state.tiles.get(targetKey);
  if (!dest) return { ok: false, reason: "Not a valid tile" };

  if (province.tiles.includes(targetKey)) {
    if (dest.unit) {
      const merged = dest.unit.level + 1;
      if (merged > MAX_UNIT_LEVEL) return { ok: false, reason: "Unit is already level 4" };
      dest.unit = { level: merged, moved: dest.unit.moved };
    } else {
      if (dest.structure) return { ok: false, reason: "Tile is occupied by a building" };
      dest.unit = { level: 1, moved: false };
      if (dest.tree) {
        dest.tree = null;
        province.money += TREE_CHOP_REWARD;
        dest.unit.moved = true;
      }
      dest.grave = false;
    }
    province.money -= UNIT_COST;
    return { ok: true };
  }

  if (!isAdjacentToProvince(state, province, targetKey)) {
    return { ok: false, reason: "Tile is out of reach" };
  }
  if (!canCapture(state, 1, targetKey, state.currentPlayer)) {
    return { ok: false, reason: "Tile is too well defended for a peasant" };
  }
  province.money -= UNIT_COST;
  dest.owner = state.currentPlayer;
  dest.unit = { level: 1, moved: true };
  dest.structure = null;
  dest.structureLevel = null;
  dest.tree = null;
  dest.grave = false;
  recomputeProvinces(state);
  checkGameOver(state);
  return { ok: true };
}

// One entry point for the whole tower family: builds a tower on an empty
// tile, or upgrades an existing level-1 tower into a fort.
function buyTower(state, provinceCapital, targetKey) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  if (!province.tiles.includes(targetKey)) return { ok: false, reason: "Must build on your own province" };
  const dest = state.tiles.get(targetKey);

  if (dest.structure === "tower") {
    if ((dest.structureLevel || 1) >= 2) return { ok: false, reason: "Already a fort" };
    if (province.money < TOWER_UPGRADE_COST) return { ok: false, reason: "Not enough money" };
    province.money -= TOWER_UPGRADE_COST;
    dest.structureLevel = 2;
    return { ok: true };
  }

  if (province.money < TOWER_COST) return { ok: false, reason: "Not enough money" };
  if (dest.unit || dest.structure || dest.tree || dest.grave) {
    return { ok: false, reason: "Tile must be empty" };
  }
  province.money -= TOWER_COST;
  dest.structure = "tower";
  dest.structureLevel = 1;
  return { ok: true };
}

function canPlaceFarm(state, province, key) {
  const t = state.tiles.get(key);
  if (!t || !province.tiles.includes(key)) return false;
  if (t.terrain === "hills") return false; // too rocky to farm
  if (t.unit || t.structure || t.tree || t.grave) return false;
  return neighborKeys(key).some(nk => {
    const nt = state.tiles.get(nk);
    return nt && nt.owner === province.owner && province.tiles.includes(nk) &&
      (nt.structure === "farm" || nt.structure === "capital");
  });
}

function buyFarm(state, provinceCapital, targetKey) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  const dest = state.tiles.get(targetKey);

  // Upgrade path: a farm purchase aimed at an existing farm.
  if (dest && dest.structure === "farm" && province.tiles.includes(targetKey)) {
    const level = dest.structureLevel || 1;
    if (level >= MAX_FARM_LEVEL) return { ok: false, reason: "Farm is already max level" };
    const cost = FARM_UPGRADE_COSTS[level + 1];
    if (province.money < cost) return { ok: false, reason: "Not enough money" };
    province.money -= cost;
    dest.structureLevel = level + 1;
    return { ok: true };
  }

  const cost = farmCost(state, province);
  if (province.money < cost) return { ok: false, reason: "Not enough money" };
  if (!canPlaceFarm(state, province, targetKey)) {
    return { ok: false, reason: "Farms need an empty tile next to the capital or another farm" };
  }
  province.money -= cost;
  dest.structure = "farm";
  dest.structureLevel = 1;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Snapshots (used for undo)

function snapshotState(state) {
  return JSON.stringify({
    tiles: [...state.tiles.values()],
    provinces: state.provinces,
    nextProvinceId: state.nextProvinceId,
    currentPlayer: state.currentPlayer,
    round: state.round,
    difficulty: state.difficulty,
    gameOver: state.gameOver,
  });
}

function restoreState(state, snapshot) {
  const data = JSON.parse(snapshot);
  state.tiles = new Map(data.tiles.map(t => [keyOf(t.q, t.r), t]));
  state.provinces = data.provinces;
  state.nextProvinceId = data.nextProvinceId;
  state.currentPlayer = data.currentPlayer;
  state.round = data.round;
  state.difficulty = data.difficulty;
  state.gameOver = data.gameOver;
}
