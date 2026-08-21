// Bootstrap and turn sequencing.
"use strict";

(function () {
  const canvas = document.getElementById("game");
  const renderer = createRenderer(canvas);

  let state = null;
  let undoStack = [];
  let ui = null;
  let playback = null; // active AI-turn replay, see startPlayback()

  function startGame() {
    if (playback) endPlayback();
    const mode = document.getElementById("opt-mode").value;
    const tileCount = +document.getElementById("opt-size").value;
    const aiCount = +document.getElementById("opt-ai").value;
    const difficulty = document.getElementById("opt-diff").value;
    state = newGame({ mode, tileCount, aiCount, difficulty });
    undoStack = [];
    ui.clearSelection();
    document.getElementById("start-overlay").classList.add("hidden");
    document.getElementById("end-overlay").classList.add("hidden");
    ui.recentCaptures = null;
    renderer.resize();
    renderer.fitToMap(state);
    startPlayerTurn(state, 0);
    saveGame();
    refresh();
  }

  function refresh() {
    ui.threats = state.gameOver ? null : computeThreats(state);
    updateHUD(state, ui, undoStack.length > 0);
  }

  // --- persistence ---------------------------------------------------------
  const SAVE_KEY = "hexlands-save-1";

  function saveGame() {
    try {
      if (!state || state.gameOver) {
        localStorage.removeItem(SAVE_KEY);
      } else {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          snapshot: snapshotState(state),
          players: state.players,
          history: state.history || [],
        }));
      }
    } catch (e) { /* storage unavailable: play without saves */ }
    updateContinueButton();
  }

  function hasSave() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  function updateContinueButton() {
    document.getElementById("btn-continue").classList.toggle("hidden", !hasSave());
  }

  function resumeGame() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { /* fall through */ }
    if (!data) { updateContinueButton(); return; }
    loadGameData(data);
  }

  // Shared loader for saved games and imported files: data must carry
  // { snapshot, players, history }.
  function loadGameData(data) {
    if (playback) endPlayback();
    state = {
      tiles: new Map(), players: data.players, provinces: [],
      nextProvinceId: 1, currentPlayer: 0, round: 1,
      mode: "standard", difficulty: "normal", rngState: null,
      throneHolder: -1, throneHeldRounds: 0,
      history: data.history || [],
      gameOver: null, gameOverReason: null,
    };
    restoreState(state, data.snapshot);
    undoStack = [];
    ui.clearSelection();
    ui.recentCaptures = null;
    document.getElementById("start-overlay").classList.add("hidden");
    document.getElementById("end-overlay").classList.add("hidden");
    renderer.resize();
    renderer.fitToMap(state);
    refresh();
    maybeShowDoctrinePick();
  }

  // --- export / import -----------------------------------------------------

  function buildExport() {
    return {
      format: "hexlands-game",
      version: 1,
      exported: new Date().toISOString(),
      players: state.players,
      history: state.history || [],
      state: JSON.parse(snapshotState(state)),
    };
  }

  function onExport() {
    if (!state) return;
    if (playback) endPlayback(); // export the real end-of-turn state
    const blob = new Blob([JSON.stringify(buildExport(), null, 1)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hexlands-${state.mode}-round${state.round}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("Game exported — full state and move history");
  }

  function importGame(data) {
    if (!data || data.format !== "hexlands-game") {
      showToast("Not a Hexlands game file");
      return false;
    }
    if (data.version !== 1) {
      showToast(`Unsupported game-file version (${data.version})`);
      return false;
    }
    try {
      loadGameData({
        snapshot: JSON.stringify(data.state),
        players: data.players,
        history: data.history,
      });
      saveGame();
      showToast(`Game imported — ${state.mode}, round ${state.round}`);
      if (state.gameOver) maybeShowGameOver();
      return true;
    } catch (e) {
      showToast("Import failed — file looks corrupted");
      return false;
    }
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data = null;
      try { data = JSON.parse(reader.result); } catch (err) { /* handled below */ }
      importGame(data);
    };
    reader.readAsText(file);
  }

  function attempt(fn) {
    const snapshot = snapshotState(state);
    const result = fn();
    if (result.ok) {
      undoStack.push(snapshot);
      if (undoStack.length > 50) undoStack.shift();
      maybeShowGameOver();
      saveGame();
    } else if (result.reason) {
      showToast(result.reason);
    }
    return result.ok;
  }

  function onTileClick(key) {
    if (playback) { endPlayback(); return; } // any click skips the AI replay
    if (!state || state.gameOver || state.currentPlayer !== 0) return;
    const tile = state.tiles.get(key);

    // Clicking a landmark always explains it (hover isn't available on touch).
    if (tile && tile.landmark) {
      const desc = landmarkDescription(tile);
      if (desc) showToast(desc, 3500);
    }

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
    if (playback) return;
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

  // Ending the turn runs the whole AI phase instantly and invisibly, then —
  // if "Watch AI moves" is on — rewinds the visible board and replays the
  // recorded history entries one by one with the camera following along.
  // The invisible result is authoritative: when the replay ends (or is
  // skipped) it is swapped in wholesale, so replay fidelity can never
  // corrupt the game, and duel determinism is untouched.
  function onEndTurn() {
    if (!state || state.gameOver || state.currentPlayer !== 0 || playback) return;
    ui.clearSelection();
    undoStack = [];

    const preSnapshot = snapshotState(state);
    const preLen = state.history ? state.history.length : 0;

    // Record the board before the AI phase so their captures can be flagged.
    const ownerBefore = new Map();
    for (const [k, t] of state.tiles) ownerBefore.set(k, t.owner);

    for (const pl of state.players) {
      if (pl.id === 0 || !playerAlive(state, pl.id)) continue;
      state.currentPlayer = pl.id;
      startPlayerTurn(state, pl.id);
      aiPickDoctrines(state, pl.id);
      runAITurn(state, pl.id);
      checkGameOver(state);
      if (state.gameOver) break;
    }

    if (!state.gameOver) {
      state.round += 1;
      growTrees(state);
      updateThrone(state);
      state.currentPlayer = 0;
      if (!state.gameOver) startPlayerTurn(state, 0);
      checkGameOver(state);
    }

    const captures = new Map();
    for (const [k, t] of state.tiles) {
      const before = ownerBefore.get(k);
      if (before !== t.owner) captures.set(k, before);
    }

    saveGame(); // persist the authoritative post-turn state right away

    const entries = (state.history || []).slice(preLen);
    const watch = document.getElementById("opt-anim").checked;
    if (!watch || entries.length === 0) {
      ui.recentCaptures = captures;
      maybeShowGameOver();
      refresh();
      maybeShowDoctrinePick();
      return;
    }

    const postSnapshot = snapshotState(state);
    const postHistory = state.history.slice();
    restoreState(state, preSnapshot);
    startPlayback(entries, { postSnapshot, postHistory, captures });
  }

  // --- AI-turn playback ----------------------------------------------------

  function startPlayback(entries, post) {
    playback = {
      entries, post, idx: 0, timer: null,
      savedCam: {
        x: renderer.camera.x, y: renderer.camera.y, scale: renderer.camera.scale,
      },
      // spend ~5s total however many moves there are, within sane per-move bounds
      delay: Math.max(120, Math.min(450, Math.round(5000 / entries.length))),
    };
    document.getElementById("ai-banner").classList.remove("hidden");
    stepPlayback();
  }

  function setAiBanner(playerId) {
    const pl = state.players[playerId];
    const el = document.getElementById("ai-banner-text");
    el.textContent = `${pl.name} is moving…`;
    el.style.color = pl.color;
  }

  function stepPlayback() {
    const pb = playback;
    if (!pb) return;
    if (pb.idx >= pb.entries.length) { endPlayback(); return; }
    const entry = pb.entries[pb.idx];

    // Entering the next AI's turn: same sequencing as the invisible run.
    if (state.currentPlayer !== entry.p) {
      state.currentPlayer = entry.p;
      startPlayerTurn(state, entry.p);
    }
    setAiBanner(entry.p);

    const focusKey = entry.to || entry.at || entry.from;
    const tile = focusKey ? state.tiles.get(focusKey) : null;
    if (tile) {
      const { x, y } = hexToPixel(tile.q, tile.r, HEX_SIZE);
      renderer.panTo(x, y);
    }
    if (entry.a === "doctrine") {
      const d = DOCTRINES[entry.d];
      if (d) showToast(`${state.players[entry.p].name} adopts ${d.icon} ${d.name}`);
    }

    // Let the camera arrive, then apply the move and go on to the next one.
    pb.timer = setTimeout(() => {
      pb.timer = null;
      applyEntry(entry);
      if (!playback) return; // a failed replay step bailed out to the end state
      pb.idx += 1;
      updateHUD(state, ui, false);
      stepPlayback();
    }, pb.delay);
  }

  function applyEntry(entry) {
    let res = null;
    switch (entry.a) {
      case "move":     res = moveUnit(state, entry.from, entry.to); break;
      case "unit":     res = buyUnit(state, entry.c, entry.to); break;
      case "tower":    res = buyTower(state, entry.c, entry.to); break;
      case "farm":     res = buyFarm(state, entry.c, entry.to); break;
      case "sell":     res = sellAsset(state, entry.c, entry.at); break;
      case "doctrine": res = adoptDoctrine(state, entry.p, entry.d); break;
    }
    // Replay should mirror the invisible run exactly; if it ever can't,
    // jump straight to the authoritative end state instead of desyncing.
    if (!res || !res.ok) endPlayback();
  }

  // Finish (or skip) the replay: swap in the authoritative post-turn state
  // and glide the camera back to where the player left it.
  function endPlayback() {
    const pb = playback;
    if (!pb) return;
    playback = null;
    if (pb.timer) clearTimeout(pb.timer);
    document.getElementById("ai-banner").classList.add("hidden");
    state.history = pb.post.postHistory;
    restoreState(state, pb.post.postSnapshot);
    ui.recentCaptures = pb.post.captures;
    renderer.panTo(pb.savedCam.x, pb.savedCam.y, pb.savedCam.scale);
    maybeShowGameOver();
    refresh();
    maybeShowDoctrinePick();
  }

  function onUndo() {
    if (playback || undoStack.length === 0) return;
    restoreState(state, undoStack.pop());
    ui.clearSelection();
    saveGame();
    refresh();
  }

  function onCancel() {
    if (playback) { endPlayback(); return; }
    ui.placing = null;
    ui.selectedUnitKey = null;
    ui.highlights = new Map();
    refresh();
  }

  function maybeShowDoctrinePick() {
    const overlay = document.getElementById("doctrine-overlay");
    if (!state || state.gameOver || state.currentPlayer !== 0 ||
        pendingDoctrinePicks(state, 0) <= 0) {
      overlay.classList.add("hidden");
      return;
    }
    const cards = document.getElementById("doctrine-cards");
    cards.innerHTML = "";
    for (const [id, d] of Object.entries(DOCTRINES)) {
      if (state.players[0].doctrines.includes(id)) continue;
      const btn = document.createElement("button");
      btn.className = "doctrine-card";
      btn.innerHTML = `<span class="dc-icon">${d.icon}</span>` +
        `<span><div class="dc-name">${d.name}</div><div class="dc-desc">${d.desc}</div></span>`;
      btn.addEventListener("click", () => {
        if (!adoptDoctrine(state, 0, id).ok) return;
        showToast(`${d.icon} Doctrine adopted: ${d.name}`);
        saveGame();
        refresh();
        maybeShowDoctrinePick(); // another pick may still be pending
      });
      cards.appendChild(btn);
    }
    overlay.classList.remove("hidden");
  }

  function maybeShowGameOver() {
    if (!state.gameOver) return;
    const overlay = document.getElementById("end-overlay");
    const title = document.getElementById("end-title");
    const text = document.getElementById("end-text");
    title.textContent =
      state.gameOver === "victory" ? "Victory!" :
      state.gameOver === "draw" ? "Draw" : "Defeat";
    text.textContent = (state.gameOverReason || "") + ` (round ${state.round})`;
    overlay.classList.remove("hidden");
    saveGame(); // clears the save for a finished game
  }

  function onHover(key, sx, sy) {
    if (!state || key === null || sx === undefined) {
      updateTileTooltip(null, null, 0, 0);
      return;
    }
    updateTileTooltip(state, key, sx, sy);
  }

  ui = createUI(canvas, renderer, { onTileClick, onEndTurn, onCancel, onHover });

  document.getElementById("btn-start").addEventListener("click", startGame);

  function updateModeUI() {
    const duel = document.getElementById("opt-mode").value === "duel";
    document.getElementById("row-size").classList.toggle("hidden", duel);
    document.getElementById("row-ai").classList.toggle("hidden", duel);
    document.getElementById("mode-desc").textContent = duel
      ? "One fixed, mirror-symmetric map against a single Balanced opponent — " +
        "no randomness anywhere, so strategies can be studied like chess " +
        "lines. Hold the central Throne for 20 rounds to claim the crown."
      : "Conquer a random island against AI opponents with random personalities.";
  }
  document.getElementById("opt-mode").addEventListener("change", updateModeUI);
  updateModeUI();

  // Remember the "Watch AI moves" preference across visits.
  const animBox = document.getElementById("opt-anim");
  try {
    const saved = localStorage.getItem("hexlands-watch-ai");
    if (saved !== null) animBox.checked = saved === "1";
  } catch (e) { /* storage unavailable */ }
  animBox.addEventListener("change", () => {
    try { localStorage.setItem("hexlands-watch-ai", animBox.checked ? "1" : "0"); }
    catch (e) { /* storage unavailable */ }
  });
  updateContinueButton();
  document.getElementById("btn-restart").addEventListener("click", () => {
    document.getElementById("end-overlay").classList.add("hidden");
    document.getElementById("start-overlay").classList.remove("hidden");
  });
  document.getElementById("btn-unit").addEventListener("click", () => armPlacement("unit"));
  document.getElementById("btn-tower").addEventListener("click", () => armPlacement("tower"));
  document.getElementById("btn-farm").addEventListener("click", () => armPlacement("farm"));
  document.getElementById("btn-sell").addEventListener("click", () => armPlacement("sell"));
  document.getElementById("btn-continue").addEventListener("click", resumeGame);
  document.getElementById("btn-export").addEventListener("click", onExport);
  document.getElementById("btn-import").addEventListener("click",
    () => document.getElementById("import-file").click());
  document.getElementById("btn-import-start").addEventListener("click",
    () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", onImportFile);
  document.getElementById("btn-end").addEventListener("click", onEndTurn);
  document.getElementById("btn-undo").addEventListener("click", onUndo);

  window.addEventListener("resize", () => renderer.resize());
  renderer.resize();

  // Debug/testing handle (also handy when prototyping new features).
  window.hexlands = {
    getState: () => state,
    renderer,
    exportGame: () => buildExport(),
    importGame,
    isPlayingBack: () => !!playback,
    skipPlayback: () => endPlayback(),
  };

  (function loop() {
    if (state) renderer.draw(state, ui);
    requestAnimationFrame(loop);
  })();
})();
