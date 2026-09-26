const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
let db;
const cid='10000000-0000-4000-8000-000000000001';
const did='20000000-0000-4000-8000-000000000001';
before(async()=>{
  db=new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname,'fixtures/legacy-schema.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/20260926_production_foundation.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/20260926_esp8266_device.sql'),'utf8'));
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec(`truncate paysync_payment_anomalies,paysync_coin_commands,paysync_orders,paysync_runtime,qr_payments,income_events,device_pending_pulses,plan_payments,device_subscriptions,devices,companies cascade;
  insert into companies(id,name) values('${cid}','Fixture Arcade');
  insert into devices(id,device_code,company_id,status,qr_price_ars,pulses_per_payment,pulse_duration_ms,device_token,subscription_status,subscription_expires_at) values('${did}','PS-000004','${cid}','active',150,2,120,'fixture-device-token','active',now()+interval '30 days');
  insert into paysync_runtime(device_id,boot_id,ready,commissioned,protocol) values('${did}','boot-original',true,true,'ack-v1');`);
});
async function rpc(name,args=[]) {
  const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');
  return (await db.query(`select public.${name}(${placeholders}) as result`,args)).rows[0].result;
}
const prepare=(kind='qr')=>rpc('paysync_prepare_order',[kind,kind==='company_plan'?null:'PS-000004',cid,kind==='qr'?null:'monthly',5000]);
const claim=(boot='boot-original')=>rpc('paysync_claim_coin',['PS-000004','fixture-device-token',boot]);
const ack=(id,outcome='relay_sent')=>rpc('paysync_ack_coin',['PS-000004','fixture-device-token',id,outcome]);
test('database migration and read-only version probe succeed',async()=>{assert.equal(await rpc('paysync_schema_version'),'20260926-device-v1');});

test('new polls renew a stale lease, require commissioning and refuse maintenance delivery',async()=>{
  const order=await prepare();await rpc('paysync_apply_payment',[order.id,'mp-poll',150]);
  await db.exec("update paysync_runtime set last_seen_at=now()-interval '1 hour',commissioned=false");
  const poll=(ready=true)=>rpc('paysync_poll_coin',['PS-000004','fixture-device-token','boot-original',ready]);
  assert.equal((await poll()).command,null);
  await db.exec('update paysync_runtime set commissioned=true');
  assert.equal((await poll(false)).command,null);assert.ok((await poll()).command.id);
  assert.equal((await rpc('paysync_poll_coin',['PS-000004','fixture-device-token','different-boot',true])).command,null);
});

test('telemetry is authenticated, durable and cannot advertise ready during maintenance',async()=>{
  const args=['PS-000004','fixture-device-token','boot-original',true,123456,32000,3,'storage_failure',true];
  const r=await rpc('paysync_device_telemetry',args);assert.equal(r.ready,false);
  const row=(await db.query('select ready,maintenance,free_heap,pending_events,last_error,last_error_at from paysync_runtime')).rows[0];
  assert.equal(row.maintenance,true);assert.equal(row.free_heap,32000);assert.ok(row.last_error_at);
  await assert.rejects(rpc('paysync_device_telemetry',args.map((v,i)=>i===1?null:v)),/Invalid device/);
  await assert.rejects(rpc('paysync_device_telemetry',args.map((v,i)=>i===6?129:v)),/Invalid telemetry/);
});

const deviceEvent=(uid,kind='billetero',amount=1000,company=cid)=>rpc('paysync_record_device_event',['PS-000004','fixture-device-token',uid,company,kind,amount,'fixture']);
test('offline cash retries are atomic, retain snapshot amount and reject event identity conflicts',async()=>{
  const results=await Promise.all([deviceEvent('event-cash-001'),deviceEvent('event-cash-001')]);
  assert.equal(results.filter(r=>r.duplicate).length,1);
  await db.exec('update devices set bill_pulse_value_ars=9999');
  assert.equal((await deviceEvent('event-cash-001')).amount_ars,1000);
  assert.equal((await deviceEvent('event-cash-001','billetero',2000)).error,'event_conflict');
  assert.equal((await deviceEvent('event-cash-001','monedero')).error,'event_conflict');
  assert.equal((await db.query('select count(*)::int as n from income_events')).rows[0].n,1);
  await db.exec('update devices set company_id=null');
  assert.equal((await deviceEvent('event-cash-001')).duplicate,true);
  assert.equal((await deviceEvent('event-cash-002')).error,'company_changed');
});

