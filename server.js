require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const API_KEY = String(process.env.API_KEY || "Laluna123").trim();
const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();

let SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://lrsladmyfriundetnnjw.supabase.co/rest/v1/"
).trim();

const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

if (SUPABASE_URL.endsWith("/rest/v1/")) {
  SUPABASE_URL = SUPABASE_URL.substring(0, SUPABASE_URL.length - 9);
}

if (SUPABASE_URL.endsWith("/rest/v1")) {
  SUPABASE_URL = SUPABASE_URL.substring(0, SUPABASE_URL.length - 8);
}

while (SUPABASE_URL.endsWith("/")) {
  SUPABASE_URL = SUPABASE_URL.substring(0, SUPABASE_URL.length - 1);
}

function getParam(req, names, fallback) {
  if (fallback === undefined) fallback = null;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];

    if (req.body && req.body[name] !== undefined) return req.body[name];
    if (req.query && req.query[name] !== undefined) return req.query[name];
    if (req.params && req.params[name] !== undefined) return req.params[name];
  }

  return fallback;
}

function normalizeDeviceCode(value) {
  const raw = String(value || "").trim().toUpperCase();
  const digits = raw.replace(/[^0-9]/g, "");

  if (!digits) {
    return raw;
  }

  return "PS-" + digits.padStart(6, "0");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cppString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, "");
  }

  return "https://" + req.get("host");
}

function checkApiKey(req) {
  const key =
    req.headers["x-api-key"] ||
    req.query.key ||
    (req.body ? req.body.key : null);

  return key === API_KEY;
}

function ok(res, data) {
  if (data === undefined) data = {};

  return res.json({
    ok: true,
    data: data
  });
}

function fail(res, error, statusCode) {
  if (statusCode === undefined) statusCode = 500;

  console.error("ERROR:", error);

  return res.status(statusCode).json({
    ok: false,
    error: error.message || String(error),
    name: error.name || null,
    cause: error.cause ? String(error.cause) : null
  });
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json"
  };
}

async function supabaseRequest(path, method, bodyObject) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase is not configured.");
  }

  const url = SUPABASE_URL + path;

  const options = {
    method: method || "GET",
    headers: supabaseHeaders()
  };

  if (bodyObject !== undefined && bodyObject !== null) {
    options.body = JSON.stringify(bodyObject);
  }

  const response = await fetch(url, options);
  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }

  if (!response.ok) {
    throw new Error("Supabase HTTP " + response.status + ": " + text);
  }

  return data;
}

async function callRpc(functionName, params) {
  return await supabaseRequest(
    "/rest/v1/rpc/" + functionName,
    "POST",
    params || {}
  );
}

async function mercadoPagoRequest(path, method, bodyObject) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("MP_ACCESS_TOKEN is not configured in Vercel.");
  }

  const options = {
    method: method || "GET",
    headers: {
      Authorization: "Bearer " + MP_ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  };

  if (bodyObject !== undefined && bodyObject !== null) {
    options.body = JSON.stringify(bodyObject);
  }

  const response = await fetch("https://api.mercadopago.com" + path, options);
  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }

  if (!response.ok) {
    throw new Error("Mercado Pago HTTP " + response.status + ": " + text);
  }

  return data;
}

