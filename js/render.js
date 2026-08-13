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
      if (t.terrain === "hills") drawHills(x, y);
      else if (t.terrain === "meadow" && !t.structure && !t.unit) drawMeadow(x, y);
      if (t.tree) drawTree(x, y, t.tree);
      if (t.grave) drawGrave(x, y);
      if (t.structure === "capital") drawCapital(x, y);
      if (t.structure === "tower") drawTower(x, y, (t.structureLevel || 1) >= 2);
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

    // Treasury labels on capitals
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

  function drawCapital(x, y) {
    ctx.fillStyle = "#ffd24a";
    ctx.strokeStyle = "#7a5b12";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? 10 : 4.5;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function drawTower(x, y, strong) {
    ctx.fillStyle = strong ? "#4a4f5a" : "#6b7280";
    ctx.strokeStyle = "#22252b";
    ctx.lineWidth = 1.5;
    const w = strong ? 8 : 6.5, h = strong ? 13 : 10;
    ctx.beginPath();
    ctx.rect(x - w, y - h / 2, w * 2, h);
    ctx.fill(); ctx.stroke();
    // battlements
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) ctx.rect(x + i * (w * 0.8) - 1.6, y - h / 2 - 3.5, 3.2, 3.5);
    ctx.fill(); ctx.stroke();
    if (strong) {
      ctx.fillStyle = "#9aa2b0";
      ctx.fillRect(x - 2, y - 2, 4, h / 2 + 2);
    }
  }

  function drawFarm(x, y, level) {
    ctx.fillStyle = "#e8c56a";
    ctx.strokeStyle = "#6e5518";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.rect(x - 6.5, y - 1, 13, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#b04a3a";
    ctx.beginPath();
    ctx.moveTo(x - 8.5, y - 1);
    ctx.lineTo(x, y - 9);
    ctx.lineTo(x + 8.5, y - 1);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // level pips on the roof
    ctx.fillStyle = "#ffe9a8";
    for (let i = 0; i < level - 1; i++) {
      ctx.beginPath();
      ctx.arc(x - 3 + i * 6, y - 3.2, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawUnit(x, y, unit, isHumanTurnUnit, boosted) {
    const exhausted = isHumanTurnUnit && unit.moved;
    const radius = 8 + unit.level * 1.2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = exhausted ? "#a7a7a7" : "#f3f3f3";
    ctx.fill();
    ctx.strokeStyle = boosted ? "#e0a92c" : "#1f2530";
    ctx.lineWidth = boosted ? 2.4 : 1.8;
    ctx.stroke();
    ctx.fillStyle = "#1f2530";
    ctx.font = `bold ${9 + unit.level}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(unit.level), x, y + 0.5);
    if (boosted) {
      // "+1" badge at the top-right of the unit
      const bx = x + radius * 0.85, by = y - radius * 0.85;
      ctx.beginPath();
      ctx.arc(bx, by, 5.2, 0, Math.PI * 2);
      ctx.fillStyle = "#e0a92c";
      ctx.fill();
      ctx.strokeStyle = "#7a5b12";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#1f2530";
      ctx.font = "bold 7px system-ui, sans-serif";
      ctx.fillText("+1", bx, by + 0.5);
    }
  }

  return { camera, resize, fitToMap, draw, screenToTileKey, screenToWorld };
}
