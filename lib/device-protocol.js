const SCHEMA_VERSION='20260926-device-v1';
function deviceParams(req,rt) {
  const get=(key,fallback=null)=>rt.getParam(req,[key],fallback);
  if(req.method!=='POST' || get('protocol')!=='ack-v1') throw rt.httpError(400,'POST ack-v1 required');
  const device=rt.getParam(req,['device','device_code']),token=rt.getParam(req,['token','device_token']);
  if(!device || typeof token!=='string' || !token) throw rt.httpError(400,'Missing device or token');
  return {p_device_code:device,p_device_token:token};
}
function runtimeParams(req,rt) {
  const params=deviceParams(req,rt),boot=rt.getParam(req,['boot_id']),ready=rt.getParam(req,['ready']);
  if(!/^[\w-]{8,80}$/.test(boot || '') || typeof ready!=='boolean') throw rt.httpError(400,'Invalid device runtime');
  return {...params,p_boot_id:boot,p_ready:ready};
}
async function recordDeviceEvent(req,res,rt,kind) {
  const params=deviceParams(req,rt),get=(name)=>rt.getParam(req,[name]);
  const uid=get('event_uid'),company=get('company_id'),amount=get('unit_amount_ars');
  const source=kind==='collection'?'collection':get('source');
  if(!/^[\w-]{8,100}$/.test(uid || '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(company || '') || !['collection','billetero','monedero'].includes(source) || (kind!=='collection' && source==='collection')) throw rt.httpError(400,'Invalid device event');
  if(source!=='collection' && (!Number.isSafeInteger(amount) || amount<1 || amount>100000000)) throw rt.httpError(400,'Invalid cash amount');
  const data=await rt.callRpc('paysync_record_device_event',{...params,p_event_uid:uid,p_company_id:company,p_kind:source,p_unit_amount:source==='collection'?0:amount,p_notes:get('notes')});
  if(data?.error) throw rt.httpError(409,data.error);
  return rt.ok(res,data);
}
module.exports={SCHEMA_VERSION,deviceParams,runtimeParams,recordDeviceEvent};
