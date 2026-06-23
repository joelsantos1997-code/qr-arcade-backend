require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const API_KEY = (process.env.API_KEY || "Laluna123").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
auth: {
persistSession: false,
autoRefreshToken: false
}
});
} else {
console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

function getSupabase() {
if (!supabase) {
throw new Error("Supabase is not configured. Check Render Environment Variables.");
}
return supabase;
}

function getParam(req, names, fallback) {
if (fallback === undefined) {
fallback = null;
}

for (const name of names) {
if (req.body && req.body[name] !== undefined) {
return req.body[name];
}

```
if (req.query && req.query[name] !== undefined) {
  return req.query[name];
}

if (req.params && req.params[name] !== undefined) {
  return req.params[name];
}
```

}

return fallback;
}

function checkApiKey(req) {
const key =
req.headers["x-api-key"] ||
req.query.key ||
(req.body ? req.body.key : null);

return key === API_KEY;
}

async function callRpc(functionName, params) {
const db = getSupabase();

const result = await db.rpc(functionName, params);

if (result.error) {
throw result.error;
}

return result.data;
}

function ok(res, data) {
if (data === undefined) {
data = {};
}

return res.json({
ok: true,
data: data
});
}

function fail(res, error, statusCode) {
if (statusCode === undefined) {
statusCode = 500;
}

console.error("ERROR:", error);

return res.status(statusCode).json({
ok: false,
error: error.message || String(error),
name: error.name || null,
cause: error.cause ? String(error.cause) : null
});
}

app.get("/", function (req, res) {
res.json({
ok: true,
name: "PaySync Backend",
status: "online",
endpoints: [
"GET /health",
"GET /debug/supabase",
"GET /device/config?device=PS-000001&token=TOKEN-PS-000001-TEST",
"GET /device/heartbeat?device=PS-000001&token=TOKEN-PS-000001-TEST&rssi=-58&firmware=v1.0",
"GET /device/bill-pulse?device=PS-000001&token=TOKEN-PS-000001-TEST",
"GET /device/consume-pulse?device=PS-000001&token=TOKEN-PS-000001-TEST",
"GET /device/summary?device=PS-000001",
"GET /device/live-status?device=PS-000001",
"GET /test/qr-approved?key=Laluna123&device=PS-000001"
]
});
});

app.get("/health", function (req, res) {
res.json({
ok: true,
service: "paysync-backend",
port: PORT,
supabase_url_configured: Boolean(SUPABASE_URL),
supabase_key_configured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
api_key_configured: Boolean(API_KEY)
});
});

app.get("/debug/supabase", async function (req, res) {
try {
const db = getSupabase();

```
const result = await db
  .from("devices")
  .select("device_code, visible_name, status")
  .limit(5);

if (result.error) {
  return res.status(500).json({
    ok: false,
    step: "supabase_query_error",
    supabase_url: SUPABASE_URL,
    has_service_key: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    error: result.error
  });
}

return res.json({
  ok: true,
  step: "supabase_connected",
  supabase_url: SUPABASE_URL,
  has_service_key: Boolean(SUPABASE_SERVICE_ROLE_KEY),
  data: result.data
});
```

} catch (err) {
return res.status(500).json({
ok: false,
step: "catch_error",
message: err.message,
name: err.name,
cause: err.cause ? String(err.cause) : null
});
}
});

async function deviceConfigHandler(req, res) {
try {
const deviceCode = getParam(req, ["device", "device_code"]);
const deviceToken = getParam(req, ["token", "device_token"]);

```
if (!deviceCode || !deviceToken) {
  return fail(res, new Error("Missing device/device_code or token/device_token"), 400);
}

const data = await callRpc("get_device_config_by_device_code", {
  p_device_code: deviceCode,
  p_device_token: deviceToken
});

return ok(res, data);
```

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

```
if (!deviceCode || !deviceToken) {
  return fail(res, new Error("Missing device/device_code or token/device_token"), 400);
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
```

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

```
let eventUid = getParam(req, ["event_uid", "event"]);

if (!deviceCode || !deviceToken) {
  return fail(res, new Error("Missing device/device_code or token/device_token"), 400);
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
```

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

```
if (!deviceCode || !deviceToken) {
  return fail(res, new Error("Missing device/device_code or token/device_token"), 400);
}

const data = await callRpc("consume_pending_pulse_by_device_code", {
  p_device_code: deviceCode,
  p_device_token: deviceToken
});

return ok(res, data);
```

} catch (error) {
return fail(res, error);
}
}

app.get("/device/consume-pulse", consumePulseHandler);
app.post("/device/consume-pulse", consumePulseHandler);

app.get("/device/live-status", async function (req, res) {
try {
const deviceCode = getParam(req, ["device", "device_code"]);

```
let query = getSupabase()
  .from("device_live_status")
  .select("*");

if (deviceCode) {
  query = query.eq("device_code", deviceCode);
}

const result = await query;

if (result.error) {
  throw result.error;
}

return ok(res, result.data);
```

} catch (error) {
return fail(res, error);
}
});

app.get("/device/summary", async function (req, res) {
try {
const deviceCode = getParam(req, ["device", "device_code"]);

```
let query = getSupabase()
  .from("device_dashboard_summary")
  .select("*");

if (deviceCode) {
  query = query.eq("device_code", deviceCode);
}

const result = await query;

if (result.error) {
  throw result.error;
}

return ok(res, result.data);
```

} catch (error) {
return fail(res, error);
}
});

async function testQrApprovedHandler(req, res) {
try {
if (!checkApiKey(req)) {
return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
}

```
const deviceCode = getParam(req, ["device", "device_code"], "PS-000001");

let paymentId = getParam(req, ["payment", "payment_id", "mp_payment_id"]);
let preferenceId = getParam(req, ["preference", "preference_id", "mp_preference_id"]);
let externalReference = getParam(req, ["external_reference"]);

if (!paymentId) {
  paymentId = "MP-TEST-" + Date.now();
}

if (!preferenceId) {
  preferenceId = "PREF-TEST-" + Date.now();
}

if (!externalReference) {
  externalReference = deviceCode + "-" + paymentId;
}

const data = await callRpc("register_qr_payment_by_device_code", {
  p_device_code: deviceCode,
  p_mp_payment_id: paymentId,
  p_mp_preference_id: preferenceId,
  p_external_reference: externalReference
});

return ok(res, data);
```

} catch (error) {
return fail(res, error);
}
}

app.get("/test/qr-approved", testQrApprovedHandler);
app.post("/test/qr-approved", testQrApprovedHandler);

app.listen(PORT, function () {
console.log("PaySync backend running on port " + PORT);
});
