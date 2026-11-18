import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { loadEntries, addEntry, updateEntry, deleteEntry, saveEntries, genId } from './storage.js';

// Границы района: Коммунар и Заклязьменский (Владимир)
const DISTRICT_BOUNDS = L.latLngBounds(
  [56.098211, 40.421300], // юго-западный угол
  [56.126853, 40.470280]  // северо-восточный угол
);

const map = L.map('map');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

// Иконки-«пилюли» с кодом прямо на карте
function makeIcon(code, stale) {
  const label = code && code.length > 6 ? code.slice(0, 5) + '…' : code || 'нет кода';
  return L.divIcon({
    className: 'pill-wrap',
    html: `<div class="pill ${stale ? 'stale' : ''}">🔑 ${label}</div>`,
    iconSize: null,
  });
}

let entries = loadEntries();
let markers = new Map(); // id -> marker
let addMode = false;
let pendingLatLng = null;

const $list = document.getElementById('list');
const $count = document.getElementById('count');
const $empty = document.getElementById('empty');
const $search = document.getElementById('search');
const $banner = document.getElementById('addmode-banner');

// ---------- UI ----------

function render() {
  const q = $search.value.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.address.toLowerCase().includes(q));

  $count.textContent = String(entries.length);
  $empty.classList.toggle('hidden', entries.length > 0);
  $list.innerHTML = '';

  for (const e of shown.sort((a, b) => a.address.localeCompare(b.address, 'ru'))) {
    const li = document.createElement('li');
    li.className = 'entry' + (e.stale ? ' is-stale' : '');
    li.innerHTML = `
      <div class="entry-main">
        <b>${esc(e.address)}</b>
        <span class="code">${esc(e.code || '—')}</span>
      </div>
      <div class="entry-meta">
        подъезд ${esc(e.entrance)}${e.note ? ' · ' + esc(e.note) : ''}
        ${e.stale ? ' · ⚠️ требует проверки' : ''}
      </div>`;
    li.addEventListener('click', () => focusEntry(e.id));
    $list.appendChild(li);
  }

  // перерисовка маркеров
  for (const [id, m] of markers) {
    if (!entries.find((e) => e.id === id)) {
      map.removeLayer(m);
      markers.delete(id);
    }
  }
  for (const e of entries) {
    if (markers.has(e.id)) {
      markers.get(e.id).setIcon(makeIcon(e.code, e.stale));
    } else {
      const mk = L.marker([e.lat, e.lng], { icon: makeIcon(e.code, e.stale) })
        .on('click', () => openPopup(e.id))
        .addTo(map);
      markers.set(e.id, mk);
    }
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function focusEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  map.setView([e.lat, e.lng], Math.max(map.getZoom(), 17));
  openPopup(id);
}

// Поповер с формой редактирования записи
function openPopup(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const popup = L.popup({ maxWidth: 320, autoPan: true }).setLatLng([e.lat, e.lng]).setContent(buildForm(e)).openOn(map);

  function buildForm(entry) {
    const div = document.createElement('div');
    div.className = 'popup-form';
    div.innerHTML = `
      <label>Адрес / ЖК<input name="address" value="${esc(entry.address)}" /></label>
      <label>Подъезд<input name="entrance" value="${esc(entry.entrance)}" /></label>
      <label>Код домофона<input name="code" value="${esc(entry.code)}" placeholder="например 1234#" /></label>
      <label>Комментарий<textarea name="note" rows="2">${esc(entry.note)}</textarea></label>
      <label class="check"><input type="checkbox" name="stale" ${entry.stale ? 'checked' : ''}/> Код мог измениться (требует проверки)</label>
      <div class="popup-actions">
        <button data-act="save" class="btn primary small">Сохранить</button>
        <button data-act="delete" class="btn danger small">Удалить</button>
      </div>`;

    div.querySelector('[data-act=save]').addEventListener('click', () => {
      const get = (n) => div.querySelector(`[name=${n}]`).value.trim();
      entries = updateEntry(entry.id, {
        address: get('address'),
        entrance: get('entrance'),
        code: get('code'),
        note: get('note'),
        stale: div.querySelector('[name=stale]').checked,
        updatedAt: Date.now(),
      });
      map.closePopup(popup);
      render();
    });

    div.querySelector('[data-act=delete]').addEventListener('click', () => {
      if (confirm(`Удалить запись «${entry.address}»?`)) {
        entries = deleteEntry(entry.id);
        map.closePopup(popup);
        render();
      }
    });
    return div;
  }
}

