const crypto = require("node:crypto");
function cppString(v) { return JSON.stringify(String(v)).slice(1,-1); }
function generateEspFirmware(deviceCode, deviceToken, config) {
  const safeDeviceCode = cppString(deviceCode);
  const safeDeviceToken = cppString(deviceToken);

  if (!config.caPem.includes("-----BEGIN CERTIFICATE-----")) throw Object.assign(new Error("FIRMWARE_CA_PEM is required"), {status:503});
  const safeBackend = cppString(config.publicUrl);
  const safeCa = JSON.stringify(config.caPem);
  const apPassword = crypto.createHmac("sha256",deviceToken).update("paysync-ap").digest("hex").slice(0,16);
  return String.raw`#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <memory>
#include <ctype.h>
#include <ArduinoJson.h>
#include <time.h>

// ======================================================
// PAYSYNC - CONFIGURACION DEL DISPOSITIVO
// ======================================================

const String BACKEND_URL = "${safeBackend}";
static const char TRUST_CA[] PROGMEM = ${safeCa};

const String DEVICE_CODE = "${safeDeviceCode}";
const String DEVICE_TOKEN = "${safeDeviceToken}";

// ======================================================
// RED LOCAL DE CONFIGURACION
// ======================================================

String AP_SSID = String("PaySync-") + DEVICE_CODE;

// Clave de la red local PaySync.
// Sin espacios:
const char* AP_PASS = "${apPassword}";

// IP local del portal
IPAddress AP_IP(192, 168, 4, 1);
IPAddress AP_GATEWAY(192, 168, 4, 1);
IPAddress AP_SUBNET(255, 255, 255, 0);

// ======================================================
// PINES NODEMCU
// ======================================================

const int RELAY_PIN = D5;        // Rele de credito / coin
const int BILL_PIN = D2;         // Entrada billetero con optoacoplador
const int COLLECTION_PIN = D7;   // Boton fisico de recaudacion

const int STATUS_LED_PIN = LED_BUILTIN;

const bool RELAY_ACTIVE_LOW = true;
const bool STATUS_LED_ACTIVE_LOW = true;
const bool BILL_ACTIVE_LOW = true;
const bool COLLECTION_ACTIVE_LOW = true;

// ======================================================
// TIEMPOS
// ======================================================

const unsigned long HEARTBEAT_INTERVAL_MS = 10000;
const unsigned long CHECK_PULSE_INTERVAL_MS = 2500;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 15000;

const unsigned long COIN_PULSE_MS = 180;
const unsigned long BILL_DEBOUNCE_MS = 350;
const unsigned long COLLECTION_DEBOUNCE_MS = 1500;

// ======================================================
// EEPROM WIFI
// ======================================================

const int EEPROM_SIZE = 512;
const int MAGIC_ADDR = 0;
const int SSID_ADDR = 16;
const int PASS_ADDR = 96;
const int SSID_MAX = 64;
const int PASS_MAX = 96;

const String EEPROM_MAGIC = "PAYSYNC1";

String savedSsid = "";
String savedPass = "";

// ======================================================
// SERVIDORES LOCALES
// ======================================================

ESP8266WebServer server(80);
DNSServer dnsServer;
const byte DNS_PORT = 53;

// ======================================================
// VARIABLES INTERNAS
// ======================================================

unsigned long lastHeartbeat = 0;
unsigned long lastCheckPulse = 0;
unsigned long lastReconnectAttempt = 0;
unsigned long lastBillPulse = 0;
unsigned long lastCollectionPress = 0;
unsigned long lastLedBlink = 0;

bool lastBillActive = false;
bool lastCollectionActive = false;
bool ledBlinkState = false;

// ======================================================
// UTILIDADES
// ======================================================

String htmlEscape(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#039;");
  return value;
}

String urlEncode(String value) {
  String encoded = "";

  for (int i = 0; i < value.length(); i++) {
    char c = value.charAt(i);

    if (isalnum(c)) {
      encoded += c;
    } else if (c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += c;
    } else if (c == ' ') {
      encoded += "%20";
    } else {
      char hex[4];
      sprintf(hex, "%%%02X", (unsigned char)c);
      encoded += hex;
    }
  }

  return encoded;
}

// ======================================================
// EEPROM
// ======================================================

String readEEPROMString(int start, int maxLen) {
  String value = "";

  for (int i = 0; i < maxLen; i++) {
    char c = char(EEPROM.read(start + i));

    if (c == 0 || c == 255) {
      break;
    }

    value += c;
  }

  return value;
}

void writeEEPROMString(int start, int maxLen, String value) {
  for (int i = 0; i < maxLen; i++) {
    if (i < value.length()) {
      EEPROM.write(start + i, value.charAt(i));
    } else {
      EEPROM.write(start + i, 0);
    }
  }
}

void loadWiFiCredentials() {
  String magic = readEEPROMString(MAGIC_ADDR, 12);

  if (magic == EEPROM_MAGIC) {
    savedSsid = readEEPROMString(SSID_ADDR, SSID_MAX);
    savedPass = readEEPROMString(PASS_ADDR, PASS_MAX);
  } else {
    savedSsid = "";
    savedPass = "";
  }

  Serial.println("");
  Serial.println("Credenciales guardadas:");
  Serial.print("SSID: ");
  Serial.println(savedSsid.length() > 0 ? savedSsid : "(sin WiFi guardado)");
}

void saveWiFiCredentials(String ssid, String pass) {
  writeEEPROMString(MAGIC_ADDR, 12, EEPROM_MAGIC);
  writeEEPROMString(SSID_ADDR, SSID_MAX, ssid);
  writeEEPROMString(PASS_ADDR, PASS_MAX, pass);
  EEPROM.commit();

  savedSsid = ssid;
  savedPass = pass;
}

void clearWiFiCredentials() {
  for (int i = 0; i < 256; i++) {
    EEPROM.write(i, 0);
  }

  EEPROM.commit();

  savedSsid = "";
  savedPass = "";
}

// ======================================================
// LED TESTIGO
// ======================================================

void statusLedSet(bool on) {
  if (STATUS_LED_ACTIVE_LOW) {
    digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
  }
}

void updateStatusLed() {
  if (WiFi.status() == WL_CONNECTED) {
    statusLedSet(true);
    return;
  }

  unsigned long now = millis();

  if (now - lastLedBlink >= 500) {
    lastLedBlink = now;
    ledBlinkState = !ledBlinkState;
    statusLedSet(ledBlinkState);
  }
}

// ======================================================
// RELAY / CREDITO
// ======================================================

void relayOff() {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, HIGH);
  } else {
    digitalWrite(RELAY_PIN, LOW);
  }
}

void relayOn() {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, LOW);
  } else {
    digitalWrite(RELAY_PIN, HIGH);
  }
}



// ======================================================
// HTTP HTTPS
// ======================================================


// ======================================================
// ENDPOINTS PAYSYNC
// ======================================================

// A durable receipt protects against duplicate relay pulses after HTTP retries.
// A power cut during a pulse is ambiguous: stop, report, and require inspection.
String bootId;
bool deliveryBlocked = false;
struct DeliveryReceipt {
  uint32_t magic;
  char commandId[37];
  uint8_t state; // 0 empty, 1 armed/uncertain, 2 relay sent
  uint32_t checksum;
};
DeliveryReceipt receipt;
const int RECEIPT_ADDR = 256;
uint32_t receiptChecksum() {
  uint32_t hash = 2166136261UL;
  for (int i=0; i<37; i++) hash = (hash ^ uint8_t(receipt.commandId[i])) * 16777619UL;
  return (hash ^ receipt.state) * 16777619UL;
}
bool saveReceipt(uint8_t state, String id) {
  memset(&receipt, 0, sizeof(receipt));
  receipt.magic = 0x5053594E;
  id.toCharArray(receipt.commandId, sizeof(receipt.commandId));
  receipt.state = state;
  receipt.checksum = receiptChecksum();
  EEPROM.put(RECEIPT_ADDR, receipt);
  if (!EEPROM.commit()) { deliveryBlocked = true; return false; }
  return true;
}
void loadDeliveryReceipt() {
  EEPROM.get(RECEIPT_ADDR, receipt);
  if (receipt.magic == 0 || receipt.magic == 0xFFFFFFFF) {
    saveReceipt(0, "");
  } else if (receipt.magic != 0x5053594E || receipt.commandId[36] != 0 || receipt.state > 2 || receipt.checksum != receiptChecksum()) {
    deliveryBlocked = true;
  } else if (receipt.state == 1) {
    deliveryBlocked = true;
  }
}
String httpPostJson(String route, String body) {
  if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) return "";
  BearSSL::WiFiClientSecure client;
  BearSSL::X509List trust(TRUST_CA);
  client.setTrustAnchors(&trust);
  HTTPClient https;
  if (!https.begin(client, BACKEND_URL + route)) return "";
  https.setTimeout(7000);
  https.addHeader("Content-Type", "application/json");
  int code = https.POST(body);
  String payload = code >= 200 && code < 300 ? https.getString() : "";
  https.end();
  return payload;
}
String authenticatedBody(JsonDocument &doc) {
  doc["device"] = DEVICE_CODE;
  doc["token"] = DEVICE_TOKEN;
  doc["boot_id"] = bootId;
  String body;
  serializeJson(doc, body);
  return body;
}
bool acknowledgeReceipt() {
  if (receipt.state != 1 && receipt.state != 2) return false;
  if (receipt.magic != 0x5053594E || receipt.checksum != receiptChecksum()) return false;
  JsonDocument doc;
  doc["command_id"] = receipt.commandId;
  doc["outcome"] = receipt.state == 2 ? "relay_sent" : "uncertain";
  String body = httpPostJson("/device/coin/ack", authenticatedBody(doc));
  JsonDocument response;
  if (deserializeJson(response, body) || response["ok"] != true) return false;
  if (receipt.state == 2 && response["data"]["acknowledged"] == true) return saveReceipt(0, "");
  return false;
}
void sendHeartbeat() {
  JsonDocument doc;
  doc["protocol"] = "ack-v1";
  doc["ready"] = !deliveryBlocked && receipt.state != 1;
  doc["rssi"] = WiFi.RSSI();
  doc["firmware"] = "paysync-ack-v1";
  httpPostJson("/device/heartbeat", authenticatedBody(doc));
}
void checkPendingPulse() {
  if (receipt.state == 1 || receipt.state == 2) {
    acknowledgeReceipt();
    return;
  }
  if (deliveryBlocked) return;
  JsonDocument doc;
  String body = httpPostJson("/device/coin/claim", authenticatedBody(doc));
  JsonDocument response;
  if (deserializeJson(response, body) || response["ok"] != true) return;
  JsonObject command = response["data"]["command"];
  if (command.isNull()) return;
  String id = command["id"].as<String>();
  int duration = command["pulse_duration_ms"] | 0;
  if (id.length() != 36 || duration < 20 || duration > 1000) { deliveryBlocked = true; return; }
  if (!saveReceipt(1, id)) return;
  relayOn();
  delay(duration);
  relayOff();
  if (!saveReceipt(2, id)) return;
  acknowledgeReceipt();
}

void registerBillPulse() {
  String eventUid =
    DEVICE_CODE +
    "-bill-" +
    String(ESP.getChipId(), HEX) +
    "-" +
    bootId + "-" + String(millis());

  JsonDocument doc;
  doc["event_uid"] = eventUid;
  httpPostJson("/device/bill-pulse", authenticatedBody(doc));
}

void registerCollection() {
  JsonDocument doc;
  doc["notes"] = "Recaudacion desde boton fisico ESP";
  httpPostJson("/device/register-collection", authenticatedBody(doc));
}

// ======================================================
// WIFI
// ======================================================

void startAccessPoint() {
  WiFi.mode(WIFI_AP_STA);

  WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);

  bool apStarted = WiFi.softAP(AP_SSID.c_str(), AP_PASS);

  Serial.println("");
  Serial.println("Portal PaySync:");
  Serial.print("Red: ");
  Serial.println(AP_SSID);
  Serial.print("Clave: ");
  Serial.println(AP_PASS);
  Serial.print("IP: ");
  Serial.println(WiFi.softAPIP());

  if (apStarted) {
    Serial.println("Access Point iniciado OK");
  } else {
    Serial.println("ERROR iniciando Access Point");
  }

  dnsServer.start(DNS_PORT, "*", AP_IP);
}

bool connectSavedWiFi(unsigned long timeoutMs) {
  if (savedSsid.length() == 0) {
    Serial.println("No hay WiFi guardado.");
    return false;
  }

  Serial.println("");
  Serial.println("Conectando al WiFi guardado...");
  Serial.print("SSID: ");
  Serial.println(savedSsid);

  WiFi.hostname(DEVICE_CODE);
  WiFi.begin(savedSsid.c_str(), savedPass.c_str());

  unsigned long startAttempt = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < timeoutMs) {
    delay(500);
    Serial.print(".");
    updateStatusLed();
  }

  Serial.println("");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi conectado OK");
    Serial.print("IP local: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
    return true;
  }

  Serial.println("No conecto al WiFi guardado. El portal queda disponible.");
  return false;
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (savedSsid.length() == 0) return;

  unsigned long now = millis();

  if (now - lastReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS) {
    lastReconnectAttempt = now;

    Serial.println("");
    Serial.println("WiFi desconectado. Reintentando...");
    WiFi.begin(savedSsid.c_str(), savedPass.c_str());
  }
}

// ======================================================
// PORTAL WEB LOCAL
// ======================================================

void redirectToRoot() {
  server.sendHeader("Location", "http://192.168.4.1/", true);
  server.send(302, "text/plain", "");
}

String buildWifiOptionsHtml() {
  String options = "";

  Serial.println("");
  Serial.println("Escaneando redes WiFi...");
  int n = WiFi.scanNetworks(false, true);

  if (n <= 0) {
    options += "<option value=''>No se encontraron redes</option>";
    return options;
  }

  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);

    if (ssid.length() == 0) {
      continue;
    }

    String safeSsid = htmlEscape(ssid);

    options += String("<option value='") +
      safeSsid +
      "'>" +
      safeSsid +
      "</option>";
  }

  WiFi.scanDelete();

  if (options.length() == 0) {
    options += "<option value=''>No se encontraron redes visibles</option>";
  }

  return options;
}

bool authorizePortal(bool mutation = false) {
  if (server.client().localIP() != WiFi.softAPIP()) { server.send(403, "text/plain", "Use la red WiFi de configuracion del equipo"); return false; }
  if (!server.authenticate("admin", AP_PASS)) { server.requestAuthentication(); return false; }
  if (mutation && server.arg("csrf") != bootId) { server.send(403, "text/plain", "Sesion invalida"); return false; }
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("X-Frame-Options", "DENY");
  return true;
}
void handleRoot() {
  if (!authorizePortal()) return;
  bool connected = WiFi.status() == WL_CONNECTED;

  String wifiStatus = connected ? "Conectado" : "Sin conexion";
  String wifiName = connected ? WiFi.SSID() : "No conectado";
  String localIp = connected ? WiFi.localIP().toString() : "-";
  String rssi = connected ? String(WiFi.RSSI()) + " dBm" : "-";

  String html = "";
  html.reserve(12000);

  html += "<html>";
  html += "<head>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1.0'>";
  html += "<meta charset='UTF-8'>";
  html += "<title>PaySync</title>";
  html += "<style>";
  html += "body{margin:0;font-family:Arial,sans-serif;background:#080b12;color:white;padding:18px;}";
  html += ".box{max-width:460px;margin:auto;background:#111827;border:1px solid #263244;border-radius:22px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.35);}";
  html += "h1{margin:0;color:#16d9ff;font-size:32px;text-align:center;}";
  html += "h2{font-size:18px;color:#e5e7eb;margin-top:22px;}";
  html += ".device{text-align:center;color:#94a3b8;margin-top:6px;font-size:14px;}";
  html += ".status{background:#0b1220;border:1px solid #263244;border-radius:14px;padding:14px;margin-top:18px;}";
  html += ".row{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #1f2937;padding:8px 0;font-size:14px;}";
  html += ".row:last-child{border-bottom:0;}";
  html += ".label{color:#94a3b8;}";
  html += ".value{font-weight:bold;text-align:right;}";
  html += ".ok{color:#22c55e;}";
  html += ".bad{color:#f97316;}";
  html += "select,input{width:100%;box-sizing:border-box;border:1px solid #334155;border-radius:12px;background:#020617;color:white;padding:13px;margin-top:8px;font-size:16px;}";
  html += "button,.btn{width:100%;box-sizing:border-box;border:0;border-radius:12px;background:#06c8f4;color:#001018;padding:14px;font-weight:900;font-size:16px;margin-top:12px;text-decoration:none;display:block;text-align:center;}";
  html += ".secondary{background:#1f2937;color:#e5e7eb;border:1px solid #334155;}";
  html += ".danger{background:#7f1d1d;color:white;}";
  html += ".mini{font-size:12px;color:#64748b;margin-top:10px;text-align:center;line-height:1.45;}";
  html += "</style>";
  html += "</head>";
  html += "<body>";
  html += "<div class='box'>";
  html += "<h1>PaySync</h1>";
  html += String("<div class='device'>") + htmlEscape(DEVICE_CODE) + "</div>";

  html += "<div class='status'>";
  html += "<div class='row'><div class='label'>Estado</div><div class='value ";
  html += connected ? "ok" : "bad";
  html += "'>";
  html += wifiStatus;
  html += "</div></div>";

  html += String("<div class='row'><div class='label'>WiFi actual</div><div class='value'>") + htmlEscape(wifiName) + "</div></div>";
  html += String("<div class='row'><div class='label'>IP local</div><div class='value'>") + htmlEscape(localIp) + "</div></div>";
  html += String("<div class='row'><div class='label'>Senal</div><div class='value'>") + htmlEscape(rssi) + "</div></div>";
  html += String("<div class='row'><div class='label'>Red config</div><div class='value'>") + htmlEscape(AP_SSID) + "</div></div>";
  html += "</div>";

  html += "<h2>Configurar WiFi</h2>";
  html += "<form method='POST' action='/save'>";
  html += String("<input type='hidden' name='csrf' value='") + htmlEscape(bootId) + "'>";
  html += "<label>Redes cercanas</label>";
  html += "<select name='ssid'>";
  html += buildWifiOptionsHtml();
  html += "</select>";

  html += "<label style='display:block;margin-top:12px;'>O escribir red manualmente</label>";
  html += "<input name='ssid_manual' placeholder='Nombre de red WiFi'>";

  html += "<label style='display:block;margin-top:12px;'>Contrasena del WiFi</label>";
  html += "<input name='pass' type='password' placeholder='Clave del WiFi'>";
  html += "<button type='submit'>Guardar WiFi y reiniciar</button>";
  html += "</form>";

  html += "<h2>Acciones</h2>";
  html += String("<form method='POST' action='/reboot'><input type='hidden' name='csrf' value='") + htmlEscape(bootId) + "'><button class='secondary'>Reiniciar ESP</button></form>";
  html += String("<form method='POST' action='/clear'><input type='hidden' name='csrf' value='") + htmlEscape(bootId) + "'><button class='danger'>Borrar WiFi guardado</button></form>";

  html += "<div class='mini'>";
  html += "Para cambiar el WiFi, conectate a esta red PaySync desde el celular y entra al menu. ";
  html += "La clave unica se entrega al instalar el equipo.";
  html += "</div>";

  html += "</div>";
  html += "</body>";
  html += "</html>";

  server.send(200, "text/html; charset=utf-8", html);
}

void handleSaveWiFi() {
  if (!authorizePortal(true)) return;
  String ssidManual = server.arg("ssid_manual");
  ssidManual.trim();

  String ssid = ssidManual.length() > 0 ? ssidManual : server.arg("ssid");
  String pass = server.arg("pass");

  ssid.trim();

  if (ssid.length() == 0) {
    server.send(400, "text/html; charset=utf-8",
      "<html><body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
      "<h1>Falta elegir WiFi</h1>"
      "<a href='/' style='color:#16d9ff;'>Volver</a>"
      "</body></html>"
    );
    return;
  }

  Serial.println("");
  Serial.println("Guardando nuevo WiFi...");
  Serial.print("SSID: ");
  Serial.println(ssid);

  saveWiFiCredentials(ssid, pass);

  server.send(200, "text/html; charset=utf-8",
    "<html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><meta charset='UTF-8'></head>"
    "<body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<div style='max-width:420px;margin:auto;background:#111827;border:1px solid #263244;border-radius:20px;padding:24px;'>"
    "<h1 style='color:#16d9ff;'>WiFi guardado</h1>"
    "<p>La ESP se va a reiniciar y conectar al nuevo WiFi.</p>"
    "<p>Espera 20 segundos.</p>"
    "</div>"
    "</body></html>"
  );

  delay(1500);
  ESP.restart();
}

void handleClearWiFi() {
  if (!authorizePortal(true)) return;
  clearWiFiCredentials();

  server.send(200, "text/html; charset=utf-8",
    "<html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><meta charset='UTF-8'></head>"
    "<body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<div style='max-width:420px;margin:auto;background:#111827;border:1px solid #263244;border-radius:20px;padding:24px;'>"
    "<h1 style='color:#f97316;'>WiFi borrado</h1>"
    "<p>La ESP se va a reiniciar. Luego configura una red nueva.</p>"
    "</div>"
    "</body></html>"
  );

  delay(1500);
  ESP.restart();
}

void handleReboot() {
  if (!authorizePortal(true)) return;
  server.send(200, "text/html; charset=utf-8",
    "<html><body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<h1>Reiniciando ESP...</h1>"
    "</body></html>"
  );

  delay(1000);
  ESP.restart();
}

void startWebServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSaveWiFi);
  server.on("/clear", HTTP_POST, handleClearWiFi);
  server.on("/reboot", HTTP_POST, handleReboot);

  server.on("/generate_204", HTTP_GET, redirectToRoot);
  server.on("/gen_204", HTTP_GET, redirectToRoot);
  server.on("/hotspot-detect.html", HTTP_GET, handleRoot);
  server.on("/library/test/success.html", HTTP_GET, handleRoot);
  server.on("/connecttest.txt", HTTP_GET, redirectToRoot);
  server.on("/fwlink", HTTP_GET, redirectToRoot);
  server.on("/ncsi.txt", HTTP_GET, redirectToRoot);

  server.onNotFound(redirectToRoot);

  server.begin();

  Serial.println("Servidor web local iniciado.");
}

// ======================================================
// SETUP
// ======================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("");
  Serial.println("====================================");
  Serial.println("PaySync ESP8266 FINAL iniciando");
  Serial.println("====================================");

  pinMode(RELAY_PIN, OUTPUT);
  relayOff();

  pinMode(STATUS_LED_PIN, OUTPUT);
  statusLedSet(false);

  pinMode(BILL_PIN, INPUT_PULLUP);
  pinMode(COLLECTION_PIN, INPUT_PULLUP);

  EEPROM.begin(EEPROM_SIZE);
  bootId = String(ESP.getChipId(), HEX) + "-" + String(ESP.random(), HEX);
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  loadWiFiCredentials();
  loadDeliveryReceipt();

  startAccessPoint();
  startWebServer();

  bool connected = connectSavedWiFi(20000);

  if (connected) {
    sendHeartbeat();
    checkPendingPulse();
  }

  Serial.println("");
  Serial.println("Sistema listo.");
  Serial.print("Menu local: ");
  Serial.println(AP_SSID);
  Serial.println("Clave: ${apPassword}");
}

// ======================================================
// LOOP
// ======================================================

void loop() {
  dnsServer.processNextRequest();
  server.handleClient();

  updateStatusLed();
  maintainWiFi();

  unsigned long now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      sendHeartbeat();
    }

    if (now - lastCheckPulse >= CHECK_PULSE_INTERVAL_MS) {
      lastCheckPulse = now;
      checkPendingPulse();
    }
  }

  int billState = digitalRead(BILL_PIN);
  bool billActive = BILL_ACTIVE_LOW ? (billState == LOW) : (billState == HIGH);

  if (!lastBillActive && billActive) {
    if (now - lastBillPulse >= BILL_DEBOUNCE_MS) {
      lastBillPulse = now;
      Serial.println("");
      Serial.println(">>> PULSO BILLETERO DETECTADO");
      registerBillPulse();
    }
  }

  lastBillActive = billActive;

  int collectionState = digitalRead(COLLECTION_PIN);
  bool collectionActive = COLLECTION_ACTIVE_LOW ? (collectionState == LOW) : (collectionState == HIGH);

  if (!lastCollectionActive && collectionActive) {
    if (now - lastCollectionPress >= COLLECTION_DEBOUNCE_MS) {
      lastCollectionPress = now;
      Serial.println("");
      Serial.println(">>> BOTON RECAUDACION DETECTADO");
      registerCollection();
    }
  }

  lastCollectionActive = collectionActive;

  delay(10);
}
`;
}


module.exports = {generateEspFirmware};
