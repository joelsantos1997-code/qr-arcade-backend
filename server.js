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
      "GET /admin/print-qr",
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

    const existing = await supabaseRequest(
      "/rest/v1/qr_payments?select=id,mp_payment_id&mp_payment_id=eq." +
        encodeURIComponent(String(payment.id)) +
        "&limit=1",
      "GET"
    );

    if (existing && Array.isArray(existing) && existing.length > 0) {
      return ok(res, {
        message: "Pago ya registrado anteriormente",
        payment_id: payment.id
      });
    }

    const metadata = payment.metadata || {};
    const externalReference = String(payment.external_reference || "");

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
      message: "Pago aprobado registrado en PaySync",
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

if (require.main === module) {
  app.listen(PORT, function () {
    console.log("PaySync backend running on port " + PORT);
  });
}

module.exports = app;
