// Хранилище записей и домов в Supabase (общая база для всех курьеров).

import { supabase } from './supabase.js';

function fromRow(r) {
  return {
    id: r.id,
    building_id: r.building_id ?? null,
    lat: r.lat,
    lng: r.lng,
    address: r.address ?? '',
    entrance: r.entrance ?? '1',
    code: r.code ?? '',
    note: r.note ?? '',
    stale: !!r.stale,
    author_name: r.author_name ?? '',
    created_by: r.created_by ?? null,
    createdAt: r.created_at ? Date.parse(r.created_at) : 0,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : 0,
  };
}

function toRow(e, userId) {
  const row = {
    id: e.id,
    building_id: e.building_id ?? null,
    lat: e.lat,
    lng: e.lng,
    address: e.address ?? '',
    entrance: e.entrance ?? '1',
    code: e.code ?? '',
    note: e.note ?? '',
    stale: !!e.stale,
    author_name: e.author_name ?? '',
  };
  if (userId) row.created_by = userId;
  return row;
}

export async function loadEntries() {
  const { data, error } = await supabase.from('entries').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

export async function addEntry(entry) {
  const { data } = await supabase.auth.getSession();
  const { error } = await supabase
    .from('entries')
    .insert(toRow(entry, data.session?.user?.id));
  if (error) throw error;
  return loadEntries();
}

export async function updateEntry(id, patch) {
  const row = { updated_at: new Date().toISOString() };
  for (const k of ['address', 'entrance', 'code', 'note', 'stale', 'building_id', 'author_name']) {
    if (k in patch) row[k] = patch[k];
  }
  const { error } = await supabase.from('entries').update(row).eq('id', id);
  if (error) throw error;
  return loadEntries();
}

export async function deleteEntry(id) {
  const { error } = await supabase.from('entries').delete().eq('id', id);
  if (error) throw error;
  return loadEntries();
}

// Импорт JSON-файла: новые записи добавляются, существующие (по id) обновляются.
export async function importEntries(list) {
  const rows = list
    .filter((e) => e && typeof e.lat === 'number' && typeof e.lng === 'number')
    .map((e) => toRow({ ...e, id: e.id || genId() }));
  if (rows.length) {
    const { error } = await supabase.from('entries').upsert(rows, { onConflict: 'id' });
    if (error) throw error;
  }
  return { entries: await loadEntries(), imported: rows.length };
}

// ---------- Дома (число подъездов, уточнённый адрес) ----------

export async function loadBuildings() {
  const { data, error } = await supabase.from('buildings').select('*');
  if (error) throw error;
  return data;
}

export async function upsertBuilding(row) {
  const { error } = await supabase
    .from('buildings')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw error;
}

export async function upsertBuildings(rows) {
  if (!rows.length) return;
  const { error } = await supabase
    .from('buildings')
    .upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'id' });
  if (error) throw error;
}

// Подписка на изменения в реальном времени (записи и дома).
export function subscribeToChanges(onChange) {
  return supabase
    .channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings' }, onChange)
    .subscribe();
}

export function genId() {
  return crypto.randomUUID();
}