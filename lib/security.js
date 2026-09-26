const crypto = require('node:crypto');
const cors = require('cors');
const adminReads = new Set(['/device/live-status','/device/summary','/debug/supabase']);
const adminWrites = new Set(['/device/claim','/device/activate-plan','/company/activate-plan']);
const numericParams = new Map([
  ['start',[1,999999]],['start_number',[1,999999]],['quantity',[1,200]],['qty',[1,200]],
  ['qr_price',[1,100000000]],['qr_price_ars',[1,100000000]],['pulses',[1,100]],['pulses_per_payment',[1,100]],
  ['bill_value',[1,100000000]],['bill_pulse_value_ars',[1,100000000]],['coin_value',[1,100000000]],['coin_pulse_value_ars',[1,100000000]],
  ['rssi',[-127,0]],['wifi_rssi',[-127,0]]
]);
function installSecurity(app, rt) {
  const {config,fail,httpError,checkApiKey,getParam,normalizeDeviceCode} = rt;
  app.disable('x-powered-by');
  app.set('query parser','simple');
  app.use((req,res,next)=>{
    res.locals.requestId = crypto.randomUUID();
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','X-Request-Id':res.locals.requestId});
    next();
  });
  app.use(cors({origin(origin,callback){
    if (!origin || config.origins.includes(origin)) return callback(null,true);
    callback(httpError(403,'Origin not allowed'));
  },methods:['GET','POST','OPTIONS'],allowedHeaders:['Content-Type','Authorization','X-API-Key','X-Device-Token']}));
  app.use(require('express').json({limit:'32kb'}));
  app.use(async(req,res,next)=>{
    try {
      const needsAuth = req.path.startsWith('/admin/') || req.path.startsWith('/client/') || req.path==='/auth/me' || req.path.startsWith('/pay-plan/') && req.path.endsWith('/start') || adminReads.has(req.path) || adminWrites.has(req.path) || req.path.startsWith('/test/');
      if (needsAuth && req.get('authorization')) {
        const authorization=req.get('authorization');
        if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) throw httpError(401,'Invalid session');
        let user;
        try { user=(await rt.request(config.supabaseUrl+'/auth/v1/user',{headers:{apikey:config.supabaseKey,Authorization:authorization}})).data; }
        catch(e) { if (e.upstreamStatus===401 || e.upstreamStatus===403) throw httpError(401,'Session expired or invalid'); throw e; }
        const metadata=user?.app_metadata || {};
        if (!user?.id || !['admin','client'].includes(metadata.paysync_role)) throw httpError(403,'Account has no PaySync role');
        if (metadata.paysync_role==='client' && !/^[a-f0-9-]{36}$/i.test(metadata.company_id || '')) throw httpError(403,'Account has no company');
        req.auth={id:user.id,role:metadata.paysync_role,company_id:metadata.company_id || null};
      }
      if (req.path.startsWith('/test/')) {
        if (!config.simulations) throw httpError(404,'Not found');
        if (!checkApiKey(req)) throw httpError(401,'Admin authentication required');
        if (req.method!=='POST') throw httpError(405,'Use POST');
      }
      if (req.path.startsWith('/admin/') || adminReads.has(req.path) || adminWrites.has(req.path)) {
        if (!checkApiKey(req)) throw httpError(401,'Admin authentication required');
        const write = adminWrites.has(req.path) || /^\/admin\/(create-devices-batch|update-device-config|upsert-company|assign-device|unassign-device)$/.test(req.path);
        if (write && req.method!=='POST') {res.set('Allow','POST'); throw httpError(405,'Use POST');}
      }
      if (req.path.startsWith('/client/') || req.path==='/auth/me') {
        if (!req.auth) throw httpError(401,'Session required');
      }
      if(req.path==='/mp/webhook') return next();
      if(req.path.startsWith('/device/coin/')) {
        if(!getParam(req,['device']) || !getParam(req,['token'])) throw httpError(400,'Missing device or token');
        if(req.path.endsWith('/claim') && !/^[\w-]{8,80}$/.test(getParam(req,['boot_id']) || '')) throw httpError(400,'Invalid boot id');
        if(req.path.endsWith('/ack') && (!/^[a-f0-9-]{36}$/i.test(getParam(req,['command_id']) || '') || !['relay_sent','uncertain'].includes(getParam(req,['outcome'])))) throw httpError(400,'Invalid receipt');
      }
      for (const name of new Set([...Object.keys(req.query),...Object.keys(req.body || {})])) {
        const v=getParam(req,[name]);
        if (numericParams.has(name) && v!==null && v!=='') {
          const [min,max]=numericParams.get(name);
          if (!/^-?\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v)) || Number(v)<min || Number(v)>max) throw httpError(400,'Invalid parameter: '+name);
        }
      }
      for (const source of [req.body,req.query]) if (source) {
        for(const name of ['device','device_code','code']) if(source[name]!==undefined) source[name]=normalizeDeviceCode(source[name]);
      }
      next();
    } catch(e) { return fail(res,e); }
  });
}
module.exports={installSecurity};
