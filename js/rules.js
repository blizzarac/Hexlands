// Core game rules: provinces, economy, combat, building.
//
// Simplifications vs. Antiyoy (documented in README):
//  - Units may reposition anywhere inside their own province in one move.
//  - Only level-1 units can be bought; higher tiers are made by merging.
"use strict";

const UNIT_COST = 10;
const UNIT_UPKEEP = [0, 2, 6, 18, 36]; // indexed by level 1..4
const TOWER_COST = 15;
const MAX_TOWER_LEVEL = 4;
// Watchtower -> Fort -> Castle -> Citadel. Indexed by target level.
const TOWER_UPGRADE_COSTS = [0, 0, 30, 45, 60];
const TOWER_DEFENSE = [0, 2, 3, 4, 4];    // by tower level
const TOWER_AURA_RANGE = [0, 1, 1, 2, 3]; // by tower level
// No structure may defend above 4: a tower-boosted baron (effective 5) must
// always be able to break any fortification, or sieges become unwinnable.
const MAX_STRUCTURE_DEFENSE = 4;
const MAX_FARM_LEVEL = 3;
const FARM_BASE_COST = 12;
const FARM_COST_STEP = 2;
const FARM_INCOME = { plains: 4, meadow: 6 }; // per farm level, by terrain
const FARM_UPGRADE_COSTS = [0, 0, 20, 30]; // indexed by target level
const TREE_CHOP_REWARD = 3;
const TERRAIN_INCOME = { plains: 1, meadow: 2, hills: 0 };
const HILL_TOWER_BONUS = 1; // towers/forts built on hills defend one level higher
const MINE_INCOME = 3;           // while held
const VILLAGE_PLUNDER = 12;      // one-time, first capture only
const ANCIENT_FORT_DEFENSE = 2;  // while held; defends tile + neighbours
const TREE_SPREAD_CHANCE = 0.10; // per tree per round, one random neighbour
const START_MONEY = 10;
const MAX_UNIT_LEVEL = 4;

const PLAYER_COLORS = ["#4f8fd9", "#d9564f", "#9a6bd0", "#d9a13f", "#4fb8b8", "#d06bb0"];
const PLAYER_NAMES = ["You", "Red", "Purple", "Amber", "Teal", "Pink"];

// ---------------------------------------------------------------------------
// Doctrines: permanent, public empire edicts. One free pick from the full
// pool at each of these rounds — no randomness, so duel picks are bookable.

const DOCTRINE_ROUNDS = [5, 15, 25];
const DOCTRINES = {
  agriculture: { name: "Agriculture", icon: "🌾",
    desc: "Farms produce +1 income per level." },
  prospecting: { name: "Prospecting", icon: "⛏️",
    desc: "Mines pay +2 more, and your hills tiles earn +1 income." },
  banking: { name: "Banking", icon: "🪙",
    desc: "Each province earns +1 per full 25 coins in its treasury (max +4)." },
  conscription: { name: "Conscription", icon: "🗡️",
    desc: "New units cost 8 instead of 10." },
  discipline: { name: "Field Discipline", icon: "🐎",
    desc: "All your units move 1 tile further." },
  siegecraft: { name: "Siegecraft", icon: "🪓",
    desc: "Enemy structure defence counts 1 lower against your units." },
  masonry: { name: "Masonry", icon: "🧱",
    desc: "Towers cost 25% less to build and upgrade." },
  militia: { name: "Militia", icon: "🛡️",
    desc: "Your capitals defend at 2 and boost adjacent units by +1." },
};

function hasDoctrine(state, player, id) {
  if (player === null || player === undefined || player < 0) return false;
  const pl = state.players[player];
  return !!(pl && pl.doctrines && pl.doctrines.includes(id));
}

// How many picks this player has earned but not yet made.
function pendingDoctrinePicks(state, player) {
  const earned = DOCTRINE_ROUNDS.filter(r => state.round >= r).length;
  return Math.max(0, earned - (state.players[player].doctrines || []).length);
}

function adoptDoctrine(state, player, id) {
  if (!DOCTRINES[id]) return { ok: false, reason: "Unknown doctrine" };
  const pl = state.players[player];
  if (pl.doctrines.includes(id)) return { ok: false, reason: "Already adopted" };
  if (pendingDoctrinePicks(state, player) <= 0) return { ok: false, reason: "No pick available" };
  pl.doctrines.push(id);
  return { ok: true };
}

function unitCost(state, player) {
  return hasDoctrine(state, player, "conscription") ? 8 : UNIT_COST;
}

function towerBuildCost(state, player) {
  return hasDoctrine(state, player, "masonry")
    ? Math.floor(TOWER_COST * 0.75) : TOWER_COST;
}