test('collection retries create one collection and preserve the cash queue boundary',async()=>{
  await deviceEvent('event-cash-001');await deviceEvent('event-coin-001','monedero',100);
  const first=await deviceEvent('event-collect-001','collection',0);
  assert.equal(first.total_amount_ars,1100);assert.equal(first.recorded,true);
  assert.equal((await deviceEvent('event-collect-001','collection',0)).collection_id,first.collection_id);
  await deviceEvent('event-cash-002');
  const second=await deviceEvent('event-collect-002','collection',0);assert.equal(second.total_amount_ars,1000);
  assert.equal((await db.query('select count(*)::int as n from collections')).rows[0].n,2);
});

test('new cash RPC and event table cannot be invoked by browser roles',async()=>{
  const row=(await db.query("select has_function_privilege('anon','paysync_record_device_event(text,text,text,uuid,text,integer,text)','execute') as anon, has_table_privilege('authenticated','paysync_device_events','select') as browser")).rows[0];
  assert.deepEqual(row,{anon:false,browser:false});
  await assert.rejects(rpc('paysync_record_device_event',['PS-000004',null,'event-cash-001',cid,'billetero',1000,null]),/Invalid device/);
});

test('collection never transfers uncollected income from a previous company',async()=>{
  await deviceEvent('event-old-company');
  const other='10000000-0000-4000-8000-000000000002';
  await db.exec(`insert into companies(id,name) values('${other}','Second company'); update devices set company_id='${other}'`);
  const r=await deviceEvent('event-new-collect','collection',0,other);assert.equal(r.total_amount_ars,0);
  assert.equal((await deviceEvent('event-old-company')).duplicate,true);
});

test('missing device credentials, boot identity and receipt outcome cannot bypass SQL checks',async()=>{
  for(const token of [null,'','wrong']) {
    await assert.rejects(rpc('paysync_heartbeat',['PS-000004',token,'boot-original',true]),/Invalid device/);
    await assert.rejects(rpc('paysync_claim_coin',['PS-000004',token,'boot-original']),/Invalid device/);
  }
  await assert.rejects(rpc('paysync_heartbeat',['PS-000004','fixture-device-token',null,true]),/Invalid heartbeat/);
  const order=await prepare();await rpc('paysync_apply_payment',[order.id,'mp-one',150]);
  assert.equal((await claim(null)).command,null);
  const first=await claim();
  await assert.rejects(rpc('paysync_ack_coin',['PS-000004',null,first.command.id,'relay_sent']),/Invalid device/);
  await assert.rejects(ack(first.command.id,null),/Invalid outcome/);
  assert.equal((await claim()).command.id,first.command.id);
});

