// Canvas rendering: tiles, objects, highlights, HUD-adjacent labels.
"use strict";

const NEUTRAL_COLOR = "#8f957f";
const HEX_SIZE = 26;

function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const camera = { x: 0, y: 0, scale: 1 };
  const corners = hexCorners(HEX_SIZE);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }

  function fitToMap(state) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of state.tiles.values()) {
      const { x, y } = hexToPixel(t.q, t.r, HEX_SIZE);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const w = maxX - minX + HEX_SIZE * 4;
    const h = maxY - minY + HEX_SIZE * 4;
    camera.scale = Math.min(canvas.clientWidth / w, (canvas.clientHeight - 120) / h, 1.6);
    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - canvas.clientWidth / 2) / camera.scale + camera.x,
      y: (sy - canvas.clientHeight / 2) / camera.scale + camera.y,
    };
  }

  function screenToTileKey(sx, sy) {
    const { x, y } = screenToWorld(sx, sy);
    const { q, r } = pixelToHex(x, y, HEX_SIZE);
    return keyOf(q, r);
  }

  function hexPath(cx, cy, scale = 1) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const [dx, dy] = corners[i];
      const x = cx + dx * scale, y = cy + dy * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, v + amount));
    const r = ch(n >> 16), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `rgb(${r},${g},${b})`;
  }

  // Blend a base '#rrggbb' colour toward another by factor t (0..1).
  function mix(hexA, hexB, t) {
    const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
    const ch = (sa, sb) => Math.round(sa + (sb - sa) * t);
    const r = ch(a >> 16, b >> 16);
    const g = ch((a >> 8) & 255, (b >> 8) & 255);
    const bl = ch(a & 255, b & 255);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  function terrainColor(base, terrain) {
    if (terrain === "meadow") return mix(base, "#57b85f", 0.28);
    if (terrain === "hills") return mix(base, "#55504b", 0.38);
    return base;
  }

  function draw(state, view) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    const selectedProvince = view.selectedProvinceKey
      ? provinceAt(state, view.selectedProvinceKey) : null;
    const selectedTiles = selectedProvince ? new Set(selectedProvince.tiles) : null;

    // Tile fills
    for (const t of state.tiles.values()) {
      const { x, y } = hexToPixel(t.q, t.r, HEX_SIZE);
      const owned = t.owner >= 0 ? state.players[t.owner].color : NEUTRAL_COLOR;
      const base = terrainColor(owned, t.terrain);
      hexPath(x, y, 0.985);
      ctx.fillStyle = selectedTiles && selectedTiles.has(keyOf(t.q, t.r)) ? shade(base, 26) : base;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Tower aura glow inside the selected province: shows where units gain +1
    if (selectedProvince) {
      ctx.fillStyle = "rgba(255,210,74,0.16)";
      for (const k of selectedProvince.tiles) {
        if (!hasTowerAura(state, k, selectedProvince.owner)) continue;
        const { q, r } = parseKey(k);
        const { x, y } = hexToPixel(q, r, HEX_SIZE);
        hexPath(x, y, 0.72);
        ctx.fill();
      }
    }

    // Selected-province outline
    if (selectedProvince) {
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      for (const k of selectedProvince.tiles) {
        const { q, r } = parseKey(k);
        const { x, y } = hexToPixel(q, r, HEX_SIZE);
        const neigh = neighborKeys(k);
        for (let i = 0; i < 6; i++) {
          // Edge i sits between corners at 60i-30° and 60i+30°; its midpoint
          // points at 60i°, which is neighbour direction HEX_DIRS[(6 - i) % 6].
          const nk = neigh[(6 - i) % 6];
          if (selectedProvince.tiles.includes(nk)) continue;
          const [ax, ay] = corners[i];
          const [bx, by] = corners[(i + 1) % 6];
          ctx.beginPath();
          ctx.moveTo(x + ax, y + ay);
          ctx.lineTo(x + bx, y + by);
          ctx.stroke();
        }
      }
    }

    // Threat marks (always on): own tiles the enemy could capture next turn.
    // Kept subtle so they read as ambient information, not an alarm.
    if (view.threats) {
      ctx.setLineDash([3, 3.5]);
      for (const k of view.threats) {
        const { q, r } = parseKey(k);
        const { x, y } = hexToPixel(q, r, HEX_SIZE);
        hexPath(x, y, 0.86);
        ctx.strokeStyle = "rgba(225,75,60,0.65)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Tiles that changed hands during the last AI phase pulse briefly-forever
    // until the next end of turn; tiles YOU lost pulse red, others white.
    if (view.recentCaptures && view.recentCaptures.size) {
      const pulse = 0.45 + 0.35 * Math.sin(performance.now() / 280);
      for (const [k, prevOwner] of view.recentCaptures) {
        const { q, r } = parseKey(k);
        const { x, y } = hexToPixel(q, r, HEX_SIZE);
        hexPath(x, y, 0.9);
        ctx.strokeStyle = prevOwner === 0
          ? `rgba(255,80,60,${pulse})`
          : `rgba(255,255,255,${pulse * 0.8})`;
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }

    // Move/build target highlights
    if (view.highlights) {
      for (const [k, kind] of view.highlights) {
        const { q, r } = parseKey(k);
        const { x, y } = hexToPixel(q, r, HEX_SIZE);
        if (kind === "capture") {
          hexPath(x, y, 0.8);
          ctx.strokeStyle = "rgba(255,70,60,0.95)";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else if (kind === "upgrade") {
          hexPath(x, y, 0.8);
          ctx.strokeStyle = "rgba(255,210,74,0.95)";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else if (kind === "sell") {
          hexPath(x, y, 0.8);
          ctx.strokeStyle = "rgba(240,140,60,0.95)";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fill();
        }
      }
    }

    // Objects
    for (const [k, t] of state.tiles) {
      const { x, y } = hexToPixel(t.q, t.r, HEX_SIZE);
      if (t.terrain === "hills" && !t.landmark) drawHills(x, y);
      else if (t.terrain === "meadow" && !t.structure && !t.unit && !t.landmark) drawMeadow(x, y);
      if (t.landmark === "mine") drawMine(x, y);
      else if (t.landmark === "village") drawVillage(x, y, t.landmarkUsed);
      else if (t.landmark === "fort") drawAncientFort(x, y);
      if (t.tree) drawTree(x, y, t.tree);
      if (t.grave) drawGrave(x, y);
      if (t.structure === "capital") {
        drawCapital(x, y, t.owner >= 0 ? state.players[t.owner].color : "#d9a13f");
      }
      if (t.structure === "tower") drawTower(x, y, t.structureLevel || 1);
      if (t.structure === "farm") drawFarm(x, y, t.structureLevel || 1);
      if (t.unit) {
        drawUnit(x, y, t.unit,
          t.owner === state.currentPlayer && !state.players[t.owner].isAI,
          hasTowerAura(state, k, t.owner));
      }
    }

    // Selected unit marker
    if (view.selectedUnitKey) {
      const { q, r } = parseKey(view.selectedUnitKey);
      const { x, y } = hexToPixel(q, r, HEX_SIZE);
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Treasury labels on capitals; own provinces headed for bankruptcy get a
    // red warning marker.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of state.provinces) {
      const { q, r } = parseKey(p.capitalKey);
      const { x, y } = hexToPixel(q, r, HEX_SIZE);
      const label = String(p.money);
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.strokeText(label, x, y - HEX_SIZE * 0.72);
      ctx.fillStyle = "#ffe9a8";
      ctx.fillText(label, x, y - HEX_SIZE * 0.72);
      if (p.owner === 0 &&
          p.money + provinceIncome(state, p) - provinceUpkeep(state, p) < 0) {
        const wx = x - 8 - 4 * String(p.money).length, wy = y - HEX_SIZE * 0.72;
        ctx.beginPath();
        ctx.arc(wx, wy, 5.4, 0, Math.PI * 2);
        ctx.fillStyle = "#c43a30";
        ctx.fill();
        ctx.strokeStyle = "#5e1712";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#ffe9a8";
        ctx.font = "bold 8.5px system-ui, sans-serif";
        ctx.fillText("!", wx, wy + 0.5);
      }
    }
  }

  function drawHills(x, y) {
    ctx.fillStyle = "rgba(60,55,50,0.55)";
    ctx.strokeStyle = "rgba(30,27,24,0.6)";
    ctx.lineWidth = 1;
    for (const [dx, w] of [[-5, 7], [4, 5.5]]) {
      ctx.beginPath();
      ctx.moveTo(x + dx - w, y + 8);
      ctx.quadraticCurveTo(x + dx, y + 8 - w * 1.5, x + dx + w, y + 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawMeadow(x, y) {
    ctx.strokeStyle = "rgba(35,110,55,0.55)";
    ctx.lineWidth = 1.2;
    for (const [dx, dy] of [[-6, 5], [1, 7], [6, 4]]) {
      ctx.beginPath();
      ctx.moveTo(x + dx, y + dy);
      ctx.lineTo(x + dx - 1.5, y + dy - 4);
      ctx.moveTo(x + dx, y + dy);
      ctx.lineTo(x + dx + 1.5, y + dy - 3);
      ctx.stroke();
    }
  }

  // A mine: rocky mound with a dark timber-framed entrance and gold flecks.
  function drawMine(x, y) {
    const G = y + 7.5;
    ctx.fillStyle = "#78726a";
    ctx.strokeStyle = "#38342e";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 9, G);
    ctx.quadraticCurveTo(x - 5, G - 10, x, G - 10.5);
    ctx.quadraticCurveTo(x + 6, G - 10, x + 9, G);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // entrance with beams
    ctx.fillStyle = "#241f1a";
    ctx.beginPath();
    ctx.moveTo(x - 3, G);
    ctx.lineTo(x - 3, G - 4);
    ctx.arc(x, G - 4, 3, Math.PI, 0);
    ctx.lineTo(x + 3, G);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#7a5230";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - 3.6, G); ctx.lineTo(x - 3.6, G - 5);
    ctx.moveTo(x + 3.6, G); ctx.lineTo(x + 3.6, G - 5);
    ctx.moveTo(x - 4.4, G - 5.4); ctx.lineTo(x + 4.4, G - 5.4);
    ctx.stroke();
    // gold flecks
    ctx.fillStyle = "#ffd24a";
    for (const [dx, dy] of [[-6, -3], [5.5, -4], [-1, -8]]) {
      ctx.beginPath();
      ctx.arc(x + dx, G + dy, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A village: two small huts; plundered villages are charred and roofless.
  function drawVillage(x, y, plundered) {
    const G = y + 7.5;
    ctx.lineWidth = 1;
    const hut = (bx, w, h, roofH) => {
      ctx.fillStyle = plundered ? "#57514b" : "#d8c9a3";
      ctx.strokeStyle = "#3a352c";
      ctx.beginPath(); ctx.rect(bx - w / 2, G - h, w, h); ctx.fill(); ctx.stroke();
      if (!plundered) {
        ctx.fillStyle = "#8a6b43";
        ctx.beginPath();
        ctx.moveTo(bx - w / 2 - 1.2, G - h);
        ctx.lineTo(bx, G - h - roofH);
        ctx.lineTo(bx + w / 2 + 1.2, G - h);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else {
        // broken wall notch
        ctx.fillStyle = "#2c2823";
        ctx.fillRect(bx - w * 0.2, G - h, w * 0.4, 1.8);
      }
    };
    hut(x - 4.2, 6.5, 5.5, 3.6);
    hut(x + 4.4, 5.5, 4.5, 3);
    if (plundered) {
      ctx.strokeStyle = "rgba(60,55,50,0.8)"; // smoke wisp
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 4, G - 7);
      ctx.quadraticCurveTo(x - 6, G - 10, x - 4.5, G - 12.5);
      ctx.stroke();
    }
  }

  // An ancient fort: a broken crenellated ruin with cracks and moss.
  function drawAncientFort(x, y) {
    const G = y + 7.5;
    ctx.fillStyle = "#8d9188";
    ctx.strokeStyle = "#3b3f38";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 6, G);
    ctx.lineTo(x - 6, G - 9);
    ctx.lineTo(x - 3.6, G - 9);
    ctx.lineTo(x - 3.6, G - 11.4);
    ctx.lineTo(x - 1.2, G - 11.4);
    ctx.lineTo(x - 1.2, G - 9);
    ctx.lineTo(x + 1.6, G - 9);
    ctx.lineTo(x + 3, G - 6.2);   // broken jagged edge
    ctx.lineTo(x + 6, G - 5);
    ctx.lineTo(x + 6, G);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // cracks
    ctx.strokeStyle = "rgba(40,44,38,0.7)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x - 1, G - 1);
    ctx.lineTo(x + 0.6, G - 4.4);
    ctx.lineTo(x - 0.6, G - 6.8);
    ctx.moveTo(x + 3.4, G - 1);
    ctx.lineTo(x + 4.4, G - 3.6);
    ctx.stroke();
    // moss
    ctx.fillStyle = "#4d7a44";
    for (const [dx, dy] of [[-5, -0.8], [5, -0.8], [-3.2, -8.4]]) {
      ctx.beginPath();
      ctx.arc(x + dx, G + dy, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTree(x, y, kind) {
    ctx.fillStyle = "#5b4225";
    ctx.fillRect(x - 1.5, y + 2, 3, 7);
    ctx.fillStyle = kind === "palm" ? "#3f9c50" : "#2c6e3c";
    ctx.beginPath();
    ctx.arc(x - 5, y - 1, 5.5, 0, Math.PI * 2);
    ctx.arc(x + 5, y - 1, 5.5, 0, Math.PI * 2);
    ctx.arc(x, y - 7, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGrave(x, y) {
    ctx.strokeStyle = "#d8d8d8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
    ctx.moveTo(x - 5, y - 3); ctx.lineTo(x + 5, y - 3);
    ctx.stroke();
  }

  // The capital is a small walled town flying the owner's banner.
  function drawCapital(x, y, bannerColor) {
    const G = y + 7.5;
    const stroke = "#2b2f38";
    const stone = "#9aa3b2";
    const stoneShade = "#6a7280";
    const roof = "#b04a3a";
    const wall = "#e8dcc0";

    // Houses peeking above the wall (drawn first, wall overlaps their feet).
    const house = (bx, w, h, roofH) => {
      ctx.lineWidth = 1;
      ctx.fillStyle = wall;
      ctx.strokeStyle = stroke;
      ctx.beginPath(); ctx.rect(bx - w / 2, G - h, w, h); ctx.fill(); ctx.stroke();
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(bx - w / 2 - 1.2, G - h);
      ctx.lineTo(bx, G - h - roofH);
      ctx.lineTo(bx + w / 2 + 1.2, G - h);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    };
    house(x - 4.6, 6, 8.5, 4);
    house(x + 4.6, 6, 7.5, 3.6);
    house(x, 6.5, 11, 4.5); // central hall, tallest

    // Town wall with crenellations and a gate.
    ctx.fillStyle = stone;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.rect(x - 8.8, G - 4.8, 17.6, 4.8); ctx.fill();
    ctx.fillStyle = stoneShade;
    ctx.fillRect(x + 4.4, G - 4.8, 4.4, 4.8);
    ctx.beginPath(); ctx.rect(x - 8.8, G - 4.8, 17.6, 4.8); ctx.stroke();
    ctx.fillStyle = stone;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      ctx.rect(x - 8.8 + i * 3.52 + 0.6, G - 6.6, 1.8, 1.8);
    }
    ctx.fill(); ctx.stroke();
    // gate
    ctx.fillStyle = "#6e4a28";
    ctx.beginPath();
    ctx.moveTo(x - 1.7, G);
    ctx.lineTo(x - 1.7, G - 2.2);
    ctx.arc(x, G - 2.2, 1.7, Math.PI, 0);
    ctx.lineTo(x + 1.7, G);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Owner banner on the central hall.
    ctx.strokeStyle = "#3a2f22";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, G - 15.5);
    ctx.lineTo(x, G - 20);
    ctx.stroke();
    // Lightened so the banner stands out against the owner's own tile colour.
    ctx.fillStyle = shade(bannerColor, 55);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, G - 20);
    ctx.lineTo(x + 4.6, G - 18.6);
    ctx.lineTo(x, G - 17.2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  // Four tiers with distinct silhouettes: watchtower, fort, castle, citadel.
  // Two-tone stone, masonry courses, conical roofs and lit windows keep them
  // from reading as grey boxes.
  function drawTower(x, y, level) {
    const G = y + 7.5;
    const stroke = "#2b2f38";
    const stone = "#9aa3b2";
    const stoneShade = "#6a7280";
    const roofC = "#a8453a";
    const roofShade = "#7e332c";

    const courses = (bx, w, h, n) => { // subtle masonry lines
      ctx.strokeStyle = "rgba(30,35,45,0.30)";
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let i = 1; i <= n; i++) {
        const yy = G - (h * i) / (n + 1);
        ctx.moveTo(bx - w / 2 + 0.8, yy);
        ctx.lineTo(bx + w / 2 - 0.8, yy);
      }
      ctx.stroke();
    };

    const body = (bx, w, h) => {
      ctx.fillStyle = stone;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.rect(bx - w / 2, G - h, w, h); ctx.fill();
      ctx.fillStyle = stoneShade; // right-side shading
      ctx.fillRect(bx + w / 2 - w * 0.32, G - h, w * 0.32, h);
      ctx.beginPath(); ctx.rect(bx - w / 2, G - h, w, h); ctx.stroke();
      courses(bx, w, h, Math.max(2, Math.round(h / 4.5)));
    };

    const crenellate = (bx, w, topY) => {
      const n = Math.max(2, Math.round(w / 3.2));
      const step = w / n;
      ctx.fillStyle = stone; ctx.strokeStyle = stroke; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        ctx.rect(bx - w / 2 + i * step + step * 0.15, topY - 2.4, step * 0.5, 2.4);
      }
      ctx.fill(); ctx.stroke();
    };

    const cone = (bx, topY, w, h) => {
      ctx.strokeStyle = stroke; ctx.lineWidth = 1;
      ctx.fillStyle = roofC;
      ctx.beginPath();
      ctx.moveTo(bx - w / 2 - 1.3, topY);
      ctx.lineTo(bx, topY - h);
      ctx.lineTo(bx + w / 2 + 1.3, topY);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = roofShade; // shaded half
      ctx.beginPath();
      ctx.moveTo(bx, topY);
      ctx.lineTo(bx, topY - h);
      ctx.lineTo(bx + w / 2 + 1.3, topY);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx - w / 2 - 1.3, topY);
      ctx.lineTo(bx, topY - h);
      ctx.lineTo(bx + w / 2 + 1.3, topY);
      ctx.closePath(); ctx.stroke();
    };

    const litWindow = (bx, by, w = 1.9, h = 3.1) => {
      ctx.fillStyle = "#ffd97a";
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.rect(bx - w / 2, by, w, h); ctx.fill(); ctx.stroke();
    };

    const gate = (halfW, portcullis) => {
      ctx.fillStyle = "#6e4a28";
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - halfW, G);
      ctx.lineTo(x - halfW, G - halfW * 1.2);
      ctx.arc(x, G - halfW * 1.2, halfW, Math.PI, 0);
      ctx.lineTo(x + halfW, G);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      if (portcullis) {
        ctx.strokeStyle = "rgba(20,12,5,0.5)";
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (const dx of [-halfW * 0.5, 0, halfW * 0.5]) {
          ctx.moveTo(x + dx, G);
          ctx.lineTo(x + dx, G - (dx === 0 ? halfW * 2.2 : halfW * 1.8));
        }
        ctx.stroke();
      }
    };

    const pennant = (bx, fromY, len, color = "#d9a13f") => {
      ctx.strokeStyle = "#3a2f22";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, fromY);
      ctx.lineTo(bx, fromY - len);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(bx, fromY - len);
      ctx.lineTo(bx + len, fromY - len * 0.68);
      ctx.lineTo(bx, fromY - len * 0.38);
      ctx.closePath();
      ctx.fill();
    };

    if (level === 1) {
      // Watchtower: tapered body with a jettied, crenellated crown.
      ctx.fillStyle = stone; ctx.strokeStyle = stroke; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 5.2, G); ctx.lineTo(x - 3.9, G - 10);
      ctx.lineTo(x + 3.9, G - 10); ctx.lineTo(x + 5.2, G);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = stoneShade;
      ctx.beginPath();
      ctx.moveTo(x + 1.4, G); ctx.lineTo(x + 1.8, G - 10);
      ctx.lineTo(x + 3.9, G - 10); ctx.lineTo(x + 5.2, G);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 5.2, G); ctx.lineTo(x - 3.9, G - 10);
      ctx.lineTo(x + 3.9, G - 10); ctx.lineTo(x + 5.2, G);
      ctx.closePath(); ctx.stroke();
      courses(x, 8.4, 10, 3);
      // crown platform + crenellations
      ctx.fillStyle = stone; ctx.strokeStyle = stroke; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.rect(x - 5.6, G - 12.2, 11.2, 2.2); ctx.fill(); ctx.stroke();
      crenellate(x, 10.8, G - 12.2);
      litWindow(x, G - 8);
      return;
    }

    if (level === 2) {
      // Fort: broad crenellated keep behind a curtain wall with a gate.
      body(x, 8.5, 12.5);
      crenellate(x, 9.6, G - 12.5);
      litWindow(x, G - 9.5);
      body(x, 12.5, 6);
      crenellate(x, 12.5, G - 6);
      gate(2, false);
      return;
    }

    if (level === 3) {
      // Castle: keep with banner, curtain wall, flanking roofed towers.
      body(x, 7.5, 14);
      crenellate(x, 8.6, G - 14);
      litWindow(x, G - 11);
      body(x, 13, 6.5);
      crenellate(x, 13, G - 6.5);
      body(x - 8, 5.5, 9.5);
      cone(x - 8, G - 9.5, 5.5, 5);
      body(x + 8, 5.5, 9.5);
      cone(x + 8, G - 9.5, 5.5, 5);
      litWindow(x - 8, G - 7, 1.6, 2.4);
      litWindow(x + 8, G - 7, 1.6, 2.4);
      gate(2.3, true);
      pennant(x, G - 16.4, 4.2);
      return;
    }

    // Citadel: great roofed keep, twin roofed towers with pennants, wide
    // gated wall.
    body(x, 8.5, 15);
    cone(x, G - 15, 8.5, 6);
    body(x - 9, 6, 11);
    cone(x - 9, G - 11, 6, 4.6);
    body(x + 9, 6, 11);
    cone(x + 9, G - 11, 6, 4.6);
    body(x, 15, 6.5);
    crenellate(x, 15, G - 6.5);
    litWindow(x, G - 11.5);
    litWindow(x, G - 4.8, 1.7, 2.2);
    litWindow(x - 9, G - 9, 1.6, 2.4);
    litWindow(x + 9, G - 9, 1.6, 2.4);
    gate(2.7, true);
    pennant(x, G - 21, 4.6);
    pennant(x - 9, G - 15.6, 3.2);
    pennant(x + 9, G - 15.6, 3.2);
  }

  // Farms grow with their level: cottage -> farmhouse with barn -> villa.
  function drawFarm(x, y, level) {
    const GROUND = y + 7.5;
    const stroke = "#6e5518";
    const roof = "#b04a3a";
    const wall = level >= 3 ? "#efe2c6" : "#e8c56a";

    // One gabled building block; (bx, GROUND) is the bottom-centre.
    const block = (bx, w, h, roofH) => {
      ctx.lineWidth = 1.2;
      ctx.fillStyle = wall;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.rect(bx - w / 2, GROUND - h, w, h);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(bx - w / 2 - 1.5, GROUND - h);
      ctx.lineTo(bx, GROUND - h - roofH);
      ctx.lineTo(bx + w / 2 + 1.5, GROUND - h);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    };
    const door = (bx, w = 2.6, h = 3.6) => {
      ctx.fillStyle = "#5b4225";
      ctx.fillRect(bx - w / 2, GROUND - h, w, h);
    };
    const window_ = (bx, by) => {
      ctx.fillStyle = "#fff3c4";
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.rect(bx - 1.3, by - 1.3, 2.6, 2.6);
      ctx.fill(); ctx.stroke();
    };

    if (level === 1) {
      // Cottage
      block(x, 10, 6, 5);
      door(x);
    } else if (level === 2) {
      // Farmhouse with a barn annex and a chimney
      block(x - 3, 11, 7.5, 6);
      block(x + 5.8, 7, 5, 3.5);
      ctx.fillStyle = "#8a8378";
      ctx.fillRect(x - 6.2, GROUND - 15, 2.2, 5); // chimney
      door(x - 3);
      window_(x + 5.8, GROUND - 2.6);
    } else {
      // Villa: two wings flanking a tall centre block
      block(x - 6.8, 6.5, 5.5, 3.5);
      block(x + 6.8, 6.5, 5.5, 3.5);
      block(x, 9.5, 9.5, 5.5);
      door(x, 3, 4);
      window_(x - 6.8, GROUND - 3);
      window_(x + 6.8, GROUND - 3);
      window_(x, GROUND - 7);
      // little flag on the villa roof
      ctx.strokeStyle = "#5b4225";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, GROUND - 15);
      ctx.lineTo(x, GROUND - 19);
      ctx.stroke();
      ctx.fillStyle = "#d9a13f";
      ctx.beginPath();
      ctx.moveTo(x, GROUND - 19);
      ctx.lineTo(x + 4, GROUND - 17.7);
      ctx.lineTo(x, GROUND - 16.4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Four figures: pitchfork peasant, spearman with shield, armoured knight,
  // crowned baron with greatsword and cape. Exhausted units go grey; a tower
  // boost shows as a gold ground ring plus a +1 badge.
  function drawUnit(x, y, unit, isHumanTurnUnit, boosted) {
    const exhausted = isHumanTurnUnit && unit.moved;
    const G = y + 7;
    const pal = exhausted ? {
      outline: "#565b64", skin: "#b6b6b6", cloth: "#9c9c9c", pants: "#8b8b8b",
      metal: "#a9a9a9", metalDark: "#8f8f8f", wood: "#9a9a9a",
      straw: "#b0b0a4", shield: "#9c9c9c", accent: "#a5a5a5", gold: "#b0ab98",
    } : {
      outline: "#1f2530", skin: "#e9c39b", cloth: "#8a6b43", pants: "#6b5436",
      metal: "#aab2bf", metalDark: "#7a828f", wood: "#7a5230",
      straw: "#d9b95c", shield: "#a8703d", accent: "#b04a3a", gold: "#e0b23c",
    };

    if (boosted) {
      ctx.strokeStyle = "#e0a92c";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.ellipse(x, G + 0.8, 8.2, 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.lineWidth = 1.1;
    const O = pal.outline;
    const rect = (rx, ry, w, h, fill) => {
      ctx.fillStyle = fill; ctx.strokeStyle = O;
      ctx.beginPath(); ctx.rect(rx, ry, w, h); ctx.fill(); ctx.stroke();
    };
    const circle = (cx, cy, r, fill) => {
      ctx.fillStyle = fill; ctx.strokeStyle = O;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };
    const line = (x1, y1, x2, y2, color, w) => {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.lineWidth = 1.1;
    };

    if (unit.level === 1) {
      // Peasant: straw hat, tunic, pitchfork.
      line(x + 2.6, G, x + 4.6, G - 10, pal.wood, 1.5);
      for (const dx of [-1.4, 0, 1.4]) {
        line(x + 4.6 + dx * 0.5, G - 10, x + 4.6 + dx * 0.6, G - 12.4, pal.metal, 1.1);
      }
      rect(x - 2, G - 3, 4, 3, pal.pants);
      rect(x - 2.5, G - 7.2, 5, 4.4, pal.cloth);
      circle(x, G - 8.9, 2.2, pal.skin);
      ctx.fillStyle = pal.straw; ctx.strokeStyle = O;
      ctx.beginPath();
      ctx.ellipse(x, G - 10, 3.6, 1.2, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      circle(x, G - 11, 1.4, pal.straw);
    } else if (unit.level === 2) {
      // Spearman: capped helmet, spear, round shield.
      line(x + 3.6, G, x + 3.6, G - 12, pal.wood, 1.5);
      ctx.fillStyle = pal.metal; ctx.strokeStyle = O;
      ctx.beginPath();
      ctx.moveTo(x + 2.6, G - 12);
      ctx.lineTo(x + 3.6, G - 15);
      ctx.lineTo(x + 4.6, G - 12);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      rect(x - 2.2, G - 3.2, 4.4, 3.2, pal.pants);
      rect(x - 2.7, G - 7.6, 5.4, 4.6, pal.metalDark);
      circle(x, G - 9.3, 2.2, pal.skin);
      ctx.fillStyle = pal.metal; ctx.strokeStyle = O; // helmet cap
      ctx.beginPath();
      ctx.arc(x, G - 9.7, 2.4, Math.PI, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      circle(x - 4, G - 5, 2.9, pal.shield);
      circle(x - 4, G - 5, 0.9, pal.metal);
    } else if (unit.level === 3) {
      // Knight: great helm with plume, plate armour, kite shield, sword.
      line(x + 4.2, G - 1, x + 4.2, G - 11, pal.metal, 1.6);
      line(x + 2.6, G - 8.2, x + 5.8, G - 8.2, pal.wood, 1.4);
      rect(x - 2.6, G - 3.4, 5.2, 3.4, pal.metalDark);
      rect(x - 3, G - 8.2, 6, 4.8, pal.metal);
      circle(x - 3, G - 8, 1.5, pal.metalDark); // pauldron
      circle(x + 3, G - 8, 1.5, pal.metalDark);
      // great helm
      rect(x - 2.1, G - 12.6, 4.2, 4.4, pal.metal);
      line(x - 1.4, G - 10.6, x + 1.4, G - 10.6, pal.outline, 0.9);
      ctx.fillStyle = pal.accent; ctx.strokeStyle = O; // plume
      ctx.beginPath();
      ctx.moveTo(x - 1.8, G - 12.6);
      ctx.quadraticCurveTo(x, G - 15.6, x + 1.8, G - 12.6);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      // kite shield
      ctx.fillStyle = pal.accent; ctx.strokeStyle = O;
      ctx.beginPath();
      ctx.moveTo(x - 4.2, G - 8);
      ctx.quadraticCurveTo(x - 6.4, G - 6, x - 4.2, G - 1.2);
      ctx.quadraticCurveTo(x - 2, G - 6, x - 4.2, G - 8);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      line(x - 4.2, G - 7.2, x - 4.2, G - 2.4, "#e8dcc0", 0.9);
    } else {
      // Baron: cape, crowned helm, gold-trimmed armour, greatsword.
      ctx.fillStyle = exhausted ? "#8f8f8f" : "#7e2f2a"; // cape behind
      ctx.strokeStyle = O;
      ctx.beginPath();
      ctx.moveTo(x - 2.6, G - 9);
      ctx.lineTo(x - 5, G);
      ctx.lineTo(x + 5, G);
      ctx.lineTo(x + 2.6, G - 9);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      line(x + 5, G - 0.6, x + 5, G - 12.6, pal.metal, 1.8);
      line(x + 3.2, G - 9.4, x + 6.8, G - 9.4, pal.gold, 1.5);
      rect(x - 2.8, G - 3.6, 5.6, 3.6, pal.metalDark);
      rect(x - 3.3, G - 8.8, 6.6, 5.2, pal.metal);
      line(x - 3.3, G - 4.4, x + 3.3, G - 4.4, pal.gold, 1.2); // belt
      circle(x - 3.4, G - 8.6, 1.7, pal.metalDark);
      circle(x + 3.4, G - 8.6, 1.7, pal.metalDark);
      // helm with crown
      rect(x - 2.2, G - 13.2, 4.4, 4.6, pal.metal);
      line(x - 1.5, G - 11, x + 1.5, G - 11, pal.outline, 0.9);
      ctx.fillStyle = pal.gold; ctx.strokeStyle = O; ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x - 2.2, G - 13.0);
      ctx.lineTo(x - 2.2, G - 14.6);
      ctx.lineTo(x - 1.1, G - 13.5);
      ctx.lineTo(x, G - 15.2);
      ctx.lineTo(x + 1.1, G - 13.5);
      ctx.lineTo(x + 2.2, G - 14.6);
      ctx.lineTo(x + 2.2, G - 13.0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1.1;
    }

    if (boosted) {
      const bx = x + 7, by = G - 12;
      ctx.beginPath();
      ctx.arc(bx, by, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = "#e0a92c";
      ctx.fill();
      ctx.strokeStyle = "#7a5b12";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#1f2530";
      ctx.font = "bold 6.5px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("+1", bx, by + 0.5);
    }
  }

  return { camera, resize, fitToMap, draw, screenToTileKey, screenToWorld };
}
