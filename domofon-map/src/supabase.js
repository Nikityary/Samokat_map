import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// anon-ключ публичный по замыслу Supabase: данные защищает RLS (доступ только после входа).
export const isConfigured = Boolean(
  url && anonKey && !url.includes('YOUR-PROJECT') && !anonKey.includes('YOUR-ANON-KEY')
);

export const supabase = isConfigured ? createClient(url, anonKey) : null;