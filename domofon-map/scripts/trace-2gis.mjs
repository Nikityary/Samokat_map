// CV-трассировка контуров зданий с растровых тайлов 2GIS (z=18), сшивка 3x3 тайла.
// Стратегии заливки от точки дома:
//   A: светлые крыши (R>=232), барьер — всё тёмное (стены 212, контур, земля 235)
//   B: серые дома целиком: всё, что не земля/белое/зелень/текст:
//      150<=R<=228 и G<=R+10 (серый 212, обводка 192-206; земля 235, белый 255, зелень G>R+10 мимо)
// Старт — сплошной блок 3x3 заливки (не ореол подписи). Контур — трассировка Мура
// с замыканием по повтору состояния. Тайлы сшиваются 3x3, чтобы дома у границ тайла
// не обрезались; брак только при касании ВНЕШНЕГО края сшивки.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // корень репозитория
const KEY = readFileSync(ROOT + '/gis-key.txt', 'utf8').match(/KEY=(\S+)/)[1];
const OSM = fileURLToPath(new URL('../public/osm-buildings.json', import.meta.url));
const Z = 18;
const LIGHT = 232;
const START_LIGHT = 240;
const DARK = 150, LANDMAX = 228;
const MIN_AREA = 40, MAX_AREA = 30000;
const EPS = 1.2;          // упрощение Douglas-Peucker, px (~0.4 м)
const MAX_START_R = 24;   // радиус поиска стартового блока, px (~8 м)
const CENTER_MAX = 90;    // центроид контура не дальше этого от точки дома, px (~30 м)
const PAD = 256;          // запас сшивки вокруг центрального тайла (1 тайл с каждой стороны)

const tileCache = new Map();
let failReason = {};

function tileFor(lat, lng, z) {
  const n = 2 ** z;
  const xf = (lng + 180) / 360 * n;
  const yf = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  return { x: Math.floor(xf), y: Math.floor(yf), px: (xf - Math.floor(xf)) * 256, py: (yf - Math.floor(yf)) * 256 };
}
async function getTile(x, y) {
  const k = x + ',' + y;
  if (tileCache.has(k)) return tileCache.get(k);
  let png = null;
  for (let a = 0; a < 3 && !png; a++) {
    try {
      const res = await fetch(`https://tile${a}.maps.2gis.com/tiles?x=${x}&y=${y}&z=${Z}&ts=online&key=${KEY}`);
      if (res.ok) png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    } catch { /* retry */ }
    if (!png) await new Promise(r => setTimeout(r, 300));
  }
  tileCache.set(k, png);
  return png;
}

// сшитый холст 768x768: центральный тайл (tx,ty) + по тайлу с каждой стороны
async function getStitch(tx, ty) {
  const k = 's' + tx + ',' + ty;
  if (tileCache.has(k)) return tileCache.get(k);
  const S = 256 + PAD * 2;
  const canvas = { width: S, height: S, data: new Uint8ClampedArray(S * S * 4) };
  let holes = 0;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const png = await getTile(tx + ox, ty + oy);
    if (!png) { holes++; continue; }
    for (let y = 0; y < 256; y++) {
      // строка y тайла -> строка (oy+1)*256 + y холста, колонки от (ox+1)*256
      const d0 = (((oy + 1) * 256 + y) * S + (ox + 1) * 256) << 2;
      for (let x = 0; x < 256; x++) {
        const si = (256 * y + x) << 2, di = d0 + (x << 2);
        canvas.data[di] = png.data[si]; canvas.data[di + 1] = png.data[si + 1];
        canvas.data[di + 2] = png.data[si + 2]; canvas.data[di + 3] = 255;
      }
    }
  }
  if (holes > 0) return null;
  return canvas;
}

function fail(reason) { failReason[reason] = (failReason[reason] || 0) + 1; return null; }

// предикаты заливки по R,G каналу
const fillA = (r, g) => r >= LIGHT;
const fillB = (r, g) => r >= DARK && r <= LANDMAX && g <= r + 10;

// сплошной блок 3x3 заливки — признак внутренности фигуры, не ореола подписи
function solid3(st, x, y, isFill) {
  const W = st.width;
  if (x < 1 || y < 1 || x >= st.width - 1 || y >= st.height - 1) return false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = ((y + dy) * W + (x + dx)) << 2;
    if (!isFill(st.data[i], st.data[i + 1])) return false;
  }
  return true;
}

function flood(st, start, isFill) {
  const W = st.width, H = st.height;
  const mask = new Uint8Array(W * H);
  const stack = [start];
  mask[start[1] * W + start[0]] = 1;
  let area = 0;
  while (stack.length) {
    const [x, y] = stack.pop(); area++;
    if (area > MAX_AREA) return { leak: true };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx <= 0 || ny <= 0 || nx >= W - 1 || ny >= H - 1) return { leak: true }; // дошли до края сшивки — дом больше поля
      const idx = ny * W + nx;
      if (!mask[idx]) {
        const i = idx << 2;
        if (isFill(st.data[i], st.data[i + 1])) { mask[idx] = 1; stack.push([nx, ny]); }
      }
    }
  }
  return { mask, area };
}

