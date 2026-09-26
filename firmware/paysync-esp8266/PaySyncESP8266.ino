/* PaySync ESP8266 v1.0.0 — NodeMCU 1.0 (ESP-12E), core 3.1.2, ArduinoJson 7.
 * Factory template. /admin/firmware injects the four provisioning markers.
 * Never commit a provisioned copy. See docs/INSTALACION-DISPOSITIVO.md.
 * A relay ACK is NOT evidence of physical credit acceptance by the machine.
 */
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <time.h>

// Factory identity (option A): never exposed or editable through the portal.
const char DEVICE_CODE[] = "{{PAYSYNC_DEVICE_CODE}}";
const char DEVICE_TOKEN[] = "{{PAYSYNC_DEVICE_TOKEN}}";
const char TECH_PASSWORD[] = "{{PAYSYNC_TECH_PASSWORD}}";
const char TRUST_CA[] PROGMEM = "{{PAYSYNC_CA_PEM}}";
const char BACKEND_URL[] = "https://qr-arcade-backend.vercel.app"; // PAYSYNC_BACKEND_ORIGIN
const char FIRMWARE_VERSION[] = "paysync-esp8266-v1.0.0";

// Change these only after an electrical bench test.
const uint8_t RELAY_PIN = D5;             // GPIO14: relay DRIVER, never a bare coil
const uint8_t BILL_PIN = D2;              // GPIO4: PC817 collector / dry contact
const uint8_t COLLECTION_PIN = D7;        // GPIO13: normally open button
const uint8_t CONFIG_PIN = D6;            // GPIO12: extra config button to GND
const uint8_t STATUS_LED_PIN = LED_BUILTIN;
const bool RELAY_ACTIVE_LOW = true;
const bool BILL_ACTIVE_LOW = true;
const bool COLLECTION_ACTIVE_LOW = true;
const bool STATUS_LED_ACTIVE_LOW = true;
const char CASH_INPUT_SOURCE[] = "billetero"; // OR "monedero"; one source on D2
const uint32_t RELAY_PULSE_MS = 180;      // manual bench test; paid commands use DB snapshot
const uint32_t HEARTBEAT_INTERVAL_MS = 30000;
const uint32_t POLL_INTERVAL_MS = 2500;
const uint32_t BILL_DEBOUNCE_MS = 350;
const uint32_t COLLECTION_DEBOUNCE_MS = 1500;
const uint32_t WIFI_RETRY_MS = 15000;
const uint32_t CONFIG_HOLD_MS = 3000;
const uint32_t PORTAL_WINDOW_MS = 600000;
const uint16_t MAX_OUTBOX = 128;
const char AP_PASSWORD[] = "PSync1234";
IPAddress AP_IP(192,168,4,1), AP_MASK(255,255,255,0);

// Preserve the previous firmware's EEPROM receipt layout across upgrades.
const size_t EEPROM_SIZE = 512;
const uint16_t RECEIPT_ADDR = 256, FS_MARKER_ADDR = 224;
struct DeliveryReceipt { uint32_t magic; char commandId[37]; uint8_t state; uint32_t checksum; };
DeliveryReceipt receipt;
static_assert(sizeof(DeliveryReceipt) + RECEIPT_ADDR <= EEPROM_SIZE, "Receipt layout");
ESP8266WebServer server(80);
DNSServer dns;
BearSSL::Session tlsSession;
String bootId, csrf, savedSsid, savedPass, machineName, companyId, apName;
String lastError = "none";
uint32_t lastErrorAt = 0, lastHeartbeatAt = 0, lastBackendAt = 0, lastCoinAt = 0;
uint32_t nextNetwork = 0, nextHeartbeat = 0, nextPoll = 0, nextConfig = 0, nextOutbox = 0;
uint32_t lastWifiAttempt = 0, apUntil = 0, maintenanceUntil = 0, restartAt = 0;
uint32_t relayUntil = 0, sequence = 0, previousMillis = 0;
uint64_t uptimeMs = 0;
uint16_t queuedEvents = 0, relayDuration = RELAY_PULSE_MS;
int32_t billValue = 0, coinValue = 0;
uint8_t networkFailures = 0;
int lastHttp = 0;
bool provisioned = false, fsReady = false, storageFault = false, inputOverflow = false;
bool receiptValid = false, deliveryBlocked = false, relayActive = false, paidPulse = false;
bool apActive = false, maintenance = false, maintenanceReported = false, configKnown = false;
bool requestTest = false, backendCompatible = false, preferOutbox = true;

