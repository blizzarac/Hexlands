// Input handling and HUD wiring. Owns the selection/placement state machine.
"use strict";

function createUI(canvas, renderer, callbacks) {
  const ui = {
    selectedProvinceKey: null, // any tile key inside the selected province
    selectedUnitKey: null,
    placing: null,             // 'unit' | 'tower' | 'farm' | 'sell'
    highlights: new Map(),     // tile key -> 'move' | 'capture' | 'build'
    threats: null,             // Set of own tile keys the enemy can capture
    recentCaptures: null,      // Map key -> previous owner, from last AI phase
  };

  // --- camera controls -----------------------------------------------------
  let dragging = false, dragMoved = false;
  let lastX = 0, lastY = 0;
  const activePointers = new Map();
  let pinchDist = 0;

  canvas.addEventListener("pointerdown", e => {
    callbacks.onHover(null);
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      dragging = true;
      dragMoved = false;
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  canvas.addEventListener("pointermove", e => {
    const p = activePointers.get(e.pointerId);
    if (!p) {
      // plain hover, no buttons down
      callbacks.onHover(renderer.screenToTileKey(e.clientX, e.clientY), e.clientX, e.clientY);
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        renderer.cancelPan();
        renderer.camera.scale = clampScale(renderer.camera.scale * d / pinchDist);
      }
      pinchDist = d;
      dragMoved = true;
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (dx || dy) renderer.cancelPan();
    renderer.camera.x -= dx / renderer.camera.scale;
    renderer.camera.y -= dy / renderer.camera.scale;
    if (Math.hypot(dx, dy) > 3) dragMoved = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const endPointer = e => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchDist = 0;
    if (activePointers.size === 0) {
      if (dragging && !dragMoved) {
        callbacks.onTileClick(renderer.screenToTileKey(e.clientX, e.clientY));
      }
      dragging = false;
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    renderer.cancelPan();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    renderer.camera.scale = clampScale(renderer.camera.scale * factor);
  }, { passive: false });

  function clampScale(s) { return Math.max(0.3, Math.min(3.5, s)); }

  window.addEventListener("keydown", e => {
    if (e.key === "Escape") callbacks.onCancel();
    if (e.key === "Enter") callbacks.onEndTurn();
  });

  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    callbacks.onCancel();
  });

  canvas.addEventListener("pointerleave", () => callbacks.onHover(null));

  // --- highlight computation ----------------------------------------------

  ui.computeUnitHighlights = (state, fromKey) => {
    ui.highlights = new Map();
    const province = provinceAt(state, fromKey);
    const from = state.tiles.get(fromKey);
    if (!province || !from || !from.unit) return;
    const level = from.unit.level;
    const effLevel = effectiveUnitLevel(state, fromKey);
    const range = moveRange(state, state.currentPlayer, from.unit);
    const dist = reachableWithin(state, fromKey, range);
    for (const k of dist.keys()) {
      if (k === fromKey) continue;
      const t = state.tiles.get(k);
      if (t.structure && t.structure !== "farm") continue;
      if (t.unit && t.unit.level + level > MAX_UNIT_LEVEL) continue;
      ui.highlights.set(k, "move");
    }
    // Capture targets: enemy/neutral tiles bordering a tile reachable with a
    // step to spare.
    for (const [k, d] of dist) {
      if (d > range - 1) continue;
      for (const nk of neighborKeys(k)) {
        const t = state.tiles.get(nk);
        if (!t || t.owner === state.currentPlayer || ui.highlights.get(nk) === "capture") continue;
        if (canCapture(state, effLevel, nk, state.currentPlayer)) ui.highlights.set(nk, "capture");
      }
    }
  };

  ui.computePlacementHighlights = (state, provinceKey, kind) => {
    ui.highlights = new Map();
    const province = provinceAt(state, provinceKey);
    if (!province) return;
    if (kind === "unit") {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (t.structure && t.structure !== "farm") continue;
        if (t.unit && t.unit.level >= MAX_UNIT_LEVEL) continue;
        ui.highlights.set(k, "move");
      }
      for (const k of borderTargets(state, province)) {
        if (canCapture(state, 1, k, state.currentPlayer)) ui.highlights.set(k, "capture");
      }
    } else if (kind === "sell") {
      for (const k of province.tiles) {
        if (sellPrice(state.tiles.get(k)) > 0) ui.highlights.set(k, "sell");
      }
    } else if (kind === "farm") {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (canPlaceFarm(state, province, k)) ui.highlights.set(k, "build");
        else if (t.structure === "farm" && (t.structureLevel || 1) < MAX_FARM_LEVEL) {
          ui.highlights.set(k, "upgrade");
        }
      }
    } else {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (!t.unit && !t.structure && !t.tree && !t.grave) ui.highlights.set(k, "build");
        else if (t.structure === "tower" && (t.structureLevel || 1) < MAX_TOWER_LEVEL) {
          ui.highlights.set(k, "upgrade");
        }
      }
    }
  };

  ui.clearSelection = () => {
    ui.selectedProvinceKey = null;
    ui.selectedUnitKey = null;
    ui.placing = null;
    ui.highlights = new Map();
  };

  return ui;
}

