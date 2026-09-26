-- Apply to a BACKUP/preview database first. This is additive to the existing
-- PaySync schema recovered from the project history; it does not seed customers.
begin;

create table public.paysync_runtime (
  device_id uuid primary key references public.devices(id),
  boot_id text not null,
  ready boolean not null default false,
  commissioned boolean not null default false,
  protocol text not null,
  last_seen_at timestamptz not null default now()
);
create table public.paysync_orders (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('qr','device_plan','company_plan')),
  company_id uuid references public.companies(id),
  company_name text,
  device_code text,
  device_codes text[] not null,
  amount_ars integer not null check(amount_ars > 0),
  pulses integer not null default 0,
  pulse_duration_ms integer,
  plan_type text,
  preference_id text,
  mp_payment_id text unique,
  state text not null default 'awaiting' check(state in ('awaiting','paid','delivered','relay_confirmed','review')),
  review_reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '10 minutes',
  paid_at timestamptz
);
create index paysync_orders_device_state on public.paysync_orders(device_code,state);
create table public.paysync_coin_commands (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.paysync_orders(id),
  device_id uuid not null references public.devices(id),
  ordinal integer not null,
  pulse_duration_ms integer not null check(pulse_duration_ms between 20 and 1000),
  state text not null default 'queued' check(state in ('queued','sent','acknowledged','uncertain')),
  boot_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  acknowledged_at timestamptz,
  unique(order_id,ordinal)
);
create index paysync_commands_device on public.paysync_coin_commands(device_id,state,created_at);
create table public.paysync_payment_anomalies (
  payment_id text primary key,
  order_id uuid,
  reason text not null,
  created_at timestamptz not null default now()
);

create function public.paysync_schema_version() returns text
language sql stable set search_path=public,pg_temp as $$ select '20260926'::text $$;

