-- Миграция: имя автора записи (для уже созданной базы).
-- Выполните в Supabase: SQL Editor -> New query -> вставить -> Run.

alter table public.entries add column if not exists author_name text not null default '';