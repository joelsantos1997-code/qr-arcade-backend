const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const template = fs.readFileSync(path.join(__dirname,'../firmware/paysync-esp8266/PaySyncESP8266.ino'),'utf8');
const cppString = value => JSON.stringify(String(value)).slice(1,-1);
function technicalPassword(deviceToken) {
  return crypto.createHmac('sha256',deviceToken).update('paysync-technical-v1').digest('hex').slice(0,24);
}
function generateEspFirmware(deviceCode,deviceToken,config) {
  if (!/^PS-\d{6}$/.test(deviceCode) || typeof deviceToken!=='string' || deviceToken.length<16 || deviceToken.length>256 || /[\x00-\x1f]/.test(deviceToken)) throw Object.assign(new Error('Invalid device provisioning'),{status:400});
  if (!config.caPem?.includes('-----BEGIN CERTIFICATE-----')) throw Object.assign(new Error('FIRMWARE_CA_PEM is required'),{status:503});
  const url=new URL(config.publicUrl);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw Object.assign(new Error('HTTPS backend origin required'),{status:503});
  const values={DEVICE_CODE:deviceCode,DEVICE_TOKEN:deviceToken,TECH_PASSWORD:technicalPassword(deviceToken),CA_PEM:config.caPem};
  // One pass prevents token contents becoming template directives.
  return template.replace(/\{\{PAYSYNC_(DEVICE_CODE|DEVICE_TOKEN|TECH_PASSWORD|CA_PEM)\}\}/g,(_,key)=>cppString(values[key]))
    .replace(/^const char BACKEND_URL\[\].*PAYSYNC_BACKEND_ORIGIN$/m,()=>`const char BACKEND_URL[] = "${cppString(url.origin)}"; // PAYSYNC_BACKEND_ORIGIN`);
}
module.exports={generateEspFirmware,technicalPassword};
