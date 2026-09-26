-- Test-only legacy schema reconstructed from the supplied project history.
-- No production data or credentials. Must never be run against production.
create role anon; create role authenticated; create role service_role bypassrls;
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  mp_alias text,
  mp_access_token text,
  mp_enabled boolean default false,
  status text not null default 'active',
  created_at timestamptz default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete set null,
  full_name text,
  email text unique not null,
  role text not null default 'client',
  created_at timestamptz default now()
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  device_code text unique not null,
  company_id uuid references companies(id) on delete set null,
  visible_name text not null default 'Máquina sin nombre',
  description text,
  location text,
  status text not null default 'stock',
  qr_price_ars integer not null default 2000,
  pulses_per_payment integer not null default 1,
  pulse_duration_ms integer not null default 120,
  bill_pulse_value_ars integer not null default 1000,
  coin_pulse_value_ars integer not null default 100,
  device_token text,
  firmware_version text,
  last_seen_at timestamptz,
  wifi_rssi integer,
  wifi_quality text,
  subscription_status text not null default 'inactive',
  subscription_expires_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists qr_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  mp_payment_id text,
  mp_preference_id text,
  external_reference text,
  amount_ars integer not null,
  pulses integer not null default 1,
  status text not null default 'pending',
  paid_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists income_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  source text not null,
  amount_ars integer not null,
  pulses integer not null default 1,
  device_event_uid text unique,
  description text,
  created_at timestamptz default now()
);

create table if not exists device_pending_pulses (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references devices(id) on delete cascade unique,
  pending_pulses integer not null default 0,
  updated_at timestamptz default now()
);

create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  period_start_at timestamptz,
  period_end_at timestamptz default now(),
  qr_amount_ars integer not null default 0,
  bill_amount_ars integer not null default 0,
  coin_amount_ars integer not null default 0,
  manual_amount_ars integer not null default 0,
  total_amount_ars integer generated always as (
    qr_amount_ars + bill_amount_ars + coin_amount_ars + manual_amount_ars
  ) stored,
  notes text,
  collected_at timestamptz default now()
);

create table if not exists device_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  amount_ars integer not null default 4000,
  days_added integer not null default 30,
  status text not null default 'pending',
  mp_payment_id text,
  paid_at timestamptz,
  starts_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  type text not null,
  title text not null,
  message text,
  is_read boolean default false,
  created_at timestamptz default now()
);