async function getDeviceFromSummary(deviceCode) {
  const normalizedCode = normalizeDeviceCode(deviceCode);
  const path =
    "/rest/v1/device_dashboard_summary?select=*&device_code=eq." +
    encodeURIComponent(normalizedCode);

  const data = await supabaseRequest(path, "GET");

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

async function getDeviceTechnical(deviceCode) {
  const normalizedCode = normalizeDeviceCode(deviceCode);

  const path =
    "/rest/v1/devices?select=device_code,device_token,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars,subscription_status,subscription_expires_at&device_code=eq." +
    encodeURIComponent(normalizedCode) +
    "&limit=1";

  const data = await supabaseRequest(path, "GET");

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

function paymentStatusPage(title, message, deviceCode) {
  return (
    "<html>" +
      "<head>" +
        "<meta name='viewport' content='width=device-width, initial-scale=1.0' />" +
        "<title>PaySync</title>" +
      "</head>" +
      "<body style='font-family:Arial;background:#080b12;color:white;margin:0;padding:30px;text-align:center;'>" +
        "<div style='max-width:420px;margin:auto;background:#111827;border:1px solid #263244;border-radius:20px;padding:24px;'>" +
          "<h1 style='color:#16d9ff;'>" + escapeHtml(title) + "</h1>" +
          "<p style='color:#cbd5e1;'>" + escapeHtml(message) + "</p>" +
          "<p style='font-size:14px;color:#94a3b8;'>Codigo: " + escapeHtml(deviceCode || "") + "</p>" +
        "</div>" +
      "</body>" +
    "</html>"
  );
}

function generateEspFirmware(deviceCode, deviceToken) {
  const safeDeviceCode = cppString(deviceCode);
  const safeDeviceToken = cppString(deviceToken);

  return String.raw`#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <memory>
#include <ctype.h>

// ======================================================
// PAYSYNC - CONFIGURACION DEL DISPOSITIVO
// ======================================================

const String BACKEND_URL = "https://qr-arcade-backend.vercel.app";

const String DEVICE_CODE = "${safeDeviceCode}";
const String DEVICE_TOKEN = "${safeDeviceToken}";

// ======================================================
// RED LOCAL DE CONFIGURACION
// ======================================================

String AP_SSID = String("PaySync-") + DEVICE_CODE;

// Clave de la red local PaySync.
// Sin espacios:
const char* AP_PASS = "PSync1234";

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

// LED testigo.
// En NodeMCU el LED interno suele ser LED_BUILTIN / D4.
// Si tu LED testigo externo esta en otro pin, cambia esta linea.
const int STATUS_LED_PIN = LED_BUILTIN;

// Muchos reles de Arduino activan con LOW.
// Si tu rele queda prendido al reves, cambia true por false.
const bool RELAY_ACTIVE_LOW = true;

// LED interno NodeMCU normalmente activa con LOW.
const bool STATUS_LED_ACTIVE_LOW = true;

// Entradas con INPUT_PULLUP.
// Con opto o boton a GND, el pulso activo es LOW.
const bool BILL_ACTIVE_LOW = true;
const bool COLLECTION_ACTIVE_LOW = true;

// ======================================================
// TIEMPOS
// ======================================================

const unsigned long HEARTBEAT_INTERVAL_MS = 30000;
const unsigned long CHECK_PULSE_INTERVAL_MS = 2500;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 15000;

const unsigned long COIN_PULSE_MS = 180;
const unsigned long BILL_DEBOUNCE_MS = 350;
const unsigned long COLLECTION_DEBOUNCE_MS = 1500;

// ======================================================
// EEPROM WIFI
// ======================================================

const int EEPROM_SIZE = 256;
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
  for (int i = 0; i < EEPROM_SIZE; i++) {
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

void sendCoinPulse() {
  Serial.println("");
  Serial.println(">>> ENTREGANDO CREDITO / PULSO RELAY");

  relayOn();
  delay(COIN_PULSE_MS);
  relayOff();

  Serial.println(">>> PULSO FINALIZADO");
}

// ======================================================
// HTTP HTTPS
// ======================================================

String httpGet(String url) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("No hay WiFi. No se puede llamar al backend.");
    return "";
  }

  std::unique_ptr<BearSSL::WiFiClientSecure> client(new BearSSL::WiFiClientSecure);
  client->setInsecure();

  HTTPClient https;

  Serial.println("");
  Serial.println("GET:");
  Serial.println(url);

  if (!https.begin(*client, url)) {
    Serial.println("ERROR: no se pudo iniciar HTTPS");
    return "";
  }

  https.setTimeout(12000);

  int httpCode = https.GET();
  String payload = https.getString();

  Serial.print("HTTP CODE: ");
  Serial.println(httpCode);

  Serial.println("RESPUESTA:");
  Serial.println(payload);

  https.end();

  if (httpCode <= 0) {
    Serial.println("ERROR HTTP");
    return "";
  }

  return payload;
}

bool responseHasPulse(String body) {
  body.toLowerCase();

  if (body.length() == 0) return false;

  if (body.indexOf("no pending") >= 0) return false;
  if (body.indexOf("sin pulsos") >= 0) return false;
  if (body.indexOf("no hay") >= 0) return false;
  if (body.indexOf("\"pending_pulses\":0") >= 0) return false;
  if (body.indexOf("\"pulses_pending\":0") >= 0) return false;

  if (body.indexOf("\"pulse_delivered\":true") >= 0) return true;
  if (body.indexOf("\"delivered\":true") >= 0) return true;
  if (body.indexOf("\"should_pulse\":true") >= 0) return true;
  if (body.indexOf("\"has_pulse\":true") >= 0) return true;
  if (body.indexOf("\"can_pulse\":true") >= 0) return true;

  if (body.indexOf("true") >= 0 && body.indexOf("pulse") >= 0) return true;
  if (body.indexOf("true") >= 0 && body.indexOf("pulso") >= 0) return true;
  if (body.indexOf("entregado") >= 0) return true;
  if (body.indexOf("delivered") >= 0 && body.indexOf("true") >= 0) return true;

  return false;
}

// ======================================================
// ENDPOINTS PAYSYNC
// ======================================================

void sendHeartbeat() {
  String url = BACKEND_URL +
    "/device/heartbeat?device=" + urlEncode(DEVICE_CODE) +
    "&token=" + urlEncode(DEVICE_TOKEN) +
    "&rssi=" + String(WiFi.RSSI()) +
    "&firmware=esp8266-final-v3";

  httpGet(url);
}

void checkPendingPulse() {
  String url = BACKEND_URL +
    "/device/consume-pulse?device=" + urlEncode(DEVICE_CODE) +
    "&token=" + urlEncode(DEVICE_TOKEN);

  String body = httpGet(url);

  if (responseHasPulse(body)) {
    sendCoinPulse();
  } else {
    Serial.println("No hay pulsos pendientes.");
  }
}

void registerBillPulse() {
  String eventUid =
    DEVICE_CODE +
    "-bill-" +
    String(ESP.getChipId(), HEX) +
    "-" +
    String(millis());

  String url = BACKEND_URL +
    "/device/bill-pulse?device=" + urlEncode(DEVICE_CODE) +
    "&token=" + urlEncode(DEVICE_TOKEN) +
    "&event_uid=" + urlEncode(eventUid);

  httpGet(url);
}

void registerCollection() {
  String url = BACKEND_URL +
    "/device/register-collection?device=" + urlEncode(DEVICE_CODE) +
    "&token=" + urlEncode(DEVICE_TOKEN) +
    "&notes=" + urlEncode("Recaudacion desde boton fisico ESP");

  httpGet(url);
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

void handleRoot() {
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
  html += "<a class='btn secondary' href='/collection'>Registrar recaudacion</a>";
  html += "<a class='btn secondary' href='/test-pulse'>Probar pulso relay</a>";
  html += "<a class='btn secondary' href='/reboot'>Reiniciar ESP</a>";
  html += "<a class='btn danger' href='/clear'>Borrar WiFi guardado</a>";

  html += "<div class='mini'>";
  html += "Para cambiar el WiFi, conectate a esta red PaySync desde el celular y entra al menu. ";
  html += "La clave de esta red es: <b>PSync1234</b>.";
  html += "</div>";

  html += "</div>";
  html += "</body>";
  html += "</html>";

  server.send(200, "text/html; charset=utf-8", html);
}

void handleSaveWiFi() {
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
  server.send(200, "text/html; charset=utf-8",
    "<html><body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<h1>Reiniciando ESP...</h1>"
    "</body></html>"
  );

  delay(1000);
  ESP.restart();
}

void handleCollection() {
  registerCollection();

  server.send(200, "text/html; charset=utf-8",
    "<html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><meta charset='UTF-8'></head>"
    "<body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<div style='max-width:420px;margin:auto;background:#111827;border:1px solid #263244;border-radius:20px;padding:24px;'>"
    "<h1 style='color:#22c55e;'>Recaudacion registrada</h1>"
    "<p>Se envio la recaudacion al panel PaySync.</p>"
    "<a href='/' style='color:#16d9ff;'>Volver</a>"
    "</div>"
    "</body></html>"
  );
}

void handleTestPulse() {
  sendCoinPulse();

  server.send(200, "text/html; charset=utf-8",
    "<html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><meta charset='UTF-8'></head>"
    "<body style='font-family:Arial;background:#080b12;color:white;text-align:center;padding:30px;'>"
    "<div style='max-width:420px;margin:auto;background:#111827;border:1px solid #263244;border-radius:20px;padding:24px;'>"
    "<h1 style='color:#16d9ff;'>Pulso enviado</h1>"
    "<p>Se activo el relay de credito.</p>"
    "<a href='/' style='color:#16d9ff;'>Volver</a>"
    "</div>"
    "</body></html>"
  );
}

void startWebServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSaveWiFi);
  server.on("/clear", HTTP_GET, handleClearWiFi);
  server.on("/reboot", HTTP_GET, handleReboot);
  server.on("/collection", HTTP_GET, handleCollection);
  server.on("/test-pulse", HTTP_GET, handleTestPulse);

  // Rutas comunes que usan Android/iPhone/Windows para detectar portal cautivo
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

  loadWiFiCredentials();

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
  Serial.println("Clave: PSync1234");
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

app.get("/", function (req, res) {
  return res.json({
    ok: true,
    name: "PaySync Backend",
    status: "online",
    service: "paysync-backend",
    supabase_url: SUPABASE_URL,
    mercado_pago_configured: Boolean(MP_ACCESS_TOKEN),
    endpoints: [
      "GET /health",
      "GET /debug/supabase",
      "GET /device/config",
      "GET /device/heartbeat",
      "GET /device/bill-pulse",
      "GET /device/consume-pulse",
      "GET /device/live-status",
      "GET /device/summary",
      "GET /device/register-collection",
      "GET /device/claim",
      "GET /device/activate-plan",
      "GET /company/activate-plan",
      "GET /admin/create-devices-batch",
      "GET /admin/update-device-config",
      "GET /admin/print-qr",
      "GET /admin/devices-technical",
      "GET /admin/firmware",
      "GET /pay/:device_code",
      "GET /pay/start/:device_code",
      "POST /mp/webhook"
    ]
  });
});

app.get("/health", function (req, res) {
  return res.json({
    ok: true,
    service: "paysync-backend",
    port: PORT,
    supabase_url_configured: Boolean(SUPABASE_URL),
    supabase_key_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    api_key_configured: Boolean(API_KEY),
    mercado_pago_configured: Boolean(MP_ACCESS_TOKEN),
    supabase_url: SUPABASE_URL
  });
});

app.get("/debug/supabase", async function (req, res) {
  try {
    const data = await supabaseRequest(
      "/rest/v1/devices?select=device_code,visible_name,status&order=device_code.asc&limit=50",
      "GET"
    );

    return res.json({
      ok: true,
      step: "supabase_connected",
      data: data
    });
  } catch (error) {
    return fail(res, error);
  }
});

async function deviceConfigHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);
    const deviceToken = getParam(req, ["token", "device_token"]);

    if (!deviceCode || !deviceToken) {
      return fail(res, new Error("Missing device or token"), 400);
    }

    const data = await callRpc("get_device_config_by_device_code", {
      p_device_code: deviceCode,
      p_device_token: deviceToken
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/config", deviceConfigHandler);
app.post("/device/config", deviceConfigHandler);

async function heartbeatHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);
    const deviceToken = getParam(req, ["token", "device_token"]);
    const rssiRaw = getParam(req, ["rssi", "wifi_rssi"]);
    const firmware = getParam(req, ["firmware", "firmware_version"], "v1.0");

    if (!deviceCode || !deviceToken) {
      return fail(res, new Error("Missing device or token"), 400);
    }

    let wifiRssi = null;

    if (rssiRaw !== null) {
      wifiRssi = parseInt(rssiRaw, 10);
    }

    const data = await callRpc("device_heartbeat_by_device_code", {
      p_device_code: deviceCode,
      p_device_token: deviceToken,
      p_wifi_rssi: wifiRssi,
      p_firmware_version: firmware
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/heartbeat", heartbeatHandler);
app.post("/device/heartbeat", heartbeatHandler);

async function billPulseHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);
    const deviceToken = getParam(req, ["token", "device_token"]);
    let eventUid = getParam(req, ["event_uid", "event"]);

    if (!deviceCode || !deviceToken) {
      return fail(res, new Error("Missing device or token"), 400);
    }

    if (!eventUid) {
      eventUid =
        deviceCode +
        "-bill-" +
        Date.now() +
        "-" +
        Math.floor(Math.random() * 999999);
    }

    const data = await callRpc("register_bill_pulse_by_device_code", {
      p_device_code: deviceCode,
      p_device_token: deviceToken,
      p_event_uid: eventUid
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/bill-pulse", billPulseHandler);
app.post("/device/bill-pulse", billPulseHandler);

async function consumePulseHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);
    const deviceToken = getParam(req, ["token", "device_token"]);

    if (!deviceCode || !deviceToken) {
      return fail(res, new Error("Missing device or token"), 400);
    }

    const data = await callRpc("consume_pending_pulse_by_device_code", {
      p_device_code: deviceCode,
      p_device_token: deviceToken
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/consume-pulse", consumePulseHandler);
app.post("/device/consume-pulse", consumePulseHandler);

app.get("/device/live-status", async function (req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);

    let path = "/rest/v1/device_live_status?select=*";

    if (deviceCode) {
      path = path + "&device_code=eq." + encodeURIComponent(deviceCode);
    }

    const data = await supabaseRequest(path, "GET");
    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/device/summary", async function (req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);

    let path = "/rest/v1/device_dashboard_summary?select=*";

    if (deviceCode) {
      path = path + "&device_code=eq." + encodeURIComponent(deviceCode);
    }

    const data = await supabaseRequest(path, "GET");
    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
});

async function testQrApprovedHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code"], "PS-000001");

    let paymentId = getParam(req, ["payment", "payment_id", "mp_payment_id"]);
    let preferenceId = getParam(req, [
      "preference",
      "preference_id",
      "mp_preference_id"
    ]);
    let externalReference = getParam(req, ["external_reference"]);

    if (!paymentId) paymentId = "MP-TEST-" + Date.now();
    if (!preferenceId) preferenceId = "PREF-TEST-" + Date.now();
    if (!externalReference) externalReference = deviceCode + "-" + paymentId;

    const data = await callRpc("register_qr_payment_by_device_code", {
      p_device_code: deviceCode,
      p_mp_payment_id: paymentId,
      p_mp_preference_id: preferenceId,
      p_external_reference: externalReference
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/test/qr-approved", testQrApprovedHandler);
app.post("/test/qr-approved", testQrApprovedHandler);

async function registerCollectionHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);
    const deviceToken = getParam(req, ["token", "device_token"]);
    const notes = getParam(
      req,
      ["notes"],
      "Recaudacion registrada desde PaySync"
    );

    if (!deviceCode || !deviceToken) {
      return fail(res, new Error("Missing device or token"), 400);
    }

    const data = await callRpc("register_collection_by_device_code_secure", {
      p_device_code: deviceCode,
      p_device_token: deviceToken,
      p_notes: notes
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/register-collection", registerCollectionHandler);
app.post("/device/register-collection", registerCollectionHandler);

async function claimDeviceHandler(req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code", "code"]);
    const companyName = getParam(req, ["company", "company_name"]);
    const companyEmail = getParam(req, ["email", "company_email"], null);

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    if (!companyName) {
      return fail(res, new Error("Missing company name"), 400);
    }

    const data = await callRpc("claim_device_by_code", {
      p_device_code: deviceCode,
      p_company_name: companyName,
      p_company_email: companyEmail
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/claim", claimDeviceHandler);
app.post("/device/claim", claimDeviceHandler);

async function activateDevicePlanHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code", "code"]);
    const planType = getParam(req, ["plan", "plan_type"], "monthly");

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    if (planType !== "monthly" && planType !== "six_months") {
      return fail(res, new Error("Invalid plan. Use monthly or six_months"), 400);
    }

    const data = await callRpc("activate_device_plan_by_code", {
      p_device_code: deviceCode,
      p_plan_type: planType
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/device/activate-plan", activateDevicePlanHandler);
app.post("/device/activate-plan", activateDevicePlanHandler);

async function activateCompanyPlanHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const companyName = getParam(req, ["company", "company_name"]);
    const planType = getParam(req, ["plan", "plan_type"], "monthly");
    const onlyInactiveRaw = getParam(req, ["only_inactive"], "false");

    if (!companyName) {
      return fail(res, new Error("Missing company name"), 400);
    }

    if (planType !== "monthly" && planType !== "six_months") {
      return fail(res, new Error("Invalid plan. Use monthly or six_months"), 400);
    }

    const onlyInactive =
      onlyInactiveRaw === true ||
      onlyInactiveRaw === "true" ||
      onlyInactiveRaw === "1";

    const data = await callRpc("activate_company_devices_plan_by_name", {
      p_company_name: companyName,
      p_plan_type: planType,
      p_only_inactive: onlyInactive
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/company/activate-plan", activateCompanyPlanHandler);
app.post("/company/activate-plan", activateCompanyPlanHandler);

async function createDevicesBatchHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const prefix = getParam(req, ["prefix"], "PS");
    const startNumberRaw = getParam(req, ["start", "start_number"], "4");
    const quantityRaw = getParam(req, ["quantity", "qty"], "10");
    const defaultName = getParam(req, ["name", "default_name"], "Dispositivo PaySync");
    const qrPriceRaw = getParam(req, ["qr_price", "qr_price_ars"], "2000");
    const pulsesRaw = getParam(req, ["pulses", "pulses_per_payment"], "1");
    const billValueRaw = getParam(req, ["bill_value", "bill_pulse_value_ars"], "1000");

    const startNumber = parseInt(startNumberRaw, 10);
    const quantity = parseInt(quantityRaw, 10);
    const qrPrice = parseInt(qrPriceRaw, 10);
    const pulses = parseInt(pulsesRaw, 10);
    const billValue = parseInt(billValueRaw, 10);

    if (!startNumber || startNumber < 1) {
      return fail(res, new Error("Invalid start number"), 400);
    }

    if (!quantity || quantity < 1 || quantity > 200) {
      return fail(res, new Error("Invalid quantity. Use 1 to 200"), 400);
    }

    const data = await callRpc("create_devices_batch", {
      p_prefix: prefix,
      p_start_number: startNumber,
      p_quantity: quantity,
      p_default_name: defaultName,
      p_qr_price_ars: qrPrice,
      p_pulses_per_payment: pulses,
      p_bill_pulse_value_ars: billValue
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/admin/create-devices-batch", createDevicesBatchHandler);
app.post("/admin/create-devices-batch", createDevicesBatchHandler);

async function updateDeviceConfigHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code", "code"]);
    const visibleName = getParam(req, ["name", "visible_name"], null);

    const qrPriceRaw = getParam(req, ["qr_price", "qr_price_ars"], null);
    const pulsesRaw = getParam(req, ["pulses", "pulses_per_payment"], null);
    const billValueRaw = getParam(req, ["bill_value", "bill_pulse_value_ars"], null);
    const coinValueRaw = getParam(req, ["coin_value", "coin_pulse_value_ars"], null);

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    const qrPrice = qrPriceRaw === null || qrPriceRaw === "" ? null : parseInt(qrPriceRaw, 10);
    const pulses = pulsesRaw === null || pulsesRaw === "" ? null : parseInt(pulsesRaw, 10);
    const billValue = billValueRaw === null || billValueRaw === "" ? null : parseInt(billValueRaw, 10);
    const coinValue = coinValueRaw === null || coinValueRaw === "" ? null : parseInt(coinValueRaw, 10);

    const data = await callRpc("update_device_config_by_code", {
      p_device_code: deviceCode,
      p_visible_name: visibleName,
      p_qr_price_ars: qrPrice,
      p_pulses_per_payment: pulses,
      p_bill_pulse_value_ars: billValue,
      p_coin_pulse_value_ars: coinValue
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/admin/update-device-config", updateDeviceConfigHandler);
app.post("/admin/update-device-config", updateDeviceConfigHandler);

app.get("/admin/firmware", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code", "code"]);
    const download = getParam(req, ["download"], "0");

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    const device = await getDeviceTechnical(deviceCode);

    if (!device) {
      return fail(res, new Error("Device not found"), 404);
    }

    const firmware = generateEspFirmware(device.device_code, device.device_token);
    const fileName = "PaySync-" + device.device_code + ".ino";

    if (download === "1" || download === 1 || download === true) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"" + fileName + "\"");
      return res.send(firmware);
    }

    const firmwareUrl =
      "/admin/firmware?device=" +
      encodeURIComponent(device.device_code) +
      "&download=1&key=" +
      encodeURIComponent(API_KEY);

    return res.send(
      "<html>" +
        "<head>" +
          "<meta name='viewport' content='width=device-width, initial-scale=1.0' />" +
          "<title>PaySync Firmware - " + escapeHtml(device.device_code) + "</title>" +
          "<style>" +
            "body{font-family:Arial,sans-serif;background:#0b1120;color:#e5e7eb;margin:0;padding:24px;}" +
            ".top{background:#111827;border:1px solid #263244;border-radius:16px;padding:20px;margin-bottom:18px;}" +
            "h1{margin:0;color:#16d9ff;}" +
            "p{color:#94a3b8;}" +
            ".grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px;}" +
            ".card{background:#0f172a;border:1px solid #263244;border-radius:12px;padding:12px;}" +
            ".label{color:#93c5fd;font-size:12px;margin-bottom:4px;}" +
            ".value{font-weight:bold;word-break:break-all;}" +
            ".actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;}" +
            ".btn{background:#06c8f4;color:#001018;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:bold;border:0;cursor:pointer;}" +
            ".secondary{background:#1f2937;color:#e5e7eb;border:1px solid #334155;}" +
            "textarea{width:100%;height:70vh;background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:14px;padding:16px;font-size:13px;line-height:1.35;box-sizing:border-box;}" +
            "@media(max-width:700px){.grid{grid-template-columns:1fr;}textarea{height:65vh;font-size:12px;}}" +
          "</style>" +
          "<script>" +
            "function copyFirmware(){" +
              "var el=document.getElementById('firmware');" +
              "el.focus();" +
              "el.select();" +
              "el.setSelectionRange(0,9999999);" +
              "navigator.clipboard.writeText(el.value).then(function(){alert('Firmware copiado');}).catch(function(){document.execCommand('copy');alert('Firmware copiado');});" +
            "}" +
          "</script>" +
        "</head>" +
        "<body>" +
          "<div class='top'>" +
            "<h1>Firmware ESP - " + escapeHtml(device.device_code) + "</h1>" +
            "<p>Codigo Arduino completo listo para cargar en NodeMCU ESP8266.</p>" +
            "<div class='grid'>" +
              "<div class='card'><div class='label'>Dispositivo</div><div class='value'>" + escapeHtml(device.device_code) + "</div></div>" +
              "<div class='card'><div class='label'>Nombre</div><div class='value'>" + escapeHtml(device.visible_name) + "</div></div>" +
              "<div class='card'><div class='label'>Token secreto</div><div class='value'>" + escapeHtml(device.device_token) + "</div></div>" +
              "<div class='card'><div class='label'>Precio QR</div><div class='value'>$" + escapeHtml(device.qr_price_ars) + "</div></div>" +
            "</div>" +
            "<div class='actions'>" +
              "<button class='btn' onclick='copyFirmware()'>Copiar firmware completo</button>" +
              "<a class='btn secondary' href='" + firmwareUrl + "'>Descargar .ino</a>" +
              "<a class='btn secondary' href='/admin/devices-technical?key=" + encodeURIComponent(API_KEY) + "'>Volver a dispositivos</a>" +
            "</div>" +
          "</div>" +
          "<textarea id='firmware' readonly>" + escapeHtml(firmware) + "</textarea>" +
        "</body>" +
      "</html>"
    );
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/admin/devices-technical", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const fromRaw = getParam(req, ["from", "start"], null);
    const toRaw = getParam(req, ["to", "end"], null);
    const statusRaw = getParam(req, ["status"], null);

    let path =
      "/rest/v1/devices?select=device_code,device_token,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars,subscription_status,subscription_expires_at,created_at&order=device_code.asc&limit=300";

    if (fromRaw) {
      const fromCode = normalizeDeviceCode(fromRaw);
      path = path + "&device_code=" + encodeURIComponent("gte." + fromCode);
    }

    if (toRaw) {
      const toCode = normalizeDeviceCode(toRaw);
      path = path + "&device_code=" + encodeURIComponent("lte." + toCode);
    }

    if (statusRaw) {
      path = path + "&status=" + encodeURIComponent("eq." + statusRaw);
    }

    const devices = await supabaseRequest(path, "GET");
    const publicBaseUrl = getPublicBaseUrl(req);

    let rows = "";

    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];

      const code = String(d.device_code || "");
      const token = String(d.device_token || "");
      const name = String(d.visible_name || "");
      const status = String(d.status || "");
      const qrPrice = String(d.qr_price_ars || 0);
      const pulses = String(d.pulses_per_payment || 1);
      const billValue = String(d.bill_pulse_value_ars || 0);
      const subscriptionStatus = String(d.subscription_status || "");
      const expires = d.subscription_expires_at ? String(d.subscription_expires_at) : "-";
      const payUrl = publicBaseUrl + "/pay/" + encodeURIComponent(code);

      const arduinoBlock =
        'const String DEVICE_CODE = "' + code + '";\n' +
        'const String DEVICE_TOKEN = "' + token + '";';

      rows +=
        "<tr>" +
          "<td><b>" + escapeHtml(code) + "</b></td>" +
          "<td>" + escapeHtml(name) + "</td>" +
          "<td><span class='tag'>" + escapeHtml(status) + "</span></td>" +
          "<td>$" + escapeHtml(qrPrice) + "</td>" +
          "<td>" + escapeHtml(pulses) + "</td>" +
          "<td>$" + escapeHtml(billValue) + "</td>" +
          "<td>" + escapeHtml(subscriptionStatus) + "<br><small>" + escapeHtml(expires) + "</small></td>" +
          "<td><code>" + escapeHtml(token) + "</code></td>" +
          "<td><a href='" + escapeHtml(payUrl) + "' target='_blank'>Abrir QR</a></td>" +
          "<td>" +
            "<a class='smallbtn' href='/admin/firmware?device=" + encodeURIComponent(code) + "&key=" + encodeURIComponent(API_KEY) + "' target='_blank'>Firmware</a>" +
            "<textarea id='copy_" + i + "' readonly>" + escapeHtml(arduinoBlock) + "</textarea>" +
            "<button onclick='copyText(\"copy_" + i + "\")'>Copiar Arduino</button>" +
          "</td>" +
        "</tr>";
    }

    if (!rows) {
      rows =
        "<tr><td colspan='10' style='text-align:center;padding:30px;color:#64748b;'>No hay dispositivos para mostrar.</td></tr>";
    }

    return res.send(
      "<html>" +
        "<head>" +
          "<meta name='viewport' content='width=device-width, initial-scale=1.0' />" +
          "<title>PaySync - Dispositivos tecnicos</title>" +
          "<style>" +
            "body{font-family:Arial,sans-serif;background:#0b1120;color:#e5e7eb;margin:0;padding:24px;}" +
            ".top{background:#111827;border:1px solid #263244;border-radius:16px;padding:20px;margin-bottom:18px;}" +
            "h1{margin:0;color:#16d9ff;}" +
            "p{color:#94a3b8;}" +
            ".actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;}" +
            ".linkbtn{background:#06c8f4;color:#001018;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:bold;}" +
            ".wrap{overflow-x:auto;background:#111827;border:1px solid #263244;border-radius:16px;}" +
            "table{width:100%;border-collapse:collapse;min-width:1320px;}" +
            "th,td{border-bottom:1px solid #263244;padding:12px;text-align:left;font-size:13px;vertical-align:top;}" +
            "th{background:#0f172a;color:#93c5fd;position:sticky;top:0;}" +
            "code{font-size:12px;color:#facc15;word-break:break-all;}" +
            ".tag{background:#1f2937;border:1px solid #334155;border-radius:999px;padding:4px 8px;font-size:12px;}" +
            "a{color:#38bdf8;}" +
            ".smallbtn{display:inline-block;background:#06c8f4;color:#001018;padding:8px 10px;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:8px;}" +
            "textarea{width:260px;height:58px;background:#020617;color:#f8fafc;border:1px solid #334155;border-radius:10px;padding:8px;font-size:12px;}" +
            "button{display:block;margin-top:6px;background:#06c8f4;color:#001018;border:0;border-radius:8px;padding:8px 10px;font-weight:bold;cursor:pointer;}" +
            "small{color:#94a3b8;}" +
          "</style>" +
          "<script>" +
            "function copyText(id){" +
              "var el=document.getElementById(id);" +
              "el.select();" +
              "el.setSelectionRange(0,99999);" +
              "navigator.clipboard.writeText(el.value).then(function(){alert('Copiado');}).catch(function(){document.execCommand('copy');alert('Copiado');});" +
            "}" +
          "</script>" +
        "</head>" +
        "<body>" +
          "<div class='top'>" +
            "<h1>PaySync - Dispositivos tecnicos</h1>" +
            "<p>Total mostrados: <b>" + devices.length + "</b></p>" +
            "<p>Esta pagina es solo admin. Muestra tokens secretos para programar ESP.</p>" +
            "<div class='actions'>" +
              "<a class='linkbtn' href='/admin/print-qr?key=" + encodeURIComponent(API_KEY) + "'>Ver QR imprimibles</a>" +
            "</div>" +
          "</div>" +
          "<div class='wrap'>" +
            "<table>" +
              "<thead>" +
                "<tr>" +
                  "<th>Codigo</th>" +
                  "<th>Nombre</th>" +
                  "<th>Estado</th>" +
                  "<th>Precio QR</th>" +
                  "<th>Pulsos</th>" +
                  "<th>Billetero</th>" +
                  "<th>Plan</th>" +
                  "<th>Token secreto</th>" +
                  "<th>Link</th>" +
                  "<th>Arduino</th>" +
                "</tr>" +
              "</thead>" +
              "<tbody>" + rows + "</tbody>" +
            "</table>" +
          "</div>" +
        "</body>" +
      "</html>"
    );
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/admin/print-qr", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const fromRaw = getParam(req, ["from", "start"], null);
    const toRaw = getParam(req, ["to", "end"], null);
    const statusRaw = getParam(req, ["status"], null);

    let path =
      "/rest/v1/devices?select=device_code,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars&order=device_code.asc&limit=200";

    if (fromRaw) {
      const fromCode = normalizeDeviceCode(fromRaw);
      path = path + "&device_code=" + encodeURIComponent("gte." + fromCode);
    }

    if (toRaw) {
      const toCode = normalizeDeviceCode(toRaw);
      path = path + "&device_code=" + encodeURIComponent("lte." + toCode);
    }

    if (statusRaw) {
      path = path + "&status=" + encodeURIComponent("eq." + statusRaw);
    }

    const devices = await supabaseRequest(path, "GET");
    const publicBaseUrl = getPublicBaseUrl(req);

    let cardsHtml = "";

    for (let i = 0; i < devices.length; i++) {
      const device = devices[i];
      const deviceCode = escapeHtml(device.device_code);
      const visibleName = escapeHtml(device.visible_name || device.device_code);
      const status = escapeHtml(device.status || "");
      const price = escapeHtml(device.qr_price_ars || 0);
      const pulses = escapeHtml(device.pulses_per_payment || 1);

      const payUrl = publicBaseUrl + "/pay/" + encodeURIComponent(device.device_code);
      const qrImage =
        "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
        encodeURIComponent(payUrl);

      cardsHtml =
        cardsHtml +
        "<div class='card'>" +
          "<div class='title'>" + deviceCode + "</div>" +
          "<div class='name'>" + visibleName + "</div>" +
          "<img class='qr' src='" + qrImage + "' />" +
          "<div class='price'>$" + price + "</div>" +
          "<div class='meta'>Pulsos por pago: " + pulses + "</div>" +
          "<div class='meta'>Estado: " + status + "</div>" +
          "<div class='url'>" + escapeHtml(payUrl) + "</div>" +
        "</div>";
    }

    if (!cardsHtml) {
      cardsHtml =
        "<div style='padding:30px; text-align:center; color:#555;'>No hay dispositivos para mostrar.</div>";
    }

    return res.send(
      "<html>" +
        "<head>" +
          "<meta name='viewport' content='width=device-width, initial-scale=1.0' />" +
          "<title>PaySync - QR imprimibles</title>" +
          "<style>" +
            "body{font-family:Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#111827;}" +
            ".top{max-width:1100px;margin:0 auto 20px auto;background:white;border-radius:14px;padding:18px 22px;box-shadow:0 2px 10px rgba(0,0,0,.08);}" +
            ".top h1{margin:0;color:#0f172a;font-size:26px;}" +
            ".top p{margin:8px 0 0 0;color:#475569;}" +
            ".actions{margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;}" +
            ".btn{border:0;background:#06c8f4;color:#001018;padding:12px 16px;border-radius:10px;font-weight:bold;cursor:pointer;}" +
            ".grid{max-width:1100px;margin:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}" +
            ".card{background:white;border:2px solid #111827;border-radius:14px;padding:16px;text-align:center;break-inside:avoid;page-break-inside:avoid;}" +
            ".title{font-size:24px;font-weight:900;letter-spacing:.5px;color:#0f172a;}" +
            ".name{font-size:14px;color:#475569;margin-top:4px;min-height:34px;}" +
            ".qr{width:190px;height:190px;margin:12px auto;display:block;}" +
            ".price{font-size:28px;font-weight:900;color:#111827;margin-top:4px;}" +
            ".meta{font-size:12px;color:#475569;margin-top:4px;}" +
            ".url{font-size:10px;color:#334155;margin-top:10px;word-break:break-all;border-top:1px dashed #cbd5e1;padding-top:8px;}" +
            "@media print{" +
              "body{background:white;padding:0;}" +
              ".top{box-shadow:none;border-bottom:1px solid #ddd;border-radius:0;max-width:none;margin:0 0 10px 0;}" +
              ".actions{display:none;}" +
              ".grid{max-width:none;grid-template-columns:repeat(3,1fr);gap:8px;}" +
              ".card{border:1.5px solid #000;border-radius:8px;padding:10px;}" +
              ".qr{width:165px;height:165px;}" +
              ".title{font-size:20px;}" +
              ".price{font-size:24px;}" +
            "}" +
          "</style>" +
        "</head>" +
        "<body>" +
          "<div class='top'>" +
            "<h1>PaySync - QR imprimibles</h1>" +
            "<p>Total de dispositivos mostrados: <b>" + devices.length + "</b></p>" +
            "<p>Tip: podes filtrar por rango usando <b>?from=4&to=8&key=Laluna123</b></p>" +
            "<div class='actions'>" +
              "<button class='btn' onclick='window.print()'>Imprimir / Guardar PDF</button>" +
            "</div>" +
          "</div>" +
          "<div class='grid'>" +
            cardsHtml +
          "</div>" +
        "</body>" +
      "</html>"
    );
  } catch (error) {
    return fail(res, error);
  }
});

const PLAN_PRICES_ARS = {
  monthly: 5000,
  six_months: 25000
};

function getPlanLabel(planType) {
  if (planType === "six_months") return "Plan 6 meses";
  return "Plan mensual";
}

function getPlanAmount(planType) {
  return PLAN_PRICES_ARS[planType] || PLAN_PRICES_ARS.monthly;
}

async function getCompanySummaryByName(companyName) {
  const data = await supabaseRequest(
    "/rest/v1/company_dashboard_summary?select=*&company_name=eq." +
      encodeURIComponent(companyName) +
      "&limit=1",
    "GET"
  );

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

app.get("/pay-plan/device/start", async function (req, res) {
  try {
    const deviceCode = normalizeDeviceCode(getParam(req, ["device", "device_code", "code"]));
    const planType = getParam(req, ["plan", "plan_type"], "monthly");

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    if (planType !== "monthly" && planType !== "six_months") {
      return fail(res, new Error("Invalid plan. Use monthly or six_months"), 400);
    }

    const device = await getDeviceTechnical(deviceCode);

    if (!device) {
      return fail(res, new Error("Device not found"), 404);
    }

    const amount = getPlanAmount(planType);
    const publicBaseUrl = getPublicBaseUrl(req);
    const externalReference =
      "PLAN|device|" + device.device_code + "|" + planType + "|" + Date.now();

    const preference = await mercadoPagoRequest(
      "/checkout/preferences",
      "POST",
      {
        items: [
          {
            title: getPlanLabel(planType) + " PaySync - " + device.device_code,
            description: "Abono PaySync para dispositivo " + device.device_code,
            quantity: 1,
            currency_id: "ARS",
            unit_price: amount
          }
        ],
        external_reference: externalReference,
        metadata: {
          payment_type: "plan_subscription",
          plan_scope: "device",
          device_code: device.device_code,
          plan_type: planType,
          source: "paysync"
        },
        notification_url: publicBaseUrl + "/mp/webhook",
        back_urls: {
          success: publicBaseUrl + "/pay-plan/success?scope=device&device=" + encodeURIComponent(device.device_code),
          failure: publicBaseUrl + "/pay-plan/failure?scope=device&device=" + encodeURIComponent(device.device_code),
          pending: publicBaseUrl + "/pay-plan/pending?scope=device&device=" + encodeURIComponent(device.device_code)
        },
        auto_return: "approved"
      }
    );

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;

    if (!checkoutUrl) {
      return fail(res, new Error("Mercado Pago did not return init_point"), 500);
    }

    if (getParam(req, ["json"], "0") === "1") {
      return ok(res, {
        scope: "device",
        device_code: device.device_code,
        plan_type: planType,
        amount: amount,
        preference_id: preference.id,
        checkout_url: checkoutUrl,
        external_reference: externalReference
      });
    }

    return res.redirect(checkoutUrl);
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/pay-plan/company/start", async function (req, res) {
  try {
    const companyName = getParam(req, ["company", "company_name", "name"]);
    const planType = getParam(req, ["plan", "plan_type"], "monthly");

    if (!companyName) {
      return fail(res, new Error("Missing company name"), 400);
    }

    if (planType !== "monthly" && planType !== "six_months") {
      return fail(res, new Error("Invalid plan. Use monthly or six_months"), 400);
    }

    const company = await getCompanySummaryByName(companyName);

    if (!company) {
      return fail(res, new Error("Company not found"), 404);
    }

    const totalDevices = Number(company.total_devices || 0);

    if (!totalDevices || totalDevices <= 0) {
      return fail(res, new Error("Company has no devices assigned"), 400);
    }

    const amountPerDevice = getPlanAmount(planType);
    const amount = amountPerDevice * totalDevices;

    const publicBaseUrl = getPublicBaseUrl(req);
    const externalReference =
      "PLAN|company|" + company.company_name + "|" + planType + "|" + Date.now();

    const preference = await mercadoPagoRequest(
      "/checkout/preferences",
      "POST",
      {
        items: [
          {
            title: getPlanLabel(planType) + " PaySync - " + company.company_name,
            description:
              "Abono PaySync para " +
              totalDevices +
              " dispositivo/s de " +
              company.company_name,
            quantity: 1,
            currency_id: "ARS",
            unit_price: amount
          }
        ],
        external_reference: externalReference,
        metadata: {
          payment_type: "plan_subscription",
          plan_scope: "company",
          company_name: company.company_name,
          plan_type: planType,
          devices_count: totalDevices,
          source: "paysync"
        },
        notification_url: publicBaseUrl + "/mp/webhook",
        back_urls: {
          success: publicBaseUrl + "/pay-plan/success?scope=company&company=" + encodeURIComponent(company.company_name),
          failure: publicBaseUrl + "/pay-plan/failure?scope=company&company=" + encodeURIComponent(company.company_name),
          pending: publicBaseUrl + "/pay-plan/pending?scope=company&company=" + encodeURIComponent(company.company_name)
        },
        auto_return: "approved"
      }
    );

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;

    if (!checkoutUrl) {
      return fail(res, new Error("Mercado Pago did not return init_point"), 500);
    }

    if (getParam(req, ["json"], "0") === "1") {
      return ok(res, {
        scope: "company",
        company_name: company.company_name,
        devices_count: totalDevices,
        plan_type: planType,
        amount_per_device: amountPerDevice,
        amount: amount,
        preference_id: preference.id,
        checkout_url: checkoutUrl,
        external_reference: externalReference
      });
    }

    return res.redirect(checkoutUrl);
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/pay-plan/success", function (req, res) {
  const scope = getParam(req, ["scope"], "");
  const deviceCode = getParam(req, ["device"], "");
  const companyName = getParam(req, ["company"], "");

  return res.send(paymentStatusPage(
    "Abono aprobado",
    "Listo. PaySync va a activar el plan automaticamente cuando Mercado Pago confirme el pago.",
    scope === "company" ? companyName : deviceCode
  ));
});

app.get("/pay-plan/failure", function (req, res) {
  const scope = getParam(req, ["scope"], "");
  const deviceCode = getParam(req, ["device"], "");
  const companyName = getParam(req, ["company"], "");

  return res.send(paymentStatusPage(
    "Abono rechazado",
    "No se pudo completar el pago del plan. Podes volver a intentar desde el panel.",
    scope === "company" ? companyName : deviceCode
  ));
});

app.get("/pay-plan/pending", function (req, res) {
  const scope = getParam(req, ["scope"], "");
  const deviceCode = getParam(req, ["device"], "");
  const companyName = getParam(req, ["company"], "");

  return res.send(paymentStatusPage(
    "Abono pendiente",
    "Mercado Pago todavia esta procesando el abono. Cuando se apruebe, PaySync activara el plan.",
    scope === "company" ? companyName : deviceCode
  ));
});

app.get("/pay/start/:device_code", async function (req, res) {
  try {
    const deviceCode = normalizeDeviceCode(getParam(req, ["device_code"]));
    const device = await getDeviceFromSummary(deviceCode);

    if (!device) {
      return res.status(404).send(paymentStatusPage(
        "Dispositivo no encontrado",
        "El codigo no existe en PaySync.",
        deviceCode
      ));
    }

    if (device.status !== "active") {
      return res.status(403).send(paymentStatusPage(
        "Dispositivo no disponible",
        "Esta maquina no esta activa o tiene el plan vencido.",
        deviceCode
      ));
    }

    const amount = Number(device.qr_price_ars || 0);

    if (!amount || amount <= 0) {
      return fail(res, new Error("Invalid QR price for device"), 400);
    }

    const publicBaseUrl = getPublicBaseUrl(req);
    const externalReference = device.device_code + "|" + Date.now();

    const preference = await mercadoPagoRequest(
      "/checkout/preferences",
      "POST",
      {
        items: [
          {
            title: "Credito PaySync - " + device.visible_name,
            description: "Maquina " + device.device_code,
            quantity: 1,
            currency_id: "ARS",
            unit_price: amount
          }
        ],
        external_reference: externalReference,
        metadata: {
          device_code: device.device_code,
          source: "paysync"
        },
        notification_url: publicBaseUrl + "/mp/webhook",
        back_urls: {
          success: publicBaseUrl + "/pay/success?device=" + encodeURIComponent(device.device_code),
          failure: publicBaseUrl + "/pay/failure?device=" + encodeURIComponent(device.device_code),
          pending: publicBaseUrl + "/pay/pending?device=" + encodeURIComponent(device.device_code)
        },
        auto_return: "approved"
      }
    );

    const checkoutUrl = preference.init_point || preference.sandbox_init_point;

    if (!checkoutUrl) {
      return fail(res, new Error("Mercado Pago did not return init_point"), 500);
    }

    if (getParam(req, ["json"], "0") === "1") {
      return ok(res, {
        device_code: device.device_code,
        amount: amount,
        preference_id: preference.id,
        checkout_url: checkoutUrl,
        external_reference: externalReference
      });
    }

    return res.redirect(checkoutUrl);
  } catch (error) {
    return fail(res, error);
  }
});

async function mercadoPagoWebhookHandler(req, res) {
  try {
    const body = req.body || {};
    const query = req.query || {};

    const paymentId =
      (body.data && body.data.id) ||
      body.id ||
      query["data.id"] ||
      query.id ||
      query.payment_id ||
      null;

    if (!paymentId) {
      return ok(res, {
        message: "Webhook recibido sin paymentId",
        query: query,
        body: body
      });
    }

    const payment = await mercadoPagoRequest(
      "/v1/payments/" + encodeURIComponent(paymentId),
      "GET"
    );

    const paymentStatus = String(payment.status || "");

    if (paymentStatus !== "approved") {
      return ok(res, {
        message: "Pago recibido pero no aprobado",
        payment_id: paymentId,
        status: paymentStatus
      });
    }

    const metadata = payment.metadata || {};
    const externalReference = String(payment.external_reference || "");
    const parts = externalReference.split("|");

    const paymentType = String(
      metadata.payment_type ||
      metadata.paymentType ||
      ""
    );

    const isPlanPayment =
      paymentType === "plan_subscription" ||
      parts[0] === "PLAN";

    const amountArs = Math.round(Number(payment.transaction_amount || 0));

    if (isPlanPayment) {
      const planScope = String(
        metadata.plan_scope ||
        metadata.scope ||
        parts[1] ||
        ""
      );

      const planType = String(
        metadata.plan_type ||
        parts[3] ||
        "monthly"
      );

      const preferenceId = String(
        payment.preference_id ||
        (payment.order && payment.order.id) ||
        "PREF-" + payment.id
      );

      if (planScope === "device") {
        const deviceCode = normalizeDeviceCode(
          metadata.device_code ||
          metadata.deviceCode ||
          parts[2] ||
          ""
        );

        if (!deviceCode || deviceCode === "PS-000000") {
          return fail(res, new Error("Plan payment approved but device_code was not found"), 400);
        }

        const data = await callRpc("register_device_plan_payment_by_code", {
          p_device_code: deviceCode,
          p_plan_type: planType,
          p_mp_payment_id: String(payment.id),
          p_mp_preference_id: preferenceId,
          p_external_reference: externalReference,
          p_amount_ars: amountArs
        });

        return ok(res, {
          message: "Pago de abono de dispositivo aprobado y registrado",
          payment_id: payment.id,
          scope: "device",
          device_code: deviceCode,
          plan_type: planType,
          amount_ars: amountArs,
          result: data
        });
      }

      if (planScope === "company") {
        const companyName = String(
          metadata.company_name ||
          metadata.companyName ||
          parts[2] ||
          ""
        );

        if (!companyName) {
          return fail(res, new Error("Plan payment approved but company_name was not found"), 400);
        }

        const data = await callRpc("register_company_plan_payment_by_name", {
          p_company_name: companyName,
          p_plan_type: planType,
          p_mp_payment_id: String(payment.id),
          p_mp_preference_id: preferenceId,
          p_external_reference: externalReference,
          p_amount_ars: amountArs
        });

        return ok(res, {
          message: "Pago de abono de empresa aprobado y registrado",
          payment_id: payment.id,
          scope: "company",
          company_name: companyName,
          plan_type: planType,
          amount_ars: amountArs,
          result: data
        });
      }

      return fail(res, new Error("Invalid plan payment scope"), 400);
    }

    const existing = await supabaseRequest(
      "/rest/v1/qr_payments?select=id,mp_payment_id&mp_payment_id=eq." +
        encodeURIComponent(String(payment.id)) +
        "&limit=1",
      "GET"
    );

    if (existing && Array.isArray(existing) && existing.length > 0) {
      return ok(res, {
        message: "Pago QR ya registrado anteriormente",
        payment_id: payment.id
      });
    }

    let deviceCode =
      metadata.device_code ||
      metadata.deviceCode ||
      externalReference.split("|")[0] ||
      "";

    deviceCode = normalizeDeviceCode(deviceCode);

    if (!deviceCode || deviceCode === "PS-000000") {
      return fail(res, new Error("Payment approved but device_code was not found"), 400);
    }

    const preferenceId = String(
      payment.preference_id ||
      (payment.order && payment.order.id) ||
      "PREF-" + payment.id
    );

    const data = await callRpc("register_qr_payment_by_device_code", {
      p_device_code: deviceCode,
      p_mp_payment_id: String(payment.id),
      p_mp_preference_id: preferenceId,
      p_external_reference: externalReference || deviceCode + "-" + payment.id
    });

    return ok(res, {
      message: "Pago QR aprobado registrado en PaySync",
      payment_id: payment.id,
      device_code: deviceCode,
      result: data
    });
  } catch (error) {
    return fail(res, error);
  }
}

app.post("/mp/webhook", mercadoPagoWebhookHandler);
app.get("/mp/webhook", mercadoPagoWebhookHandler);

app.get("/pay/success", function (req, res) {
  const deviceCode = getParam(req, ["device"], "");
  return res.send(paymentStatusPage(
    "Pago aprobado",
    "Listo. Si la maquina esta online, el credito se va a entregar automaticamente.",
    deviceCode
  ));
});

app.get("/pay/failure", function (req, res) {
  const deviceCode = getParam(req, ["device"], "");
  return res.send(paymentStatusPage(
    "Pago rechazado",
    "No se pudo completar el pago. Podes volver a escanear el QR e intentar otra vez.",
    deviceCode
  ));
});

app.get("/pay/pending", function (req, res) {
  const deviceCode = getParam(req, ["device"], "");
  return res.send(paymentStatusPage(
    "Pago pendiente",
    "Mercado Pago todavia esta procesando el pago. Cuando se apruebe, PaySync entregara el credito.",
    deviceCode
  ));
});

app.get("/pay/:device_code", async function (req, res) {
  try {
    const deviceCode = normalizeDeviceCode(getParam(req, ["device_code"]));
    const device = await getDeviceFromSummary(deviceCode);

    if (!device) {
      return res.status(404).send(
        "<html>" +
          "<body style='font-family: Arial; background:#080b12; color:white; text-align:center; padding:40px;'>" +
            "<h1>Dispositivo no encontrado</h1>" +
            "<p>El codigo " + escapeHtml(deviceCode) + " no existe en PaySync.</p>" +
          "</body>" +
        "</html>"
      );
    }

    if (device.status !== "active") {
      return res.status(403).send(
        "<html>" +
          "<body style='font-family: Arial; background:#080b12; color:white; text-align:center; padding:40px;'>" +
            "<h1>Dispositivo no disponible</h1>" +
            "<p>Esta maquina no esta activa o tiene el plan vencido.</p>" +
            "<p>Codigo: " + escapeHtml(deviceCode) + "</p>" +
          "</body>" +
        "</html>"
      );
    }

    return res.send(
      "<html>" +
        "<head>" +
          "<meta name='viewport' content='width=device-width, initial-scale=1.0' />" +
          "<title>PaySync - " + escapeHtml(device.visible_name) + "</title>" +
        "</head>" +
        "<body style='font-family: Arial; background:#080b12; color:white; margin:0; padding:30px;'>" +
          "<div style='max-width:420px; margin:auto; background:#111827; border:1px solid #263244; border-radius:20px; padding:24px; text-align:center;'>" +
            "<h1 style='color:#16d9ff; margin-top:0;'>PaySync</h1>" +
            "<h2>" + escapeHtml(device.visible_name) + "</h2>" +
            "<p style='color:#9ca3af;'>Confirma que esta es la maquina en la que queres jugar</p>" +
            "<p style='font-size:14px; color:#9ca3af;'>Codigo: " + escapeHtml(device.device_code) + "</p>" +
            "<p style='font-size:34px; font-weight:bold;'>$" + escapeHtml(device.qr_price_ars) + "</p>" +
            "<a href='/pay/start/" + encodeURIComponent(device.device_code) + "' " +
              "style='display:block; background:#06c8f4; color:#001018; padding:16px; border-radius:14px; text-decoration:none; font-weight:bold; margin-top:20px;'>" +
              "Pagar ahora" +
            "</a>" +
            "<p style='font-size:12px; color:#6b7280; margin-top:20px;'>Pago seguro con Mercado Pago</p>" +
          "</div>" +
        "</body>" +
      "</html>"
    );
  } catch (error) {
    return fail(res, error);
  }
});
app.get("/admin/companies", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const data = await supabaseRequest(
      "/rest/v1/company_dashboard_summary?select=*&order=company_name.asc",
      "GET"
    );

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
});

app.get("/admin/company-devices", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const companyName = getParam(req, ["company", "company_name"], null);
    const companyId = getParam(req, ["company_id"], null);

    let resolvedCompanyId = companyId;

    if (!resolvedCompanyId) {
      if (!companyName) {
        return fail(res, new Error("Missing company or company_id"), 400);
      }

      const companies = await supabaseRequest(
        "/rest/v1/companies?select=id,name,contact_email,status&name=eq." +
          encodeURIComponent(companyName) +
          "&limit=1",
        "GET"
      );

      if (!companies || !Array.isArray(companies) || companies.length === 0) {
        return fail(res, new Error("Company not found"), 404);
      }

      resolvedCompanyId = companies[0].id;
    }

    const devices = await supabaseRequest(
      "/rest/v1/devices?select=device_code,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars,coin_pulse_value_ars,subscription_status,subscription_expires_at,last_seen_at,wifi_rssi,firmware_version&company_id=eq." +
        encodeURIComponent(resolvedCompanyId) +
        "&order=device_code.asc",
      "GET"
    );

    return ok(res, {
      company_id: resolvedCompanyId,
      devices: devices
    });
  } catch (error) {
    return fail(res, error);
  }
});

async function upsertCompanyHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const companyName = getParam(req, ["company", "company_name", "name"]);
    const companyEmail = getParam(req, ["email", "company_email"], null);
    const companyStatus = getParam(req, ["status", "company_status"], "active");

    if (!companyName) {
      return fail(res, new Error("Missing company name"), 400);
    }

    const data = await callRpc("upsert_company_by_name", {
      p_company_name: companyName,
      p_company_email: companyEmail,
      p_company_status: companyStatus
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/admin/upsert-company", upsertCompanyHandler);
app.post("/admin/upsert-company", upsertCompanyHandler);

async function assignDeviceHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code", "code"]);
    const companyName = getParam(req, ["company", "company_name"]);
    const companyEmail = getParam(req, ["email", "company_email"], null);
    const forceRaw = getParam(req, ["force", "force_reassign"], "true");

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    if (!companyName) {
      return fail(res, new Error("Missing company name"), 400);
    }

    const forceReassign =
      forceRaw === true ||
      forceRaw === "true" ||
      forceRaw === "1";

    const data = await callRpc("admin_assign_device_to_company", {
      p_device_code: deviceCode,
      p_company_name: companyName,
      p_company_email: companyEmail,
      p_force_reassign: forceReassign
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/admin/assign-device", assignDeviceHandler);
app.post("/admin/assign-device", assignDeviceHandler);

async function unassignDeviceHandler(req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const deviceCode = getParam(req, ["device", "device_code", "code"]);

    if (!deviceCode) {
      return fail(res, new Error("Missing device code"), 400);
    }

    const data = await callRpc("admin_unassign_device_by_code", {
      p_device_code: deviceCode
    });

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
}

app.get("/admin/unassign-device", unassignDeviceHandler);
app.post("/admin/unassign-device", unassignDeviceHandler);

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("PaySync backend running on port " + PORT);
  });
}

module.exports = app;
