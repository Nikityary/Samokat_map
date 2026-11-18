// Простейкое хранилище записей в localStorage.
// Позже можно заменить на серверное API, не меняя остальной код.

const KEY = 'domofon.entries.v1';

export function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function saveEntries(entries) {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

export function addEntry(entry) {
  const entries = loadEntries();
  entries.push(entry);
  saveEntries(entries);
  return entries;
}

export function updateEntry(id, patch) {
  const entries = loadEntries().map((e) => (e.id === id ? { ...e, ...patch } : e));
  saveEntries(entries);
  return entries;
}

export function deleteEntry(id) {
  const entries = loadEntries().filter((e) => e.id !== id);
  saveEntries(entries);
  return entries;
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
