// Прокси к Supabase (Netlify Function): обход блокировки CORS-preflight провайдером.
const TARGET = 'https://jaskogcjhnuxrnjjnjdm.supabase.co';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/\.netlify\/functions\/proxy/, '')
    .replace(/^\/api/, '');
  const target = TARGET + path + url.search;

  const headers = {};
  for (const [k, v] of req.headers.entries()) {
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();

  try {
    const up = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    const buf = await up.arrayBuffer();
    const out = { ...CORS };
    const ct = up.headers.get('content-type');
    if (ct) out['Content-Type'] = ct;
    return new Response(buf, { status: up.status, headers: out });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'proxy: ' + e.message }), {
      status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
};