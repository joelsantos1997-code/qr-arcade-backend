// Compile-only fixture: never contains real credentials and must not be installed.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {generateEspFirmware}=require('../lib/firmware');
const root=path.resolve(process.env.PAYSYNC_BUILD_DIR || path.join(os.tmpdir(),'paysync-firmware-check'));
const sketch=path.join(root,'PaySyncESP8266');
fs.mkdirSync(sketch,{recursive:true});
fs.writeFileSync(path.join(sketch,'PaySyncESP8266.ino'),generateEspFirmware('PS-999999','COMPILE_ONLY_NOT_A_REAL_DEVICE',{
  publicUrl:'https://example.invalid',caPem:require('node:tls').rootCertificates[0]
}));
const args=['compile','--fqbn','esp8266:esp8266:nodemcuv2:eesz=4M1M','--build-path',path.join(root,'build'),sketch];
if(process.env.ARDUINO_CONFIG_FILE)args.push('--config-file',process.env.ARDUINO_CONFIG_FILE);
const result=spawnSync(process.env.ARDUINO_CLI || 'arduino-cli',args,{stdio:'inherit',shell:false});
if(result.error)console.error('Arduino CLI unavailable. Install core 3.1.2 and ArduinoJson 7.4.3; see docs/INSTALACION-DISPOSITIVO.md.');
process.exitCode=result.status ?? 1;
