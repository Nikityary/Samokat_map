-- Миграция: справочник контактов сотрудников (для уже созданной базы).
-- Выполните в Supabase: SQL Editor -> New query -> вставить -> Run.

create table if not exists public.contacts (
  id text primary key,
  role text not null default 'Товаровед',
  name text not null default '',
  phone text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.contacts enable row level security;
grant select, insert, update, delete on public.contacts to authenticated;

drop policy if exists "contacts_select_authenticated" on public.contacts;
create policy "contacts_select_authenticated" on public.contacts for select to authenticated using (true);
drop policy if exists "contacts_insert_authenticated" on public.contacts;
create policy "contacts_insert_authenticated" on public.contacts for insert to authenticated with check (true);
drop policy if exists "contacts_update_authenticated" on public.contacts;
create policy "contacts_update_authenticated" on public.contacts for update to authenticated using (true) with check (true);
drop policy if exists "contacts_delete_authenticated" on public.contacts;
create policy "contacts_delete_authenticated" on public.contacts for delete to authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table public.contacts;
exception when duplicate_object then null;
end $$;