-- Run AFTER 20260926_production_foundation.sql in a separate test database first.
-- No credentials, customer assignment or production toggles are changed.
begin;
alter table public.paysync_runtime
  add column uptime_ms bigint,
  add column free_heap integer,
  add column pending_events integer,
  add column last_error text,
  add column last_error_at timestamptz,
  add column maintenance boolean not null default false;
create table public.paysync_device_events (
  device_id uuid not null references public.devices(id),
  event_uid text not null,
  company_id uuid not null references public.companies(id),
  kind text not null check(kind in ('billetero','monedero','collection')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(device_id,event_uid)
);
alter table public.paysync_device_events enable row level security;
revoke all on public.paysync_device_events from public,anon,authenticated;
grant all on public.paysync_device_events to service_role;
create or replace function public.paysync_schema_version() returns text
language sql stable set search_path=public,pg_temp as $$ select '20260926-device-v1'::text $$;

create function public.paysync_device_telemetry(p_device_code text,p_device_token text,p_boot_id text,p_ready boolean,
  p_uptime_ms bigint,p_free_heap integer,p_pending_events integer,p_last_error text,p_maintenance boolean)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if p_uptime_ms is null or p_uptime_ms not between 0 and 9007199254740991 or p_free_heap is null or p_free_heap not between 0 and 200000
    or p_pending_events is null or p_pending_events not between 0 and 128 or p_last_error is null or p_last_error !~ '^[a-z_]{1,48}$'
    or p_maintenance is null or p_ready is null then raise exception 'Invalid telemetry'; end if;
  result:=paysync_heartbeat(p_device_code,p_device_token,p_boot_id,p_ready and not p_maintenance);
  update paysync_runtime set uptime_ms=p_uptime_ms,free_heap=p_free_heap,pending_events=p_pending_events,
    last_error_at=case when p_last_error='none' then null when last_error is distinct from p_last_error then now() else last_error_at end,
    last_error=p_last_error,maintenance=p_maintenance
    where device_id=(select id from devices where device_code=p_device_code);
  return result;
end $$;

-- Only this new poll renews the lease; the older claim/ACK contracts stay intact.
create function public.paysync_poll_coin(p_device_code text,p_device_token text,p_boot_id text,p_ready boolean)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
begin
  if p_ready is null then raise exception 'Invalid readiness'; end if;
  perform paysync_heartbeat(p_device_code,p_device_token,p_boot_id,p_ready);
  update devices set last_seen_at=now() where device_code=p_device_code;
  return paysync_claim_coin(p_device_code,p_device_token,p_boot_id);
end $$;

create function public.paysync_record_device_event(p_device_code text,p_device_token text,p_event_uid text,
  p_company_id uuid,p_kind text,p_unit_amount integer,p_notes text)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype; saved paysync_device_events%rowtype; result jsonb; entry_id uuid;
  boundary timestamptz; captured_at timestamptz; recorded_collection collections%rowtype;
begin
  select * into d from devices where device_code=p_device_code for update;
  if d.id is null or p_device_token is null or p_device_token='' or d.device_token is distinct from p_device_token then raise exception 'Invalid device'; end if;
  if p_event_uid is null or p_event_uid !~ '^[A-Za-z0-9_-]{8,100}$' or p_kind is null or p_kind not in ('collection','billetero','monedero') then raise exception 'Invalid event'; end if;
  select * into saved from paysync_device_events where device_id=d.id and event_uid=p_event_uid;
  if found then
    if saved.kind is distinct from p_kind or saved.company_id is distinct from p_company_id or (p_kind<>'collection' and (saved.result->>'amount_ars')::integer is distinct from p_unit_amount) then
      return jsonb_build_object('error','event_conflict');
    end if;
    return saved.result || jsonb_build_object('duplicate',true);
  end if;
  if p_company_id is null or d.company_id is distinct from p_company_id then return jsonb_build_object('error','company_changed'); end if;
  if p_kind='collection' then
    captured_at:=clock_timestamp();
    select coalesce(max(collected_at),'1970-01-01'::timestamptz) into boundary from collections where device_id=d.id and company_id=d.company_id;
    insert into collections(company_id,device_id,period_start_at,period_end_at,qr_amount_ars,bill_amount_ars,coin_amount_ars,manual_amount_ars,notes,collected_at)
      select d.company_id,d.id,boundary,captured_at,
        coalesce(sum(amount_ars) filter(where source='qr'),0),coalesce(sum(amount_ars) filter(where source='billetero'),0),
        coalesce(sum(amount_ars) filter(where source='monedero'),0),coalesce(sum(amount_ars) filter(where source='manual'),0),left(p_notes,1024),captured_at
      from income_events where device_id=d.id and company_id=d.company_id and created_at>boundary and created_at<=captured_at
      returning * into recorded_collection;
    result:=jsonb_build_object('collection_id',recorded_collection.id,'total_amount_ars',recorded_collection.total_amount_ars,'collected_at',captured_at);
  else
    if p_unit_amount is null or p_unit_amount not between 1 and 100000000 then raise exception 'Invalid cash amount'; end if;
    insert into income_events(company_id,device_id,source,amount_ars,pulses,device_event_uid,description,created_at)
      values(d.company_id,d.id,p_kind,p_unit_amount,1,d.id::text||':'||p_event_uid,'PaySync cash pulse',clock_timestamp()) returning id into entry_id;
    result:=jsonb_build_object('income_event_id',entry_id,'amount_ars',p_unit_amount);
  end if;
  result:=result || jsonb_build_object('recorded',true,'event_uid',p_event_uid);
  insert into paysync_device_events(device_id,event_uid,company_id,kind,result) values(d.id,p_event_uid,p_company_id,p_kind,result);
  return result;
end $$;
revoke all on function public.paysync_device_telemetry(text,text,text,boolean,bigint,integer,integer,text,boolean),
  public.paysync_poll_coin(text,text,text,boolean),public.paysync_record_device_event(text,text,text,uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.paysync_device_telemetry(text,text,text,boolean,bigint,integer,integer,text,boolean),
  public.paysync_poll_coin(text,text,text,boolean),public.paysync_record_device_event(text,text,text,uuid,text,integer,text) to service_role;
commit;
