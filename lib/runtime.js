const crypto = require('node:crypto');

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function normalizeDeviceCode(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!s) return '';
  const match = /^(?:PS[- ]?)?([0-9]{1,6})$/.exec(s);
  if (!match || Number(match[1]) < 1) throw httpError(400, 'Invalid device code');
  return 'PS-' + match[1].padStart(6, '0');
}
function getParam(req, names, fallback = null) {
  for (const name of names) for (const source of [req.body, req.query, req.params]) {
    if (source && source[name] !== undefined) {
      const v = source[name];
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw httpError(400, 'Invalid parameter: ' + name);
      if (typeof v === 'string' && v.length > 1024) throw httpError(400, 'Parameter too long: ' + name);
      return v;
    }
  }
  return fallback;
}
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function createRuntime(env, fetchImpl) {
  const config = {
    apiKey: (env.API_KEY || '').trim(),
    supabaseUrl: (env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
    supabaseKey: (env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    mpToken: (env.MP_ACCESS_TOKEN || '').trim(),
    webhookSecret: (env.MP_WEBHOOK_SECRET || '').trim(),
    collectorId: (env.MP_COLLECTOR_ID || '').trim(),
    publicUrl: (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    production: env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production',
    paymentsEnabled: env.PAYMENTS_ENABLED === 'true',
    mpLive: env.MP_ENVIRONMENT === 'production',
    simulations: env.ENABLE_SIMULATORS === 'true' && env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production',
    origins: (env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean),
    caPem: (env.FIRMWARE_CA_PEM || '').replace(/\\n/g, '\n'),
    heartbeatSeconds: 30,
    monthly: Number(env.PLAN_MONTHLY_ARS || 5000),
    sixMonths: Number(env.PLAN_SIX_MONTHS_ARS || 25000)
  };
  function configIssues() {
    const issues = [];
    for (const [key, value] of Object.entries({SUPABASE_URL:config.supabaseUrl,SUPABASE_SERVICE_ROLE_KEY:config.supabaseKey,API_KEY:config.apiKey,MP_ACCESS_TOKEN:config.mpToken,MP_WEBHOOK_SECRET:config.webhookSecret,MP_COLLECTOR_ID:config.collectorId,PUBLIC_BASE_URL:config.publicUrl})) if (!value) issues.push(key + ': missing');
    if (config.apiKey && config.apiKey.length < 32) issues.push('API_KEY: use at least 32 random characters');
    for (const [key, value] of [['SUPABASE_URL',config.supabaseUrl],['PUBLIC_BASE_URL',config.publicUrl]]) {
      try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error(); }
      catch { if (value) issues.push(key + ': expected HTTPS origin'); }
    }
    if (![config.monthly,config.sixMonths].every(n=>Number.isSafeInteger(n)&&n>0)) issues.push('PLAN_PRICES: expected positive integer ARS');
    if (config.production && !config.origins.length) issues.push('ALLOWED_ORIGINS: missing');
    if (!['sandbox','production'].includes(env.MP_ENVIRONMENT || '')) issues.push('MP_ENVIRONMENT: choose sandbox or production');
    return issues;
  }
  async function request(url, options = {}) {
    try {
      const response = await fetchImpl(url, {...options, signal: AbortSignal.timeout(7000), redirect:'error'});
      const raw = await response.text();
      let data; try { data = raw ? JSON.parse(raw) : null; } catch { throw httpError(502, 'Invalid upstream response'); }
      if (!response.ok) {
        const err = httpError(503, 'Upstream service unavailable');
        err.upstreamStatus = response.status;
        // Deliberately do not retain upstream response text (it can contain secrets).
        throw err;
      }
      return {data, headers:response.headers};
    } catch (e) {
      if (e.status) throw e;
      throw httpError(503, 'Upstream service unavailable');
    }
  }
  function supabaseHeaders() {
    const headers = {apikey:config.supabaseKey,'Content-Type':'application/json'};
    // New sb_secret keys are API keys, not JWT bearer tokens.
    if (!config.supabaseKey.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + config.supabaseKey;
    return headers;
  }
  async function dbRaw(path, method = 'GET', body, extraHeaders = {}) {
    if (!config.supabaseUrl || !config.supabaseKey) throw httpError(503, 'Supabase is not configured');
    return request(config.supabaseUrl + path, {method,headers:{...supabaseHeaders(),...extraHeaders},...(body == null ? {} : {body:JSON.stringify(body)})});
  }
  async function supabaseRequest(path, method, body) { return (await dbRaw(path, method, body)).data; }
  const callRpc = (name, params = {}) => supabaseRequest('/rest/v1/rpc/' + name,'POST',params);
  async function mercadoPagoRequest(path, method = 'GET', body) {
    if (!config.mpToken) throw httpError(503, 'Mercado Pago is not configured');
    return (await request('https://api.mercadopago.com' + path,{method,headers:{Authorization:'Bearer '+config.mpToken,'Content-Type':'application/json'},...(body == null ? {} : {body:JSON.stringify(body)})})).data;
  }
  function checkApiKey(req) {
    const cookie=(req.get('cookie') || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('paysync_admin='))?.slice(14);
    if(config.apiKey.length>=32 && cookie) {
      const [expires,signature]=cookie.split('.');
      if(/^\d+$/.test(expires) && Number(expires)>Date.now() && Number(expires)<Date.now()+601000 && equalSecret(signature,crypto.createHmac('sha256',config.apiKey).update('admin:'+expires).digest('hex'))) return true;
    }
    const valid=req.auth?.role==='admin' || (config.apiKey.length>=32 && equalSecret(req.get('x-api-key') || (req.method==='GET' && req.path==='/admin/status' ? req.query.key : null),config.apiKey));
    if(valid && config.apiKey.length>=32 && req.path.startsWith('/admin/') && !req.get('authorization')) {
      const expires=String(Date.now()+600000);
      const signature=crypto.createHmac('sha256',config.apiKey).update('admin:'+expires).digest('hex');
      req.res.cookie('paysync_admin',expires+'.'+signature,{secure:true,httpOnly:true,sameSite:'strict',maxAge:600000,path:'/admin'});
    }
    return valid;
  }
  function fail(res, error, statusCode) {
    const status = statusCode || error.status || 500;
    const requestId = res.locals.requestId || crypto.randomUUID();
    if (status >= 500) console.error(JSON.stringify({event:'request_failed',status,request_id:requestId,upstream_status:error.upstreamStatus || null}));
    return res.status(status).json({ok:false,error:status >= 500 ? 'Servicio temporalmente no disponible' : error.message,request_id:requestId});
  }
  const ok = (res,data={}) => res.json({ok:true,data});
  function getPublicBaseUrl() { if (configIssues().some(s=>s.startsWith('PUBLIC_BASE_URL'))) throw httpError(503,'PUBLIC_BASE_URL is not configured'); return config.publicUrl; }
  return {config,configIssues,dbRaw,request,supabaseHeaders,supabaseRequest,callRpc,mercadoPagoRequest,checkApiKey,fail,ok,getPublicBaseUrl,normalizeDeviceCode,getParam,escapeHtml,httpError,equalSecret};
}
module.exports = {createRuntime,httpError,equalSecret,normalizeDeviceCode,getParam,escapeHtml};