// ---------- Добавление новой точки ----------

document.getElementById('btn-add').addEventListener('click', () => {
  addMode = true;
  $banner.classList.remove('hidden');
  document.getElementById('map').style.cursor = 'crosshair';
});

function cancelAdd() {
  addMode = false;
  pendingLatLng = null;
  $banner.classList.add('hidden');
  document.getElementById('map').style.cursor = '';
}

document.getElementById('btn-cancel-add').addEventListener('click', cancelAdd);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelAdd(); });

map.on('click', (ev) => {
  if (!addMode) return;
  pendingLatLng = ev.latlng;
  const guess = reverseGeocode(ev.latlng).then((addr) => showNewForm(ev.latlng, addr));
  addMode = false;
  $banner.classList.add('hidden');
  document.getElementById('map').style.cursor = '';
  return guess;
});

async function reverseGeocode(latlng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ru&lat=${latlng.lat}&lon=${latlng.lng}`
    );
    const j = await r.json();
    const a = j.address || {};
    const street = a.road || a.pedestrian || a.residential || a.neighbourhood || '';
    const house = a.house_number || '';
    return [street, house].filter(Boolean).join(', ') || j.name || 'Новая точка';
  } catch {
    return 'Новая точка';
  }
}

function showNewForm(latlng, suggestedAddress) {
  const div = document.createElement('div');
  div.className = 'popup-form';
  div.innerHTML = `
    <h3 style="margin:.2rem 0 .5rem">Новый домофон</h3>
    <label>Адрес / ЖК<input name="address" value="${esc(suggestedAddress)}" /></label>
    <label>Подъезд<input name="entrance" value="1" /></label>
    <label>Код домофона<input name="code" placeholder="например 1234#" /></label>
    <label>Комментарий<textarea name="note" rows="2"></textarea></label>
    <div class="popup-actions">
      <button data-act="save" class="btn primary small">Добавить</button>
      <button data-act="cancel" class="btn small">Отмена</button>
    </div>`;

  const popup = L.popup({ maxWidth: 320 }).setLatLng(latlng).setContent(div).openOn(map);

  div.querySelector('[data-act=cancel]').addEventListener('click', () => map.closePopup(popup));
  div.querySelector('[data-act=save]').addEventListener('click', () => {
    const get = (n) => div.querySelector(`[name=${n}]`).value.trim();
    const entry = {
      id: genId(),
      lat: latlng.lat,
      lng: latlng.lng,
      address: get('address') || 'Без адреса',
      entrance: get('entrance') || '1',
      code: get('code'),
      note: get('note'),
      stale: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!entry.code && !confirm('Код пустой. Всё равно добавить запись без кода?')) return;
    entries = addEntry(entry);
    map.closePopup(popup);
    render();
  });
}

// ---------- Поиск ----------
$search.addEventListener('input', render);

// ---------- Экспорт / импорт ----------
document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'domofony.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('file-import').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('bad');
    const existing = new Set(entries.map((e) => e.id));
    let added = 0;
    for (const e of data) {
      if (e && typeof e.lat === 'number' && typeof e.lng === 'number' && !existing.has(e.id)) {
        entries.push({ ...e, id: e.id || genId() });
        added++;
      }
    }
    saveEntries(entries);
    render();
    alert(`Импортировано записей: ${added}`);
  } catch {
    alert('Не удалось прочитать файл. Ожидается JSON-массив записей.');
  }
  ev.target.value = '';
});

// ---------- Границы района: Коммунар и Заклязьменский ----------
L.rectangle(DISTRICT_BOUNDS, {
  color: '#00b3ff', weight: 1.5, dashArray: '6 6', fill: false, interactive: false
}).addTo(map).bindTooltip('Коммунар и Заклязьменский', { sticky: true });

map.fitBounds(DISTRICT_BOUNDS, { padding: [10, 10] });

render();
