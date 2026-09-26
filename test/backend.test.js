const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const request=require('supertest');
const {createApp}=require('../server');
const {generateEspFirmware}=require('../lib/firmware');
const env={NODE_ENV:'production',API_KEY:'a'.repeat(48),SUPABASE_URL:'https://example.supabase.co/rest/v1/',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_fixture',MP_ACCESS_TOKEN:'fixture-token',MP_WEBHOOK_SECRET:'fixture-webhook',MP_COLLECTOR_ID:'123',MP_ENVIRONMENT:'production',PUBLIC_BASE_URL:'https://pay.example.com',ALLOWED_ORIGINS:'https://panel.example.com',PAYMENTS_ENABLED:'true'};
const orderId='00000000-0000-4000-8000-000000000001';
function setup(overrides={},handler=c=>c.url.endsWith('/paysync_schema_version')?'20260926-device-v1':[]) {
  const calls=[];
  const app=createApp({env:{...env,...overrides},fetchImpl:async(url,options)=>{
    const call={url,options,body:options.body?JSON.parse(options.body):null};calls.push(call);
    const r=await handler(call);
    return r instanceof Response?r:new Response(JSON.stringify(r),{headers:{'content-type':'application/json','content-range':'0-0/12'}});
  }});
  return {app,calls};
}
function signed(id='1234') {
  const ts=String(Date.now()); const requestId='request-test';
  return {'x-request-id':requestId,'x-signature':`ts=${ts},v1=${crypto.createHmac('sha256',env.MP_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex')}`};
}
test('health probes actual database and reports outages without leaking upstream details',async()=>{
  const healthy=setup();assert.equal((await request(healthy.app).get('/health')).status,200);
  assert.ok(healthy.calls[0].url.startsWith('https://example.supabase.co/rest/v1/devices'));
  assert.equal(healthy.calls[0].options.headers.Authorization,undefined);
  const bad=setup({},()=>{throw new Error('secret database password');});
  const r=await request(bad.app).get('/health');assert.equal(r.status,503);assert.equal(r.body.ok,false);assert.ok(!r.text.includes('password'));
});

test('health fails closed for missing migration and coin routes require credentials',async()=>{
  const {app,calls}=setup({},()=>[]);
  const r=await request(app).get('/health');assert.equal(r.status,503);assert.equal(r.body.supabase,'online');assert.equal(r.body.schema,'unavailable');
  calls.length=0;
  assert.equal((await request(app).post('/device/coin/claim').send({device:'4',boot_id:'valid-boot'})).status,400);
  assert.equal((await request(app).post('/device/coin/ack').send({device:'4',token:'x',command_id:orderId})).status,400);
  assert.equal(calls.length,0);
});

test('status renders actual checks and a short secure session without echoing keys',async()=>{
  const {app}=setup({},c=>c.url.endsWith('/paysync_schema_version')?'20260926-device-v1':c.url.includes('last_seen_at=not')?[{last_seen_at:'2026-09-26T12:00:00Z'}]:[]);
  const status=await request(app).get('/admin/status?format=json').set('x-api-key',env.API_KEY);
  assert.equal(status.status,200);assert.equal(status.body.data.metrics.devices,12);assert.equal(status.body.data.schema,'20260926-device-v1');
  assert.equal(status.body.data.configuration.mercado_pago,'configured_not_verified');
  const html=await request(app).get('/admin/status?key='+env.API_KEY);
  assert.equal(html.status,200);assert.ok(html.text.includes('Servicios disponibles'));assert.ok(!html.text.includes(env.API_KEY));assert.ok(!html.text.includes(env.MP_ACCESS_TOKEN));
  assert.match(html.headers['set-cookie'][0],/HttpOnly/);assert.match(html.headers['set-cookie'][0],/Secure/);assert.match(html.headers['set-cookie'][0],/SameSite=Strict/);
});

test('firmware download and printable QR require admin and never embed the admin key',async()=>{
  const device={device_code:'PS-000004',device_token:'fixture-device-secret',visible_name:'<script>bad()</script>',qr_price_ars:150,pulses_per_payment:2};
  const {app}=setup({FIRMWARE_CA_PEM:'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'},()=>[device]);
  const fw=await request(app).get('/admin/firmware?device=4&download=1').set('x-api-key',env.API_KEY);
  assert.equal(fw.status,200);assert.match(fw.headers['content-disposition'],/PaySync-PS-000004\.ino/);assert.ok(fw.text.includes('/device/consume-pulse'));assert.ok(!fw.text.includes(env.API_KEY));
  const qr=await request(app).get('/admin/print-qr?device=4').set('x-api-key',env.API_KEY);
  assert.equal(qr.status,200);assert.ok(qr.text.includes('data:image/png;base64,'));assert.ok(!qr.text.includes('<script>bad()'));assert.ok(!qr.text.includes('fixture-device-secret'));assert.ok(!qr.text.includes(env.API_KEY));
});

test('manual reconciliation rechecks the payment provider and is admin-only',async()=>{
  const {app,calls}=setup({},c=>c.url.includes('/v1/payments/')?{id:1234,status:'approved',collector_id:123,currency_id:'ARS',live_mode:true,transaction_amount:150,external_reference:orderId,metadata:{source:'paysync',order_id:orderId}}:{duplicate:true});
  assert.equal((await request(app).post('/admin/reconcile-payment').send({payment_id:'1234'})).status,401);
  assert.equal(calls.length,0);
  const r=await request(app).post('/admin/reconcile-payment').set('x-api-key',env.API_KEY).send({payment_id:'1234'});
  assert.equal(r.status,200);assert.equal(r.body.data.duplicate,true);assert.ok(calls[0].url.endsWith('/v1/payments/1234'));
});

test('client company, collections and plan history always use the verified tenant',async()=>{
  const cid='10000000-0000-4000-8000-000000000001';
  const {app,calls}=setup({},c=>c.url.endsWith('/auth/v1/user')?{id:'u',app_metadata:{paysync_role:'client',company_id:cid}}:[]);
  for(const route of ['company','collections','plan-payments']) {
    const r=await request(app).get('/client/'+route+'?company_id=evil&offset=100').set('Authorization','Bearer valid-token');
    assert.equal(r.status,200);assert.ok(calls.at(-1).url.includes('=eq.'+cid));assert.ok(!calls.at(-1).url.includes('evil'));assert.ok(!calls.at(-1).url.includes('access_token'));
  }
});
test('admin, diagnostics, financial summaries and claims require authentication',async()=>{
  const {app,calls}=setup();
  for(const path of ['/admin/companies','/device/summary','/device/live-status','/debug/supabase','/admin/firmware','/admin/status']) assert.equal((await request(app).get(path)).status,401,path);
  assert.equal((await request(app).post('/device/claim').send({device:'1',company:'X'})).status,401);
  assert.equal(calls.length,0);
});
test('no fallback API key and no API key query except status',async()=>{
  const {app}=setup({API_KEY:''});assert.equal((await request(app).get('/admin/status?key=insecure-legacy')).status,401);
  const {app:good}=setup();assert.equal((await request(good).get('/admin/companies?key='+env.API_KEY)).status,401);
});
test('admin mutations require POST and validate numbers before touching the database',async()=>{
  const {app,calls}=setup();
  assert.equal((await request(app).get('/admin/unassign-device?device=1').set('x-api-key',env.API_KEY)).status,405);
  for(const quantity of ['2oops',-1,2.3,201]) assert.equal((await request(app).post('/admin/create-devices-batch').set('x-api-key',env.API_KEY).send({quantity})).status,400);
  assert.equal(calls.length,0);
});
test('client management calls preserve RPC contracts and safe reassignment default',async()=>{
  const {app,calls}=setup();
  for(const [route,body,rpc] of [
    ['upsert-company',{company:'Cliente'},'upsert_company_by_name'],
    ['assign-device',{device:'4',company:'Cliente'},'admin_assign_device_to_company'],
    ['unassign-device',{device:'4'},'admin_unassign_device_by_code'],
    ['update-device-config',{device:'4',qr_price:150,pulses:2},'update_device_config_by_code'],
    ['create-devices-batch',{quantity:2},'create_devices_batch']
  ]) {const r=await request(app).post('/admin/'+route).set('x-api-key',env.API_KEY).send(body);assert.equal(r.status,200);assert.ok(calls.at(-1).url.endsWith('/rpc/'+rpc));}
  assert.equal(calls[1].body.p_device_code,'PS-000004');assert.equal(calls[1].body.p_force_reassign,false);
});
test('simulators are impossible in production even with the flag set',async()=>{
  const {app,calls}=setup({ENABLE_SIMULATORS:'true'});
  assert.equal((await request(app).post('/test/qr-approved').set('x-api-key',env.API_KEY)).status,404);
  assert.equal(calls.length,0);
  const dev=setup({NODE_ENV:'test',ENABLE_SIMULATORS:'true'},c=>c.url.endsWith('/paysync_prepare_order')?{id:orderId,amount_ars:150}:{registered:true});
  assert.equal((await request(dev.app).post('/test/qr-approved').set('x-api-key',env.API_KEY).send({device:'4'})).status,200);
  assert.equal((await request(dev.app).get('/test/qr-approved').set('x-api-key',env.API_KEY)).status,405);
});
test('QR checkout is blocked when paused or database reports offline/busy',async()=>{
  const paused=setup({PAYMENTS_ENABLED:'false'});assert.equal((await request(paused.app).get('/pay/start/PS-000004')).status,503);assert.equal(paused.calls.length,0);
  const offline=setup({},()=>({error:'device_not_ready'}));assert.equal((await request(offline.app).get('/pay/start/PS-000004')).status,409);assert.equal(offline.calls.length,1);
});
test('QR checkout uses saved price, trusted public URL, order metadata and stored preference',async()=>{
  const {app,calls}=setup({},c=>c.url.endsWith('paysync_prepare_order')?{id:orderId,amount_ars:150,device_code:'PS-000004',expires_at:'2030-01-01T12:00:00Z'}:c.url.endsWith('/checkout/preferences')?{id:'pref-1',init_point:'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1'}:{});
  const r=await request(app).get('/pay/start/PS-000004?json=1&price=1').set('Host','evil.example');
  assert.equal(r.status,200);assert.equal(r.body.data.amount,150);
  assert.equal(calls[1].body.items[0].unit_price,150);assert.equal(calls[1].body.notification_url,env.PUBLIC_BASE_URL+'/mp/webhook');assert.equal(calls[1].body.metadata.order_id,orderId);
  assert.ok(calls[2].url.endsWith('paysync_set_preference'));
});
test('webhooks reject spoofed notifications before lookup; signed approval uses atomic RPC',async()=>{
  const {app,calls}=setup({},c=>c.url.includes('/v1/payments/')?{id:1234,status:'approved',collector_id:123,currency_id:'ARS',live_mode:true,transaction_amount:150,external_reference:orderId,metadata:{source:'paysync',order_id:orderId}}:{registered:true});
  assert.equal((await request(app).post('/mp/webhook?data.id=1234').send({type:'payment',data:{id:'1234'}})).status,401);assert.equal(calls.length,0);
  assert.equal((await request(app).post('/mp/webhook?data.id=1234').set(signed()).send({type:'payment',data:{id:'999'}})).status,401);
  const r=await request(app).post('/mp/webhook?data.id=1234').set(signed()).send({type:'payment',data:{id:'1234'}});
  assert.equal(r.status,200);assert.ok(calls[1].url.endsWith('paysync_apply_payment'));assert.deepEqual(calls[1].body,{p_order_id:orderId,p_payment_id:'1234',p_amount:150});
});
test('wrong collector, sandbox payment, currency or amount never issue coins',async()=>{
  for(const mismatch of [{collector_id:999},{live_mode:false},{currency_id:'USD'},{transaction_amount:1.5}]) {
    const {app,calls}=setup({},()=>({id:1234,status:'approved',collector_id:123,currency_id:'ARS',live_mode:true,transaction_amount:150,external_reference:orderId,metadata:{source:'paysync',order_id:orderId},...mismatch}));
    assert.equal((await request(app).post('/mp/webhook?data.id=1234').set(signed()).send({type:'payment',data:{id:'1234'}})).status,400);assert.equal(calls.length,1);
  }
});
test('session role comes from verified app metadata, tenant cannot read another company',async()=>{
  const cid='00000000-0000-4000-8000-000000000002';
  const {app,calls}=setup({},c=>c.url.endsWith('/auth/v1/user')?{id:'u',app_metadata:{paysync_role:'client',company_id:cid},user_metadata:{paysync_role:'admin'}}:[]);
  assert.equal((await request(app).get('/admin/companies').set('Authorization','Bearer valid-token')).status,401);
  const r=await request(app).get('/client/devices?company_id=other').set('Authorization','Bearer valid-token');assert.equal(r.status,200);assert.ok(calls.at(-1).url.includes('company_id=eq.'+cid));assert.ok(!calls.at(-1).url.includes('device_token'));
});
test('CORS rejects unknown origin and malformed JSON returns JSON 400',async()=>{
  const {app}=setup();assert.equal((await request(app).get('/health').set('Origin','https://evil.example')).status,403);
  const r=await request(app).post('/device/heartbeat').set('Content-Type','application/json').send('{broken');assert.equal(r.status,400);assert.equal(r.body.ok,false);
});
test('legacy consumption is retired and generated firmware verifies TLS and persists receipts',async()=>{
  const {app}=setup();assert.equal((await request(app).get('/device/consume-pulse')).status,426);
  assert.throws(()=>generateEspFirmware('PS-000004','fixture-device-secret',{caPem:'',publicUrl:env.PUBLIC_BASE_URL}));
  const code=generateEspFirmware('PS-000004','fixture-device-secret',{caPem:'-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',publicUrl:env.PUBLIC_BASE_URL});
  assert.ok(!code.includes('setInsecure'));assert.ok(code.includes('setTrustAnchors'));assert.ok(code.includes('/device/coin/ack'));assert.ok(code.includes('EEPROM_SIZE = 512'));assert.ok(!code.includes('body.indexOf("true")'));assert.ok(!code.includes(env.API_KEY));
});
test('public success page never activates plans or delivers credits',async()=>{
  const {app,calls}=setup();const r=await request(app).get('/pay/success?status=approved');assert.equal(r.status,200);assert.equal(calls.length,0);assert.ok(!r.text.includes('Pago aprobado'));
});

test('new consume-pulse requires typed readiness and never uses the legacy dequeue',async()=>{
  const {app,calls}=setup({},()=>({command:{id:orderId,pulse_duration_ms:180}}));
  const base={device:'4',token:'fixture-device-token',boot_id:'fixture-boot',protocol:'ack-v1',ready:true};
  for(const invalid of [{ready:'true'},{boot_id:'bad'},{token:''}])assert.equal((await request(app).post('/device/consume-pulse').send({...base,...invalid})).status,400);
  assert.equal(calls.length,0);
  const r=await request(app).post('/device/consume-pulse').send(base);
  assert.equal(r.status,200);assert.equal(r.body.protocol,'ack-v1');assert.equal(r.body.data.command.id,orderId);
  assert.ok(calls[0].url.endsWith('/paysync_poll_coin'));assert.equal(calls[0].body.p_device_code,'PS-000004');
});

test('heartbeat stores bounded telemetry and preserves legacy data while exposing runtime confirmation',async()=>{
  const {app,calls}=setup({},c=>c.url.endsWith('/paysync_device_telemetry')?{ready:false}:[{device_code:'PS-000004'}]);
  const base={device:'4',token:'fixture-device-token',boot_id:'fixture-boot',protocol:'ack-v1',ready:false,rssi:-60,firmware:'paysync-esp8266-v1.0.0',uptime_ms:999999,free_heap:35000,pending_events:3,last_error:'none',maintenance:true};
  for(const invalid of [{uptime_ms:-1},{free_heap:'35000'},{pending_events:129},{last_error:'secret\nvalue'},{maintenance:'true'}])assert.equal((await request(app).post('/device/heartbeat').send({...base,...invalid})).status,400);
  assert.equal(calls.length,0);
  const r=await request(app).post('/device/heartbeat').send(base);
  assert.equal(r.status,200);assert.equal(r.body.runtime.ready,false);assert.equal(r.body.data[0].device_code,'PS-000004');assert.equal(calls[0].body.p_uptime_ms,999999);
});

test('ack-v1 cash and collection events retain identity and refuse conflicts',async()=>{
  const base={device:'4',token:'fixture-device-token',protocol:'ack-v1',event_uid:'fixture-event-001',company_id:'10000000-0000-4000-8000-000000000001',source:'billetero',unit_amount_ars:1000};
  const {app,calls}=setup({},c=>({recorded:true,event_uid:c.body.p_event_uid}));
  for(const route of ['bill-pulse','register-collection']) {
    const r=await request(app).post('/device/'+route).send(base);assert.equal(r.status,200);assert.equal(r.body.data.event_uid,base.event_uid);
    assert.ok(calls.at(-1).url.endsWith('/paysync_record_device_event'));
  }
  assert.equal(calls[0].body.p_kind,'billetero');assert.equal(calls[1].body.p_kind,'collection');
  for(const invalid of [{company_id:''},{event_uid:''},{source:'qr'},{unit_amount_ars:0}])assert.equal((await request(app).post('/device/bill-pulse').send({...base,...invalid})).status,400);
  const conflict=setup({},()=>({error:'company_changed'}));
  assert.equal((await request(conflict.app).post('/device/bill-pulse').send(base)).status,409);
});

test('status distinguishes online count, payment history, device faults and unverified production prerequisites',async()=>{
  const {app}=setup({},c=>c.url.endsWith('/paysync_schema_version')?'20260926-device-v1':c.url.includes('last_error_at=not')?[{last_error:'receipt_uncertain'}]:c.url.includes('kind=eq.qr')?[{state:'relay_confirmed'}]:c.url.includes('kind=in.')?[{kind:'device_plan'}]:[]);
  const r=await request(app).get('/admin/status?format=json').set('x-api-key',env.API_KEY);
  assert.equal(r.status,200);assert.equal(r.body.data.metrics.online_devices,12);
  assert.equal(r.body.data.metrics.latest_qr_payments[0].state,'relay_confirmed');assert.equal(r.body.data.metrics.latest_plan_payments[0].kind,'device_plan');
  assert.equal(r.body.data.metrics.recent_device_errors[0].last_error,'receipt_uncertain');assert.ok(r.body.data.production_warnings.some(w=>w.code==='physical_credit_unverified'));
  assert.ok(!r.text.includes('fixture-token'));
});

test('per-device template safely quotes provisioning and does not recursively substitute token content',()=>{
  const token='fake-"-\\-{{PAYSYNC_CA_PEM}}-secret';
  const code=generateEspFirmware('PS-000004',token,{publicUrl:env.PUBLIC_BASE_URL,caPem:'-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----'});
  const literal=code.match(/const char DEVICE_TOKEN\[\] = (.*);/)[1];assert.equal(JSON.parse(literal),token);
  assert.throws(()=>generateEspFirmware('PS-000004',token,{publicUrl:'http://example.com',caPem:'-----BEGIN CERTIFICATE-----'}));
  assert.throws(()=>generateEspFirmware('BAD',token,{publicUrl:env.PUBLIC_BASE_URL,caPem:'-----BEGIN CERTIFICATE-----'}));
});
