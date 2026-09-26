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
test('database migration and read-only version probe succeed',async()=>{assert.equal(await rpc('paysync_schema_version'),'20260926');});

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