// ISRs only enqueue edges in RAM. No String, allocation, network or flash in ISR.
// RAM capture survives HTTPS stalls, NOT power loss before the loop persists it.
const uint8_t EDGE_CAPACITY = 64;
volatile uint8_t edgeKind[EDGE_CAPACITY], edgeRead = 0, edgeWrite = 0;
volatile bool edgeOverflow = false;
volatile uint32_t lastBillUs = 0, lastCollectionUs = 0;
void IRAM_ATTR pushEdge(uint8_t kind) {
  uint8_t next = (edgeWrite + 1) % EDGE_CAPACITY;
  if (next == edgeRead) { edgeOverflow = true; return; }
  edgeKind[edgeWrite] = kind;
  edgeWrite = next;
}
void IRAM_ATTR billInterrupt() {
  uint32_t now = micros();
  if (uint32_t(now - lastBillUs) < BILL_DEBOUNCE_MS * 1000UL) return;
  lastBillUs = now;
  pushEdge(1);
}
void IRAM_ATTR collectionInterrupt() {
  uint32_t now = micros();
  if (uint32_t(now - lastCollectionUs) < COLLECTION_DEBOUNCE_MS * 1000UL) return;
  lastCollectionUs = now;
  pushEdge(2);
}
bool due(uint32_t now, uint32_t deadline) { return int32_t(now - deadline) >= 0; }
void errorCode(const char* code) {
  lastError = code; lastErrorAt = millis();
  Serial.printf("[ERROR] %s (heap=%u)\n", code, ESP.getFreeHeap());
}
String escapeHtml(String s) {
  s.replace("&","&amp;"); s.replace("<","&lt;"); s.replace(">","&gt;");
  s.replace("\"","&quot;"); s.replace("'","&#39;"); return s;
}
void relayOff() { digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW); }
uint32_t checksumReceipt() {
  uint32_t h = 2166136261UL;
  for (uint8_t i=0;i<37;i++) h = (h ^ uint8_t(receipt.commandId[i])) * 16777619UL;
  return (h ^ receipt.state) * 16777619UL;
}
bool saveReceipt(uint8_t state, const String& id) {
  memset(&receipt,0,sizeof(receipt)); receipt.magic = 0x5053594E;
  id.toCharArray(receipt.commandId,sizeof(receipt.commandId)); receipt.state = state;
  receipt.checksum = checksumReceipt(); EEPROM.put(RECEIPT_ADDR,receipt);
  if (!EEPROM.commit()) { deliveryBlocked=true; receiptValid=false; errorCode("storage_failure"); return false; }
  receiptValid=true; return true;
}
void loadReceipt() {
  EEPROM.get(RECEIPT_ADDR,receipt);
  if (receipt.magic==0 || receipt.magic==0xFFFFFFFF) { saveReceipt(0,""); return; }
  receiptValid=receipt.magic==0x5053594E && receipt.commandId[36]==0 && receipt.state<=2 && receipt.checksum==checksumReceipt();
  if (!receiptValid) { deliveryBlocked=true; errorCode("receipt_corrupt"); }
  else if (receipt.state==1) { deliveryBlocked=true; errorCode("receipt_uncertain"); }
}
String readEepromString(uint16_t address, uint16_t maximum) {
  String s;
  for (uint16_t i=0;i<maximum;i++) { uint8_t c=EEPROM.read(address+i); if (!c || c==255) break; s+=char(c); }
  return s;
}
void writeEepromString(uint16_t address, uint16_t maximum, const String& s) {
  for (uint16_t i=0;i<maximum;i++) EEPROM.write(address+i,i<s.length()?s[i]:0);
}
bool saveWifi(const String& ssid,const String& pass) {
  writeEepromString(0,12,"PAYSYNC1"); writeEepromString(16,64,ssid); writeEepromString(96,96,pass);
  // Never erase the receipt, filesystem marker or queued events when clearing WiFi.
  if (!EEPROM.commit()) { storageFault=true; errorCode("storage_failure"); return false; }
  savedSsid=ssid; savedPass=pass; return true;
}
bool writeJsonAtomic(const String& path, const JsonDocument& doc) {
  String temporary=path+".tmp";
  File f=LittleFS.open(temporary,"w");
  if (!f) return false;
  size_t expected=measureJson(doc), written=serializeJson(doc,f); f.flush(); f.close();
  if (written!=expected) return false;
  File check=LittleFS.open(temporary,"r"); JsonDocument copy;
  bool valid=check && !deserializeJson(copy,check) && check.size()==expected; check.close();
  return valid && LittleFS.rename(temporary,path);
}
void mountOutbox() {
  LittleFSConfig options; options.setAutoFormat(false); LittleFS.setConfig(options);
  fsReady=LittleFS.begin(); // Never auto-format a damaged ledger.
  if (!fsReady) { errorCode("fs_uninitialized"); return; }
  if (EEPROM.read(FS_MARKER_ADDR)!=0xA5) {
    EEPROM.write(FS_MARKER_ADDR,0xA5);
    if(!EEPROM.commit()){storageFault=true;errorCode("storage_failure");return;}
  }
  if (!LittleFS.exists("/q") && !LittleFS.mkdir("/q")) { storageFault=true; return; }
  Dir dir=LittleFS.openDir("/q");
  while (dir.next()) {
    String name=dir.fileName();
    if (name.endsWith(".tmp")) { storageFault=true; errorCode("storage_failure"); continue; }
    if (!name.endsWith(".json")) continue;
    queuedEvents++; sequence=max(sequence,uint32_t(name.substring(name.lastIndexOf('/')+1).toInt()));
  }
  if (queuedEvents>MAX_OUTBOX) { storageFault=true; errorCode("queue_full"); }
  if (LittleFS.exists("/machine.json")) {
    File f=LittleFS.open("/machine.json","r"); JsonDocument cached;
    if (!deserializeJson(cached,f) && cached["device"]==DEVICE_CODE) {
      companyId=cached["company_id"].as<String>(); machineName=cached["name"].as<String>();
      billValue=cached["bill_value"] | 0; coinValue=cached["coin_value"] | 0;
    }
    f.close();
  }
}
bool enqueueEvent(uint8_t kind) {
  if (!fsReady || storageFault || queuedEvents>=MAX_OUTBOX || sequence>=2147483640UL) { errorCode("queue_full"); return false; }
  JsonDocument doc;
  uint32_t n=sequence+1;
  doc["event_uid"]=bootId+"-"+String(n);
  doc["kind"]=kind==1 ? CASH_INPUT_SOURCE : "collection";
  doc["company_id"]=companyId;
  doc["unit_amount_ars"]=strcmp(CASH_INPUT_SOURCE,"monedero")==0 ? coinValue : billValue;
  doc["uptime_ms"]=uptimeMs;
  char path[28]; snprintf(path,sizeof(path),"/q/%010lu.json",static_cast<unsigned long>(n));
  if (!writeJsonAtomic(path,doc)) { storageFault=true; errorCode("storage_failure"); return false; }
  sequence=n; queuedEvents++; return true;
}
void drainEdges() {
  if (edgeOverflow) { inputOverflow=true; errorCode("input_overflow"); edgeOverflow=false; }
  for (uint8_t i=0;i<8 && edgeRead!=edgeWrite;i++) {
    uint8_t kind=edgeKind[edgeRead];
    if (!enqueueEvent(kind)) break; // Keep uncommitted edge in RAM for retry.
    noInterrupts(); edgeRead=(edgeRead+1)%EDGE_CAPACITY; interrupts();
  }
}
bool readyForSales() {
  return provisioned && fsReady && !storageFault && !inputOverflow && receiptValid && !deliveryBlocked && !maintenance && configKnown && receipt.state!=1 && queuedEvents<MAX_OUTBOX;
}
String requestBody(JsonDocument& doc) {
  doc["device"]=DEVICE_CODE; doc["token"]=DEVICE_TOKEN; doc["boot_id"]=bootId; doc["protocol"]="ack-v1";
  String body; serializeJson(doc,body); return body;
}
class BoundedResponse : public Stream {
 public:
  String body;
  size_t write(uint8_t b) override { if(body.length()>=8192)return 0; body+=char(b); return 1; }
  size_t write(const uint8_t* data,size_t size) override {
    if(size>8192-body.length())return 0;
    return body.concat(reinterpret_cast<const char*>(data),size)?size:0;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};
bool postJson(const char* route, JsonDocument& input, JsonDocument& output) {
  if (!provisioned || WiFi.status()!=WL_CONNECTED) return false;
  if (time(nullptr)<1700000000) { errorCode("tls_clock"); nextNetwork=millis()+5000; return false; }
  if (ESP.getFreeHeap()<20000) { errorCode("low_heap"); nextNetwork=millis()+5000; return false; }
  BearSSL::WiFiClientSecure client;
  BearSSL::X509List ca(TRUST_CA); client.setTrustAnchors(&ca); client.setSession(&tlsSession);
  client.setTimeout(3500); // BearSSL core 3.1.2 uses this timeout while negotiating TLS.
  HTTPClient http; http.setTimeout(3500); http.setReuse(false);
  bool success=false;
  if (http.begin(client,String(BACKEND_URL)+route)) {
    http.addHeader("Content-Type","application/json");
    lastHttp=http.POST(requestBody(input));
    if(lastHttp>=200 && lastHttp<300 && http.getSize()<=8192) {
      BoundedResponse response;
      int bytes=http.writeToStream(&response);
      success=bytes>=0 && !deserializeJson(output,response.body,DeserializationOption::NestingLimit(8)) && output["ok"]==true;
    }
    http.end();
  }
  if(success) { lastBackendAt=millis(); networkFailures=0; nextNetwork=millis()+150; }
  else {
    networkFailures=min(uint8_t(5),uint8_t(networkFailures+1));
    nextNetwork=millis()+min(uint32_t(30000),uint32_t(1000UL<<networkFailures));
    errorCode(lastHttp==426?"protocol_mismatch":"http_failure");
    Serial.printf("[HTTP] %s status=%d\n",route,lastHttp); // No tokens, request bodies or URLs.
  }
  return success;
}
void heartbeat() {
  JsonDocument input,output;
  input["ready"]=readyForSales(); input["rssi"]=WiFi.RSSI(); input["firmware"]=FIRMWARE_VERSION;
  input["uptime_ms"]=uptimeMs; input["free_heap"]=ESP.getFreeHeap(); input["pending_events"]=queuedEvents;
  input["last_error"]=lastError; input["maintenance"]=maintenance;
  if(postJson("/device/heartbeat",input,output)) {
    lastHeartbeatAt=millis();
    backendCompatible=output["protocol"]=="ack-v1";
    maintenanceReported=maintenance && backendCompatible && output["runtime"]["ready"]==false;
    if(!backendCompatible)errorCode("protocol_mismatch");
  }
  nextHeartbeat=millis()+HEARTBEAT_INTERVAL_MS;
}
void fetchConfig() {
  JsonDocument input,output;
  if(postJson("/device/config",input,output)) {
    JsonVariant data=output["data"];
    JsonVariant item=data;
    if(data.is<JsonArray>())item=data[0].as<JsonVariant>();
    String newCompany=item["company_id"].isNull()?"":item["company_id"].as<String>();
    if(item["device_code"]==DEVICE_CODE && !newCompany.isEmpty()) {
      JsonDocument cached;
      cached["device"]=DEVICE_CODE; cached["company_id"]=newCompany;
      cached["name"]=item["visible_name"] | "Maquina";
      cached["bill_value"]=item["bill_pulse_value_ars"] | 0;
      cached["coin_value"]=item["coin_pulse_value_ars"] | 0;
      String newName=cached["name"].as<String>();
      int newBill=cached["bill_value"],newCoin=cached["coin_value"];
      bool changed=companyId!=newCompany || machineName!=newName || billValue!=newBill || coinValue!=newCoin;
      if(changed && fsReady && !writeJsonAtomic("/machine.json",cached)) { storageFault=true; errorCode("storage_failure"); }
      companyId=newCompany; machineName=newName; billValue=newBill; coinValue=newCoin;
      int duration=item["pulse_duration_ms"] | RELAY_PULSE_MS;
      if(duration>=20 && duration<=1000)relayDuration=duration;
      configKnown=!storageFault;
    } else { configKnown=false; errorCode("invalid_config"); }
  }
  nextConfig=millis()+60000;
}
void sendOutbox() {
  String oldest;
  Dir dir=LittleFS.openDir("/q");
  while(dir.next()) { String p=dir.fileName(); if(p.endsWith(".json") && (oldest.isEmpty() || p<oldest))oldest=p; }
  if(oldest.isEmpty()) { if(queuedEvents) { storageFault=true; errorCode("storage_failure"); } return; }
  if(!oldest.startsWith("/q/"))oldest="/q/"+oldest;
  File f=LittleFS.open(oldest,"r"); JsonDocument input,output;
  bool valid=f && !deserializeJson(input,f); f.close();
  if(!valid) { storageFault=true; errorCode("storage_failure"); return; }
  bool collection=input["kind"]=="collection";
  input["source"]=input["kind"]; input["notes"]="Registro desde dispositivo PaySync";
  if(postJson(collection?"/device/register-collection":"/device/bill-pulse",input,output)) {
    if(output["data"]["event_uid"]==input["event_uid"] && output["data"]["recorded"]==true) {
      if(LittleFS.remove(oldest))queuedEvents--; else {storageFault=true;errorCode("storage_failure");}
    } else errorCode("protocol_mismatch"); // Old backend must never silently consume new records.
  }
  nextOutbox=millis()+1000;
}
void acknowledge() {
  if(!receiptValid || (receipt.state!=1 && receipt.state!=2))return;
  JsonDocument input,output;
  input["command_id"]=receipt.commandId; input["outcome"]=receipt.state==2?"relay_sent":"uncertain";
  if(postJson("/device/coin/ack",input,output) && receipt.state==2 && output["data"]["acknowledged"]==true) saveReceipt(0,"");
  nextPoll=millis()+POLL_INTERVAL_MS;
}
void startRelay(uint16_t duration,bool paid) {
  paidPulse=paid; relayActive=true; relayUntil=millis()+duration;
  digitalWrite(RELAY_PIN,RELAY_ACTIVE_LOW?LOW:HIGH);
}
void tickRelay() {
  if(!relayActive || !due(millis(),relayUntil))return;
  relayOff(); relayActive=false; lastCoinAt=millis();
  if(paidPulse){String id(receipt.commandId);saveReceipt(2,id);}
  paidPulse=false;
}
void pollCoin() {
  JsonDocument input,output; input["ready"]=readyForSales();
  if(postJson("/device/consume-pulse",input,output)) {
    if(output["protocol"]!="ack-v1") { errorCode("protocol_mismatch"); nextPoll=millis()+POLL_INTERVAL_MS; return; }
    JsonObject command=output["data"]["command"];
    if(!command.isNull() && readyForSales() && receipt.state==0) {
      String id=command["id"].as<String>(); int duration=command["pulse_duration_ms"] | 0;
      if(id.length()!=36 || duration<20 || duration>1000) {deliveryBlocked=true;errorCode("invalid_response");}
      else if(saveReceipt(1,id))startRelay(duration,true);
    }
  }
  nextPoll=millis()+POLL_INTERVAL_MS;
}
void openPortal(uint32_t duration) {
  if(!apActive) {
    WiFi.mode(WIFI_AP_STA); WiFi.softAPConfig(AP_IP,AP_IP,AP_MASK);
    apActive=WiFi.softAP(apName.c_str(),AP_PASSWORD);
    if(apActive)dns.start(53,"*",AP_IP);
    Serial.println("[PORTAL] 192.168.4.1");
  }
  apUntil=millis()+duration;
}
void maintainWifi() {
  uint32_t now=millis();
  if(WiFi.status()!=WL_CONNECTED) {
    openPortal(PORTAL_WINDOW_MS);
    if(!savedSsid.isEmpty() && uint32_t(now-lastWifiAttempt)>=WIFI_RETRY_MS) {
      lastWifiAttempt=now; WiFi.begin(savedSsid.c_str(),savedPass.c_str());
    }
  } else if(apActive && due(now,apUntil) && !maintenance) {
    dns.stop(); WiFi.softAPdisconnect(true); WiFi.mode(WIFI_STA); apActive=false;
  }
  static uint32_t heldAt=0; static bool opened=false;
  if(digitalRead(CONFIG_PIN)==LOW) {
    if(!heldAt)heldAt=now;
    if(!opened && uint32_t(now-heldAt)>=CONFIG_HOLD_MS) {openPortal(PORTAL_WINDOW_MS);opened=true;}
  } else {heldAt=0;opened=false;}
  if(maintenance && due(now,maintenanceUntil)) {maintenance=false;maintenanceReported=false;nextHeartbeat=now;}
}

// Everything in the portal is local. No CDN, token display or token editor.
const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PaySync</title><style>
:root{color-scheme:dark;font-family:system-ui,Arial;background:#080e1b;color:#eaf2ff}*{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:820px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;margin:12px 0 24px}.brand{color:#38d9f8;font-size:38px;font-weight:850;letter-spacing:-1.5px}small,.muted{color:#95a7bf}.badge{padding:8px 12px;border-radius:24px;background:#183a48;color:#63e7ef}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{border:1px solid #25344b;border-radius:20px;background:#101b2d;padding:22px;box-shadow:0 10px 30px #0002}h1{font-size:23px;margin:0 0 8px}h2{font-size:17px;margin:0 0 16px}.value{font-size:25px;font-weight:700;margin:8px 0}.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #25344b;font-size:14px}.row span:last-child{text-align:right;overflow-wrap:anywhere}input,button,a.button{display:block;width:100%;padding:13px;border-radius:12px;font:inherit;margin-top:10px}input{background:#080e1b;border:1px solid #334962;color:white}button,a.button{border:0;background:#36d7ed;color:#052332;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}.secondary{background:#22364c!important;color:#d6e8fa!important}.danger{background:#492b36!important;color:#ffb6c8!important}.full{grid-column:1/-1}.note{font-size:13px;line-height:1.6;color:#9db0c6}footer{text-align:center;font-size:12px;color:#7f96ae;margin:20px}.alert{color:#f5ca80}label{font-size:13px;color:#b4c6dc}@media(max-width:620px){.grid{grid-template-columns:1fr}.brand{font-size:32px}}
</style></head><body><main><header><div><div class="brand">PaySync</div><small>{{DEVICE}} · {{VERSION}}</small></div><span class="badge" id="online">Conectando...</span></header><div class="grid"><section class="card full"><h1>{{MACHINE}}</h1><p class="muted">Estado del dispositivo y conexion WiFi</p><div class="row"><span>Backend</span><span id="backend">Sin verificar</span></div><div class="row"><span>WiFi</span><span id="wifi">—</span></div><div class="row"><span>Senal</span><span id="rssi">—</span></div><div class="row"><span>IP de red</span><span id="ip">—</span></div><div class="row"><span>Ultimo heartbeat</span><span id="hb">—</span></div><div class="row"><span>Ultimo pulso de rele</span><span id="coin">—</span></div><div class="row"><span>Registros pendientes</span><span id="queue">—</span></div><p id="notice" class="note alert"></p></section><section class="card"><h2>Configurar WiFi</h2><form action="/wifi" method="post"><input type="hidden" name="csrf" value="{{CSRF}}"><label>Nombre de red (2.4 GHz)</label><input name="ssid" maxlength="32" required autocomplete="off"><label>Contrasena</label><input type="password" name="password" maxlength="63" autocomplete="new-password"><button>Guardar WiFi</button></form><p class="note">El token del equipo esta protegido y no se muestra en este portal.</p></section><section class="card"><h2>Acciones del equipo</h2>{{ACTIONS}}<p class="note">El ensayo del rele genera un pulso real. Un pulso informado no confirma credito fisico de la maquina.</p><a class="button secondary" href="/diag">Diagnostico local</a></section></div><footer>Portal local · 192.168.4.1 · PaySync</footer></main><script>
const age=n=>n===null?'Todavia no':'Hace '+Math.floor(n/1000)+' s';
async function refresh(){try{const r=await fetch('/diag',{cache:'no-store'});const d=await r.json();const put=(id,v)=>document.getElementById(id).textContent=v;put('online',d.backend_online?'Online':'Offline');put('backend',d.backend_online?'Disponible':'Sin conexion confirmada');put('wifi',d.wifi_connected?'Conectado':'Desconectado');put('rssi',d.rssi+' dBm');put('ip',d.ip);put('hb',age(d.heartbeat_age_ms));put('coin',age(d.coin_age_ms));put('queue',d.pending_events);put('notice',d.maintenance?'Modo tecnico: cobros bloqueados':d.last_error==='none'?'':('Diagnostico: '+d.last_error));}catch{document.getElementById('online').textContent='Sin respuesta local';}finally{setTimeout(refresh,5000);}}refresh();
</script></body></html>)HTML";
bool localAccess(bool technical=false,bool mutation=false) {
  if(!apActive || server.client().localIP()!=AP_IP) {server.send(403,"text/plain","Use la red local PaySync");return false;}
  String host=server.hostHeader();
  if(mutation && host!="192.168.4.1" && host!="192.168.4.1:80") {server.send(403,"text/plain","Host invalido");return false;}
  if(technical && (!provisioned || !server.authenticate("tecnico",TECH_PASSWORD))) {server.requestAuthentication(DIGEST_AUTH,"PaySync tecnico");return false;}
  if(mutation && (server.method()!=HTTP_POST || server.arg("csrf")!=csrf)) {server.send(403,"text/plain","Sesion local invalida");return false;}
  server.sendHeader("Cache-Control","no-store"); server.sendHeader("X-Frame-Options","DENY"); server.sendHeader("Referrer-Policy","no-referrer");
  return true;
}
void reply(const String& message,int code=200) {
  server.send(code,"text/html; charset=utf-8","<meta name='viewport' content='width=device-width'><body style='background:#080e1b;color:#eaf2ff;font:18px system-ui;padding:30px'><h1>PaySync</h1><p>"+escapeHtml(message)+"</p><a style='color:#38d9f8' href='/'>Volver</a></body>");
}
String action(const char* path,const char* label,const char* style="secondary") {
  return String("<form method='post' action='")+path+"'><input type='hidden' name='csrf' value='"+csrf+"'><button class='"+style+"'>"+label+"</button></form>";
}
void page(bool technical) {
  if(!localAccess(technical))return;
  if(technical) {maintenance=true;maintenanceReported=false;maintenanceUntil=millis()+PORTAL_WINDOW_MS;nextHeartbeat=millis();}
  String html=FPSTR(PAGE);
  html.replace("{{DEVICE}}",escapeHtml(provisioned?DEVICE_CODE:"Sin provisionar")); html.replace("{{VERSION}}",FIRMWARE_VERSION);
  html.replace("{{MACHINE}}",escapeHtml(machineName.isEmpty()?"Tu equipo PaySync":machineName)); html.replace("{{CSRF}}",csrf);
  String actions;
  if(technical) {
    actions=action("/test-relay","Probar rele (mantener CONFIG)")+action("/collection","Registrar recaudacion")+action("/restart","Reiniciar ESP")+action("/clear-wifi","Borrar WiFi","danger")+action("/resume","Salir de modo tecnico");
    if(!fsReady && EEPROM.read(FS_MARKER_ADDR)!=0xA5)actions+=action("/init-storage","Inicializar equipo NUEVO (mantener CONFIG)","danger");
    actions+="<p class='note'>Identidad de fabrica: para cambiarla, regenerar y cargar firmware. El token no se puede consultar ni editar aqui.</p>";
  } else actions="<a class='button secondary' href='/tech'>Modo tecnico</a><p class='note'>Probar rele, registrar recaudacion, reiniciar y borrar WiFi requieren acceso tecnico.</p>";
  html.replace("{{ACTIONS}}",actions); server.send(200,"text/html; charset=utf-8",html);
}
void diagnostics() {
  if(!localAccess())return;
  JsonDocument doc; uint32_t now=millis();
  doc["device"]=provisioned?DEVICE_CODE:"unprovisioned";doc["firmware"]=FIRMWARE_VERSION;
  doc["wifi_connected"]=WiFi.status()==WL_CONNECTED;
  doc["backend_online"]=lastBackendAt && uint32_t(now-lastBackendAt)<30000 && backendCompatible;
  doc["rssi"]=WiFi.status()==WL_CONNECTED?WiFi.RSSI():0;doc["ip"]=WiFi.localIP().toString();
  doc["uptime_ms"]=uptimeMs;doc["free_heap"]=ESP.getFreeHeap();doc["pending_events"]=queuedEvents;
  doc["storage_ready"]=fsReady && !storageFault;doc["maintenance"]=maintenance;doc["last_error"]=lastError;
  doc["last_http_status"]=lastHttp;doc["receipt_state"]=receiptValid?int(receipt.state):-1;
  if(lastHeartbeatAt)doc["heartbeat_age_ms"]=uint32_t(now-lastHeartbeatAt);else doc["heartbeat_age_ms"]=nullptr;
  if(lastCoinAt)doc["coin_age_ms"]=uint32_t(now-lastCoinAt);else doc["coin_age_ms"]=nullptr;
  String body;serializeJson(doc,body);server.send(200,"application/json",body);
}
bool mutableNow() {
  if(relayActive || receipt.state!=0 || !receiptValid) {reply("Entrega pendiente: no reiniciar ni modificar el equipo",409);return false;}
  return true;
}
void startPortalServer() {
  server.on("/",HTTP_GET,[]{page(false);});server.on("/tech",HTTP_GET,[]{page(true);});server.on("/diag",HTTP_GET,diagnostics);
  server.on("/wifi",HTTP_POST,[]{
    if(!localAccess(false,true) || !mutableNow())return;
    String ssid=server.arg("ssid"),pass=server.arg("password");ssid.trim();
    if(ssid.isEmpty() || ssid.length()>32 || (!pass.isEmpty() && (pass.length()<8 || pass.length()>63))) {reply("Revisar nombre de red y contrasena (8 a 63 caracteres, o vacia para red abierta)",400);return;}
    if(!saveWifi(ssid,pass)){reply("No se pudo guardar",503);return;}
    WiFi.disconnect();lastWifiAttempt=millis()-WIFI_RETRY_MS;openPortal(PORTAL_WINDOW_MS);reply("WiFi guardado. El equipo intentara conectarse sin borrar registros.");
  });
  server.on("/collection",HTTP_POST,[]{
    if(!localAccess(true,true))return;
    // Drain earlier ISR edges first, preserving the collection boundary in the queue.
    drainEdges();
    if(edgeRead!=edgeWrite || !enqueueEvent(2)) {reply("No se pudo guardar la recaudacion",503);return;}
    reply("Recaudacion guardada para sincronizar. Todavia no implica confirmacion del servidor.");
  });
  server.on("/test-relay",HTTP_POST,[]{
    if(!localAccess(true,true) || !mutableNow())return;
    if(digitalRead(CONFIG_PIN)!=LOW) {reply("Mantener presionado el boton CONFIG para ensayar el rele",409);return;}
    if(!maintenance) {reply("Abrir primero el modo tecnico",409);return;}
    requestTest=true;nextHeartbeat=millis();reply("Ensayo solicitado. El rele se prueba tras informar mantenimiento al backend. Si no hay Internet, solo se permite con el equipo desconectado de la maquina y CONFIG sostenido.");
  });
  server.on("/restart",HTTP_POST,[]{if(localAccess(true,true)&&mutableNow()){restartAt=millis()+700;reply("Reinicio solicitado");}});
  server.on("/clear-wifi",HTTP_POST,[]{if(localAccess(true,true)&&mutableNow()){if(saveWifi("","")){WiFi.disconnect();openPortal(PORTAL_WINDOW_MS);reply("WiFi borrado. Se conservaron los registros y la identidad del equipo.");}else reply("Error de almacenamiento",503);}});
  server.on("/resume",HTTP_POST,[]{if(localAccess(true,true)){maintenance=false;maintenanceReported=false;requestTest=false;nextHeartbeat=millis();reply("Modo tecnico cerrado. El servidor decide la habilitacion de ventas.");}});
  server.on("/init-storage",HTTP_POST,[]{
    if(!localAccess(true,true)||!mutableNow())return;
    if(fsReady || EEPROM.read(FS_MARKER_ADDR)==0xA5 || digitalRead(CONFIG_PIN)!=LOW) {reply("Inicializacion solo para equipo nuevo, con CONFIG sostenido",409);return;}
    // One-time factory action. Mark BEFORE format; never retry destructive format automatically.
    EEPROM.write(FS_MARKER_ADDR,0xA5);
    if(!EEPROM.commit() || !LittleFS.format()) {storageFault=true;reply("Inicializacion fallida; requiere inspeccion tecnica",503);return;}
    mountOutbox();reply(fsReady?"Almacenamiento inicializado":"No se pudo montar almacenamiento");
  });
  server.onNotFound([]{server.sendHeader("Location","http://192.168.4.1/",true);server.send(302,"text/plain","");});
  server.begin();
}
void setup() {
  // Set inactive output latch BEFORE enabling output. Hardware needs its own safe bias.
  relayOff();pinMode(RELAY_PIN,OUTPUT);relayOff();
  pinMode(STATUS_LED_PIN,OUTPUT);pinMode(CONFIG_PIN,INPUT_PULLUP);
  pinMode(BILL_PIN,BILL_ACTIVE_LOW?INPUT_PULLUP:INPUT);
  pinMode(COLLECTION_PIN,COLLECTION_ACTIVE_LOW?INPUT_PULLUP:INPUT);
  Serial.begin(115200);Serial.println("\nPaySync paysync-esp8266-v1.0.0");
  EEPROM.begin(EEPROM_SIZE);loadReceipt();
  if(readEepromString(0,12)=="PAYSYNC1"){savedSsid=readEepromString(16,64);savedPass=readEepromString(96,96);}
  char randomId[40];snprintf(randomId,sizeof(randomId),"%08lx-%08lx-%08lx",static_cast<unsigned long>(ESP.random()),static_cast<unsigned long>(ESP.random()),static_cast<unsigned long>(ESP.random()));bootId=randomId;
  snprintf(randomId,sizeof(randomId),"%08lx%08lx%08lx",static_cast<unsigned long>(ESP.random()),static_cast<unsigned long>(ESP.random()),static_cast<unsigned long>(ESP.random()));csrf=randomId;
  provisioned=strlen(DEVICE_CODE)==9 && String(DEVICE_CODE).startsWith("PS-") && strlen(DEVICE_TOKEN)>=16 && String(DEVICE_TOKEN).indexOf("{{")<0 && String(TECH_PASSWORD).indexOf("{{")<0 && String(TRUST_CA).indexOf("BEGIN CERTIFICATE")>=0;
  if(!provisioned)errorCode("configuration_missing");
  mountOutbox();
  apName="PaySync-"+(provisioned?String(DEVICE_CODE).substring(3):String(ESP.getChipId(),HEX));
  WiFi.persistent(false);WiFi.setAutoReconnect(true);WiFi.mode(WIFI_AP_STA);WiFi.hostname(provisioned?DEVICE_CODE:"PaySync-setup");
  configTime(0,0,"pool.ntp.org","time.cloudflare.com");openPortal(60000);startPortalServer();
  lastWifiAttempt=millis()-WIFI_RETRY_MS;
  lastBillUs=micros()-BILL_DEBOUNCE_MS*1000UL;lastCollectionUs=micros()-COLLECTION_DEBOUNCE_MS*1000UL;
  attachInterrupt(digitalPinToInterrupt(BILL_PIN),billInterrupt,BILL_ACTIVE_LOW?FALLING:RISING);
  attachInterrupt(digitalPinToInterrupt(COLLECTION_PIN),collectionInterrupt,COLLECTION_ACTIVE_LOW?FALLING:RISING);
}
void loop() {
  uint32_t now=millis();uptimeMs+=uint32_t(now-previousMillis);previousMillis=now;
  tickRelay();
  // Never start HTTP, portal parsing or flash writes while the relay is energized.
  if(relayActive){yield();return;}
  drainEdges();maintainWifi();if(apActive)dns.processNextRequest();server.handleClient();
  bool online=lastBackendAt && uint32_t(now-lastBackendAt)<30000;
  digitalWrite(STATUS_LED_PIN,(online || (now/500)%2==0)==STATUS_LED_ACTIVE_LOW?LOW:HIGH);
  if(restartAt && due(now,restartAt) && receipt.state==0){relayOff();ESP.restart();return;}
  if(requestTest && maintenance && receipt.state==0 && digitalRead(CONFIG_PIN)==LOW) {
    // A physical technician may bench-test offline. No unattended/remote free coin endpoint.
    if(maintenanceReported || WiFi.status()!=WL_CONNECTED) {requestTest=false;startRelay(RELAY_PULSE_MS,false);return;}
  } else if(requestTest && digitalRead(CONFIG_PIN)!=LOW)requestTest=false;
  if(!due(now,nextNetwork) || WiFi.status()!=WL_CONNECTED || !provisioned)return;
  if(edgeRead!=edgeWrite && fsReady && !storageFault && queuedEvents<MAX_OUTBOX)return;
  // Receipt ACK has priority over fresh claims; heartbeat remains periodic during outages.
  if(due(now,nextHeartbeat)){heartbeat();return;}
  if(due(now,nextPoll) && receiptValid && receipt.state!=0){acknowledge();return;}
  if(due(now,nextConfig)){fetchConfig();return;}
  bool cashDue=due(now,nextOutbox) && queuedEvents && fsReady && !storageFault;
  bool coinDue=due(now,nextPoll) && backendCompatible && receiptValid && receipt.state==0;
  // Fair scheduling: a cash backlog must not starve the online lease or paid credits.
  if(cashDue && (preferOutbox || !coinDue)){preferOutbox=false;sendOutbox();return;}
  if(coinDue){preferOutbox=true;pollCoin();return;}
  yield();
}
