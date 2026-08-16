// Map generation: an organic island blob with fair, spread-out starting
// provinces — plus a mirror-symmetric duel map for the deterministic 1v1 mode.
"use strict";

function makeTileFactory(tiles) {
  return (q, r) => {
    tiles.set(keyOf(q, r), {
      q, r,
      owner: -1,
      terrain: "plains",    // 'plains' | 'meadow' | 'hills'
      unit: null,           // { level, moved }
      structure: null,      // 'capital' | 'tower' | 'farm'
      structureLevel: null, // tower 1-4, farm 1-3; null for capital
      landmark: null,       // 'mine' | 'village' | 'fort'
      landmarkUsed: false,  // village already plundered
      tree: null,           // 'pine' | 'palm'
      grave: false,
    });
  };
}

// Grow a blob outward, favouring candidates with many existing neighbours so
// the island stays compact but keeps an irregular coastline. When `mirror` is
// set, every added tile also adds its 180°-rotated twin, producing a
// point-symmetric island.
function growBlob(tiles, tileCount, rng, mirror) {
  const addTile = makeTileFactory(tiles);
  addTile(0, 0);
  while (tiles.size < tileCount) {
    const candidates = new Map(); // key -> weight
    for (const k of tiles.keys()) {
      for (const nk of neighborKeys(k)) {
        if (tiles.has(nk)) continue;
        candidates.set(nk, (candidates.get(nk) || 0) + 1);
      }
    }
    let total = 0;
    const entries = [];
    for (const [k, n] of candidates) {
      const w = n * n; // strongly favour concave pockets
      entries.push([k, w]);
      total += w;
    }
    let roll = rng() * total;
    for (const [k, w] of entries) {
      roll -= w;
      if (roll <= 0) {
        const { q, r } = parseKey(k);
        addTile(q, r);
        if (mirror && !tiles.has(keyOf(-q, -r))) addTile(-q, -r);
        break;
      }
    }
  }
}

function generateMap(tileCount, playerCount) {
  const tiles = new Map();
  growBlob(tiles, tileCount, Math.random, false);
  paintTerrain(tiles, Math.random);
  placeStartingProvinces(tiles, playerCount);
  placeLandmarks(tiles, Math.random);
  sprinkleTrees(tiles, Math.random);
  return tiles;
}

// Duel map: point-symmetric island, terrain, trees and starts, so neither
// side has a map advantage. Fully driven by the supplied rng.
function generateDuelMap(tileCount, rng) {
  const tiles = new Map();
  growBlob(tiles, tileCount, rng, true);
  paintTerrain(tiles, rng);
  mirrorField(tiles, "terrain");
  placeDuelStarts(tiles);
  placeLandmarks(tiles, rng);
  mirrorField(tiles, "landmark");
  // The Throne sits at the exact centre — its own mirror point, equidistant
  // from both capitals.
  const centre = tiles.get(keyOf(0, 0));
  centre.landmark = "throne";
  centre.landmarkUsed = false;
  centre.terrain = "plains";
  centre.tree = null;
  sprinkleTrees(tiles, rng);
  mirrorField(tiles, "tree");
  return tiles;
}

// Landmarks: mines (+income, prefer hills), villages (one-time plunder,
// prefer plains) and ancient forts (defensive strongpoints). Kept away from
// capitals and from each other.
function placeLandmarks(tiles, rng) {
  const capitals = [];
  for (const [k, t] of tiles) if (t.structure === "capital") capitals.push(k);
  const taken = [];
  const usable = k => {
    const t = tiles.get(k);
    if (!t || t.owner !== -1 || t.structure || t.landmark) return false;
    if (capitals.some(c => hexDistance(k, c) < 4)) return false;
    if (taken.some(o => hexDistance(k, o) < 3)) return false;
    return true;
  };
  const place = (type, count, preferTerrain) => {
    const keys = [...tiles.keys()];
    for (let n = 0; n < count; n++) {
      const preferred = keys.filter(k =>
        usable(k) && (!preferTerrain || tiles.get(k).terrain === preferTerrain));
      const pool = preferred.length ? preferred : keys.filter(usable);
      if (pool.length === 0) return;
      const k = pool[Math.floor(rng() * pool.length)];
      const t = tiles.get(k);
      t.landmark = type;
      t.landmarkUsed = false;
      t.tree = null;
      taken.push(k);
    }
  };
  place("mine", Math.max(1, Math.round(tiles.size / 90)), "hills");
  place("village", Math.max(1, Math.round(tiles.size / 80)), "plains");
  place("fort", Math.max(1, Math.round(tiles.size / 130)), null);
}

