// Дома и подъезды из OpenStreetMap (статический файл public/osm-buildings.json,
// обновляется скриптом scripts/fetch-osm.mjs).

let index = null;

export async function loadOsmBuildings() {
  if (index) return index;
  const res = await fetch(import.meta.env.BASE_URL + 'osm-buildings.json');
  if (!res.ok) throw new Error('Не удалось загрузить данные OSM: HTTP ' + res.status);
  const data = await res.json();
  index = new Map(data.buildings.map((b) => [b.id, b]));
  return index;
}