test('assignment cannot move a paid unresolved credit to another client',async()=>{
  const order=await prepare();await rpc('paysync_apply_payment',[order.id,'mp-one',150]);
  await assert.rejects(db.exec('update devices set company_id=null'),/Resolve paid orders/);
  assert.ok((await claim()).command);
});
test('offline, expired, uncommissioned and legacy-credit machines cannot create checkout',async()=>{
  await db.exec("update paysync_runtime set last_seen_at=now()-interval '31 seconds'");
  assert.equal((await prepare()).error,'device_not_ready');
  await db.exec('update paysync_runtime set last_seen_at=now(),commissioned=false');
  assert.equal((await prepare()).error,'device_not_ready');
  await db.exec("update paysync_runtime set commissioned=true; update devices set subscription_expires_at=now()-interval '1 second'");
  assert.equal((await prepare()).error,'device_disabled');
  await db.exec(`update devices set subscription_expires_at=now()+interval '1 day'; insert into device_pending_pulses(device_id,pending_pulses) values('${did}',1)`);
  assert.equal((await prepare()).error,'legacy_credits_need_reconciliation');
});
test('one active checkout per machine, expired quote does not permanently block it',async()=>{
  assert.ok((await prepare()).id);assert.equal((await prepare()).error,'previous_payment_unresolved');
  await db.exec("update paysync_orders set expires_at=now()-interval '1 second'");assert.ok((await prepare()).id);
});
test('duplicate payment notifications create one income row and exactly the quoted pulses',async()=>{
  const order=await prepare();
  const results=await Promise.all([rpc('paysync_apply_payment',[order.id,'mp-one',150]),rpc('paysync_apply_payment',[order.id,'mp-one',150])]);
  assert.equal(results.filter(r=>r.registered).length,1);assert.equal(results.filter(r=>r.duplicate).length,1);
  assert.equal((await db.query('select count(*)::int as n from income_events')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int as n from paysync_coin_commands')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int as n from device_pending_pulses')).rows[0].n,0);
});
test('price and pulse changes after checkout do not change the purchased credit',async()=>{
  const order=await prepare();await db.exec('update devices set qr_price_ars=999,pulses_per_payment=7');
  await rpc('paysync_apply_payment',[order.id,'mp-one',150]);
  const row=(await db.query('select amount_ars,pulses from qr_payments')).rows[0];assert.deepEqual(row,{amount_ars:150,pulses:2});
});
test('paid while offline remains durable and blocks new checkout until delivery',async()=>{
  const order=await prepare();await db.exec("update paysync_runtime set last_seen_at=now()-interval '1 hour'");
  await rpc('paysync_apply_payment',[order.id,'mp-one',150]);assert.equal((await claim()).command,null);
  await rpc('paysync_heartbeat',['PS-000004','fixture-device-token','boot-original',true]);
  assert.equal((await prepare()).error,'previous_payment_unresolved');
  const first=await claim();assert.ok(first.command.id);assert.equal((await claim()).command.id,first.command.id);
  await ack(first.command.id);await ack(first.command.id);
  const second=await claim();assert.notEqual(second.command.id,first.command.id);await ack(second.command.id);
  assert.equal((await claim()).command,null);
  assert.equal((await db.query('select state from paysync_orders')).rows[0].state,'relay_confirmed');
});
test('reboot cannot replay a sent command, saved receipt can still acknowledge it',async()=>{
  const order=await prepare();await rpc('paysync_apply_payment',[order.id,'mp-one',150]);const first=await claim();
  const hb=await rpc('paysync_heartbeat',['PS-000004','fixture-device-token','boot-restarted',true]);assert.equal(hb.ready,false);
  assert.equal((await claim('boot-restarted')).command,null);
  await ack(first.command.id);
  await rpc('paysync_heartbeat',['PS-000004','fixture-device-token','boot-restarted',true]);
  assert.ok((await claim('boot-restarted')).command);
});
test('uncertain pulse is never retried automatically and produces review incident',async()=>{
  const order=await prepare();await rpc('paysync_apply_payment',[order.id,'mp-one',150]);const first=await claim();await ack(first.command.id,'uncertain');
  await rpc('paysync_heartbeat',['PS-000004','fixture-device-token','boot-original',true]);assert.equal((await claim()).command,null);assert.equal((await prepare()).error,'previous_payment_unresolved');
  await assert.rejects(()=>ack(first.command.id));
});
test('mismatched amount, reassignment and second payment are retained for review',async()=>{
  const order=await prepare();assert.equal((await rpc('paysync_apply_payment',[order.id,'mp-one',1])).reason,'amount_mismatch');
  assert.equal((await rpc('paysync_apply_payment',[order.id,'mp-two',150])).reason,'second_payment_for_order');
  assert.equal((await db.query('select count(*)::int as n from paysync_coin_commands')).rows[0].n,0);
});
test('database rollback prevents lost payments after an internal insert failure',async()=>{
  const order=await prepare();await db.exec("alter table income_events add constraint test_failure check (amount_ars<100)");
  await assert.rejects(()=>rpc('paysync_apply_payment',[order.id,'mp-one',150]));
  assert.equal((await db.query('select mp_payment_id from paysync_orders')).rows[0].mp_payment_id,null);
  assert.equal((await db.query('select count(*)::int as n from qr_payments')).rows[0].n,0);
  await db.exec('alter table income_events drop constraint test_failure');
  assert.equal((await rpc('paysync_apply_payment',[order.id,'mp-one',150])).registered,true);
});
test('device and company plan renewal is applied once with no coin commands',async()=>{
  for(const kind of ['device_plan','company_plan']) {
    const order=await prepare(kind);await rpc('paysync_apply_payment',[order.id,'payment-'+kind,5000]);await rpc('paysync_apply_payment',[order.id,'payment-'+kind,5000]);
  }
  assert.equal((await db.query('select count(*)::int as n from device_subscriptions')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int as n from paysync_coin_commands')).rows[0].n,0);
});
test('company quote cannot renew an expanded or reassigned device set',async()=>{
  const order=await prepare('company_plan');await db.exec(`insert into devices(device_code,company_id) values('PS-000005','${cid}')`);
  assert.equal((await rpc('paysync_apply_payment',[order.id,'mp-one',5000])).reason,'company_devices_changed');
  assert.equal((await db.query('select count(*)::int as n from device_subscriptions')).rows[0].n,0);
});
test('revoked browser grants prevent bypassing the backend payment and admin checks',async()=>{
  await db.exec('set role anon');
  await assert.rejects(()=>db.query('select * from devices'));
  await assert.rejects(()=>rpc('paysync_apply_payment',['00000000-0000-4000-8000-000000000001','fake',150]));
  await assert.rejects(()=>rpc('register_qr_payment_by_device_code',['PS-000004','fake',null,null]));
  await db.exec('reset role');
});