function towerUpgradeCost(state, player, targetLevel) {
  const c = TOWER_UPGRADE_COSTS[targetLevel];
  return hasDoctrine(state, player, "masonry") ? Math.floor(c * 0.75) : c;
}

// Duel mode: 1v1 on a fixed, mirror-symmetric map with no luck anywhere.
const DUEL_SEED = 0xC1A55;
const DUEL_TILE_COUNT = 190;

// The Throne: the duel map's central objective at (0,0). +4 income while
// held, and holding it for 10 consecutive rounds wins the duel outright.
const THRONE_KEY = "0,0";
const THRONE_INCOME = 4;
const THRONE_HOLD_ROUNDS = 10;

// Called once per full round (after the round counter advances).
function updateThrone(state) {
  const t = state.tiles.get(THRONE_KEY);
  if (!t || t.landmark !== "throne" || state.gameOver) return;
  const holder = t.owner;
  if (holder >= 0 && holder === state.throneHolder) {
    state.throneHeldRounds += 1;
  } else {
    state.throneHolder = holder;
    state.throneHeldRounds = holder >= 0 ? 1 : 0;
  }
  if (state.throneHeldRounds >= THRONE_HOLD_ROUNDS) {
    if (state.throneHolder === 0) {
      state.gameOver = "victory";
      state.gameOverReason =
        `You held the Throne for ${THRONE_HOLD_ROUNDS} rounds — crowned!`;
    } else {
      state.gameOver = "defeat";
      state.gameOverReason =
        `The enemy held the Throne for ${THRONE_HOLD_ROUNDS} rounds.`;
    }
  }
}