// Copy a field from the canonical half of the map onto the mirrored half.
function mirrorField(tiles, field) {
  for (const [k, t] of tiles) {
    const canonical = t.q > 0 || (t.q === 0 && t.r > 0);
    if (!canonical) continue;
    const m = tiles.get(keyOf(-t.q, -t.r));
    if (!m || m.owner !== -1 || m.structure) continue;
    if (t.owner !== -1 || t.structure) continue;
    m[field] = t[field];
  }
}

// Grow meadow and hill patches over the plains: pick seeds, then expand each
// into a small organic blob.
function paintTerrain(tiles, rng) {
  const keys = [...tiles.keys()];
  const growPatch = (terrain, size) => {
    const seed = keys[Math.floor(rng() * keys.length)];
    if (tiles.get(seed).terrain !== "plains") return;
    const patch = [seed];
    tiles.get(seed).terrain = terrain;
    for (let n = 1; n < size; n++) {
      const from = patch[Math.floor(rng() * patch.length)];
      const options = neighborKeys(from).filter(nk => {
        const t = tiles.get(nk);
        return t && t.terrain === "plains";
      });
      if (options.length === 0) continue;
      const nk = options[Math.floor(rng() * options.length)];
      tiles.get(nk).terrain = terrain;
      patch.push(nk);
    }
  };
  const patches = Math.max(2, Math.round(tiles.size / 55));
  for (let i = 0; i < patches; i++) growPatch("meadow", 4 + Math.floor(rng() * 5));
  for (let i = 0; i < patches; i++) growPatch("hills", 4 + Math.floor(rng() * 5));
}

function placeStartingProvinces(tiles, playerCount) {
  const keys = [...tiles.keys()];

  // Only seed on tiles with room for a full 3-tile starting province.
  const roomy = keys.filter(k =>
    neighborKeys(k).filter(nk => tiles.has(nk)).length >= 2);

  // Greedy farthest-point seeding so players start spread apart.
  const seeds = [roomy[Math.floor(Math.random() * roomy.length)]];
  while (seeds.length < playerCount) {
    let best = null, bestDist = -1;
    for (const k of roomy) {
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, hexDistance(k, s));
      if (d > bestDist) { bestDist = d; best = k; }
    }
    seeds.push(best);
  }

  seeds.forEach((seed, player) => {
    const claimed = [seed];
    const options = neighborKeys(seed).filter(nk => {
      const t = tiles.get(nk);
      return t && t.owner === -1;
    });
    // Two extra tiles → a 3-tile starting province.
    while (claimed.length < 3 && options.length > 0) {
      const i = Math.floor(Math.random() * options.length);
      claimed.push(options.splice(i, 1)[0]);
    }
    for (const k of claimed) {
      const t = tiles.get(k);
      t.owner = player;
      t.terrain = "plains"; // fair starts: no one begins on hills or meadow
    }
    tiles.get(seed).structure = "capital";
  });
}

// Duel starts: the farthest roomy tile from the centre and its exact mirror,
// with mirrored 3-tile provinces. Deterministic — no rng involved.
function placeDuelStarts(tiles) {
  const mirrorKey = k => {
    const { q, r } = parseKey(k);
    return keyOf(-q, -r);
  };
  let seed = null, bestDist = -1;
  for (const k of tiles.keys()) {
    const mk = mirrorKey(k);
    if (mk === k || !tiles.has(mk)) continue;
    const free = neighborKeys(k).filter(nk => tiles.has(nk));
    if (free.length < 2) continue;
    const d = hexDistance(k, "0,0");
    if (d > bestDist || (d === bestDist && k < seed)) { bestDist = d; seed = k; }
  }
  const picks = [seed];
  for (const nk of neighborKeys(seed)) {
    if (picks.length >= 3) break;
    if (tiles.has(nk)) picks.push(nk);
  }
  picks.forEach((k, i) => {
    const t = tiles.get(k);
    t.owner = 0;
    t.terrain = "plains";
    t.tree = null;
    const m = tiles.get(mirrorKey(k));
    m.owner = 1;
    m.terrain = "plains";
    m.tree = null;
  });
  tiles.get(seed).structure = "capital";
  tiles.get(mirrorKey(seed)).structure = "capital";
}

function sprinkleTrees(tiles, rng) {
  for (const [k, t] of tiles) {
    if (t.owner !== -1 || t.structure || t.landmark) continue;
    if (rng() < 0.10) {
      const coastal = neighborKeys(k).some(nk => !tiles.has(nk));
      t.tree = coastal ? "palm" : "pine";
    }
  }
}
