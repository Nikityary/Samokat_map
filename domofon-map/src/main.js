import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { supabase, isConfigured } from './supabase.js';
import { initAuth, showAuth, hideAuth } from './auth.js';
import { loadOsmBuildings } from './osm.js';
import {
  loadEntries, addEntry, updateEntry, deleteEntry, importEntries,
  loadBuildings, upsertBuilding, upsertBuildings, subscribeToChanges, genId,
} from './storage.js';

// Границы района: Коммунар и Заклязьменский (Владимир)
const DISTRICT_BOUNDS = L.latLngBounds(
  [56.098211, 40.421300], // юго-западный угол
  [56.126853, 40.470280]  // северо-восточный угол
);

const map = L.map('map');
// Авторство OSM обязательно по лицензии ODbL — оставляем, но делаем компактным.
map.attributionControl.setPrefix(false);

// Подложка OSM-FR на данных OSM: чистый стиль без ключа и водяных знаков
// (Carto Voyager требует API-ключ). Авторство OSM обязательно по ODbL.
L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap &copy; OSM-FR',
}).addTo(map);

// ---------- Состояние ----------

let osm = new Map();            // id -> дом из OSM {id, address, lat, lng, poly, entrances}
let overrides = new Map();      // id -> строка buildings из базы
let entries = [];               // записи кодов
const polygons = new Map();     // id -> L.polygon
const badges = new Map();       // id -> маркер-пилюля с числом кодов
let selectedBuilding = null;
let selectedEntrance = null;
let recordForm = null;          // {mode:'add'} | {mode:'edit', entry}
let countFormOpen = false;
let started = false;
let realtimeChannel = null;
let realtimeTimer = null;

const $sidebar = document.getElementById('sidebar');
const $search = document.getElementById('search');
const $userName = document.getElementById('user-name');
let myName = '';

