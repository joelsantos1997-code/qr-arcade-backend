require('dotenv').config({quiet:true});
const {createRuntime}=require('../lib/runtime');
const {SCHEMA_VERSION}=require('../lib/device-protocol');
const rt=createRuntime(process.env,fetch);
(async()=>{
  const issues=rt.configIssues();
  for(const issue of issues)console.log('CONFIG '+issue);
  if(!rt.config.caPem.includes('-----BEGIN CERTIFICATE-----'))issues.push('FIRMWARE_CA_PEM: missing');
  try {
    const version=await rt.callRpc('paysync_schema_version');
    console.log('Database schema: '+(version===SCHEMA_VERSION?'ready':'wrong version'));
    if(version!==SCHEMA_VERSION)issues.push('schema');
  }catch{console.log('Database schema: unavailable');issues.push('schema');}
  try {
    const me=await rt.mercadoPagoRequest('/users/me');
    const matches=String(me.id)===rt.config.collectorId;
    console.log('Mercado Pago account: '+(matches?'matches MP_COLLECTOR_ID':'does not match'));
    if(!matches)issues.push('collector');
  }catch{console.log('Mercado Pago account: unavailable');issues.push('mercado_pago');}
  console.log('Payments: '+(rt.config.paymentsEnabled?'enabled':'paused'));
  console.log('Firmware CA: '+(rt.config.caPem.includes('-----BEGIN CERTIFICATE-----')?'configured, hardware TLS validation still required':'missing'));
  console.log(issues.length?'Preflight failed. Keep payments paused.':'Service preflight passed. This does not certify hardware or physical credit delivery.');
  process.exitCode=issues.length?1:0;
})();
