// Выгружает дома и подъезды из OpenStreetMap (Overpass API) для районов
// Коммунар и Заклязьменский (Владимир) и сохраняет в public/osm-buildings.json.
//
// Запуск:  node scripts/fetch-osm.mjs
// Из уже скачанного файла:  node scripts/fetch-osm.mjs --input /tmp/osm_geom.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const BOUNDS = [56.098211, 40.421300, 56.126853, 40.470280]; // юг, запад, север, восток
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const QUERY = `[out:json][timeout:120];(way["building"](${BOUNDS.join(',')});node["entrance"](${BOUNDS.join(',')}););out body geom;`;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fetchOverpass() {
  for (const url of MIRRORS) {
    try {
      console.log('Запрос:', url);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'SamokatMap/1.0',
          // без сжатия некоторые провайдеры обрывают длинные ответы
          'Accept-Encoding': 'gzip',
        },
        body: 'data=' + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(420_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const enc = res.headers.get('content-encoding') || '';
      const text = enc.includes('gzip') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      return JSON.parse(text);
    } catch (e) {
      console.warn('Не удалось:', e.message);
    }
  }
  throw new Error('Все зеркала Overpass недоступны');
}

function addressOf(tags = {}) {
  const street = tags['addr:street'] || '';
  const house = tags['addr:housenumber'] || '';
  const place = tags['addr:place'] || '';
  if (street && house) return `${street}, ${house}`;
  if (place && house) return `${place}, ${house}`;
  if (house) return `дом ${house}`;
  return '';
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;

function processData(data) {
  const ways = data.elements.filter((e) => e.type === 'way' && e.geometry?.length >= 3);
  const entranceNodes = data.elements.filter((e) => e.type === 'node' && e.tags?.entrance);

  const nodeToWay = new Map();
  for (const w of ways) for (const n of w.nodes || []) nodeToWay.set(n, w.id);

  const buildings = ways.map((w) => {
    const poly = w.geometry.map((p) => [r6(p.lat), r6(p.lon)]);
    const lat = r6(poly.reduce((s, p) => s + p[0], 0) / poly.length);
    const lng = r6(poly.reduce((s, p) => s + p[1], 0) / poly.length);
    return {
      id: 'w' + w.id,
      address: addressOf(w.tags),
      lat, lng, poly,
      entrances: [],
    };
  });
  const byId = new Map(buildings.map((b) => [b.id, b]));

  let attached = 0;
  for (const n of entranceNodes) {
    const wayId = nodeToWay.get(n.id);
    const b = wayId && byId.get('w' + wayId);
    if (!b) continue;
    b.entrances.push({
      ref: n.tags.ref || '',
      lat: r6(n.lat),
      lng: r6(n.lon),
      flats: n.tags['addr:flats'] || '',
    });
    attached++;
  }
  for (const b of buildings) {
    b.entrances.sort((a, x) => (parseInt(a.ref, 10) || 0) - (parseInt(x.ref, 10) || 0));
  }
  buildings.sort((a, b) => a.address.localeCompare(b.address, 'ru'));

  console.log(`Домов: ${buildings.length}, подъездов привязано: ${attached}/${entranceNodes.length}`);
  return { generatedAt: new Date().toISOString(), bounds: BOUNDS, buildings };
}

const inputIdx = process.argv.indexOf('--input');
const data = inputIdx !== -1
  ? JSON.parse(readFileSync(process.argv[inputIdx + 1], 'utf8'))
  : await fetchOverpass();

const result = processData(data);
const out = path.join(root, 'public', 'osm-buildings.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result));
console.log('Сохранено:', out, `(${(JSON.stringify(result).length / 1024).toFixed(0)} КБ)`);