// Game randomness goes through rand(state). In standard games rngState is
// null and this is plain Math.random; in duel mode it is a mulberry32 stream
// whose cursor lives in the state (and therefore in undo snapshots), so
// identical play always produces identical games.
function rand(state) {
  if (state.rngState === null || state.rngState === undefined) return Math.random();
  state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function newGame(opts) {
  const isDuel = opts.mode === "duel";
  const playerCount = isDuel ? 2 : 1 + opts.aiCount;
  const state = {
    tiles: null,
    players: [],
    provinces: [],
    nextProvinceId: 1,
    currentPlayer: 0,
    round: 1,
    mode: isDuel ? "duel" : "standard",
    difficulty: opts.difficulty || "normal",
    rngState: isDuel ? DUEL_SEED >>> 0 : null,
    throneHolder: -1,
    throneHeldRounds: 0,
    gameOver: null, // 'victory' | 'defeat'
  };
  state.tiles = isDuel
    ? generateDuelMap(DUEL_TILE_COUNT, () => rand(state))
    : generateMap(opts.tileCount, playerCount);
  // Deal each AI a playstyle: shuffle so every game feels different, but
  // cycle through the deck so styles stay varied when there are many AIs.
  // Duels always face a Balanced opponent so the matchup is constant.
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
      aiStyle: i === 0 ? null : (isDuel ? "balanced" : styleDeck[(i - 1) % styleDeck.length]),
      doctrines: [],
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
    if (t.landmark) score -= 40; // keep capitals off mines and ruins
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
  const agriculture = hasDoctrine(state, p.owner, "agriculture");
  const prospecting = hasDoctrine(state, p.owner, "prospecting");
  let income = 0;
  for (const k of p.tiles) {
    const t = state.tiles.get(k);
    if (t.tree || t.grave) continue;
    let tileIncome = TERRAIN_INCOME[t.terrain] ?? 1;
    if (prospecting && t.terrain === "hills") tileIncome += 1;
    income += tileIncome;
    if (t.landmark === "mine") income += MINE_INCOME + (prospecting ? 2 : 0);
    if (t.landmark === "throne") income += THRONE_INCOME;
    if (t.structure === "farm") {
      const perLevel = (FARM_INCOME[t.terrain] ?? FARM_INCOME.plains) + (agriculture ? 1 : 0);
      income += perLevel * (t.structureLevel || 1);
    }
  }
  if (hasDoctrine(state, p.owner, "banking")) {
    income += Math.min(4, Math.floor(p.money / 25));
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

// Does any friendly tower's aura cover this tile? Watchtowers and forts
// reach 1 tile, castles 2, citadels 3. Scans the coordinate neighbourhood up
// to the maximum range.
function hasTowerAura(state, key, owner) {
  const { q, r } = parseKey(key);
  const R = 3;
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = Math.max(-R, -R - dq); dr <= Math.min(R, R - dq); dr++) {
      if (dq === 0 && dr === 0) continue;
      const t = state.tiles.get(keyOf(q + dq, r + dr));
      if (!t || t.owner !== owner) continue;
      const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
      if (t.structure === "tower" && TOWER_AURA_RANGE[t.structureLevel || 1] >= d) return true;
      // Militia doctrine: capitals project the +1 aura to their neighbours.
      if (t.structure === "capital" && d === 1 && hasDoctrine(state, owner, "militia")) return true;
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
// When an attacker with the Siegecraft doctrine is given, all structure
// contributions count 1 lower (units are unaffected).
function tileDefense(state, key, attacker) {
  const t = state.tiles.get(key);
  if (!t || t.owner < 0) return 0;
  const siege = hasDoctrine(state, attacker, "siegecraft") ? 1 : 0;
  let d = 0;
  const considerKey = k => {
    const tt = state.tiles.get(k);
    if (!tt || tt.owner !== t.owner) return;
    if (tt.unit) d = Math.max(d, effectiveUnitLevel(state, k));
    if (tt.landmark === "fort") d = Math.max(d, ANCIENT_FORT_DEFENSE - siege);
    if (tt.structure === "capital") {
      const base = hasDoctrine(state, tt.owner, "militia") ? 2 : 1;
      d = Math.max(d, base - siege);
    }
    if (tt.structure === "tower") {
      const sd = TOWER_DEFENSE[tt.structureLevel || 1] +
        (tt.terrain === "hills" ? HILL_TOWER_BONUS : 0);
      d = Math.max(d, Math.min(MAX_STRUCTURE_DEFENSE, sd) - siege);
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
  return level > tileDefense(state, targetKey, attacker);
}

// ---------------------------------------------------------------------------
// Movement

// A unit moves up to its level in steps per turn (peasant 1 ... baron 4),
// walking through friendly territory only. Occupied tiles can be passed
// through; only the landing tile is restricted. Field Discipline adds 1.
function moveRange(state, owner, unit) {
  return unit.level + (hasDoctrine(state, owner, "discipline") ? 1 : 0);
}

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
    if (rand(state) >= TREE_SPREAD_CHANCE) continue;
    const neigh = neighborKeys(k);
    const nk = neigh[Math.floor(rand(state) * neigh.length)];
    const nt = state.tiles.get(nk);
    if (!nt || nt.tree || nt.unit || nt.structure || nt.grave || nt.landmark) continue;
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

const DOMINATION_RATIO = 0.65;      // free-for-all: control 65% of the island
const DUEL_DOMINATION_RATIO = 0.60; // duel: 60%
const DUEL_ROUND_LIMIT = 60;        // duel: after round 60, most tiles wins

function checkGameOver(state) {
  if (state.gameOver) return;
  if (!playerAlive(state, 0)) {
    state.gameOver = "defeat";
    state.gameOverReason = "Your last province has fallen.";
    return;
  }
  const enemiesAlive = state.players.some(pl => pl.id !== 0 && playerAlive(state, pl.id));
  if (!enemiesAlive) {
    state.gameOver = "victory";
    state.gameOverReason = "Every enemy province has been destroyed.";
    return;
  }

  // Domination: once someone controls most of the island the outcome is
  // decided — end the game instead of dragging through the mop-up.
  const ratio = state.mode === "duel" ? DUEL_DOMINATION_RATIO : DOMINATION_RATIO;
  const counts = new Map();
  for (const t of state.tiles.values()) {
    if (t.owner >= 0) counts.set(t.owner, (counts.get(t.owner) || 0) + 1);
  }
  const total = state.tiles.size;
  for (const [owner, n] of counts) {
    if (n / total < ratio) continue;
    const pct = Math.round(n / total * 100);
    if (owner === 0) {
      state.gameOver = "victory";
      state.gameOverReason = `You control ${pct}% of the island — domination!`;
    } else {
      state.gameOver = "defeat";
      state.gameOverReason = `${state.players[owner].name} controls ${pct}% of the island.`;
    }
    return;
  }

  // Duel time limit: when it expires, the larger realm takes the match.
  if (state.mode === "duel" && state.round > DUEL_ROUND_LIMIT) {
    const mine = counts.get(0) || 0;
    const theirs = counts.get(1) || 0;
    if (mine > theirs) {
      state.gameOver = "victory";
      state.gameOverReason = `Round limit reached — you hold ${mine} tiles to ${theirs}.`;
    } else if (theirs > mine) {
      state.gameOver = "defeat";
      state.gameOverReason = `Round limit reached — the enemy holds ${theirs} tiles to ${mine}.`;
    } else {
      state.gameOver = "draw";
      state.gameOverReason = `Round limit reached at ${mine} tiles apiece — a draw.`;
    }
  }
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

  const range = moveRange(state, from.owner, from.unit);
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
  plunderVillage(state, dest, province);
  recomputeProvinces(state);
  checkGameOver(state);
  return { ok: true };
}

// Called with the capturing province BEFORE provinces are recomputed, so the
// plunder lands in the treasury that made the capture.
function plunderVillage(state, tile, province) {
  if (tile.landmark === "village" && !tile.landmarkUsed) {
    tile.landmarkUsed = true;
    province.money += VILLAGE_PLUNDER;
  }
}

function buyUnit(state, provinceCapital, targetKey) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  const cost = unitCost(state, state.currentPlayer);
  if (province.money < cost) return { ok: false, reason: "Not enough money" };

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
    province.money -= cost;
    return { ok: true };
  }

  if (!isAdjacentToProvince(state, province, targetKey)) {
    return { ok: false, reason: "Tile is out of reach" };
  }
  if (!canCapture(state, 1, targetKey, state.currentPlayer)) {
    return { ok: false, reason: "Tile is too well defended for a peasant" };
  }
  province.money -= cost;
  dest.owner = state.currentPlayer;
  dest.unit = { level: 1, moved: true };
  dest.structure = null;
  dest.structureLevel = null;
  dest.tree = null;
  dest.grave = false;
  plunderVillage(state, dest, province);
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
    const level = dest.structureLevel || 1;
    if (level >= MAX_TOWER_LEVEL) return { ok: false, reason: "Already a citadel" };
    const cost = towerUpgradeCost(state, state.currentPlayer, level + 1);
    if (province.money < cost) return { ok: false, reason: "Not enough money" };
    province.money -= cost;
    dest.structureLevel = level + 1;
    return { ok: true };
  }

  const buildCost = towerBuildCost(state, state.currentPlayer);
  if (province.money < buildCost) return { ok: false, reason: "Not enough money" };
  if (dest.landmark) return { ok: false, reason: "Can't build on a landmark" };
  if (dest.unit || dest.structure || dest.tree || dest.grave) {
    return { ok: false, reason: "Tile must be empty" };
  }
  province.money -= buildCost;
  dest.structure = "tower";
  dest.structureLevel = 1;
  return { ok: true };
}

function canPlaceFarm(state, province, key) {
  const t = state.tiles.get(key);
  if (!t || !province.tiles.includes(key)) return false;
  if (t.terrain === "hills") return false; // too rocky to farm
  if (t.landmark) return false;
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
// Selling

const SELL_RATIO = 0.75;

// Nominal invested cost of whatever sits on the tile (unit or building).
// Farm build prices vary with farm count at purchase time; we use the base
// price, which keeps sell-and-rebuild strictly unprofitable.
function assetValue(tile) {
  if (tile.unit) return UNIT_COST * tile.unit.level;
  if (tile.structure === "tower") {
    let total = TOWER_COST;
    for (let l = 2; l <= (tile.structureLevel || 1); l++) total += TOWER_UPGRADE_COSTS[l];
    return total;
  }
  if (tile.structure === "farm") {
    let total = FARM_BASE_COST;
    for (let l = 2; l <= (tile.structureLevel || 1); l++) total += FARM_UPGRADE_COSTS[l];
    return total;
  }
  return 0; // capitals and empty tiles are not sellable
}

function sellPrice(tile) {
  return Math.floor(assetValue(tile) * SELL_RATIO);
}

function sellAsset(state, provinceCapital, targetKey) {
  const province = state.provinces.find(
    p => p.capitalKey === provinceCapital && p.owner === state.currentPlayer);
  if (!province) return { ok: false, reason: "No such province" };
  if (!province.tiles.includes(targetKey)) return { ok: false, reason: "Not in this province" };
  const t = state.tiles.get(targetKey);
  const price = sellPrice(t);
  if (price <= 0) return { ok: false, reason: "Nothing sellable there" };
  if (t.unit) {
    t.unit = null;
  } else {
    t.structure = null;
    t.structureLevel = null;
  }
  province.money += price;
  return { ok: true, price };
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
    mode: state.mode,
    difficulty: state.difficulty,
    rngState: state.rngState,
    gameOver: state.gameOver,
    gameOverReason: state.gameOverReason,
    doctrines: state.players.map(pl => [...(pl.doctrines || [])]),
    throneHolder: state.throneHolder,
    throneHeldRounds: state.throneHeldRounds,
  });
}

function restoreState(state, snapshot) {
  const data = JSON.parse(snapshot);
  state.tiles = new Map(data.tiles.map(t => [keyOf(t.q, t.r), t]));
  state.provinces = data.provinces;
  state.nextProvinceId = data.nextProvinceId;
  state.currentPlayer = data.currentPlayer;
  state.round = data.round;
  state.mode = data.mode;
  state.difficulty = data.difficulty;
  state.rngState = data.rngState;
  state.gameOver = data.gameOver;
  state.gameOverReason = data.gameOverReason;
  if (data.doctrines) {
    data.doctrines.forEach((d, i) => {
      if (state.players[i]) state.players[i].doctrines = d;
    });
  }
  state.throneHolder = data.throneHolder ?? -1;
  state.throneHeldRounds = data.throneHeldRounds ?? 0;
}
