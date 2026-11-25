-- Миграция: контур дома (полигон), правимый пользователями.
-- Выполните в Supabase: SQL Editor -> New query -> вставить -> Run.

alter table public.buildings add column if not exists poly jsonb;