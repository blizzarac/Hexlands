// Input handling and HUD wiring. Owns the selection/placement state machine.
"use strict";

function createUI(canvas, renderer, callbacks) {
  const ui = {
    selectedProvinceKey: null, // any tile key inside the selected province
    selectedUnitKey: null,
    placing: null,             // 'unit' | 'tower' | 'strongtower' | 'farm'
    highlights: new Map(),     // tile key -> 'move' | 'capture' | 'build'
  };

  // --- camera controls -----------------------------------------------------
  let dragging = false, dragMoved = false;
  let lastX = 0, lastY = 0;
  const activePointers = new Map();
  let pinchDist = 0;

  canvas.addEventListener("pointerdown", e => {
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
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        renderer.camera.scale = clampScale(renderer.camera.scale * d / pinchDist);
      }
      pinchDist = d;
      dragMoved = true;
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
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

  // --- highlight computation ----------------------------------------------

  ui.computeUnitHighlights = (state, fromKey) => {
    ui.highlights = new Map();
    const province = provinceAt(state, fromKey);
    const from = state.tiles.get(fromKey);
    if (!province || !from || !from.unit) return;
    const level = from.unit.level;
    for (const k of province.tiles) {
      if (k === fromKey) continue;
      const t = state.tiles.get(k);
      if (t.structure) continue;
      if (t.unit && t.unit.level + level > MAX_UNIT_LEVEL) continue;
      ui.highlights.set(k, "move");
    }
    for (const k of borderTargets(state, province)) {
      if (canCapture(state, level, k, state.currentPlayer)) ui.highlights.set(k, "capture");
    }
  };

  ui.computePlacementHighlights = (state, provinceKey, kind) => {
    ui.highlights = new Map();
    const province = provinceAt(state, provinceKey);
    if (!province) return;
    if (kind === "unit") {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (t.structure) continue;
        if (t.unit && t.unit.level >= MAX_UNIT_LEVEL) continue;
        ui.highlights.set(k, "move");
      }
      for (const k of borderTargets(state, province)) {
        if (canCapture(state, 1, k, state.currentPlayer)) ui.highlights.set(k, "capture");
      }
    } else if (kind === "farm") {
      for (const k of province.tiles) {
        if (canPlaceFarm(state, province, k)) ui.highlights.set(k, "build");
      }
    } else {
      for (const k of province.tiles) {
        const t = state.tiles.get(k);
        if (!t.unit && !t.structure && !t.tree && !t.grave) ui.highlights.set(k, "build");
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
  document.getElementById("round-label").textContent = `Round ${state.round}`;

  const chips = document.getElementById("player-chips");
  chips.innerHTML = "";
  for (const pl of state.players) {
    const alive = playerAlive(state, pl.id);
    const tiles = [...state.tiles.values()].filter(t => t.owner === pl.id).length;
    const style = pl.aiStyle ? AI_STYLES[pl.aiStyle] : null;
    const chip = document.createElement("span");
    chip.className = "chip" + (alive ? "" : " dead") +
      (pl.id === state.currentPlayer ? " current" : "");
    chip.innerHTML = `<span class="dot" style="background:${pl.color}"></span>` +
      `${pl.name}${style ? " " + style.icon : ""} · ${tiles}`;
    if (style) chip.title = `${style.label} (${AI_DIFFICULTIES[state.difficulty].label} difficulty)`;
    chips.appendChild(chip);
  }

  const province = ui.selectedProvinceKey ? provinceAt(state, ui.selectedProvinceKey) : null;
  const own = province && province.owner === 0 ? province : null;
  const moneyEl = document.getElementById("prov-money");
  const incomeEl = document.getElementById("prov-income");
  if (own) {
    const net = provinceIncome(state, own) - provinceUpkeep(state, own);
    moneyEl.textContent = `⬡ ${own.money}`;
    incomeEl.textContent = `${net >= 0 ? "+" : ""}${net} / round`;
    incomeEl.style.color = net >= 0 ? "#9fd89f" : "#e08a8a";
  } else {
    moneyEl.textContent = "—";
    incomeEl.textContent = "select a province";
    incomeEl.style.color = "#b8c4d0";
  }

  const canAct = !!own && !state.gameOver;
  const btn = id => document.getElementById(id);
  btn("btn-unit").disabled = !canAct || own.money < UNIT_COST;
  btn("btn-tower").disabled = !canAct || own.money < TOWER_COST;
  btn("btn-stower").disabled = !canAct || own.money < STRONG_TOWER_COST;
  btn("btn-farm").disabled = !canAct || own.money < farmCost(state, own);
  btn("btn-undo").disabled = !undoAvailable || !!state.gameOver;
  btn("btn-end").disabled = !!state.gameOver;
  document.getElementById("farm-cost").textContent =
    own ? `⬡${farmCost(state, own)}` : "⬡12";

  for (const [id, kind] of [["btn-unit", "unit"], ["btn-tower", "tower"],
    ["btn-stower", "strongtower"], ["btn-farm", "farm"]]) {
    btn(id).classList.toggle("armed", ui.placing === kind);
  }
}
