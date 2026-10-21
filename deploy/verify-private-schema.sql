-- Run AFTER Prisma migrate deploy with DATABASE_URL schema=siktak, BEFORE seed.
-- Use the same migration owner as the preparation script. This reads no rows
-- or secrets and changes no grants/data. Re-run after migrations/grant changes.
-- Also verify siktak is not exposed by the Data API. Keep a shared project's
-- Data API enabled when another application needs it.
-- From a postgres session using the dedicated-role bootstrap, add
-- SET LOCAL ROLE siktak_app immediately after BEGIN below.
begin;

do $$
declare
  api_role text;
  item record;
  migration_owner oid := current_user::regrole::oid;
begin
  if to_regclass('siktak."_prisma_migrations"') is null
    or to_regclass('siktak."User"') is null
    or to_regclass('siktak."Job"') is null
    or to_regclass('siktak."Setting"') is null
    or to_regclass('siktak."WaitlistEntry"') is null then
    raise exception 'Run Prisma migrate deploy with schema=siktak before this check';
  end if;
  if exists (
    select 1 from pg_namespace
    where nspname = 'siktak' and nspowner <> current_user::regrole::oid
  ) then
    raise exception 'Run this check as the DATABASE_URL migration owner';
  end if;
  -- Check the whole app schema, including newly migrated tables. A few sentinel
  -- tables alone cannot detect a new table created by the wrong role or without RLS.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'siktak' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and c.relowner <> migration_owner
  ) then
    raise exception 'A siktak object is not owned by the DATABASE_URL migration owner';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'siktak' and c.relkind in ('r', 'p')
      and (not c.relrowsecurity or c.relforcerowsecurity)
  ) then
    raise exception 'All siktak tables must enable RLS without FORCE RLS for the server-owned access model';
  end if;
  foreach api_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = api_role) then
      raise exception 'Missing Supabase API role %', api_role;
    end if;
    if has_schema_privilege(api_role, 'siktak', 'USAGE')
      or has_schema_privilege(api_role, 'siktak', 'CREATE') then
      raise exception 'Role % can access siktak; do not seed or start the app', api_role;
    end if;
    -- Reject dormant grants too: denying schema USAGE must not hide an
    -- accidental table grant that would become active after a later change.
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'siktak' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(api_role, c.oid,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    ) then
      raise exception 'Role % has an app table grant; do not start the app', api_role;
    end if;
    for item in
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'siktak' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      order by c.relname
    loop
      execute format('set local role %I', api_role);
      begin
        execute format('select 1 from siktak.%I limit 0', item.relname);
        raise exception 'Unexpected successful % query as %', item.relname, api_role;
      exception when insufficient_privilege then
        null; -- Expected: permission denied, even for a query returning no rows.
      end;
      reset role;
    end loop;
    reset role;
  end loop;
end;
$$;

commit;
