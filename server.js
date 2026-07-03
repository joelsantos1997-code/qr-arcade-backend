require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const API_KEY = String(process.env.API_KEY || "Laluna123").trim();

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

app.get("/", function (req, res) {
  return res.json({
    ok: true,
    name: "PaySync Backend",
    status: "online",
    service: "paysync-backend",
    supabase_url: SUPABASE_URL,
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
      "GET /test/qr-approved"
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
    supabase_url: SUPABASE_URL
  });
});

app.get("/debug/supabase", async function (req, res) {
  try {
    const data = await supabaseRequest(
      "/rest/v1/devices?select=device_code,visible_name,status&limit=10",
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

app.get("/pay/:device_code", async function (req, res) {
  try {
    const deviceCode = getParam(req, ["device_code"]);

    let path =
      "/rest/v1/device_dashboard_summary?select=*&device_code=eq." +
      encodeURIComponent(deviceCode);

    const data = await supabaseRequest(path, "GET");

    if (!data || !Array.isArray(data) || data.length === 0) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial; background:#080b12; color:white; text-align:center; padding:40px;">
            <h1>Dispositivo no encontrado</h1>
            <p>El código ${deviceCode} no existe en PaySync.</p>
          </body>
        </html>
      `);
    }

    const device = data[0];

    if (device.status !== "active") {
      return res.status(403).send(`
        <html>
          <body style="font-family: Arial; background:#080b12; color:white; text-align:center; padding:40px;">
            <h1>Dispositivo no disponible</h1>
            <p>Esta máquina no está activa o tiene el plan vencido.</p>
            <p>Código: ${deviceCode}</p>
          </body>
        </html>
      `);
    }

    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>PaySync - ${device.visible_name}</title>
        </head>
        <body style="font-family: Arial; background:#080b12; color:white; margin:0; padding:30px;">
          <div style="max-width:420px; margin:auto; background:#111827; border:1px solid #263244; border-radius:20px; padding:24px; text-align:center;">
            <h1 style="color:#16d9ff; margin-top:0;">PaySync</h1>
            <h2>${device.visible_name}</h2>
            <p style="color:#9ca3af;">Confirmá que esta es la máquina en la que querés jugar</p>
            <p style="font-size:14px; color:#9ca3af;">Código: ${device.device_code}</p>
            <p style="font-size:34px; font-weight:bold;">$${device.qr_price_ars}</p>
            <a href="https://link.mercadopago.com/paysync-mensual"
               style="display:block; background:#06c8f4; color:#001018; padding:16px; border-radius:14px; text-decoration:none; font-weight:bold; margin-top:20px;">
              Pagar ahora
            </a>
            <p style="font-size:12px; color:#6b7280; margin-top:20px;">
              Pago seguro con Mercado Pago
            </p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    return fail(res, error);
  }
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("PaySync backend running on port " + PORT);
  });
}

module.exports = app;
