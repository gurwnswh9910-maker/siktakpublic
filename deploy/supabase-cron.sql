-- Run only in the selected Supabase project after the web URL is verified.
-- Enable pg_cron and pg_net in the dashboard first.
-- In Vault, create siktak_web_url (HTTPS origin, no trailing slash) and
-- siktak_scheduler_secret (the same value as the web's SCHEDULER_SECRET).
-- Do not put either secret value in this source file or a public SQL log.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'siktak_web_url' and decrypted_secret like 'https://%'
  ) or not exists (
    select 1 from vault.decrypted_secrets
    where name = 'siktak_scheduler_secret' and length(decrypted_secret) >= 32
  ) then
    raise exception 'Configure the Siktak URL and scheduler secret in Vault first';
  end if;
end;
$$;

-- Scheduling the same name updates the existing job, avoiding duplicate cron jobs.
select cron.schedule(
  'siktak-jobs',
  '* * * * *',
  $job$
  do $dispatch$
  declare
    checked_at timestamptz := clock_timestamp();
    oldest_due_at timestamptz;
    dispatcher_role name := current_user;
    app_owner name;
  begin
    -- Supabase's postgres may have SET membership without inherited table
    -- privileges. Read/write the private schema as its owner, while keeping
    -- Vault and HTTP access under the original privileged cron role.
    select pg_catalog.pg_get_userbyid(nspowner) into strict app_owner
      from pg_catalog.pg_namespace where nspname = 'siktak';
    execute format('SET LOCAL ROLE %I', app_owner);
    -- Match the application's claim/recovery predicate. Future jobs and live
    -- claims must not keep a free web instance awake when it has no work.
    select min(case when status = 'RUNNING'
                    then "lockedAt" + interval '5 minutes' else "runAt" end)
      into oldest_due_at
      from siktak."Job"
      where (status = 'PENDING' and "runAt" <= now())
         or (status = 'RUNNING' and "lockedAt" < now() - interval '5 minutes');
    execute format('SET LOCAL ROLE %I', dispatcher_role);

    if oldest_due_at is not null then
      perform net.http_post(
        url := (select rtrim(decrypted_secret, '/') from vault.decrypted_secrets
                where name = 'siktak_web_url') || '/api/jobs/run',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' ||
            (select decrypted_secret from vault.decrypted_secrets
             where name = 'siktak_scheduler_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 240000
      );
    end if;

    -- This proves only that the DB checked the queue. Never overwrite the
    -- application's schedulerHeartbeat or claim that HTTP work completed.
    -- A single idle row is refreshed every five minutes, with state changes
    -- recorded immediately. The application allows seven minutes of age.
    execute format('SET LOCAL ROLE %I', app_owner);
    insert into siktak."Setting" (key, value)
    values ('schedulerDispatchHeartbeat', jsonb_build_object(
      'at', checked_at, 'hasDueJobs', oldest_due_at is not null,
      'oldestDueAt', oldest_due_at
    ))
    on conflict (key) do update set value = excluded.value
    where oldest_due_at is not null
       or siktak."Setting".value->'hasDueJobs' is distinct from excluded.value->'hasDueJobs'
       or case when pg_catalog.pg_input_is_valid(siktak."Setting".value->>'at', 'timestamp with time zone')
          then (siktak."Setting".value->>'at')::timestamptz <= checked_at - interval '5 minutes'
            or (siktak."Setting".value->>'at')::timestamptz > checked_at
          else true end;
    execute format('SET LOCAL ROLE %I', dispatcher_role);
  end;
  $dispatch$;
  $job$
);

-- Inspect cron.job_run_details and net._http_response for actual HTTP outcomes.
-- SQL dispatch success alone does not mean the application processed its queue.
-- Stop the schedule with: select cron.unschedule('siktak-jobs');