// ----------Helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildingInfo(id) {
  const o = osm.get(id);
  const ov = overrides.get(id);
  const address = (ov?.address || o?.address || '').trim() || 'Дом без адреса';
  const refs = (o?.entrances || [])
    .map((e) => parseInt(e.ref, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const count = ov?.entrances_count ?? (refs.length ? Math.max(...refs) : null);
  return {
    id, address, count,
    lat: ov?.lat ?? o?.lat,
    lng: ov?.lng ?? o?.lng,
  };
}

function entranceList(info) {
  if (!info.count) return null;
  return Array.from({ length: info.count }, (_, i) => String(i + 1));
}

const recordsFor = (bid, ent) =>
  entries.filter((e) => e.building_id === bid && String(e.entrance) === String(ent));
const buildingRecords = (bid) => entries.filter((e) => e.building_id === bid);
const legacyEntries = () => entries.filter((e) => !e.building_id);

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Карта: дома ----------

const POLY_STYLE = { color: '#5b7083', weight: 1, fillColor: '#9db4c4', fillOpacity: 0.25 };
const POLY_HOVER = { color: '#00b3ff', weight: 2, fillOpacity: 0.45 };
const POLY_SELECTED = { color: '#00b3ff', weight: 2.5, fillColor: '#00b3ff', fillOpacity: 0.35 };

function drawBuildings() {
  for (const b of osm.values()) {
    const poly = L.polygon(b.poly, POLY_STYLE).addTo(map);
    poly.on('mouseover', () => { if (selectedBuilding !== b.id) poly.setStyle(POLY_HOVER); });
    poly.on('mouseout', () => { if (selectedBuilding !== b.id) poly.setStyle(POLY_STYLE); });
    poly.on('click', () => selectBuilding(b.id));
    polygons.set(b.id, poly);
  }
}

function highlightSelected() {
  for (const [id, p] of polygons) {
    p.setStyle(id === selectedBuilding ? POLY_SELECTED : POLY_STYLE);
  }
}

function renderBadges() {
  const counts = new Map();
  for (const e of entries) {
    if (e.building_id) counts.set(e.building_id, (counts.get(e.building_id) || 0) + 1);
  }
  for (const [id, m] of badges) {
    if (!counts.has(id)) { map.removeLayer(m); badges.delete(id); }
  }
  for (const [id, n] of counts) {
    const info = buildingInfo(id);
    if (info.lat == null || info.lng == null) continue;
    const icon = L.divIcon({
      className: 'pill-wrap',
      html: `<div class="pill">🔑 ${n}</div>`,
      iconSize: null,
    });
    if (badges.has(id)) {
      badges.get(id).setIcon(icon);
    } else {
      const mk = L.marker([info.lat, info.lng], { icon, zIndexOffset: 500 })
        .on('click', () => selectBuilding(id))
        .addTo(map);
      badges.set(id, mk);
    }
  }
}

function selectBuilding(id) {
  selectedBuilding = id;
  recordForm = null;
  countFormOpen = false;
  const info = buildingInfo(id);
  const list = entranceList(info);
  const withCode = list?.find((ent) => recordsFor(id, ent).length > 0);
  selectedEntrance = withCode ?? (list ? list[0] : null);
  highlightSelected();
  const poly = polygons.get(id);
  if (poly) map.fitBounds(poly.getBounds(), { maxZoom: 18, padding: [40, 40] });
  renderSidebar();
}

function closeBuilding() {
  selectedBuilding = null;
  selectedEntrance = null;
  recordForm = null;
  countFormOpen = false;
  highlightSelected();
  renderSidebar();
}

// ---------- Боковая панель ----------

function renderSidebar() {
  if (selectedBuilding) renderBuildingPanel();
  else renderListView();
}

function renderListView() {
  const q = $search.value.trim().toLowerCase();
  const withCodes = new Map();
  for (const e of entries) {
    if (e.building_id) withCodes.set(e.building_id, (withCodes.get(e.building_id) || 0) + 1);
  }

  let items;
  if (q) {
    items = [...osm.keys()]
      .map(buildingInfo)
      .filter((b) => b.address.toLowerCase().includes(q));
  } else {
    items = [...withCodes.keys()].map(buildingInfo);
  }
  items.sort((a, b) => a.address.localeCompare(b.address, 'ru'));

  const legacy = legacyEntries();

  $sidebar.innerHTML = `
    <div class="sidebar-head">
      <h2>${q ? 'Найденные дома' : 'Дома с кодами'}</h2>
      <span class="count">${items.length}</span>
    </div>
    <ul class="entries" id="building-list"></ul>
    ${!items.length ? `<p class="empty">${q
      ? 'Ничего не найдено. Попробуйте другой адрес.'
      : 'Пока нет записей.<br/>Кликните на дом на карте, выберите подъезд и добавьте код.'}</p>` : ''}
    ${legacy.length ? `
      <div class="sidebar-head legacy-head"><h2>Записи без дома</h2><span class="count">${legacy.length}</span></div>
      <ul class="entries" id="legacy-list"></ul>` : ''}
  `;

  const $bl = document.getElementById('building-list');
  for (const b of items) {
    const n = withCodes.get(b.id) || 0;
    const li = document.createElement('li');
    li.className = 'entry';
    li.innerHTML = `
      <div class="entry-main">
        <b>${esc(b.address)}</b>
        <span class="code">${n ? '🔑 ' + n : 'нет кодов'}</span>
      </div>
      <div class="entry-meta">${b.count ? 'подъездов: ' + b.count : 'число подъездов не задано'}</div>`;
    li.addEventListener('click', () => selectBuilding(b.id));
    $bl.appendChild(li);
  }

  const $ll = document.getElementById('legacy-list');
  if ($ll) {
    for (const e of legacy) {
      const li = document.createElement('li');
      li.className = 'entry' + (e.stale ? ' is-stale' : '');
      li.innerHTML = `
        <div class="entry-main"><b>${esc(e.address || 'Без адреса')}</b><span class="code">${esc(e.code || '—')}</span></div>
        <div class="entry-meta">подъезд ${esc(e.entrance)}${e.note ? ' · ' + esc(e.note) : ''}</div>
        <div class="popup-actions"><button class="btn danger small" data-del="${esc(e.id)}">Удалить</button></div>`;
      li.querySelector('[data-del]').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Удалить старую запись?')) return;
        try { entries = await deleteEntry(e.id); refresh(); }
        catch (err) { alert('Не удалось удалить: ' + err.message); }
      });
      $ll.appendChild(li);
    }
  }
}