create or replace function register_collection_by_device_code(
  p_device_code text,
  p_user_email text default null,
  p_notes text default null
)
returns table (
  collection_id uuid,
  device_code text,
  visible_name text,
  qr_amount_ars integer,
  bill_amount_ars integer,
  coin_amount_ars integer,
  manual_amount_ars integer,
  total_amount_ars integer,
  collected_at timestamptz
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_user_id uuid;
  v_last_collection_at timestamptz;
  v_qr integer := 0;
  v_bill integer := 0;
  v_coin integer := 0;
  v_manual integer := 0;
  v_collection_id uuid;
  v_collected_at timestamptz := now();
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  select profiles.id
  into v_user_id
  from profiles
  where profiles.email = p_user_email
  limit 1;

  select max(collections.collected_at)
  into v_last_collection_at
  from collections
  where collections.device_id = v_device.id;

  if v_last_collection_at is null then
    v_last_collection_at := '1970-01-01'::timestamptz;
  end if;

  select
    coalesce(sum(case when income_events.source = 'qr' then income_events.amount_ars else 0 end), 0),
    coalesce(sum(case when income_events.source = 'billetero' then income_events.amount_ars else 0 end), 0),
    coalesce(sum(case when income_events.source = 'monedero' then income_events.amount_ars else 0 end), 0),
    coalesce(sum(case when income_events.source = 'manual' then income_events.amount_ars else 0 end), 0)
  into
    v_qr,
    v_bill,
    v_coin,
    v_manual
  from income_events
  where income_events.device_id = v_device.id
  and income_events.created_at > v_last_collection_at;

  insert into collections (
    company_id,
    device_id,
    user_id,
    period_start_at,
    period_end_at,
    qr_amount_ars,
    bill_amount_ars,
    coin_amount_ars,
    manual_amount_ars,
    notes,
    collected_at
  )
  values (
    v_device.company_id,
    v_device.id,
    v_user_id,
    v_last_collection_at,
    v_collected_at,
    v_qr,
    v_bill,
    v_coin,
    v_manual,
    p_notes,
    v_collected_at
  )
  returning id into v_collection_id;

  return query
  select
    v_collection_id,
    v_device.device_code,
    v_device.visible_name,
    v_qr,
    v_bill,
    v_coin,
    v_manual,
    v_qr + v_bill + v_coin + v_manual,
    v_collected_at;
end;
$$;

create or replace function register_bill_pulse_by_device_code(
  p_device_code text,
  p_device_token text,
  p_event_uid text default null
)
returns table (
  device_code text,
  visible_name text,
  source text,
  amount_ars integer,
  pulses integer,
  created_at timestamptz
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_amount integer;
  v_event_uid text;
  v_created_at timestamptz := now();
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  if v_device.device_token is null or v_device.device_token <> p_device_token then
    raise exception 'Token inválido para dispositivo %', p_device_code;
  end if;

  if v_device.status not in ('active', 'assigned') then
    raise exception 'Dispositivo no activo: %', p_device_code;
  end if;

  v_amount := coalesce(v_device.bill_pulse_value_ars, 1000);

  if p_event_uid is null then
    v_event_uid := p_device_code || '-bill-' || extract(epoch from now())::text;
  else
    v_event_uid := p_event_uid;
  end if;

  insert into income_events (
    company_id,
    device_id,
    source,
    amount_ars,
    pulses,
    device_event_uid,
    description,
    created_at
  )
  values (
    v_device.company_id,
    v_device.id,
    'billetero',
    v_amount,
    1,
    v_event_uid,
    'Pulso billetero registrado por dispositivo',
    v_created_at
  )
  on conflict (device_event_uid) do nothing;

  return query
  select
    v_device.device_code,
    v_device.visible_name,
    'billetero'::text,
    v_amount,
    1,
    v_created_at;
end;
$$;
create or replace function register_qr_payment_by_device_code(
  p_device_code text,
  p_mp_payment_id text,
  p_mp_preference_id text default null,
  p_external_reference text default null
)
returns table (
  device_code text,
  visible_name text,
  amount_ars integer,
  pulses_added integer,
  pending_pulses integer,
  created_at timestamptz
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_amount integer;
  v_pulses integer;
  v_event_uid text;
  v_pending integer;
  v_created_at timestamptz := now();
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  if v_device.status not in ('active', 'assigned') then
    raise exception 'Dispositivo no activo: %', p_device_code;
  end if;

  if v_device.company_id is null then
    raise exception 'Dispositivo sin empresa asignada: %', p_device_code;
  end if;

  v_amount := coalesce(v_device.qr_price_ars, 2000);
  v_pulses := coalesce(v_device.pulses_per_payment, 1);
  v_event_uid := 'qr-' || p_mp_payment_id;

  insert into qr_payments (
    company_id,
    device_id,
    mp_payment_id,
    mp_preference_id,
    external_reference,
    amount_ars,
    pulses,
    status,
    paid_at
  )
  values (
    v_device.company_id,
    v_device.id,
    p_mp_payment_id,
    p_mp_preference_id,
    p_external_reference,
    v_amount,
    v_pulses,
    'approved',
    v_created_at
  );

  insert into income_events (
    company_id,
    device_id,
    source,
    amount_ars,
    pulses,
    device_event_uid,
    description,
    created_at
  )
  values (
    v_device.company_id,
    v_device.id,
    'qr',
    v_amount,
    v_pulses,
    v_event_uid,
    'Pago QR aprobado',
    v_created_at
  )
  on conflict (device_event_uid) do nothing;

  insert into device_pending_pulses (
    device_id,
    pending_pulses,
    updated_at
  )
  values (
    v_device.id,
    v_pulses,
    now()
  )
  on conflict (device_id)
  do update set
    pending_pulses = device_pending_pulses.pending_pulses + excluded.pending_pulses,
    updated_at = now()
  returning device_pending_pulses.pending_pulses into v_pending;

  return query
  select
    v_device.device_code,
    v_device.visible_name,
    v_amount,
    v_pulses,
    v_pending,
    v_created_at;
end;
$$;


create or replace function consume_pending_pulse_by_device_code(
  p_device_code text,
  p_device_token text
)
returns table (
  device_code text,
  visible_name text,
  should_pulse boolean,
  pulse_duration_ms integer,
  remaining_pulses integer,
  message text
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_current_pulses integer := 0;
  v_remaining integer := 0;
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  if v_device.device_token is null or v_device.device_token <> p_device_token then
    raise exception 'Token inválido para dispositivo %', p_device_code;
  end if;

  if v_device.status not in ('active', 'assigned') then
    raise exception 'Dispositivo no activo: %', p_device_code;
  end if;

  select device_pending_pulses.pending_pulses
  into v_current_pulses
  from device_pending_pulses
  where device_pending_pulses.device_id = v_device.id
  for update;

  if v_current_pulses is null then
    v_current_pulses := 0;
  end if;

  if v_current_pulses <= 0 then
    return query
    select
      v_device.device_code,
      v_device.visible_name,
      false,
      v_device.pulse_duration_ms,
      0,
      'Sin pulsos pendientes'::text;

    return;
  end if;

  update device_pending_pulses
  set
    pending_pulses = pending_pulses - 1,
    updated_at = now()
  where device_pending_pulses.device_id = v_device.id
  returning device_pending_pulses.pending_pulses into v_remaining;

  return query
  select
    v_device.device_code,
    v_device.visible_name,
    true,
    v_device.pulse_duration_ms,
    v_remaining,
    'Enviar pulso a la máquina'::text;
end;
$$;
create or replace function device_heartbeat_by_device_code(
  p_device_code text,
  p_device_token text,
  p_wifi_rssi integer default null,
  p_firmware_version text default null
)
returns table (
  device_code text,
  visible_name text,
  status text,
  connection_status text,
  wifi_rssi integer,
  wifi_quality text,
  firmware_version text,
  last_seen_at timestamptz,
  qr_price_ars integer,
  pulses_per_payment integer,
  pulse_duration_ms integer,
  bill_pulse_value_ars integer,
  coin_pulse_value_ars integer,
  subscription_status text,
  subscription_expires_at timestamptz,
  subscription_active boolean
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_wifi_quality text;
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  if v_device.device_token is null or v_device.device_token <> p_device_token then
    raise exception 'Token inválido para dispositivo %', p_device_code;
  end if;

  if p_wifi_rssi is null then
    v_wifi_quality := null;
  elsif p_wifi_rssi >= -55 then
    v_wifi_quality := 'Excelente';
  elsif p_wifi_rssi >= -67 then
    v_wifi_quality := 'Buena';
  elsif p_wifi_rssi >= -75 then
    v_wifi_quality := 'Débil';
  else
    v_wifi_quality := 'Muy débil';
  end if;

  update devices
  set
    last_seen_at = now(),
    wifi_rssi = p_wifi_rssi,
    wifi_quality = v_wifi_quality,
    firmware_version = coalesce(p_firmware_version, devices.firmware_version)
  where devices.id = v_device.id;

  select *
  into v_device
  from devices
  where devices.id = v_device.id;

  return query
  select
    v_device.device_code,
    v_device.visible_name,
    v_device.status,
    'online'::text,
    v_device.wifi_rssi,
    v_device.wifi_quality,
    v_device.firmware_version,
    v_device.last_seen_at,
    v_device.qr_price_ars,
    v_device.pulses_per_payment,
    v_device.pulse_duration_ms,
    v_device.bill_pulse_value_ars,
    v_device.coin_pulse_value_ars,
    v_device.subscription_status,
    v_device.subscription_expires_at,
    case
      when v_device.subscription_status = 'active'
      and v_device.subscription_expires_at > now()
      then true
      else false
    end;
end;
$$;


create or replace function get_device_config_by_device_code(
  p_device_code text,
  p_device_token text
)
returns table (
  device_code text,
  visible_name text,
  status text,
  company_id uuid,
  qr_price_ars integer,
  pulses_per_payment integer,
  pulse_duration_ms integer,
  bill_pulse_value_ars integer,
  coin_pulse_value_ars integer,
  subscription_status text,
  subscription_expires_at timestamptz,
  subscription_active boolean,
  can_work boolean,
  message text
)
language plpgsql
as $$
declare
  v_device devices%rowtype;
  v_subscription_active boolean;
  v_can_work boolean;
  v_message text;
begin
  select *
  into v_device
  from devices
  where devices.device_code = p_device_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado: %', p_device_code;
  end if;

  if v_device.device_token is null or v_device.device_token <> p_device_token then
    raise exception 'Token inválido para dispositivo %', p_device_code;
  end if;

  v_subscription_active :=
    v_device.subscription_status = 'active'
    and v_device.subscription_expires_at > now();

  v_can_work :=
    v_device.status in ('active', 'assigned')
    and v_device.company_id is not null
    and v_subscription_active = true;

  if v_can_work then
    v_message := 'Dispositivo habilitado';
  elsif v_device.company_id is null then
    v_message := 'Dispositivo sin empresa asignada';
  elsif v_device.status = 'suspended' then
    v_message := 'Dispositivo suspendido';
  elsif v_subscription_active = false then
    v_message := 'Suscripción vencida o inactiva';
  else
    v_message := 'Dispositivo no habilitado';
  end if;

  return query
  select
    v_device.device_code,
    v_device.visible_name,
    v_device.status,
    v_device.company_id,
    v_device.qr_price_ars,
    v_device.pulses_per_payment,
    v_device.pulse_duration_ms,
    v_device.bill_pulse_value_ars,
    v_device.coin_pulse_value_ars,
    v_device.subscription_status,
    v_device.subscription_expires_at,
    v_subscription_active,
    v_can_work,
    v_message;
end;
$$;

create or replace function normalize_paysync_device_code(
  p_code text
)
returns text
language plpgsql
as $$
declare
  v_raw text;
  v_digits text;
begin
  v_raw := upper(trim(coalesce(p_code, '')));
  v_raw := replace(v_raw, ' ', '');
  v_raw := replace(v_raw, '_', '-');

  v_digits := regexp_replace(v_raw, '[^0-9]', '', 'g');

  if v_digits is null or v_digits = '' then
    return v_raw;
  end if;

  return 'PS-' || lpad(v_digits, 6, '0');
end;
$$;


create or replace function claim_device_by_code(
  p_device_code text,
  p_company_name text,
  p_company_email text default null
)
returns table (
  device_id uuid,
  device_code text,
  visible_name text,
  company_id uuid,
  company_name text,
  device_status text,
  subscription_status text,
  subscription_expires_at timestamptz,
  message text
)
language plpgsql
as $$
declare
  v_code text;
  v_device devices%rowtype;
  v_company companies%rowtype;
  v_status text;
begin
  v_code := normalize_paysync_device_code(p_device_code);

  if p_company_name is null or trim(p_company_name) = '' then
    raise exception 'Falta nombre de empresa';
  end if;

  select *
  into v_device
  from devices
  where devices.device_code = v_code
  limit 1;

  if v_device.id is null then
    raise exception 'Código inválido';
  end if;

  select *
  into v_company
  from companies
  where lower(companies.name) = lower(trim(p_company_name))
  limit 1;

  if v_company.id is null then
    insert into companies (
      name,
      contact_email,
      status
    )
    values (
      trim(p_company_name),
      p_company_email,
      'active'
    )
    returning * into v_company;
  end if;

  if v_device.company_id is not null and v_device.company_id <> v_company.id then
    raise exception 'Este dispositivo ya fue asignado';
  end if;

  if v_device.subscription_status = 'active'
  and v_device.subscription_expires_at > now() then
    v_status := 'active';
  else
    v_status := 'assigned';
  end if;

  update devices
  set
    company_id = v_company.id,
    status = v_status
  where devices.id = v_device.id
  returning * into v_device;

  return query
  select
    v_device.id,
    v_device.device_code,
    v_device.visible_name,
    v_company.id,
    v_company.name,
    v_device.status,
    v_device.subscription_status,
    v_device.subscription_expires_at,
    'Dispositivo agregado correctamente'::text;
end;
$$;


create or replace function activate_device_plan_by_code(
  p_device_code text,
  p_plan_type text default 'monthly'
)
returns table (
  device_id uuid,
  device_code text,
  visible_name text,
  plan_type text,
  amount_ars integer,
  days_added integer,
  subscription_status text,
  subscription_expires_at timestamptz,
  message text
)
language plpgsql
as $$
declare
  v_code text;
  v_device devices%rowtype;
  v_amount integer;
  v_days integer;
  v_start timestamptz;
  v_new_expiry timestamptz;
begin
  v_code := normalize_paysync_device_code(p_device_code);

  select *
  into v_device
  from devices
  where devices.device_code = v_code
  limit 1;

  if v_device.id is null then
    raise exception 'Dispositivo no encontrado';
  end if;

  if p_plan_type = 'six_months' then
    v_amount := 25000;
    v_days := 180;
  else
    v_amount := 5000;
    v_days := 30;
  end if;

  if v_device.subscription_expires_at is not null
  and v_device.subscription_expires_at > now() then
    v_start := v_device.subscription_expires_at;
  else
    v_start := now();
  end if;

  v_new_expiry := v_start + make_interval(days => v_days);

  insert into device_subscriptions (
    company_id,
    device_id,
    amount_ars,
    days_added,
    status,
    paid_at,
    starts_at,
    expires_at
  )
  values (
    v_device.company_id,
    v_device.id,
    v_amount,
    v_days,
    'approved',
    now(),
    v_start,
    v_new_expiry
  );

  update devices
  set
    subscription_status = 'active',
    subscription_expires_at = v_new_expiry,
    activated_at = coalesce(activated_at, now()),
    status = case
      when company_id is not null then 'active'
      else status
    end
  where devices.id = v_device.id
  returning * into v_device;

  return query
  select
    v_device.id,
    v_device.device_code,
    v_device.visible_name,
    p_plan_type,
    v_amount,
    v_days,
    v_device.subscription_status,
    v_device.subscription_expires_at,
    'Plan activado correctamente'::text;
end;
$$;

create or replace function activate_company_devices_plan_by_name(
  p_company_name text,
  p_plan_type text default 'monthly',
  p_only_inactive boolean default false
)
returns table (
  company_id uuid,
  company_name text,
  plan_type text,
  devices_activated integer,
  amount_per_device_ars integer,
  total_amount_ars integer,
  days_added integer,
  message text
)
language plpgsql
as $$
declare
  v_company companies%rowtype;
  v_device devices%rowtype;
  v_amount integer;
  v_days integer;
  v_count integer := 0;
  v_start timestamptz;
  v_new_expiry timestamptz;
begin
  if p_company_name is null or trim(p_company_name) = '' then
    raise exception 'Falta nombre de empresa';
  end if;

  select *
  into v_company
  from companies
  where lower(companies.name) = lower(trim(p_company_name))
  limit 1;

  if v_company.id is null then
    raise exception 'Empresa no encontrada: %', p_company_name;
  end if;

  if p_plan_type = 'six_months' then
    v_amount := 25000;
    v_days := 180;
  else
    v_amount := 5000;
    v_days := 30;
  end if;

  for v_device in
    select *
    from devices
    where devices.company_id = v_company.id
    and (
      p_only_inactive = false
      or devices.subscription_status is distinct from 'active'
      or devices.subscription_expires_at is null
      or devices.subscription_expires_at <= now()
    )
    order by devices.device_code
  loop
    if v_device.subscription_expires_at is not null
    and v_device.subscription_expires_at > now() then
      v_start := v_device.subscription_expires_at;
    else
      v_start := now();
    end if;

    v_new_expiry := v_start + make_interval(days => v_days);

    insert into device_subscriptions (
      company_id,
      device_id,
      amount_ars,
      days_added,
      status,
      paid_at,
      starts_at,
      expires_at
    )
    values (
      v_company.id,
      v_device.id,
      v_amount,
      v_days,
      'approved',
      now(),
      v_start,
      v_new_expiry
    );

    update devices
    set
      subscription_status = 'active',
      subscription_expires_at = v_new_expiry,
      activated_at = coalesce(activated_at, now()),
      status = 'active'
    where devices.id = v_device.id;

    v_count := v_count + 1;
  end loop;

  return query
  select
    v_company.id,
    v_company.name,
    p_plan_type,
    v_count,
    v_amount,
    v_count * v_amount,
    v_days,
    case
      when v_count = 0 then 'No había dispositivos para activar'
      else 'Plan masivo activado correctamente'
    end;
end;
$$;

create table if not exists plan_payments (
  id uuid primary key default gen_random_uuid(),

  mp_payment_id text unique not null,
  mp_preference_id text,
  external_reference text,

  scope text not null check (scope in ('device', 'company')),
  plan_type text not null check (plan_type in ('monthly', 'six_months')),

  device_code text,
  company_name text,

  amount_ars integer not null default 0,
  status text not null default 'approved',

  created_at timestamptz not null default now()
);


create or replace function register_device_plan_payment_by_code(
  p_device_code text,
  p_plan_type text,
  p_mp_payment_id text,
  p_mp_preference_id text default null,
  p_external_reference text default null,
  p_amount_ars integer default 0
)
returns table (
  device_code text,
  plan_type text,
  subscription_status text,
  subscription_expires_at timestamptz,
  amount_ars integer,
  message text
)
language plpgsql
as $$
declare
  v_payment_exists uuid;
  v_plan_result record;
begin
  if p_plan_type not in ('monthly', 'six_months') then
    raise exception 'Plan invalido';
  end if;

  select id
  into v_payment_exists
  from plan_payments
  where mp_payment_id = p_mp_payment_id
  limit 1;

  if v_payment_exists is not null then
    select
      d.device_code,
      d.subscription_status,
      d.subscription_expires_at
    into v_plan_result
    from devices d
    where d.device_code = normalize_paysync_device_code(p_device_code)
    limit 1;

    return query
    select
      v_plan_result.device_code,
      p_plan_type,
      v_plan_result.subscription_status,
      v_plan_result.subscription_expires_at,
      p_amount_ars,
      'Pago de plan ya registrado anteriormente'::text;

    return;
  end if;

  insert into plan_payments (
    mp_payment_id,
    mp_preference_id,
    external_reference,
    scope,
    plan_type,
    device_code,
    amount_ars,
    status
  )
  values (
    p_mp_payment_id,
    p_mp_preference_id,
    p_external_reference,
    'device',
    p_plan_type,
    normalize_paysync_device_code(p_device_code),
    p_amount_ars,
    'approved'
  );

  perform *
  from activate_device_plan_by_code(
    normalize_paysync_device_code(p_device_code),
    p_plan_type
  );

  select
    d.device_code,
    d.subscription_status,
    d.subscription_expires_at
  into v_plan_result
  from devices d
  where d.device_code = normalize_paysync_device_code(p_device_code)
  limit 1;

  return query
  select
    v_plan_result.device_code,
    p_plan_type,
    v_plan_result.subscription_status,
    v_plan_result.subscription_expires_at,
    p_amount_ars,
    'Plan de dispositivo activado correctamente'::text;
end;
$$;


create or replace function register_company_plan_payment_by_name(
  p_company_name text,
  p_plan_type text,
  p_mp_payment_id text,
  p_mp_preference_id text default null,
  p_external_reference text default null,
  p_amount_ars integer default 0
)
returns table (
  company_name text,
  plan_type text,
  affected_devices integer,
  amount_ars integer,
  message text
)
language plpgsql
as $$
declare
  v_payment_exists uuid;
  v_result record;
begin
  if p_plan_type not in ('monthly', 'six_months') then
    raise exception 'Plan invalido';
  end if;

  select id
  into v_payment_exists
  from plan_payments
  where mp_payment_id = p_mp_payment_id
  limit 1;

  if v_payment_exists is not null then
    return query
    select
      p_company_name,
      p_plan_type,
      0::integer,
      p_amount_ars,
      'Pago de plan ya registrado anteriormente'::text;

    return;
  end if;

  insert into plan_payments (
    mp_payment_id,
    mp_preference_id,
    external_reference,
    scope,
    plan_type,
    company_name,
    amount_ars,
    status
  )
  values (
    p_mp_payment_id,
    p_mp_preference_id,
    p_external_reference,
    'company',
    p_plan_type,
    p_company_name,
    p_amount_ars,
    'approved'
  );

  select *
  into v_result
  from activate_company_devices_plan_by_name(
    p_company_name,
    p_plan_type,
    false
  );

  return query
  select
    p_company_name,
    p_plan_type,
    coalesce(v_result.affected_devices, 0)::integer,
    p_amount_ars,
    'Plan de empresa activado correctamente'::text;
end;
$$;
