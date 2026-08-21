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
  hexed: {
    label: "Hexed",
    actChance: 1.0,
    noise: 0,
    merge: true,
    buyCap: 99,
    reserve: 0,
    // Unlocks planning behaviours (individually flagged, tuned by AI-vs-AI
    // tournament ablation). No cheating — harder purely through better play.
    smart: true,
    race: true,    // frontier-aware expansion: won the hard-mirror 63%
    cut: true,     // split enemy provinces: mirror-neutral, punishes the
                   // thin shapes human players build
    defend: true,  // garrison threatened assets: counters human-style raids
    strip: false,  // measured net-negative in tournaments; kept for tuning
    siege: false,  // measured net-negative in tournaments; kept for tuning
    escalate: true, // once the war front dominates the border, level units
                    // up (merges + buy-upgrades) instead of spamming
                    // peasants — a flat level-1 army loses to anyone who
                    // fields knights (learned from a shared game log)
    react: true,    // reactive escalation: the moment the enemy fields a
                    // level-2+ unit, start levelling too, even with neutral
                    // fringe left — waiting four rounds lost a second log
    walls: true,    // at war, buy one tower covering the most threatened
                    // frontier tiles before peasants drain the treasury
    raidgate: false, // suppress low-value peasant raids: measured clearly
                     // net-negative (38% mirror) — raids buy real tempo
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

// Fixed doctrine priorities per playstyle — deterministic, so duel-mode
// opponents are bookable.
const AI_DOCTRINE_PRIORITY = {
  balanced: ["agriculture", "conscription", "masonry", "prospecting", "discipline", "siegecraft", "banking", "militia"],
  warlord: ["conscription", "siegecraft", "discipline", "militia", "agriculture", "masonry", "prospecting", "banking"],
  builder: ["agriculture", "prospecting", "banking", "masonry", "militia", "conscription", "discipline", "siegecraft"],
  turtle: ["masonry", "militia", "banking", "agriculture", "prospecting", "conscription", "siegecraft", "discipline"],
};

function aiPickDoctrines(state, player) {
  const style = state.players[player].aiStyle || "balanced";
  const priority = AI_DOCTRINE_PRIORITY[style] || AI_DOCTRINE_PRIORITY.balanced;
  let guard = 0;
  while (pendingDoctrinePicks(state, player) > 0 && guard++ < 10) {
    const pick = priority.find(id => !state.players[player].doctrines.includes(id));
    if (!pick || !adoptDoctrine(state, player, pick).ok) break;
  }
}

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

  // 0. Objective first: a held but empty throne gets garrisoned before any
  //    unit is spent on ordinary attacks.
  const p0 = resolve();
  if (p0) garrisonThrone(state, player, p0);

  // 1. Attack with existing units, best targets first. Lower difficulties
  //    have a chance to stop early, leaving units unused.
  for (let guard = 0; guard < 60; guard++) {
    if (rand(state) > diff.actChance) break;
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

  // 3b. Hexed planning: garrison genuinely threatened assets, then park
  //     units in tower auras to crack walls next turn.
  if (diff.smart) {
    if (diff.defend) {
      province = resolve();
      if (province) defendThreatened(state, player, province, diff);
    }
    if (diff.siege) {
      province = resolve();
      if (province) setupSieges(state, player, province, diff, style);
    }
  }

  // 4. Send leftover idle units toward the border so they defend something.
  province = resolve();
  if (province) repositionIdleUnits(state, player, province);
}

// How much this tile is worth protecting.
function defenseValueOf(state, key) {
  const t = state.tiles.get(key);
  let v = 1;
  if (t.structure === "capital") v = 10;
  else if (t.structure === "tower") v = 2 + 2 * (t.structureLevel || 1);
  else if (t.structure === "farm") v = 2 + 2 * (t.structureLevel || 1);
  if (t.landmark === "mine") v = Math.max(v, 5);
  if (t.landmark === "fort") v = Math.max(v, 4);
  if (t.landmark === "throne") v = Math.max(v, 12);
  if (t.terrain === "meadow") v = Math.max(v, 3);
  return v;
}

// Move idle units onto (or beside) valuable tiles the enemy could actually
// capture next turn.
function defendThreatened(state, player, province, diff) {
  const threatened = computeCapturableTiles(state, player);
  // Only the single most valuable threatened asset earns a garrison per
  // province per turn — more than that bleeds offensive tempo dry.
  const targets = province.tiles
    .filter(k => threatened.has(k))
    .map(k => ({ k, v: defenseValueOf(state, k) }))
    .filter(o => o.v >= 5)
    .sort((a, b) => b.v - a.v)
    .slice(0, 1);

  for (const { k } of targets) {
    const t = state.tiles.get(k);
    if (t.unit) continue; // already garrisoned
    // Structure tiles (except farms) can't be stood on: defend a neighbour.
    const landings = (!t.structure || t.structure === "farm")
      ? [k]
      : neighborKeys(k).filter(nk => {
          const nt = state.tiles.get(nk);
          return nt && province.tiles.includes(nk) && !nt.unit && !nt.tree &&
            !nt.grave && (!nt.structure || nt.structure === "farm");
        });
    if (landings.length === 0) continue;
    const idle = province.tiles
      .filter(uk => {
        const ut = state.tiles.get(uk);
        return ut.unit && !ut.unit.moved;
      })
      .sort((a, b) => hexDistance(a, k) - hexDistance(b, k));
    outer:
    for (const uk of idle) {
      const ut = state.tiles.get(uk);
      const dist = reachableWithin(state, uk, moveRange(state, player, ut.unit));
      for (const lk of landings) {
        if (lk !== uk && dist.has(lk) && moveUnit(state, uk, lk).ok) break outer;
      }
    }
  }
}

// Park a unit in a friendly tower aura from which its boosted level can crack
// a wall it currently cannot: the classic one-turn siege setup.
function setupSieges(state, player, province, diff, style) {
  const targets = borderTargets(state, province);
  const idle = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  for (const uk of idle) {
    const unit = state.tiles.get(uk).unit;
    const effNow = effectiveUnitLevel(state, uk);
    const boosted = unit.level + TOWER_AURA_BONUS;
    const memo = new Map();
    let bestT = null, bestV = 8; // only worthwhile prizes justify a setup turn
    for (const tk of targets) {
      const d = tileDefense(state, tk, player);
      if (effNow > d || boosted <= d) continue; // takeable already / boost won't help
      const v = targetValue(state, tk, player, diff, style, memo);
      if (v > bestV) { bestV = v; bestT = tk; }
    }
    if (!bestT) continue;
    const range = moveRange(state, player, unit);
    const dist = reachableWithin(state, uk, range);
    let spot = null, bestDist = Infinity;
    for (const k of dist.keys()) {
      if (k === uk) continue;
      const t = state.tiles.get(k);
      if (t.unit || t.tree || t.grave) continue;
      if (t.structure && t.structure !== "farm") continue;
      if (!hasTowerAura(state, k, player)) continue;
      const dd = hexDistance(k, bestT);
      if (dd <= range && dd < bestDist) { bestDist = dd; spot = k; }
    }
    if (spot) moveUnit(state, uk, spot);
  }
}

// Escalation phase gate: while free land dominates the border, cheap
// peasants claiming neutral tiles out-tempo everything, so levelling up
// waits until the enemy front is the bigger share of the frontier.
// Tournament-tuned: ungated escalation measured 43% vs hard; gating on the
// enemy front dominating restores the full 63% while still firing mid-war.
function frontierIsWar(state, province) {
  let enemy = 0, neutral = 0;
  const seen = new Set();
  for (const k of province.tiles) {
    for (const nk of neighborKeys(k)) {
      if (seen.has(nk)) continue;
      seen.add(nk);
      const t = state.tiles.get(nk);
      if (!t || t.owner === province.owner) continue;
      if (t.owner === -1) neutral++; else enemy++;
    }
  }
  return enemy > 0 && enemy >= neutral * WAR_FRONT_RATIO;
}
let WAR_FRONT_RATIO = 1; // enemy border tiles per neutral one before escalating

// The war-phase gate: the front dominates the border, or (reactive) the
// enemy has started fielding levelled units — an arms race waits for no
// fringe. Hard opponents and early-game AIs never level first, so the
// reactive trigger costs nothing in tournaments while answering the human
// habit of teching up mid-expansion.
function warPhase(state, player, province, diff) {
  if (frontierIsWar(state, province)) return true;
  if (diff.react) {
    for (const t of state.tiles.values()) {
      if (t.unit && t.unit.level >= 2 && t.owner >= 0 && t.owner !== player) return true;
    }
  }
  return false;
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

// Would capturing `key` split the province it belongs to? Splitting is
// devastating (fragments lose the treasury or die outright), so Hexed prices
// cut tiles above almost everything. Memoised per decision batch.
function cutBonus(state, key, player, memo) {
  if (memo && memo.has(key)) return memo.get(key);
  let bonus = 0;
  const t = state.tiles.get(key);
  if (t && t.owner >= 0 && t.owner !== player) {
    const prov = provinceAt(state, key);
    if (prov && prov.tiles.length > 2) {
      const remaining = new Set(prov.tiles);
      remaining.delete(key);
      const start = remaining.values().next().value;
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const ck = stack.pop();
        for (const nk of neighborKeys(ck)) {
          if (remaining.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
      if (seen.size < remaining.size) {
        const smaller = Math.min(seen.size, remaining.size - seen.size);
        // Only meaningful severances score: chasing 1-2 tile crumbs is a
        // tempo loss dressed up as tactics.
        if (smaller >= 3) bonus = 6 + Math.min(12, smaller);
      }
    }
  }
  if (memo) memo.set(key, bonus);
  return bonus;
}

function targetValue(state, key, player, diff, style, cutMemo) {
  const t = state.tiles.get(key);
  let value = t.owner === -1 ? style.neutralValue : style.enemyValue;
  value += ((TERRAIN_INCOME[t.terrain] ?? 1) - 1) * 1.5; // meadows tempt, hills bore
  if (t.landmark === "mine") value += 4;
  else if (t.landmark === "village" && !t.landmarkUsed) value += 3;
  else if (t.landmark === "fort") value += 3;
  else if (t.landmark === "throne") {
    // The duel's central objective; contesting it grows urgent as the
    // holder's crown clock runs.
    value += 8 + (t.owner !== player && t.owner >= 0 ? state.throneHeldRounds : 0);
  }
  // Gravity toward an unheld throne: expansion and attacks lean centreward
  // so the AI's frontier reaches the objective instead of wandering.
  const throne = state.tiles.get(THRONE_KEY);
  if (throne && throne.landmark === "throne" && throne.owner !== player) {
    value += Math.max(0, 6 - hexDistance(key, THRONE_KEY)) *
      (1 + state.throneHeldRounds * 0.15);
  }
  if (t.structure === "capital") value += 12 * style.structureMult;
  else if (t.structure === "tower") value += (4 + 2 * (t.structureLevel || 1)) * style.structureMult;
  else if (t.structure === "farm") value += (4 + 2 * (t.structureLevel || 1)) * style.structureMult;
  if (t.unit) value += t.unit.level * 2;
  // Bonus for tiles that cut into enemy territory.
  for (const nk of neighborKeys(key)) {
    const nt = state.tiles.get(nk);
    if (nt && nt.owner !== player && nt.owner !== -1) value += 0.5;
  }
  if (diff.smart) {
    // Race tempo: frontier tiles that open into more neutral land beat
    // dead-end pockets — expansion aims where the future is. Ring 2 gives
    // the gradient real reach.
    if (diff.race && t.owner === -1) {
      let open1 = 0, open2 = 0;
      for (const nk of neighborKeys(key)) {
        const nt = state.tiles.get(nk);
        if (nt && nt.owner === -1) {
          open1++;
          for (const nnk of neighborKeys(nk)) {
            if (nnk === key) continue;
            const nnt = state.tiles.get(nnk);
            if (nnt && nnt.owner === -1) open2++;
          }
        }
      }
      value += open1 * 0.6 + open2 * 0.1;
    }
    // Province splitting is the strongest move in the game.
    if (diff.cut) value += cutBonus(state, key, player, cutMemo);
    // Aura stripping: a static tower props up neighbouring defences —
    // removing it is worth more the more tiles it covers. (Units are not
    // counted: chasing them head-on costs more tempo than it strips.)
    if (diff.strip && t.owner >= 0 && t.owner !== player && t.structure === "tower") {
      let covered = 0;
      for (const nk of neighborKeys(key)) {
        const nt = state.tiles.get(nk);
        if (nt && nt.owner === t.owner) covered++;
      }
      value += covered * 0.5;
    }
  }
  // Imperfect play: lower difficulties mis-rank their options.
  value += (rand(state) * 2 - 1) * diff.noise;
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
  const cutMemo = diff.smart ? new Map() : null;
  for (const uk of units) {
    const unit = state.tiles.get(uk).unit;
    const range = moveRange(state, player, unit);
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
        const value = targetValue(state, nk, player, diff, style, cutMemo);
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

  // What the merged unit must beat. The classic rule demands it crack the
  // hardest border tile — which peasants facing a defence-2 wall can never
  // reach in one merge, so the army stays level 1 forever. Escalating AIs
  // instead climb one rung at a time: any merge that out-levels the current
  // army is allowed while some border tile stays blocked.
  let needed = maxDefense;
  if (diff.escalate && warPhase(state, player, province, diff)) {
    const blocked = targets.some(k => tileDefense(state, k) >= maxLevel);
    if (!blocked || maxLevel >= MAX_UNIT_LEVEL) return;
    needed = maxLevel;
  } else if (maxLevel > maxDefense) {
    return; // a single unit could already do the job
  }

  // Find a pair the mover can actually walk to.
  idle.sort((a, b) => state.tiles.get(a).unit.level - state.tiles.get(b).unit.level);
  for (const a of idle) {
    const ua = state.tiles.get(a).unit;
    const dist = reachableWithin(state, a, moveRange(state, player, ua));
    for (const b of idle) {
      if (b === a || !dist.has(b)) continue;
      const combined = ua.level + state.tiles.get(b).unit.level;
      if (combined > MAX_UNIT_LEVEL || combined <= needed) continue;
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
  // Emergency downsizing: if the next income phase would bankrupt the
  // province (killing every unit), sell the cheapest units until it balances.
  for (let guard = 0; guard < 10; guard++) {
    const net = provinceIncome(state, province) - provinceUpkeep(state, province);
    if (province.money + net >= 0) break;
    const units = province.tiles
      .filter(k => state.tiles.get(k).unit)
      .sort((a, b) => state.tiles.get(a).unit.level - state.tiles.get(b).unit.level);
    if (units.length === 0) break;
    if (!sellAsset(state, province.capitalKey, units[0]).ok) break;
  }

  // Farm first: compounding income wins long games. Build new farms while
  // there is room; once there isn't, upgrade existing ones.
  if (rand(state) < style.farmChance) {
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

  // Escalation: when the frontier's prizes are walled off beyond every unit
  // this province owns, another peasant is money down the drain — put the
  // coins into levelling an existing unit (buying onto a unit raises it one
  // level) until it can break through.
  const atWar = diff.smart ? warPhase(state, player, province, diff) : false;
  if (diff.escalate && atWar) {
    const memo = new Map();
    let maxEff = 0;
    for (const k of province.tiles) {
      const t = state.tiles.get(k);
      if (t.unit) maxEff = Math.max(maxEff, effectiveUnitLevel(state, k));
    }
    let target = null, bestV = 5; // only worthwhile prizes justify the upkeep
    if (maxEff > 0 && maxEff < MAX_UNIT_LEVEL) {
      for (const k of borderTargets(state, province)) {
        const d = tileDefense(state, k, player);
        // Skip what we can already take, and defence-4 walls — those need a
        // tower-boosted baron (the siege game), not a bigger unit.
        if (d < maxEff || d >= MAX_STRUCTURE_DEFENSE) continue;
        const v = targetValue(state, k, player, diff, style, memo);
        if (v > bestV) { bestV = v; target = { k, d }; }
      }
    }
    if (target) {
      const uks = province.tiles
        .filter(k => {
          const t = state.tiles.get(k);
          return t.unit && t.unit.level < MAX_UNIT_LEVEL;
        })
        .sort((a, b) => hexDistance(a, target.k) - hexDistance(b, target.k));
      const uk = uks[0];
      for (let guard = 0; uk && guard < MAX_UNIT_LEVEL; guard++) {
        const lvl = state.tiles.get(uk).unit.level;
        if (lvl > target.d || lvl >= MAX_UNIT_LEVEL) break; // strong enough
        if (province.money < unitCost(state, player) + diff.reserve) break;
        const extra = UNIT_UPKEEP[lvl + 1] - UNIT_UPKEEP[lvl];
        const net = provinceIncome(state, province) - provinceUpkeep(state, province);
        if (net - extra < 0 && province.money < 50) break; // not into bankruptcy
        if (!buyUnit(state, province.capitalKey, uk).ok) break;
      }
    }
  }

  // War-phase walls: the enemy can churn undefended gains straight back, so
  // before peasants drain the treasury, put one tower where it covers the
  // most tiles the enemy could actually capture next turn.
  if (diff.walls && atWar &&
      province.money >= towerBuildCost(state, player) + UNIT_COST + diff.reserve) {
    const threatened = computeCapturableTiles(state, player);
    let best = null, bestCover = 1.75; // a wall must protect at least 2 tiles
    if (threatened.size >= 2) {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (t.unit || t.structure || t.tree || t.grave || t.landmark) continue;
        if (tileDefense(state, k) >= 2) continue; // already covered
        let cover = threatened.has(k) ? 1 : 0;
        for (const nk of neighborKeys(k)) {
          const nt = state.tiles.get(nk);
          if (nt && nt.owner === player && threatened.has(nk)) cover++;
        }
        if (t.terrain === "hills") cover += 0.25; // +1 defence up there
        if (cover > bestCover) { bestCover = cover; best = k; }
      }
    }
    if (best) buyTower(state, province.capitalKey, best);
  }

  // Buy units that immediately capture something.
  for (let bought = 0; bought < diff.buyCap; bought++) {
    const buyMemo = diff.smart ? new Map() : null; // fresh: captures reshape provinces
    if (bought > 0 && rand(state) > style.unitZeal) break;
    const p = state.provinces.find(x => x.id === province.id) ||
      state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
    if (!p) return;
    province = p;
    if (province.money < unitCost(state, player) + diff.reserve) break;
    const net = provinceIncome(state, province) - provinceUpkeep(state, province);
    if (net - UNIT_UPKEEP[1] + 1 < 0 && province.money < 30) break;

    const targets = borderTargets(state, province)
      .filter(k => canCapture(state, 1, k, player))
      .filter(k => {
        if (!diff.raidgate || !atWar) return true;
        const t = state.tiles.get(k);
        if (t.owner === -1) return true; // neutral expansion is always fine
        // A peasant dropped on a plain enemy tile flips straight back next
        // turn — only real prizes (structures, landmarks, throne, cuts)
        // justify the coins.
        return targetValue(state, k, player, diff, style, buyMemo) >= 8;
      })
      .sort((a, b) =>
        targetValue(state, b, player, diff, style, buyMemo) -
        targetValue(state, a, player, diff, style, buyMemo));
    if (targets.length === 0) break;
    if (!buyUnit(state, province.capitalKey, targets[0]).ok) break;
  }

  // Add a tower on a threatened border tile.
  const p = state.provinces.find(x => x.owner === player && x.tiles.includes(province.capitalKey));
  if (!p) return;
  province = p;
  if (rand(state) < style.towerChance) {
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
    if (spot && province.money >= towerBuildCost(state, player) + UNIT_COST + diff.reserve) {
      buyTower(state, province.capitalKey, spot);
    } else if (!spot) {
      // No room for a new tower: climb the upgrade ladder on a frontline one,
      // cheapest (lowest-level) first.
      const ups = province.tiles
        .filter(k => {
          const t = state.tiles.get(k);
          return t.structure === "tower" && (t.structureLevel || 1) < MAX_TOWER_LEVEL && nearEnemy(k);
        })
        .sort((a, b) =>
          (state.tiles.get(a).structureLevel || 1) - (state.tiles.get(b).structureLevel || 1));
      const up = ups[0];
      if (up) {
        const cost = towerUpgradeCost(state, player, (state.tiles.get(up).structureLevel || 1) + 1);
        if (province.money >= cost + UNIT_COST + diff.reserve) {
          buyTower(state, province.capitalKey, up);
        }
      }
    }
  }
}

// Keep a unit standing on a throne we hold; the crown clock depends on it.
function garrisonThrone(state, player, province) {
  const throne = state.tiles.get(THRONE_KEY);
  if (!throne || throne.landmark !== "throne") return;
  if (throne.owner !== player || throne.unit) return;
  if (!province.tiles.includes(THRONE_KEY)) return;
  const idle = province.tiles
    .filter(k => {
      const t = state.tiles.get(k);
      return t.unit && !t.unit.moved;
    })
    .sort((a, b) => hexDistance(a, THRONE_KEY) - hexDistance(b, THRONE_KEY));
  for (const uk of idle) {
    if (moveUnit(state, uk, THRONE_KEY).ok) return;
  }
}

function repositionIdleUnits(state, player, province) {
  let idle = province.tiles.filter(k => {
    const t = state.tiles.get(k);
    return t.unit && !t.unit.moved;
  });
  if (idle.length === 0) return;

  const throne = state.tiles.get(THRONE_KEY);
  const throneActive = throne && throne.landmark === "throne";

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

  // March gradient: toward the throne while someone else has it (or it is
  // unclaimed), otherwise toward the border as usual.
  const contested = throneActive && throne.owner !== player;
  const gradient = k => contested
    ? hexDistance(k, THRONE_KEY)
    : (borderDist.get(k) ?? Infinity);

  for (const uk of idle) {
    const here = gradient(uk);
    if (!contested && here === 0) continue; // already on the border
    const unit = state.tiles.get(uk).unit;
    const dist = reachableWithin(state, uk, moveRange(state, player, unit));
    let spot = null, bestD = here;
    for (const k of dist.keys()) {
      const t = state.tiles.get(k);
      if (t.unit || t.tree || t.grave) continue;
      if (t.structure && t.structure !== "farm") continue;
      const d = gradient(k);
      if (d < bestD) { bestD = d; spot = k; }
    }
    if (spot) moveUnit(state, uk, spot);
  }
}
