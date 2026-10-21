-- Defense in depth after Prisma migrate deploy. Apply as postgres through
-- Supabase apply_migration, or with the dedicated siktak_app connection.
-- New app-table migrations should enable RLS in the same migration transaction.
-- This helper covers the initial schema and verifies ownership before changing it.
-- It never grants API access, adopts foreign objects, or changes another schema.
begin;
set local role siktak_app;

do $$
declare item record;
begin
  if not exists (
    select 1 from pg_namespace where nspname = 'siktak'
      and nspowner = current_user::regrole::oid
  ) then
    raise exception 'siktak must be owned by siktak_app';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'siktak' and c.relkind in ('r', 'p')
      and (c.relowner <> current_user::regrole::oid or c.relforcerowsecurity)
  ) then
    raise exception 'Unexpected table owner or FORCE RLS; investigate before changing privileges';
  end if;
  for item in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'siktak' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table siktak.%I enable row level security', item.relname);
  end loop;
end;
$$;
commit;
