// Bootstrap and turn sequencing.
"use strict";

(function () {
  const canvas = document.getElementById("game");
  const renderer = createRenderer(canvas);

  let state = null;
  let undoStack = [];
  let ui = null;

  function startGame() {
    const tileCount = +document.getElementById("opt-size").value;
    const aiCount = +document.getElementById("opt-ai").value;
    const difficulty = document.getElementById("opt-diff").value;
    state = newGame({ tileCount, aiCount, difficulty });
    undoStack = [];
    ui.clearSelection();
    document.getElementById("start-overlay").classList.add("hidden");
    document.getElementById("end-overlay").classList.add("hidden");
    renderer.resize();
    renderer.fitToMap(state);
    startPlayerTurn(state, 0);
    refresh();
  }

  function refresh() {
    updateHUD(state, ui, undoStack.length > 0);
  }

  function attempt(fn) {
    const snapshot = snapshotState(state);
    const result = fn();
    if (result.ok) {
      undoStack.push(snapshot);
      if (undoStack.length > 50) undoStack.shift();
      maybeShowGameOver();
    } else if (result.reason) {
      showToast(result.reason);
    }
    return result.ok;
  }

  function onTileClick(key) {
    if (!state || state.gameOver || state.currentPlayer !== 0) return;
    const tile = state.tiles.get(key);

    // Placement mode: try to place the armed purchase.
    if (ui.placing && ui.selectedProvinceKey) {
      const province = provinceAt(state, ui.selectedProvinceKey);
      if (province && ui.highlights.has(key)) {
        const capital = province.capitalKey;
        const kind = ui.placing;
        let soldFor = 0;
        const ok = attempt(() => {
          if (kind === "unit") return buyUnit(state, capital, key);
          if (kind === "farm") return buyFarm(state, capital, key);
          if (kind === "sell") {
            const result = sellAsset(state, capital, key);
            if (result.ok) soldFor = result.price;
            return result;
          }
          return buyTower(state, capital, key);
        });
        if (ok) {
          if (soldFor > 0) showToast(`Sold for ⬡${soldFor}`);
          ui.placing = null;
          ui.highlights = new Map();
          // keep the province selected (its tile set may have grown)
          ui.selectedProvinceKey = provinceAt(state, capital) ? capital : key;
        }
        refresh();
        return;
      }
      ui.placing = null;
      ui.highlights = new Map();
    }

    // Unit selected: try to move to the clicked tile.
    if (ui.selectedUnitKey && ui.highlights.has(key)) {
      const from = ui.selectedUnitKey;
      const ok = attempt(() => moveUnit(state, from, key));
      ui.selectedUnitKey = null;
      ui.highlights = new Map();
      if (ok) ui.selectedProvinceKey = key;
      refresh();
      return;
    }
    ui.selectedUnitKey = null;
    ui.highlights = new Map();

    if (!tile) {
      ui.clearSelection();
      refresh();
      return;
    }

    // Select own province; select unit too if the tile has a usable one.
    const province = provinceAt(state, key);
    if (province && province.owner === 0) {
      ui.selectedProvinceKey = key;
      if (tile.unit && !tile.unit.moved) {
        ui.selectedUnitKey = key;
        ui.computeUnitHighlights(state, key);
      }
    } else {
      ui.clearSelection();
    }
    refresh();
  }

  function armPlacement(kind) {
    if (!state || state.gameOver || !ui.selectedProvinceKey) {
      showToast("Select one of your provinces first");
      return;
    }
    const province = provinceAt(state, ui.selectedProvinceKey);
    if (!province || province.owner !== 0) {
      showToast("Select one of your provinces first");
      return;
    }
    if (ui.placing === kind) {
      ui.placing = null;
      ui.highlights = new Map();
    } else {
      ui.placing = kind;
      ui.selectedUnitKey = null;
      ui.computePlacementHighlights(state, ui.selectedProvinceKey, kind);
    }
    refresh();
  }

  function onEndTurn() {
    if (!state || state.gameOver || state.currentPlayer !== 0) return;
    ui.clearSelection();
    undoStack = [];

    for (const pl of state.players) {
      if (pl.id === 0 || !playerAlive(state, pl.id)) continue;
      state.currentPlayer = pl.id;
      startPlayerTurn(state, pl.id);
      runAITurn(state, pl.id);
      checkGameOver(state);
      if (state.gameOver) break;
    }

    if (!state.gameOver) {
      state.round += 1;
      growTrees(state);
      state.currentPlayer = 0;
      startPlayerTurn(state, 0);
      checkGameOver(state);
    }
    maybeShowGameOver();
    refresh();
  }

  function onUndo() {
    if (undoStack.length === 0) return;
    restoreState(state, undoStack.pop());
    ui.clearSelection();
    refresh();
  }

  function onCancel() {
    ui.placing = null;
    ui.selectedUnitKey = null;
    ui.highlights = new Map();
    refresh();
  }

  function maybeShowGameOver() {
    if (!state.gameOver) return;
    const overlay = document.getElementById("end-overlay");
    const title = document.getElementById("end-title");
    const text = document.getElementById("end-text");
    if (state.gameOver === "victory") {
      title.textContent = "Victory!";
      text.textContent = `You conquered the island in ${state.round} rounds.`;
    } else {
      title.textContent = "Defeat";
      text.textContent = "Your last province has fallen.";
    }
    overlay.classList.remove("hidden");
  }

  ui = createUI(canvas, renderer, { onTileClick, onEndTurn, onCancel });

  document.getElementById("btn-start").addEventListener("click", startGame);
  document.getElementById("btn-restart").addEventListener("click", () => {
    document.getElementById("end-overlay").classList.add("hidden");
    document.getElementById("start-overlay").classList.remove("hidden");
  });
  document.getElementById("btn-unit").addEventListener("click", () => armPlacement("unit"));
  document.getElementById("btn-tower").addEventListener("click", () => armPlacement("tower"));
  document.getElementById("btn-farm").addEventListener("click", () => armPlacement("farm"));
  document.getElementById("btn-sell").addEventListener("click", () => armPlacement("sell"));
  document.getElementById("btn-end").addEventListener("click", onEndTurn);
  document.getElementById("btn-undo").addEventListener("click", onUndo);

  window.addEventListener("resize", () => renderer.resize());
  renderer.resize();

  // Debug/testing handle (also handy when prototyping new features).
  window.hexlands = { getState: () => state, renderer };

  (function loop() {
    if (state) renderer.draw(state, ui);
    requestAnimationFrame(loop);
  })();
})();
