import { createClient } from '@supabase/supabase-js';

// Прокси обходит блокировку cross-origin preflight провайдером.
// На Netlify сайт и прокси на одном домене → same-origin '/api' (preflight не нужен).
const onNetlify = typeof location !== 'undefined' && location.hostname.endsWith('netlify.app');
const proxyUrl = import.meta.env.VITE_SUPABASE_PROXY_URL || (onNetlify ? location.origin + '/api' : '');
const url = proxyUrl || import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const usingProxy = Boolean(proxyUrl);

// anon-ключ публичный по замыслу Supabase: данные защищает RLS (доступ только после входа).
export const isConfigured = Boolean(
  url && anonKey && !url.includes('YOUR-PROJECT') && !anonKey.includes('YOUR-ANON-KEY')
);

export const supabase = isConfigured ? createClient(url, anonKey) : null;