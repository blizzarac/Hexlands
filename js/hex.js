// Axial hex coordinates, pointy-top orientation.
"use strict";

const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function keyOf(q, r) { return q + "," + r; }

function parseKey(k) {
  const i = k.indexOf(",");
  return { q: +k.slice(0, i), r: +k.slice(i + 1) };
}

function neighborKeys(k) {
  const { q, r } = parseKey(k);
  return HEX_DIRS.map(([dq, dr]) => keyOf(q + dq, r + dr));
}

function hexDistance(a, b) {
  const A = parseKey(a), B = parseKey(b);
  const dq = A.q - B.q, dr = A.r - B.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function hexToPixel(q, r, size) {
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    y: size * 1.5 * r,
  };
}

function pixelToHex(x, y, size) {
  const qf = (Math.sqrt(3) / 3 * x - y / 3) / size;
  const rf = (2 / 3 * y) / size;
  return hexRound(qf, rf);
}

function hexRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

// Corner offsets of a pointy-top hex, relative to its centre.
function hexCorners(size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    pts.push([size * Math.cos(a), size * Math.sin(a)]);
  }
  return pts;
}
