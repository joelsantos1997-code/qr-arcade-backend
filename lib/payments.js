const crypto=require('node:crypto');
function verifyWebhook(req,secret) {
  if(!secret) return false;
  const id=req.query['data.id'];
  const requestId=req.get('x-request-id');
  const signature=req.get('x-signature') || '';
  const pairs=signature.split(',').map(x=>x.trim().split('='));
  const ts=pairs.filter(x=>x[0]==='ts');
  const hashes=pairs.filter(x=>x[0]==='v1');
  if(typeof id!=='string' || !/^\d+$/.test(id) || !requestId || !/^[\w-]{1,200}$/.test(requestId) || ts.length!==1 || !/^\d+$/.test(ts[0][1]) || hashes.length!==1 || !/^[a-f0-9]{64}$/i.test(hashes[0][1])) return false;
  if(req.body?.data?.id!==undefined && String(req.body.data.id)!==id) return false;
  const expected=crypto.createHmac('sha256',secret).update(`id:${id};request-id:${requestId};ts:${ts[0][1]};`).digest();
  // Replayed authentic notifications are safe through database idempotency. Do not
  // reject delayed provider retries based on their original signature timestamp.
  return crypto.timingSafeEqual(expected,Buffer.from(hashes[0][1],'hex'));
}
function installPayments(app,rt) {
  const {config,callRpc,supabaseRequest,mercadoPagoRequest,getParam,normalizeDeviceCode,httpError,ok,fail}=rt;
  async function start(req,res,kind,simulate=false) {
    try {
      if(!simulate && !config.paymentsEnabled) throw httpError(503,'Payments paused');
      if(!simulate && rt.configIssues().length) throw httpError(503,'Configuration incomplete');
      let companyId=null,companyName=null;
      const device=normalizeDeviceCode(getParam(req,['device_code','device','code']));
      const plan=kind==='qr'?null:getParam(req,['plan','plan_type'],'monthly');
      if(kind!=='qr') {
        if(!['monthly','six_months'].includes(plan)) throw httpError(400,'Invalid plan');
        if(!rt.checkApiKey(req) && !req.auth) throw httpError(401,'Session required');
        if(kind==='company_plan') {
          companyName=getParam(req,['company','company_name','name']);
          const companies=await supabaseRequest('/rest/v1/companies?select=id,name&name=eq.'+encodeURIComponent(companyName || '')+'&limit=1');
          if(!companies.length) throw httpError(404,'Company not found');
          companyId=companies[0].id; companyName=companies[0].name;
        }else {
          const devices=await supabaseRequest('/rest/v1/devices?select=company_id&device_code=eq.'+encodeURIComponent(device)+'&limit=1');
          if(!devices.length) throw httpError(404,'Device not found');
          companyId=devices[0].company_id;
        }
        if(!rt.checkApiKey(req) && (req.auth.role!=='client' || req.auth.company_id!==companyId)) throw httpError(403,'Company access denied');
      }
      const intent=await callRpc('paysync_prepare_order',{p_kind:kind,p_device_code:device || null,p_company_id:companyId,p_plan_type:plan,p_unit_amount:plan==='six_months'?config.sixMonths:config.monthly});
      if(intent.error) throw httpError(409,intent.error);
      if(!intent.id || !Number.isSafeInteger(intent.amount_ars) || intent.amount_ars<=0) throw httpError(503,'Invalid order response');
      if(simulate) {
        const paymentId='SIM-'+crypto.randomUUID();
        return ok(res,{simulated:true,order_id:intent.id,payment_id:paymentId,result:await callRpc('paysync_apply_payment',{p_order_id:intent.id,p_payment_id:paymentId,p_amount:intent.amount_ars})});
      }
      const base=rt.getPublicBaseUrl();
      const prefix=kind==='qr'?'/pay':'/pay-plan';
      const preference=await mercadoPagoRequest('/checkout/preferences','POST',{
        items:[{title:kind==='qr'?'Crédito PaySync - '+intent.device_code:'Abono PaySync '+plan,quantity:1,currency_id:'ARS',unit_price:intent.amount_ars}],
        external_reference:intent.id,
        metadata:{source:'paysync',order_id:intent.id},
        notification_url:base+'/mp/webhook',
        back_urls:{success:base+prefix+'/success',failure:base+prefix+'/failure',pending:base+prefix+'/pending'},
        auto_return:'approved',expires:true,expiration_date_to:intent.expires_at
      });
      await callRpc('paysync_set_preference',{p_order_id:intent.id,p_preference_id:String(preference.id)});
      const url=config.mpLive?preference.init_point:(preference.sandbox_init_point || preference.init_point);
      let checkout;try{checkout=new URL(url);}catch{throw httpError(502,'Missing checkout URL');}
      if(checkout.protocol!=='https:' || !/(^|\.)mercadopago\.(com|com\.ar)$/.test(checkout.hostname)) throw httpError(502,'Invalid checkout URL');
      if(getParam(req,['json'],'0')==='1') return ok(res,{scope:kind,device_code:intent.device_code,company_name:companyName,plan_type:plan,amount:intent.amount_ars,preference_id:preference.id,checkout_url:url,external_reference:intent.id,order_id:intent.id});
      return res.redirect(303,url);
    }catch(e){return fail(res,e);}
  }
  app.get('/pay/start/:device_code',(req,res)=>start(req,res,'qr'));
  app.get('/pay-plan/device/start',(req,res)=>start(req,res,'device_plan'));
  app.post('/pay-plan/device/start',(req,res)=>start(req,res,'device_plan'));
  app.get('/pay-plan/company/start',(req,res)=>start(req,res,'company_plan'));
  app.post('/pay-plan/company/start',(req,res)=>start(req,res,'company_plan'));
  app.post('/test/qr-approved',(req,res)=>start(req,res,'qr',true));
  app.post('/test/plan-approved',(req,res)=>{
    const scope=getParam(req,['scope'],'device');
    if(!['device','company'].includes(scope)) return fail(res,httpError(400,'Invalid scope'));
    return start(req,res,scope+'_plan',true);
  });
  async function reconcile(id) {
      const payment=await mercadoPagoRequest('/v1/payments/'+id);
      if(String(payment.id)!==id || String(payment.collector_id)!==config.collectorId || payment.currency_id!=='ARS' || payment.live_mode!==config.mpLive) throw httpError(400,'Payment account, currency or environment mismatch');
      const orderId=payment.external_reference;
      if(!/^[a-f0-9-]{36}$/i.test(orderId || '') || payment.metadata?.source!=='paysync' || payment.metadata?.order_id!==orderId) throw httpError(400,'Payment does not match a PaySync order');
      if(payment.status!=='approved') {
        if(['refunded','charged_back','cancelled'].includes(payment.status)) await callRpc('paysync_payment_review',{p_order_id:orderId,p_payment_id:id,p_reason:payment.status});
        return {ignored:true,status:payment.status};
      }
      if(Number(payment.transaction_amount_refunded || 0)>0) return callRpc('paysync_payment_review',{p_order_id:orderId,p_payment_id:id,p_reason:'partial_refund'});
      if(!Number.isSafeInteger(payment.transaction_amount) || payment.transaction_amount<=0) throw httpError(400,'Invalid payment amount');
      const result=await callRpc('paysync_apply_payment',{p_order_id:orderId,p_payment_id:id,p_amount:payment.transaction_amount});
      return result;
  }
  app.post('/admin/reconcile-payment',async(req,res)=>{
    try {
      const id=String(getParam(req,['payment_id']) || '');
      if(!/^\d{1,30}$/.test(id)) throw httpError(400,'Invalid payment id');
      return ok(res,await reconcile(id));
    }catch(e){return fail(res,e);}
  });
  app.post('/mp/webhook',async(req,res)=>{
    try {
      if(!config.webhookSecret || !config.collectorId) throw httpError(503,'Webhook configuration incomplete');
      if(!verifyWebhook(req,config.webhookSecret)) throw httpError(401,'Invalid webhook signature');
      if((req.body.type || req.query.type)!=='payment') return ok(res,{ignored:true});
      const id=req.query['data.id'];
      return ok(res,await reconcile(id));
    }catch(e){return fail(res,e);}
  });
  app.get('/mp/webhook',(req,res)=>res.status(405).set('Allow','POST').json({ok:false,error:'Use signed POST notifications'}));
}
module.exports={installPayments,verifyWebhook};
