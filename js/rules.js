// Core game rules: provinces, economy, combat, building.
//
// Simplifications vs. Antiyoy (documented in README):
//  - Units may reposition anywhere inside their own province in one move.
//  - Only level-1 units can be bought; higher tiers are made by merging.
"use strict";

const UNIT_COST = 10;
const UNIT_UPKEEP = [0, 2, 6, 18, 36]; // indexed by level 1..4
const TOWER_COST = 15;
const STRONG_TOWER_COST = 35;
const FARM_BASE_COST = 12;
const FARM_COST_STEP = 2;
const FARM_INCOME = 4;
const TREE_CHOP_REWARD = 3;
const TREE_SPREAD_CHANCE = 0.04;
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
    income += 1;
    if (t.structure === "farm") income += FARM_INCOME;
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

// Defence of a tile = highest level among defenders on it and its neighbours
// that share the tile's owner. Neutral land is undefended.
function tileDefense(state, key) {
  const t = state.tiles.get(key);
  if (!t || t.owner < 0) return 0;
  let d = 0;
  const consider = tt => {
    if (!tt || tt.owner !== t.owner) return;
    if (tt.unit) d = Math.max(d, tt.unit.level);
    if (tt.structure === "capital") d = Math.max(d, 1);
    if (tt.structure === "tower") d = Math.max(d, 2);
    if (tt.structure === "strongtower") d = Math.max(d, 3);
  };
  consider(t);
  for (const nk of neighborKeys(key)) consider(state.tiles.get(nk));
  return d;
}

function canCapture(state, level, targetKey, attacker) {
  const t = state.tiles.get(targetKey);
  if (!t || t.owner === attacker) return false;
  const d = tileDefense(state, targetKey);
  return level > d || level >= MAX_UNIT_LEVEL;
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

function growTrees(state) {
  const sprouts = [];
  for (const [k, t] of state.tiles) {
    if (!t.tree) continue;
    for (const nk of neighborKeys(k)) {
      const nt = state.tiles.get(nk);
      if (!nt || nt.tree || nt.unit || nt.structure || nt.grave) continue;
      if (Math.random() < TREE_SPREAD_CHANCE) sprouts.push([nk, t.tree]);
    }
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

  if (province.tiles.includes(toKey)) {
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

  if (!isAdjacentToProvince(state, province, toKey)) {
    return { ok: false, reason: "Tile is out of reach" };
  }
  if (!canCapture(state, from.unit.level, toKey, state.currentPlayer)) {
    return { ok: false, reason: "Tile is too well defended" };
  }

  const unit = from.unit;
  from.unit = null;
  dest.owner = state.currentPlayer;
  dest.unit = unit;
  dest.structure = null;
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
  dest.tree = null;
  dest.grave = false;
  recomputeProvinces(state);
  checkGameOver(state);
  return { ok: true };
}

function buyTower(state, provinceCapital, targetKey, strong) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  const cost = strong ? STRONG_TOWER_COST : TOWER_COST;
  if (province.money < cost) return { ok: false, reason: "Not enough money" };
  if (!province.tiles.includes(targetKey)) return { ok: false, reason: "Must build on your own province" };
  const dest = state.tiles.get(targetKey);
  if (dest.unit || dest.structure || dest.tree || dest.grave) {
    return { ok: false, reason: "Tile must be empty" };
  }
  province.money -= cost;
  dest.structure = strong ? "strongtower" : "tower";
  return { ok: true };
}

function canPlaceFarm(state, province, key) {
  const t = state.tiles.get(key);
  if (!t || !province.tiles.includes(key)) return false;
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
  const cost = farmCost(state, province);
  if (province.money < cost) return { ok: false, reason: "Not enough money" };
  if (!canPlaceFarm(state, province, targetKey)) {
    return { ok: false, reason: "Farms need an empty tile next to the capital or another farm" };
  }
  province.money -= cost;
  state.tiles.get(targetKey).structure = "farm";
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