// трассировка границы методом Мура (8-соседей), замыкание по повтору состояния
function mooreBoundary(mask, W, H, start) {
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !!mask[y * W + x];
  let b = start;
  let c = [start[0] - 1, start[1]];
  const contour = [b];
  const seen = new Set();
  for (let step = 0; step < 500000; step++) {
    let d0 = 0;
    for (let i = 0; i < 8; i++) if (b[0] + DIRS[i][0] === c[0] && b[1] + DIRS[i][1] === c[1]) { d0 = i; break; }
    let next = null, newc = null;
    for (let k = 1; k <= 8; k++) {
      const d = (d0 + k) % 8;
      if (at(b[0] + DIRS[d][0], b[1] + DIRS[d][1])) {
        const pd = (d0 + k - 1) % 8;
        next = [b[0] + DIRS[d][0], b[1] + DIRS[d][1]];
        newc = [b[0] + DIRS[pd][0], b[1] + DIRS[pd][1]];
        break;
      }
    }
    if (!next) break;
    const key = next[0] * 1048576 + next[1] * 512 + (newc[0] - b[0] + 2) * 4 + (newc[1] - b[1] + 2);
    if (seen.has(key)) break;
    seen.add(key);
    b = next; c = newc;
    contour.push(b);
  }
  return contour;
}

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perp(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const l = dp(pts.slice(0, idx + 1), eps), r = dp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [a, b];
}
function perp(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

function trace(st, sx, sy) {
  const diag = [];
  const result = traceInner(st, sx, sy, diag);
  return result ? { poly: result, diag } : { poly: null, diag };
}
function traceInner(st, sx, sy, diag) {
  const fail = (reason) => { diag.push(reason); return null; };
  const W = st.width, H = st.height;
  const R = (x, y) => { const i = (W * y + x) << 2; return [st.data[i], st.data[i + 1]]; };
  const cx = Math.round(sx), cy = Math.round(sy);
  const strategies = [
    ['A', fillA, (r, g) => r >= START_LIGHT],
    ['B', fillB, fillB],
  ];
  for (const [tag, isFill, isStart] of strategies) {
    const cands = [];
    for (let dy = -MAX_START_R; dy <= MAX_START_R; dy++) for (let dx = -MAX_START_R; dx <= MAX_START_R; dx++) {
      const x = cx + dx, y = cy + dy;
      const [r, g] = R(x, y);
      if (isStart(r, g) && solid3(st, x, y, isFill)) cands.push([dx * dx + dy * dy, x, y]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    if (!cands.length) { fail(tag + ':start'); continue; }
    let traced = null;
    for (const [, x, y] of cands.slice(0, 12)) {
      const f = flood(st, [x, y], isFill);
      if (f.leak) { fail(tag + ':leak'); continue; }
      if (f.area < MIN_AREA) { fail(tag + ':tiny'); continue; }
      let bstart = null;
      for (let yy = 1; yy < H - 1 && !bstart; yy++) for (let xx = 1; xx < W - 1; xx++) if (f.mask[yy * W + xx]) { bstart = [xx, yy]; break; }
      if (!bstart) { fail(tag + ':bstart'); continue; }
      const contour = mooreBoundary(f.mask, W, H, bstart);
      if (!contour || contour.length < 8) { fail(tag + ':bnd'); continue; }
      // у замкнутого контура первая точка == последняя: нулевая база DP схлопнет всё в линию
      const loop = (contour[contour.length - 1][0] === contour[0][0] && contour[contour.length - 1][1] === contour[0][1])
        ? contour.slice(0, -1) : contour;
      const simp = dp(loop, EPS);
      if (simp.length < 4) { fail(tag + ':simp'); continue; }
      let mx = 0, my = 0;
      for (const [px, py] of simp) { mx += px; my += py; }
      mx /= simp.length; my /= simp.length;
      if (Math.hypot(mx - cx, my - cy) > CENTER_MAX) { fail(tag + ':far'); continue; }
      traced = simp; break;
    }
    if (traced) { traced.push(traced[0]); return traced; }
  }
  return null;
}

const data = JSON.parse(readFileSync(OSM, 'utf8'));
const limit = parseInt(process.argv[2] || '0');
const DRY = process.env.DRY === '1';
const list = limit ? data.buildings.slice(0, limit) : data.buildings;
let ok = 0, failCnt = 0;
const fails = [];
for (const b of list) {
  const t = tileFor(b.lat, b.lng, Z);
  const st = await getStitch(t.x, t.y);
  if (!st) { failCnt++; fails.push([b.address, 'no tiles']); continue; }
  // координаты точки дома внутри сшивки
  const sx = t.px + PAD, sy = t.py + PAD;
  const poly = trace(st, sx, sy);
  if (!poly.poly) { failCnt++; fails.push(b.address + ' [' + poly.diag.join(',') + ']'); continue; }
  const P = poly.poly;
  b.poly2 = P.map(([px, py]) => {
    const lx = px - PAD, ly = py - PAD; // обратно в пиксели центрального тайла
    const n = 2 ** Z;
    const lng = (t.x + lx / 256) / n * 360 - 180;
    const yy = (t.y + ly / 256) / n;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI;
    return [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6];
  });
  ok++;
}
console.log('traced ok:', ok, 'fail:', failCnt, 'из', list.length);
const agg = {};
for (const f of fails) {
  const reasons = f.match(/\[([^\]]*)\]/)?.[1] || 'other';
  const key = reasons.split(',').pop();
  agg[key] = (agg[key] || 0) + 1;
}
console.log('aggregate last-reasons:', agg);
if (DRY) {
  const uniq = [...new Set(fails.map(f => f.replace(/\[.*\]/, '')))];
  console.log('уникальных адресов-неудач:', uniq.length, 'примеры:', uniq.slice(0, 15).join(' | '));
} else if (fails.length) console.log('примеры неудач:', fails.slice(0, 10).join(' | '));
if (!limit && !DRY) writeFileSync(OSM, JSON.stringify(data));
if (!limit && DRY) writeFileSync('/home/nikita/vtrace/traced.json', JSON.stringify(data));
else console.log('sample:', JSON.stringify(list.find(b => b.poly2)?.poly2?.slice(0, 5)));