// --- tile analysis ----------------------------------------------------------

const UNIT_NAMES = [null, "Peasant", "Spearman", "Knight", "Baron"];
const TOWER_NAMES = [null, "Watchtower", "Fort", "Castle", "Citadel"];
const TERRAIN_LABELS = {
  plains: "Plains · 1 income",
  meadow: "Meadow · 2 income",
  hills: "Hills · no income, towers defend +1",
};

// Every own tile the enemy could capture on their next turn (delegates to
// the shared analysis in rules.js).
function computeThreats(state) {
  return computeCapturableTiles(state, 0);
}

function updateTileTooltip(state, key, sx, sy) {
  const el = document.getElementById("tile-tooltip");
  const t = state && key ? state.tiles.get(key) : null;
  if (!t) { el.classList.add("hidden"); return; }

  const rows = [];
  const ownerName = t.owner === -1 ? "Neutral"
    : t.owner === 0 ? "You" : state.players[t.owner].name;
  const ownerColor = t.owner === -1 ? "#b9bfae" : state.players[t.owner].color;
  rows.push(`<span class="tt-owner" style="color:${ownerColor}">${ownerName}</span>` +
    ` <span class="tt-dim">— ${TERRAIN_LABELS[t.terrain] || t.terrain}</span>`);

  if (t.tree) rows.push(`Tree <span class="tt-dim">— blocks income; chop for +${TREE_CHOP_REWARD}</span>`);
  if (t.grave) rows.push(`Gravestone <span class="tt-dim">— sprouts a tree next round</span>`);

  if (t.landmark === "mine") {
    rows.push(`Mine <span class="tt-dim">— +${MINE_INCOME} income to whoever holds it</span>`);
  } else if (t.landmark === "village") {
    rows.push(t.landmarkUsed
      ? `Village <span class="tt-dim">— already plundered</span>`
      : `Village <span class="tt-dim">— +${VILLAGE_PLUNDER} plunder on first capture</span>`);
  } else if (t.landmark === "fort") {
    rows.push(`Ancient fort <span class="tt-dim">— defends at ${ANCIENT_FORT_DEFENSE} while held; can't be built on</span>`);
  } else if (t.landmark === "throne") {
    rows.push(`👑 The Throne <span class="tt-dim">— +${THRONE_INCOME} income; hold for ` +
      `${THRONE_HOLD_ROUNDS} rounds to win (${state.throneHeldRounds}/${THRONE_HOLD_ROUNDS})</span>`);
  }

  if (t.structure === "capital") {
    const p = provinceAt(state, key);
    rows.push(`Capital <span class="tt-dim">— treasury ⬡${p ? p.money : 0}</span>`);
  } else if (t.structure === "tower") {
    const l = t.structureLevel || 1;
    rows.push(`${TOWER_NAMES[l]} <span class="tt-dim">— boost range ${TOWER_AURA_RANGE[l]}</span>`);
  } else if (t.structure === "farm") {
    const l = t.structureLevel || 1;
    const inc = (FARM_INCOME[t.terrain] ?? FARM_INCOME.plains) * l;
    rows.push(`Farm level ${l} <span class="tt-dim">— +${inc} income</span>`);
  }

  if (t.unit) {
    const eff = effectiveUnitLevel(state, key);
    rows.push(`${UNIT_NAMES[t.unit.level]} <span class="tt-dim">— level ${t.unit.level}` +
      `${eff > t.unit.level ? `, boosted to ${eff}` : ""}` +
      `${t.unit.moved && t.owner === state.currentPlayer ? ", done this turn" : ""}</span>`);
  }

  if (t.owner >= 0) {
    rows.push(`<span class="tt-dim">Defence</span> ${tileDefense(state, key)}`);
    const p = provinceAt(state, key);
    if (p && p.owner === 0) {
      const net = provinceIncome(state, p) - provinceUpkeep(state, p);
      if (p.money + net < 0) rows.push(`<span class="tt-warn">⚠ Province goes bankrupt next round</span>`);
    }
  }

  el.innerHTML = rows.join("<br>");
  el.classList.remove("hidden");
  const pad = 14;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = sx + pad, top = sy + pad;
  if (left + w > window.innerWidth - 8) left = sx - w - pad;
  if (top + h > window.innerHeight - 8) top = sy - h - pad;
  el.style.left = left + "px";
  el.style.top = top + "px";
}

