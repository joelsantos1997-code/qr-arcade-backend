// Checks only. Never creates checkouts, payments, subscriptions or relay commands.
require('dotenv').config({quiet:true});
const base=process.env.SMOKE_BASE_URL || process.env.PUBLIC_BASE_URL;
if(!base) throw Error('Set SMOKE_BASE_URL');
const u=new URL(base);
if(u.protocol!=='https:' && !['localhost','127.0.0.1'].includes(u.hostname)) throw Error('HTTPS required');
if(u.search || u.username || u.password) throw Error('Do not put credentials in the URL');
let failed=0;
async function check(path,expected,headers={},predicate) {
  try {
    const r=await fetch(new URL(path,u),{headers,signal:AbortSignal.timeout(10000),redirect:'manual'});
    const body=await r.json();
    const pass=r.status===expected && (!predicate || predicate(body));
    console.log(`${pass?'PASS':'FAIL'} ${path}: HTTP ${r.status}`);
    if(!pass)failed++;
  }catch {failed++;console.log(`FAIL ${path}: request unavailable`);}
}
(async()=>{
  await check('/health',200,{},b=>b.ok===true && b.schema==='ready');
  await check('/admin/status',401);
  await check('/debug/supabase',401);
  await check('/device/consume-pulse',426);
  await check('/mp/webhook',405);
  if(process.env.API_KEY) {
    const headers={'x-api-key':process.env.API_KEY};
    await check('/admin/status?format=json',200,headers,b=>b.ok===true);
    await check('/debug/supabase',200,headers,b=>b.ok===true);
  }
  process.exitCode=failed?1:0;
})();
