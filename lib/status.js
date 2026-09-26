const {SCHEMA_VERSION}=require('./device-protocol');
function installStatus(app,rt) {
  const {config,configIssues,supabaseRequest,dbRaw,ok,escapeHtml}=rt;
  async function probe() {
    const start=Date.now();
    try { await supabaseRequest('/rest/v1/devices?select=id&limit=1'); const schema=await rt.callRpc('paysync_schema_version'); return {connected:true,ok:schema===SCHEMA_VERSION,schema,latency_ms:Date.now()-start}; }
    catch { return {ok:false,latency_ms:Date.now()-start}; }
  }
  app.get('/health',async(req,res)=>{
    const db=await probe();
    const ready=db.ok && configIssues().length===0;
    res.status(ready?200:503).json({ok:ready,service:'paysync-backend',backend:'online',supabase:db.connected?'online':'unavailable',schema:db.ok?'ready':'unavailable',configuration:configIssues().length?'incomplete':'ready'});
  });
  app.get('/admin/status',async(req,res)=>{
    const db=await probe();
    let metrics=null, migration=db.schema || null;
    if(db.ok) {
      try {
        const cutoff=encodeURIComponent(new Date(Date.now()-30000).toISOString());
        const [count,last,incidents,anomalies,online,boards,qr,plans,errors]=await Promise.all([
          dbRaw('/rest/v1/devices?select=id&limit=1','GET',null,{Prefer:'count=exact'}),
          supabaseRequest('/rest/v1/devices?select=last_seen_at&last_seen_at=not.is.null&order=last_seen_at.desc&limit=1'),
          supabaseRequest('/rest/v1/paysync_orders?select=id,kind,device_code,state,paid_at&state=in.(paid,review)&order=created_at.asc&limit=100'),
          supabaseRequest('/rest/v1/paysync_payment_anomalies?select=payment_id,order_id,reason,created_at&order=created_at.desc&limit=100'),
          dbRaw('/rest/v1/paysync_runtime?select=device_id&last_seen_at=gte.'+cutoff+'&limit=1','GET',null,{Prefer:'count=exact'}),
          supabaseRequest('/rest/v1/paysync_runtime?select=device_id,ready,commissioned,last_seen_at,uptime_ms,free_heap,pending_events,maintenance,devices(device_code,visible_name,wifi_rssi,firmware_version)&last_seen_at=gte.'+cutoff+'&order=last_seen_at.desc&limit=100'),
          supabaseRequest('/rest/v1/paysync_orders?select=id,device_code,amount_ars,state,paid_at,mp_payment_id&kind=eq.qr&paid_at=not.is.null&order=paid_at.desc&limit=20'),
          supabaseRequest('/rest/v1/paysync_orders?select=id,kind,company_name,device_codes,amount_ars,state,paid_at,mp_payment_id&kind=in.(device_plan,company_plan)&paid_at=not.is.null&order=paid_at.desc&limit=20'),
          supabaseRequest('/rest/v1/paysync_runtime?select=device_id,last_error,last_error_at,devices(device_code)&last_error_at=not.is.null&order=last_error_at.desc&limit=20')
        ]);
        const total=count.headers.get('content-range')?.split('/')[1];
        const onlineTotal=online.headers.get('content-range')?.split('/')[1];
        metrics={devices:total && total!=='*'?Number(total):null,last_heartbeat:last[0]?.last_seen_at || null,
          online_devices:onlineTotal && onlineTotal!=='*'?Number(onlineTotal):null,online_window_seconds:30,recent_boards:boards,
          latest_qr_payments:qr,latest_plan_payments:plans,recent_device_errors:errors,unresolved_orders:incidents,payment_anomalies:anomalies};
      } catch {migration='unavailable';}
    }
    const warnings=[
      {code:'physical_credit_unverified',message:'ACK confirma activacion del rele; verificar credito real y sensor en cada maquina.'},
      {code:'hosting_plan_unverified',message:'Verificar Supabase pago y capacidad/plan Vercel; este endpoint no consulta facturacion.'},
      {code:'recovery_unverified',message:'Verificar backups, restauracion ensayada y monitoreo externo con alertas.'},
      {code:'access_review_required',message:'Verificar rotacion de secretos expuestos previamente, usuarios admin/cliente y aislamiento de clientes.'},
      {code:'open_checkout_race',message:'Un checkout ya abierto puede pagarse despues de una desconexion; revisar entregas pendientes y devoluciones.'}
    ];
    if(!config.caPem.includes('-----BEGIN CERTIFICATE-----'))warnings.push({code:'firmware_ca_missing',message:'Falta FIRMWARE_CA_PEM para generar firmware con TLS.'});
    if(metrics?.unresolved_orders?.length || metrics?.payment_anomalies?.length)warnings.push({code:'payment_review',message:'Hay pagos o entregas que requieren revision.'});
    const data={backend:'online',supabase:db,configuration:{issues:configIssues(),mercado_pago:config.mpToken?'configured_not_verified':'missing',webhook_secret:!!config.webhookSecret,simulators:config.simulations,payments_enabled:config.paymentsEnabled},schema:migration,metrics,production_warnings:warnings};
    const ready=db.ok && !configIssues().length && migration===SCHEMA_VERSION;
    res.status(ready?200:503);
    if(req.query.format==='json' || req.query.json==='1') return res.json({ok:ready,data});
    return res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PaySync · Estado</title><style>body{font:16px system-ui;background:#0b1120;color:#e5e7eb;max-width:900px;margin:40px auto;padding:20px}h1{color:${ready?'#34d399':'#fb923c'}}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111827;padding:24px;border-radius:12px}a{color:#38bdf8}</style><h1>${ready?'Servicios disponibles':'Atención requerida'}</h1><p>Los cobros ${config.paymentsEnabled?'están habilitados y se verifican por máquina':'están bloqueados hasta completar la puesta en marcha'}.</p><p>Una credencial configurada no demuestra que Mercado Pago esté operativo. Entrega de relé y crédito físico se verifican por separado.</p><pre>${escapeHtml(JSON.stringify(data,null,2))}</pre></html>`);
  });
  app.get('/auth/me',(req,res)=>ok(res,req.auth));
  app.get('/client/devices',async(req,res)=>{
    try {
      if(req.auth.role!=='client') return rt.fail(res,rt.httpError(403,'Client account required'));
      const rows=await supabaseRequest('/rest/v1/device_dashboard_summary?select=*&company_id=eq.'+encodeURIComponent(req.auth.company_id)+'&order=device_code.asc&limit=500');
      return ok(res,rows);
    }catch(e){rt.fail(res,e);}
  });
  for(const [route,table,fields,order] of [
    ['company','companies','id,name,contact_name,contact_email,contact_phone,mp_alias,status','name.asc'],
    ['plan-payments','device_subscriptions','id,device_id,amount_ars,status,paid_at,starts_at,expires_at','paid_at.desc'],
    ['collections','collections','id,device_id,qr_amount_ars,bill_amount_ars,coin_amount_ars,total_amount_ars,notes,collected_at','collected_at.desc']
  ]) app.get('/client/'+route,async(req,res)=>{
    try {
      if(req.auth.role!=='client') throw rt.httpError(403,'Client account required');
      const offset=Number(rt.getParam(req,['offset'],0));
      if(!Number.isSafeInteger(offset) || offset<0 || offset>1000000) throw rt.httpError(400,'Invalid offset');
      return ok(res,await supabaseRequest('/rest/v1/'+table+'?select='+fields+'&'+(table==='companies'?'id':'company_id')+'=eq.'+encodeURIComponent(req.auth.company_id)+'&order='+order+'&limit=100&offset='+offset));
    }catch(e){rt.fail(res,e);}
  });
  app.get('/admin/payment-anomalies',async(req,res)=>{
    try {return ok(res,await supabaseRequest('/rest/v1/paysync_payment_anomalies?select=*&order=created_at.desc&limit=200'));}catch(e){rt.fail(res,e);}
  });
  app.get('/admin/delivery-incidents',async(req,res)=>{
    try {return ok(res,await supabaseRequest('/rest/v1/paysync_orders?select=id,kind,device_code,state,paid_at,review_reason,mp_payment_id&state=in.(paid,review)&order=created_at.asc&limit=200'));}catch(e){rt.fail(res,e);}
  });
}
module.exports={installStatus};
