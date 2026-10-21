-- Run BEFORE migrations or seed, as the DATABASE_URL migration owner (postgres).
-- First disable the Data API in the dedicated project's dashboard. Never add
-- siktak to the exposed schemas. SQL cannot verify those dashboard settings.
-- This script changes only the siktak schema, not public or other applications.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'Expected Supabase API roles anon and authenticated';
  end if;
  if current_user in ('anon', 'authenticated') then
    raise exception 'Use the migration owner, not an API role';
  end if;
  if exists (
    select 1 from pg_namespace
    where nspname = 'siktak' and nspowner <> current_user::regrole::oid
  ) then
    raise exception 'siktak must be owned by the DATABASE_URL migration owner';
  end if;
end;
$$;

create schema if not exists siktak authorization current_user;
revoke all on schema siktak from public, anon, authenticated;
revoke all on all tables in schema siktak from public, anon, authenticated;
revoke all on all sequences in schema siktak from public, anon, authenticated;
revoke all on all functions in schema siktak from public, anon, authenticated;
alter default privileges in schema siktak
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema siktak
  revoke all on sequences from public, anon, authenticated;

-- Schema USAGE is the access barrier even if project-wide default privileges
-- grant object privileges. Do not revoke global defaults used by other schemas.
do $$
declare api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if has_schema_privilege(api_role, 'siktak', 'USAGE')
      or has_schema_privilege(api_role, 'siktak', 'CREATE') then
      raise exception 'Role % still has inherited access to siktak; inspect its grants before continuing', api_role;
    end if;
  end loop;
end;
$$;

commit;
