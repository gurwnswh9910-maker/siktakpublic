-- Apply remotely only as postgres, using Supabase apply_migration.
-- Secrets are generated inside PostgreSQL; no password literal enters migration history.
-- Prerequisites: PostgreSQL 17, pgcrypto, Supabase Vault, anon/authenticated roles.
-- This transaction creates only siktak_app, siktak, and one named Vault secret.
-- A repeat validates our marked objects and does not rotate credentials or take ownership.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '25s';

do $bootstrap$
declare
  marker constant text := 'siktak app bootstrap v1';
  secret_name constant text := 'siktak_app_database_password';
  app_oid oid;
  schema_oid oid;
  secret_id uuid;
  secret_description text;
  object_marker text;
  password_value text;
  crypto_schema text;
  api_role text;
  existing_count integer;
begin
  if current_user <> 'postgres' then
    raise exception 'Run siktak bootstrap as postgres';
  end if;
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'This bootstrap requires PostgreSQL 17 or later';
  end if;
  perform pg_advisory_xact_lock(1936288628, 17001);
  if to_regclass('vault.secrets') is null
    or to_regclass('vault.decrypted_secrets') is null
    or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'Supabase Vault must be enabled before bootstrap';
  end if;
  select n.nspname into crypto_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';
  if crypto_schema is null then
    raise exception 'pgcrypto must be enabled before bootstrap';
  end if;
  foreach api_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = api_role) then
      raise exception 'Missing Supabase API role %', api_role;
    end if;
  end loop;

  select oid into app_oid from pg_roles where rolname = 'siktak_app';
  select oid into schema_oid from pg_namespace where nspname = 'siktak';
  select id, description into secret_id, secret_description
  from vault.secrets where name = secret_name;
  existing_count := (app_oid is not null)::integer
    + (schema_oid is not null)::integer + (secret_id is not null)::integer;
  if existing_count not in (0, 3) then
    raise exception 'Partial or unrelated siktak objects exist; inspect before proceeding';
  end if;

  if existing_count = 0 then
    -- 256 random bits encoded as URL-safe hex. Never print or return this value.
    execute format('select encode(%I.gen_random_bytes(32), ''hex'')', crypto_schema)
      into password_value;
    secret_id := vault.create_secret(password_value, secret_name, marker);
    object_marker := marker || '; vault=' || secret_id::text;
    begin
      execute format(
        'create role siktak_app login password %L noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 10',
        password_value
      );
    exception when others then
      -- Discard inner dynamic-query context so a failure cannot echo the password.
      raise exception using message = 'Could not create the dedicated siktak role', errcode = 'P0001';
    end;
    password_value := null;
    grant siktak_app to postgres with inherit false, set true;
    create schema siktak authorization siktak_app;
    execute format('comment on role siktak_app is %L', object_marker);
    alter role siktak_app set search_path = siktak, pg_catalog;
    set local role siktak_app;
    execute format('comment on schema siktak is %L', object_marker);
    revoke all on schema siktak from public, anon, authenticated;
    alter default privileges for role siktak_app in schema siktak
      revoke all on tables from public, anon, authenticated;
    alter default privileges for role siktak_app in schema siktak
      revoke all on sequences from public, anon, authenticated;
    -- Unlike tables, new functions grant EXECUTE to PUBLIC by default.
    alter default privileges for role siktak_app
      revoke execute on functions from public;
    reset role;
    select oid into app_oid from pg_roles where rolname = 'siktak_app';
    select oid into schema_oid from pg_namespace where nspname = 'siktak';
    secret_description := marker;
  end if;

  object_marker := marker || '; vault=' || secret_id::text;
  if secret_description is distinct from marker
    or shobj_description(app_oid, 'pg_authid') is distinct from object_marker
    or obj_description(schema_oid, 'pg_namespace') is distinct from object_marker then
    raise exception 'Existing siktak objects are not this bootstrap; refusing adoption';
  end if;
  if not exists (
    select 1 from pg_namespace where oid = schema_oid and nspowner = app_oid
  ) or not exists (
    select 1 from pg_roles where oid = app_oid and rolcanlogin
      and not rolsuper and not rolcreatedb and not rolcreaterole
      and not rolreplication and not rolbypassrls and not rolinherit
      and rolconnlimit = 10
  ) then
    raise exception 'Dedicated role attributes or schema ownership changed';
  end if;
  if exists (select 1 from pg_auth_members where member = app_oid) then
    raise exception 'siktak_app must not be a member of another role';
  end if;
  if not pg_has_role('postgres', app_oid, 'SET') then
    raise exception 'postgres must be able to SET ROLE siktak_app';
  end if;
  foreach api_role in array array['anon', 'authenticated'] loop
    if has_schema_privilege(api_role, schema_oid, 'USAGE')
      or has_schema_privilege(api_role, schema_oid, 'CREATE') then
      raise exception 'API role % can access siktak; refusing to continue', api_role;
    end if;
  end loop;
  if has_schema_privilege('siktak_app', 'vault', 'USAGE') then
    raise exception 'siktak_app unexpectedly has access to Vault';
  end if;
  if exists (
    select 1 from pg_class c where c.relnamespace = schema_oid
      and c.relkind in ('r','p','v','m','S','f') and c.relowner <> app_oid
  ) then
    raise exception 'A siktak object has a different owner';
  end if;
  if exists (
    select 1 from pg_namespace n
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and n.oid <> schema_oid and has_schema_privilege('siktak_app', n.oid, 'CREATE')
  ) then
    raise exception 'Existing PUBLIC grants let siktak_app create in another schema';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and n.oid <> schema_oid and c.relkind in ('r','p','v','m','f')
      and not exists (
        select 1 from pg_depend d where d.classid = 'pg_class'::regclass
          and d.objid = c.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
      )
      and has_schema_privilege('siktak_app', n.oid, 'USAGE')
      and has_table_privilege('siktak_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) then
    raise exception 'Existing PUBLIC grants let siktak_app access another application table';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and n.oid <> schema_oid and p.prosecdef
      and not exists (
        select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
      )
      and has_schema_privilege('siktak_app', n.oid, 'USAGE')
      and has_function_privilege('siktak_app', p.oid, 'EXECUTE')
  ) then
    raise exception 'Existing grants let siktak_app execute another application SECURITY DEFINER function';
  end if;
end;
$bootstrap$;
commit;

-- Retrieve ONLY this newly generated credential with a later SELECT, keeping
-- its output inside the orchestration layer rather than chat/terminal logs:
-- select decrypted_secret from vault.decrypted_secrets
-- where name = 'siktak_app_database_password'
--   and description = 'siktak app bootstrap v1';