// Plain-language landmark explanation, used as a toast when one is clicked.
function landmarkDescription(tile) {
  if (tile.landmark === "mine") {
    return `⛏ Mine — pays +${MINE_INCOME} income every round to whoever holds this tile.`;
  }
  if (tile.landmark === "village") {
    return tile.landmarkUsed
      ? "Village — already plundered; it's just scorched ground now."
      : `Village — the first player to capture it plunders +${VILLAGE_PLUNDER} coins.`;
  }
  if (tile.landmark === "fort") {
    return `Ancient fort — while held, it defends this tile and its neighbours at level ${ANCIENT_FORT_DEFENSE}. It can't be built on and survives capture.`;
  }
  if (tile.landmark === "throne") {
    return `👑 The Throne — +${THRONE_INCOME} income while held. Hold it for ` +
      `${THRONE_HOLD_ROUNDS} consecutive rounds to win the duel. It has no ` +
      `defence of its own — garrison it or lose it.`;
  }
  return null;
}

// --- HUD helpers ------------------------------------------------------------

let toastTimer = null;
function showToast(text, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function updateHUD(state, ui, undoAvailable) {
  document.getElementById("round-label").textContent = state.mode === "duel"
    ? `Round ${state.round} / ${DUEL_ROUND_LIMIT}`
    : `Round ${state.round}`;

  const chips = document.getElementById("player-chips");
  chips.innerHTML = "";
  for (const pl of state.players) {
    const alive = playerAlive(state, pl.id);
    const tiles = [...state.tiles.values()].filter(t => t.owner === pl.id).length;
    const style = pl.aiStyle ? AI_STYLES[pl.aiStyle] : null;
    const doctrineIcons = (pl.doctrines || []).map(id => DOCTRINES[id].icon).join("");
    const chip = document.createElement("span");
    chip.className = "chip" + (alive ? "" : " dead") +
      (pl.id === state.currentPlayer ? " current" : "");
    chip.innerHTML = `<span class="dot" style="background:${pl.color}"></span>` +
      `${pl.name}${style ? " " + style.icon : ""} · ${tiles}` +
      (doctrineIcons ? ` ${doctrineIcons}` : "");
    const titleParts = [];
    if (style) titleParts.push(`${style.label} (${AI_DIFFICULTIES[state.difficulty].label} difficulty)`);
    if (pl.doctrines && pl.doctrines.length) {
      titleParts.push("Doctrines: " + pl.doctrines.map(id => DOCTRINES[id].name).join(", "));
    }
    if (titleParts.length) chip.title = titleParts.join(" — ");
    chips.appendChild(chip);
  }

  const throneEl = document.getElementById("throne-status");
  const throne = state.tiles.get(THRONE_KEY);
  if (throne && throne.landmark === "throne") {
    throneEl.classList.remove("hidden");
    throneEl.classList.toggle("danger", state.throneHolder > 0);
    if (state.throneHolder === 0) {
      throneEl.textContent = `👑 Throne: yours — ${state.throneHeldRounds}/${THRONE_HOLD_ROUNDS}`;
    } else if (state.throneHolder > 0) {
      throneEl.textContent = `👑 Throne: enemy — ${state.throneHeldRounds}/${THRONE_HOLD_ROUNDS}`;
    } else {
      throneEl.textContent = "👑 Throne unclaimed";
    }
  } else {
    throneEl.classList.add("hidden");
  }

  const province = ui.selectedProvinceKey ? provinceAt(state, ui.selectedProvinceKey) : null;
  const own = province && province.owner === 0 ? province : null;
  const moneyEl = document.getElementById("prov-money");
  const incomeEl = document.getElementById("prov-income");
  if (own) {
    const net = provinceIncome(state, own) - provinceUpkeep(state, own);
    moneyEl.textContent = `⬡ ${own.money}`;
    incomeEl.textContent = `${net >= 0 ? "+" : ""}${net} / round` +
      (own.money + net < 0 ? " — ⚠ bankrupt next round!" : "");
    incomeEl.style.color = net >= 0 ? "#9fd89f" : "#e08a8a";
  } else {
    moneyEl.textContent = "—";
    incomeEl.textContent = "select a province";
    incomeEl.style.color = "#b8c4d0";
  }

  const canAct = !!own && !state.gameOver;
  const btn = id => document.getElementById(id);
  const cheapestTowerAction = own ? Math.min(towerBuildCost(state, 0),
    ...own.tiles
      .filter(k => {
        const t = state.tiles.get(k);
        return t.structure === "tower" && (t.structureLevel || 1) < MAX_TOWER_LEVEL;
      })
      .map(k => towerUpgradeCost(state, 0, (state.tiles.get(k).structureLevel || 1) + 1))
  ) : Infinity;
  const cheapestFarmAction = own ? Math.min(farmCost(state, own),
    ...own.tiles
      .filter(k => {
        const t = state.tiles.get(k);
        return t.structure === "farm" && (t.structureLevel || 1) < MAX_FARM_LEVEL;
      })
      .map(k => FARM_UPGRADE_COSTS[(state.tiles.get(k).structureLevel || 1) + 1])
  ) : Infinity;
  btn("btn-unit").textContent = `Unit ⬡${unitCost(state, 0)}`;
  btn("btn-tower").textContent = `Tower ⬡${towerBuildCost(state, 0)}`;
  btn("btn-unit").disabled = !canAct || own.money < unitCost(state, 0);
  btn("btn-tower").disabled = !canAct || own.money < cheapestTowerAction;
  btn("btn-farm").disabled = !canAct || own.money < cheapestFarmAction;
  btn("btn-sell").disabled = !canAct ||
    !own.tiles.some(k => sellPrice(state.tiles.get(k)) > 0);
  btn("btn-undo").disabled = !undoAvailable || !!state.gameOver;
  btn("btn-end").disabled = !!state.gameOver;
  document.getElementById("farm-cost").textContent =
    own ? `⬡${farmCost(state, own)}` : "⬡12";

  for (const [id, kind] of [["btn-unit", "unit"], ["btn-tower", "tower"],
    ["btn-farm", "farm"], ["btn-sell", "sell"]]) {
    btn(id).classList.toggle("armed", ui.placing === kind);
  }
}
