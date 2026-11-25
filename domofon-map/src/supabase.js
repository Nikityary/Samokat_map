import { createClient } from '@supabase/supabase-js';

// Прокси (Vercel) обходит блокировку CORS-preflight провайдером; если задан — ходим через него.
const proxyUrl = import.meta.env.VITE_SUPABASE_PROXY_URL || '';
const url = proxyUrl || import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const usingProxy = Boolean(proxyUrl);

// anon-ключ публичный по замыслу Supabase: данные защищает RLS (доступ только после входа).
export const isConfigured = Boolean(
  url && anonKey && !url.includes('YOUR-PROJECT') && !anonKey.includes('YOUR-ANON-KEY')
);

export const supabase = isConfigured ? createClient(url, anonKey) : null;