create function public.paysync_device_available(p_device_code text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype; r paysync_runtime%rowtype;
begin
  select * into d from devices where device_code=p_device_code;
  if d.id is null then return jsonb_build_object('ready',false,'reason','device_not_found'); end if;
  select * into r from paysync_runtime where device_id=d.id;
  if d.company_id is null or d.status is null or d.status not in ('active','assigned') or d.subscription_status is distinct from 'active'
    or d.subscription_expires_at is null or d.subscription_expires_at<=now() then
    return jsonb_build_object('ready',false,'reason','device_disabled');
  end if;
  if r.device_id is null or not r.commissioned or not r.ready or r.protocol<>'ack-v1'
    or r.last_seen_at < now()-interval '30 seconds' then
    return jsonb_build_object('ready',false,'reason','device_not_ready');
  end if;
  if exists(select 1 from device_pending_pulses where device_id=d.id and pending_pulses>0) then
    return jsonb_build_object('ready',false,'reason','legacy_credits_need_reconciliation');
  end if;
  if exists(select 1 from paysync_orders where device_code=d.device_code and kind='qr'
    and (state in ('paid','review') or (state='awaiting' and expires_at>now()))) then
    return jsonb_build_object('ready',false,'reason','previous_payment_unresolved');
  end if;
  return jsonb_build_object('ready',true);
end $$;

create function public.paysync_prepare_order(p_kind text,p_device_code text,p_company_id uuid,p_plan_type text,p_unit_amount integer)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype; c companies%rowtype; o paysync_orders%rowtype; codes text[]; amount integer; availability jsonb;
begin
  -- Lock assignment/configuration changes while taking a checkout snapshot.
  lock table devices in share row exclusive mode;
  if p_kind not in ('qr','device_plan','company_plan') then raise exception 'Invalid kind'; end if;
  if p_kind in ('qr','device_plan') then
    select * into d from devices where device_code=p_device_code;
    if d.id is null then return jsonb_build_object('error','Device not found'); end if;
    if p_kind='device_plan' and d.company_id is distinct from p_company_id then return jsonb_build_object('error','Company changed'); end if;
    codes:=array[d.device_code];
    select * into c from companies where id=d.company_id;
  else
    select * into c from companies where id=p_company_id;
    select array_agg(device_code order by device_code) into codes from devices where company_id=p_company_id;
    if c.id is null or coalesce(cardinality(codes),0)=0 then return jsonb_build_object('error','Company has no devices assigned'); end if;
  end if;
  if c.id is null or c.status is distinct from 'active' then return jsonb_build_object('error','Company disabled'); end if;
  if p_kind='qr' then
    availability:=paysync_device_available(d.device_code);
    if not (availability->>'ready')::boolean then return jsonb_build_object('error',availability->>'reason'); end if;
    amount:=d.qr_price_ars;
    if d.pulses_per_payment not between 1 and 100 or d.pulse_duration_ms not between 20 and 1000 then return jsonb_build_object('error','Invalid device pulse configuration'); end if;
  else
    if p_plan_type not in ('monthly','six_months') or p_unit_amount<=0 then raise exception 'Invalid plan'; end if;
    amount:=p_unit_amount*cardinality(codes);
  end if;
  insert into paysync_orders(kind,company_id,company_name,device_code,device_codes,amount_ars,pulses,pulse_duration_ms,plan_type)
  values(p_kind,c.id,c.name,d.device_code,codes,amount,case when p_kind='qr' then d.pulses_per_payment else 0 end,d.pulse_duration_ms,p_plan_type)
  returning * into o;
  return to_jsonb(o);
end $$;

create function public.paysync_set_preference(p_order_id uuid,p_preference_id text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
begin
  update paysync_orders set preference_id=p_preference_id where id=p_order_id and (preference_id is null or preference_id=p_preference_id);
  if not found then raise exception 'Order not found or preference conflict'; end if;
  return jsonb_build_object('saved',true);
end $$;

create function public.paysync_apply_payment(p_order_id uuid,p_payment_id text,p_amount integer) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare o paysync_orders%rowtype; d devices%rowtype; codes text[]; reason text; i integer; start_at timestamptz; days integer;
begin
  lock table devices in share row exclusive mode;
  select * into o from paysync_orders where id=p_order_id for update;
  if o.id is null then
    insert into paysync_payment_anomalies(payment_id,order_id,reason) values(p_payment_id,p_order_id,'unknown_order') on conflict do nothing;
    return jsonb_build_object('review',true,'reason','unknown_order');
  end if;
  if exists(select 1 from paysync_orders where mp_payment_id=p_payment_id and id<>p_order_id) then raise exception 'Payment already belongs to another order'; end if;
  if o.mp_payment_id=p_payment_id then return jsonb_build_object('duplicate',true,'state',o.state); end if;
  if o.mp_payment_id is not null then
    insert into paysync_payment_anomalies(payment_id,order_id,reason) values(p_payment_id,p_order_id,'second_payment_for_order') on conflict do nothing;
    return jsonb_build_object('review',true,'reason','second_payment_for_order');
  end if;
  if p_amount<>o.amount_ars then reason:='amount_mismatch'; end if;
  if o.kind='company_plan' then
    select array_agg(device_code order by device_code) into codes from devices where company_id=o.company_id;
    if codes is distinct from o.device_codes then reason:='company_devices_changed'; end if;
    if not exists(select 1 from companies where id=o.company_id and name=o.company_name) then reason:='company_changed'; end if;
  else
    select * into d from devices where device_code=o.device_code;
    if d.id is null or d.company_id is distinct from o.company_id then reason:='device_assignment_changed'; end if;
  end if;
  if o.state='review' then reason:=coalesce(o.review_reason,'previous_review'); end if;
  if reason is not null then
    update paysync_orders set state='review',review_reason=reason,mp_payment_id=p_payment_id,paid_at=now() where id=o.id;
    return jsonb_build_object('review',true,'reason',reason);
  end if;
  if o.kind='qr' then
    -- Snapshot amount and pulses, independent of subsequent price/config changes.
    -- These credits use the new command queue, never legacy pending_pulses.
    insert into qr_payments(company_id,device_id,mp_payment_id,mp_preference_id,external_reference,amount_ars,pulses,status,paid_at)
      values(o.company_id,d.id,p_payment_id,o.preference_id,o.id::text,o.amount_ars,o.pulses,'approved',now());
    insert into income_events(company_id,device_id,source,amount_ars,pulses,device_event_uid,description)
      values(o.company_id,d.id,'qr',o.amount_ars,o.pulses,'qr-'||p_payment_id,'Pago QR aprobado');
    for i in 1..o.pulses loop
      insert into paysync_coin_commands(order_id,device_id,ordinal,pulse_duration_ms) values(o.id,d.id,i,o.pulse_duration_ms);
    end loop;
  else
    -- Apply exactly the quoted device set, and keep subscription accounting equal
    -- to the actual payment (the old RPC hardcoded prices and a result column).
    insert into plan_payments(mp_payment_id,mp_preference_id,external_reference,scope,plan_type,device_code,company_name,amount_ars,status)
      values(p_payment_id,o.preference_id,o.id::text,case when o.kind='company_plan' then 'company' else 'device' end,o.plan_type,o.device_code,o.company_name,o.amount_ars,'approved');
    days:=case when o.plan_type='six_months' then 180 else 30 end;
    for d in select * from devices where device_code=any(o.device_codes) order by device_code loop
      start_at:=greatest(coalesce(d.subscription_expires_at,now()),now());
      insert into device_subscriptions(company_id,device_id,amount_ars,days_added,status,mp_payment_id,paid_at,starts_at,expires_at)
        values(o.company_id,d.id,o.amount_ars/cardinality(o.device_codes),days,'approved',p_payment_id,now(),start_at,start_at+make_interval(days=>days));
      update devices set subscription_status='active',subscription_expires_at=start_at+make_interval(days=>days),activated_at=coalesce(activated_at,now()),status='active' where id=d.id;
    end loop;
  end if;
  update paysync_orders set state=case when o.kind='qr' then 'paid' else 'delivered' end,mp_payment_id=p_payment_id,paid_at=now() where id=o.id;
  return jsonb_build_object('registered',true,'order_id',o.id,'delivery',case when o.kind='qr' then 'pending' else 'plan_activated' end);
end $$;

create function public.paysync_payment_review(p_order_id uuid,p_payment_id text,p_reason text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
begin
  update paysync_orders set state='review',review_reason=p_reason where id=p_order_id and (mp_payment_id is null or mp_payment_id=p_payment_id);
  insert into paysync_payment_anomalies(payment_id,order_id,reason) values(p_payment_id,p_order_id,p_reason) on conflict do nothing;
  return jsonb_build_object('review',true);
end $$;

create function public.paysync_heartbeat(p_device_code text,p_device_token text,p_boot_id text,p_ready boolean) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype;
begin
  select * into d from devices where device_code=p_device_code for update;
  if d.id is null or d.device_token is null or d.device_token is distinct from p_device_token then raise exception 'Invalid device'; end if;
  if p_boot_id is null or length(p_boot_id) not between 8 and 80 or p_ready is null then raise exception 'Invalid heartbeat'; end if;
  if exists(select 1 from paysync_coin_commands where device_id=d.id and state='sent' and boot_id<>p_boot_id) then
    -- A restarted board must report its saved receipt; do not replay uncertain pulses.
    p_ready:=false;
  end if;
  insert into paysync_runtime(device_id,boot_id,ready,protocol) values(d.id,p_boot_id,p_ready,'ack-v1')
    on conflict(device_id) do update set boot_id=excluded.boot_id,ready=excluded.ready,last_seen_at=now(),protocol=excluded.protocol;
  return jsonb_build_object('ready',p_ready);
end $$;

create function public.paysync_claim_coin(p_device_code text,p_device_token text,p_boot_id text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype; r paysync_runtime%rowtype; c paysync_coin_commands%rowtype;
begin
  select * into d from devices where device_code=p_device_code for update;
  if d.id is null or d.device_token is null or d.device_token is distinct from p_device_token then raise exception 'Invalid device'; end if;
  select * into r from paysync_runtime where device_id=d.id;
  if r.device_id is null or not r.commissioned or not r.ready or r.boot_id is distinct from p_boot_id or r.last_seen_at<now()-interval '30 seconds' or d.status is null or d.status not in ('active','assigned') then
    return jsonb_build_object('command',null);
  end if;
  -- Subscription expiration does not erase an already paid credit.
  select cc.* into c from paysync_coin_commands cc join paysync_orders o on o.id=cc.order_id
    where cc.device_id=d.id and cc.state in ('queued','sent') and o.state='paid' and o.company_id=d.company_id
    order by cc.created_at,cc.ordinal for update of cc limit 1;
  if c.id is null then return jsonb_build_object('command',null); end if;
  if c.state='sent' and c.boot_id<>p_boot_id then return jsonb_build_object('command',null,'review',true); end if;
  update paysync_coin_commands set state='sent',boot_id=p_boot_id,sent_at=coalesce(sent_at,now()) where id=c.id;
  return jsonb_build_object('command',jsonb_build_object('id',c.id,'pulse_duration_ms',c.pulse_duration_ms));
end $$;

create function public.paysync_ack_coin(p_device_code text,p_device_token text,p_command_id uuid,p_outcome text) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare d devices%rowtype; c paysync_coin_commands%rowtype;
begin
  select * into d from devices where device_code=p_device_code for update;
  if d.id is null or d.device_token is null or d.device_token is distinct from p_device_token then raise exception 'Invalid device'; end if;
  select * into c from paysync_coin_commands where id=p_command_id and device_id=d.id for update;
  if c.id is null then raise exception 'Unknown command'; end if;
  if c.state='acknowledged' then return jsonb_build_object('acknowledged',true); end if;
  if c.state not in ('sent','uncertain') then raise exception 'Command was not sent'; end if;
  if p_outcome='uncertain' then
    update paysync_coin_commands set state='uncertain' where id=c.id;
    update paysync_orders set state='review',review_reason='coin_delivery_uncertain' where id=c.order_id;
    update paysync_runtime set ready=false where device_id=d.id;
    return jsonb_build_object('review',true);
  end if;
  if p_outcome is distinct from 'relay_sent' or c.state='uncertain' then raise exception 'Invalid outcome'; end if;
  update paysync_coin_commands set state='acknowledged',acknowledged_at=now() where id=c.id;
  if not exists(select 1 from paysync_coin_commands where order_id=c.order_id and state<>'acknowledged') then
    update paysync_orders set state='relay_confirmed' where id=c.order_id and state='paid';
  end if;
  return jsonb_build_object('acknowledged',true,'evidence','relay_sent_not_physical_credit');
end $$;

create function public.paysync_guard_assignment() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if old.company_id is distinct from new.company_id then
    if exists(select 1 from paysync_orders where old.device_code=any(device_codes) and state in ('paid','review')) then
      raise exception 'Resolve paid orders before changing assignment';
    end if;
    update paysync_runtime set commissioned=false,ready=false where device_id=old.id;
  end if;
  return new;
end $$;
create trigger paysync_guard_assignment before update of company_id on public.devices
for each row execute function public.paysync_guard_assignment();

-- Browser access is through authenticated backend routes. Existing views and
-- SECURITY DEFINER RPCs must not offer a way around those checks.
do $$ declare obj record; begin
  for obj in select c.oid::regclass as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('companies','profiles','devices','qr_payments','income_events','device_pending_pulses','collections','device_subscriptions','alerts','plan_payments','device_dashboard_summary','device_live_status','company_dashboard_summary','paysync_runtime','paysync_orders','paysync_coin_commands','paysync_payment_anomalies')
  loop
    execute format('revoke all on %s from public, anon, authenticated',obj.name);
    execute format('grant all on %s to service_role',obj.name);
  end loop;
  for obj in select p.oid::regprocedure as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'paysync_%' or p.proname in ('get_device_config_by_device_code','device_heartbeat_by_device_code','register_bill_pulse_by_device_code','consume_pending_pulse_by_device_code','register_qr_payment_by_device_code','register_collection_by_device_code_secure','register_collection_by_device_code','claim_device_by_code','activate_device_plan_by_code','activate_company_devices_plan_by_name','create_devices_batch','update_device_config_by_code','upsert_company_by_name','admin_assign_device_to_company','admin_unassign_device_by_code','register_device_plan_payment_by_code','register_company_plan_payment_by_name'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated',obj.name);
    execute format('grant execute on function %s to service_role',obj.name);
  end loop;
end $$;
alter table public.paysync_runtime enable row level security;
alter table public.paysync_orders enable row level security;
alter table public.paysync_coin_commands enable row level security;
alter table public.paysync_payment_anomalies enable row level security;
commit;