function renderBuildingPanel() {
  const info = buildingInfo(selectedBuilding);
  const list = entranceList(info);

  $sidebar.innerHTML = `
    <button class="btn small" id="btn-back">← К списку</button>
    <div class="sidebar-head building-head">
      <h2>${esc(info.address)}</h2>
      <button class="btn small" id="btn-edit-address" title="Уточнить адрес">✏️</button>
    </div>
    <div class="chips" id="chips"></div>
    <div id="count-slot"></div>
    <div id="entrance-slot"></div>
  `;

  document.getElementById('btn-back').addEventListener('click', closeBuilding);
  document.getElementById('btn-edit-address').addEventListener('click', async () => {
    const next = prompt('Адрес дома:', info.address);
    if (next === null || !next.trim() || next.trim() === info.address) return;
    try {
      await upsertBuilding({ id: info.id, address: next.trim(), lat: info.lat, lng: info.lng, entrances_count: info.count });
      overrides.set(info.id, { ...(overrides.get(info.id) || {}), id: info.id, address: next.trim() });
      refresh();
    } catch (err) { alert('Не удалось сохранить адрес: ' + err.message); }
  });

  const $chips = document.getElementById('chips');
  if (list) {
    for (const ent of list) {
      const recs = recordsFor(info.id, ent);
      const stale = recs.some((r) => r.stale);
      const chip = document.createElement('button');
      chip.className = 'chip'
        + (ent === selectedEntrance ? ' active' : '')
        + (recs.length ? ' has-code' : '')
        + (stale ? ' has-stale' : '');
      chip.innerHTML = `${esc(ent)}${recs.length ? ' 🔑' : ''}`;
      chip.title = recs.length ? `Записей: ${recs.length}` : 'Кодов пока нет';
      chip.addEventListener('click', () => {
        selectedEntrance = ent;
        recordForm = null;
        renderBuildingPanel();
      });
      $chips.appendChild(chip);
    }
    const change = document.createElement('button');
    change.className = 'chip chip-edit';
    change.textContent = '±';
    change.title = 'Изменить число подъездов';
    change.addEventListener('click', () => { countFormOpen = true; renderBuildingPanel(); });
    $chips.appendChild(change);
  }

  const $countSlot = document.getElementById('count-slot');
  if (!list || countFormOpen) {
    $countSlot.innerHTML = `
      <form class="count-form" id="count-form">
        <label>${list ? 'Изменить число подъездов' : 'Сколько подъездов в этом доме?'}</label>
        <div class="count-row">
          <input type="number" name="count" min="1" max="60" value="${info.count ?? ''}" placeholder="например 4" required />
          <button type="submit" class="btn primary small">Сохранить</button>
          ${list ? '<button type="button" class="btn small" id="count-cancel">Отмена</button>' : ''}
        </div>
        <p class="hint">Число подъездов станет общим для всех курьеров.</p>
      </form>`;
    document.getElementById('count-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const n = parseInt(ev.target.count.value, 10);
      if (!Number.isFinite(n) || n < 1 || n > 60) return;
      try {
        await upsertBuilding({ id: info.id, address: info.address, lat: info.lat, lng: info.lng, entrances_count: n });
        overrides.set(info.id, { ...(overrides.get(info.id) || {}), id: info.id, entrances_count: n });
        countFormOpen = false;
        if (selectedEntrance && parseInt(selectedEntrance, 10) > n) selectedEntrance = '1';
        refresh();
      } catch (err) { alert('Не удалось сохранить: ' + err.message); }
    });
    document.getElementById('count-cancel')?.addEventListener('click', () => {
      countFormOpen = false;
      renderBuildingPanel();
    });
  }

  const $slot = document.getElementById('entrance-slot');
  if (!list) {
    $slot.innerHTML = '<p class="empty">Задайте число подъездов, чтобы добавлять коды.</p>';
    return;
  }
  if (!selectedEntrance) {
    $slot.innerHTML = '<p class="empty">Выберите подъезд.</p>';
    return;
  }

  const recs = recordsFor(info.id, selectedEntrance);
  $slot.innerHTML = `
    <div class="sidebar-head"><h2>Подъезд ${esc(selectedEntrance)}</h2><span class="count">${recs.length}</span></div>
    <div id="records"></div>
    <div id="record-form-slot"></div>
    ${recordForm ? '' : '<button class="btn primary" id="btn-add-record">＋ Добавить код</button>'}
  `;

  const $records = document.getElementById('records');
  for (const r of recs) {
    const card = document.createElement('div');
    card.className = 'record' + (r.stale ? ' is-stale' : '');
    card.innerHTML = `
      <div class="record-code">🔑 ${esc(r.code || '—')}</div>
      ${r.note ? `<div class="record-note">${esc(r.note)}</div>` : ''}
      <div class="record-meta">${r.author_name ? esc(r.author_name) : ''}${r.updatedAt ? (r.author_name ? ' · ' : '') + 'обновлено ' + fmtDate(r.updatedAt) : ''}${r.stale ? ' · ⚠️ требует проверки' : ''}</div>
      <div class="popup-actions">
        <button class="btn small" data-edit>Изменить</button>
        <button class="btn danger small" data-del>Удалить</button>
      </div>`;
    card.querySelector('[data-edit]').addEventListener('click', () => {
      recordForm = { mode: 'edit', entry: r };
      renderBuildingPanel();
    });
    card.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Удалить код «${r.code || '—'}» (подъезд ${selectedEntrance})?`)) return;
      try { entries = await deleteEntry(r.id); refresh(); }
      catch (err) { alert('Не удалось удалить: ' + err.message); }
    });
    $records.appendChild(card);
  }
  if (!recs.length && !recordForm) {
    $records.innerHTML = '<p class="empty">Для этого подъезда кодов пока нет.</p>';
  }

  document.getElementById('btn-add-record')?.addEventListener('click', () => {
    recordForm = { mode: 'add' };
    renderBuildingPanel();
  });

  if (recordForm) renderRecordForm(info);
}

function renderRecordForm(info) {
  const slot = document.getElementById('record-form-slot');
  const e = recordForm.mode === 'edit' ? recordForm.entry : null;
  slot.innerHTML = `
    <form class="popup-form record-form" id="record-form">
      <h3>${e ? 'Изменить запись' : 'Новый код'} · подъезд ${esc(selectedEntrance)}</h3>
      <label>Код домофона<input name="code" value="${esc(e?.code ?? '')}" placeholder="например 1234#" /></label>
      <label>Комментарий<textarea name="note" rows="2" placeholder="например: звонить не нужно, дверь открыта">${esc(e?.note ?? '')}</textarea></label>
      <label class="check"><input type="checkbox" name="stale" ${e?.stale ? 'checked' : ''}/> Код мог измениться (требует проверки)</label>
      <div class="popup-actions">
        <button type="submit" class="btn primary small">${e ? 'Сохранить' : 'Добавить'}</button>
        <button type="button" class="btn small" id="record-cancel">Отмена</button>
      </div>
    </form>`;

  document.getElementById('record-cancel').addEventListener('click', () => {
    recordForm = null;
    renderBuildingPanel();
  });

  document.getElementById('record-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const code = f.code.value.trim();
    const note = f.note.value.trim();
    const stale = f.stale.checked;
    if (!code && !confirm('Код пустой. Всё равно сохранить запись без кода?')) return;
    try {
      if (e) {
        entries = await updateEntry(e.id, { code, note, stale });
      } else {
        // дом должен существовать в базе (внешний ключ)
        if (!overrides.has(info.id)) {
          await upsertBuilding({ id: info.id, address: info.address, lat: info.lat, lng: info.lng, entrances_count: info.count });
          overrides.set(info.id, { id: info.id, address: info.address, entrances_count: info.count });
        }
        entries = await addEntry({
          id: genId(),
          building_id: info.id,
          entrance: selectedEntrance,
          lat: info.lat,
          lng: info.lng,
          address: info.address,
          code, note, stale,
          author_name: myName,
        });
      }
      recordForm = null;
      refresh();
    } catch (err) {
      alert('Не удалось сохранить: ' + err.message);
    }
  });
}

function refresh() {
  renderBadges();
  renderSidebar();
}

// ---------- Поиск ----------
$search.addEventListener('input', () => {
  selectedBuilding = null;
  selectedEntrance = null;
  highlightSelected();
  renderSidebar();
});

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
    // для записей с building_id создаём недостающие дома (внешний ключ)
    const missing = new Map();
    for (const e of data) {
      if (!e?.building_id || overrides.has(e.building_id) || missing.has(e.building_id)) continue;
      const o = osm.get(e.building_id);
      missing.set(e.building_id, {
        id: e.building_id,
        address: o?.address || e.address || '',
        lat: o?.lat ?? e.lat,
        lng: o?.lng ?? e.lng,
        entrances_count: null,
      });
    }
    await upsertBuildings([...missing.values()]);
    const { entries: updated, imported } = await importEntries(data);
    entries = updated;
    overrides = new Map((await loadBuildings()).map((b) => [b.id, b]));
    refresh();
    alert(`Импортировано записей: ${imported}`);
  } catch (err) {
    alert('Не удалось импортировать: ' + (err.message === 'bad'
      ? 'ожидается JSON-массив записей.'
      : err.message));
  }
  ev.target.value = '';
});

// ---------- Границы района ----------
L.rectangle(DISTRICT_BOUNDS, {
  color: '#00b3ff', weight: 1.5, dashArray: '6 6', fill: false, interactive: false
}).addTo(map).bindTooltip('Коммунар и Заклязьменский', { sticky: true });

map.fitBounds(DISTRICT_BOUNDS, { padding: [10, 10] });

// ---------- Авторизация и запуск ----------

function scheduleRealtimeReload() {
  clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(async () => {
    try {
      const [es, bs] = await Promise.all([loadEntries(), loadBuildings()]);
      entries = es;
      overrides = new Map(bs.map((b) => [b.id, b]));
      refresh();
    } catch {
      // при следующем изменении попробуем снова
    }
  }, 300);
}

async function startApp(session) {
  if (started) return;
  started = true;
  hideAuth();
  myName = session.user.user_metadata?.display_name || session.user.email || '';
  $userName.textContent = myName;
  try {
    const [es, bs] = await Promise.all([loadEntries(), loadBuildings()]);
    entries = es;
    overrides = new Map(bs.map((b) => [b.id, b]));
    refresh();
  } catch (err) {
    alert('Не удалось загрузить записи: ' + err.message);
  }
  realtimeChannel = subscribeToChanges(scheduleRealtimeReload);
}

function stopApp() {
  started = false;
  clearTimeout(realtimeTimer);
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  for (const m of badges.values()) map.removeLayer(m);
  badges.clear();
  entries = [];
  overrides = new Map();
  closeBuilding();
  $userName.textContent = '';
  myName = '';
  showAuth();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  supabase.auth.signOut();
});

document.getElementById('btn-name').addEventListener('click', async () => {
  const next = prompt('Ваше имя (видно коллегам):', myName);
  if (next === null) return;
  const name = next.trim();
  if (!name || name === myName) return;
  try {
    const { data, error } = await supabase.auth.updateUser({ data: { display_name: name } });
    if (error) throw error;
    myName = data.user.user_metadata?.display_name || name;
    $userName.textContent = myName;
  } catch (err) {
    alert('Не удалось сохранить имя: ' + err.message);
  }
});

// Дома рисуем сразу (под экраном входа), данные записей — после входа.
loadOsmBuildings()
  .then((idx) => { osm = idx; drawBuildings(); })
  .catch((err) => console.error(err));

if (!isConfigured) {
  document.getElementById('setup-overlay').classList.remove('hidden');
} else {
  initAuth();
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      if (event === 'USER_UPDATED') {
        myName = session.user.user_metadata?.display_name || session.user.email || '';
        $userName.textContent = myName;
      }
      startApp(session);
    } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      stopApp();
    }
  });
}