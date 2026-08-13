// Map generation: an organic island blob with fair, spread-out starting provinces.
"use strict";

function generateMap(tileCount, playerCount) {
  const tiles = new Map();

  const addTile = (q, r) => {
    tiles.set(keyOf(q, r), {
      q, r,
      owner: -1,
      unit: null,       // { level, moved }
      structure: null,  // 'capital' | 'tower' | 'strongtower' | 'farm'
      tree: null,       // 'pine' | 'palm'
      grave: false,
    });
  };

  // Grow a blob outward, favouring candidates with many existing neighbours
  // so the island stays compact but keeps an irregular coastline.
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
    let roll = Math.random() * total;
    for (const [k, w] of entries) {
      roll -= w;
      if (roll <= 0) {
        const { q, r } = parseKey(k);
        addTile(q, r);
        break;
      }
    }
  }

  placeStartingProvinces(tiles, playerCount);
  sprinkleTrees(tiles);
  return tiles;
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
    for (const k of claimed) tiles.get(k).owner = player;
    tiles.get(seed).structure = "capital";
  });
}

function sprinkleTrees(tiles) {
  for (const [k, t] of tiles) {
    if (t.owner !== -1 || t.structure) continue;
    if (Math.random() < 0.10) {
      const coastal = neighborKeys(k).some(nk => !tiles.has(nk));
      t.tree = coastal ? "palm" : "pine";
    }
  }
}
