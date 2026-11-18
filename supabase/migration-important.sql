-- Миграция: пометка «Важное» у записей (для уже созданной базы).
-- Выполните в Supabase: SQL Editor -> New query -> вставить -> Run.

alter table public.entries add column if not exists important boolean not null default false;