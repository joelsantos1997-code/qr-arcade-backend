const express = require("express");
const {createRuntime} = require("./lib/runtime");
const {installSecurity} = require("./lib/security");
const {installStatus} = require("./lib/status");
const {installPayments} = require("./lib/payments");
const {generateEspFirmware} = require("./lib/firmware");

function createApp({env=process.env,fetchImpl=globalThis.fetch}={}) {
const app=express();
const rt=createRuntime(env,fetchImpl);
const {config, getParam, normalizeDeviceCode, escapeHtml, getPublicBaseUrl, checkApiKey, ok, fail, supabaseRequest, callRpc, mercadoPagoRequest}=rt;
const PLAN_PRICES_ARS={monthly:config.monthly,six_months:config.sixMonths};
installSecurity(app,rt);
installStatus(app,rt);
installPayments(app,rt);

function getPlanLabel(planType) {
  if (planType === "six_months") return "Plan 6 meses";
  return "Plan mensual";
}

function getPlanAmount(planType) {
  return PLAN_PRICES_ARS[planType] || PLAN_PRICES_ARS.monthly;
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
    "/rest/v1/devices?select=device_code,device_token,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars,coin_pulse_value_ars,subscription_status,subscription_expires_at&device_code=eq." +
    encodeURIComponent(normalizedCode) +
    "&limit=1";

  const data = await supabaseRequest(path, "GET");

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
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

app.get("/",(req,res)=>res.json({ok:true,service:"paysync-backend",health:"/health"}));

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

    if (getParam(req,["protocol"]) === "ack-v1") {
      await callRpc("paysync_heartbeat",{p_device_code:deviceCode,p_device_token:deviceToken,p_boot_id:getParam(req,["boot_id"]),p_ready:getParam(req,["ready"]) === true});
    }
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

app.all("/device/consume-pulse",(req,res)=>res.status(426).json({ok:false,error:"Firmware ack-v1 required; legacy credits need reconciliation"}));

app.get("/device/live-status", async function (req, res) {
  try {
    const deviceCode = getParam(req, ["device", "device_code"]);

    let path = "/rest/v1/device_live_status?select=*";

    if (deviceCode) {
      path = path + "&device_code=eq." + encodeURIComponent(normalizeDeviceCode(deviceCode));
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
      path = path + "&device_code=eq." + encodeURIComponent(normalizeDeviceCode(deviceCode));
    }

    const data = await supabaseRequest(path, "GET");
    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
});

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
    const forceRaw = getParam(req, ["force", "force_reassign"], "false");

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

app.get("/admin/plan-payments", async function (req, res) {
  try {
    if (!checkApiKey(req)) {
      return fail(res, new Error("Unauthorized. Invalid API_KEY."), 401);
    }

    const scope = getParam(req, ["scope"], null);
    const deviceCode = getParam(req, ["device", "device_code"], null);
    const companyName = getParam(req, ["company", "company_name"], null);

    let path =
      "/rest/v1/plan_payments?select=*&order=created_at.desc&limit=200";

    if (scope) {
      path += "&scope=eq." + encodeURIComponent(scope);
    }

    if (deviceCode) {
      path += "&device_code=eq." + encodeURIComponent(normalizeDeviceCode(deviceCode));
    }

    if (companyName) {
      path += "&company_name=eq." + encodeURIComponent(companyName);
    }

    const data = await supabaseRequest(path, "GET");

    return ok(res, data);
  } catch (error) {
    return fail(res, error);
  }
});

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

    const firmware = generateEspFirmware(device.device_code, device.device_token, config);
    const fileName = "PaySync-" + device.device_code + ".ino";

    if (download === "1" || download === 1 || download === true) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"" + fileName + "\"");
      return res.send(firmware);
    }

    const firmwareUrl =
      "/admin/firmware?device=" +
      encodeURIComponent(device.device_code) +
      "&download=1";

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
              "<a class='btn secondary' href='/admin/devices-technical'>Volver a dispositivos</a>" +
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
      "/rest/v1/devices?select=device_code,device_token,visible_name,status,qr_price_ars,pulses_per_payment,bill_pulse_value_ars,coin_pulse_value_ars,subscription_status,subscription_expires_at,created_at&order=device_code.asc&limit=300";

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
      const coinValue = String(d.coin_pulse_value_ars || 0);
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
          "<td>$" + escapeHtml(coinValue) + "</td>" +
          "<td>" + escapeHtml(subscriptionStatus) + "<br><small>" + escapeHtml(expires) + "</small></td>" +
          "<td><code>" + escapeHtml(token) + "</code></td>" +
          "<td><a href='" + escapeHtml(payUrl) + "' target='_blank'>Abrir QR</a></td>" +
          "<td>" +
            "<a class='smallbtn' href='/admin/firmware?device=" + encodeURIComponent(code) + "' target='_blank'>Firmware</a>" +
            "<textarea id='copy_" + i + "' readonly>" + escapeHtml(arduinoBlock) + "</textarea>" +
            "<button onclick='copyText(\"copy_" + i + "\")'>Copiar Arduino</button>" +
          "</td>" +
        "</tr>";
    }

    if (!rows) {
      rows =
        "<tr><td colspan='11' style='text-align:center;padding:30px;color:#64748b;'>No hay dispositivos para mostrar.</td></tr>";
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
            "table{width:100%;border-collapse:collapse;min-width:1420px;}" +
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
              "<a class='linkbtn' href='/admin/print-qr'>Ver QR imprimibles</a>" +
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
                  "<th>Monedero</th>" +
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
      const qrImage = await require('qrcode').toDataURL(payUrl, {width:220, margin:2});

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
            "<p>Filtrar por rango: <b>?from=4&amp;to=8</b>. Requiere sesión de administrador.</p>" +
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

app.get("/pay-plan/success", function (req, res) {
  const scope = getParam(req, ["scope"], "");
  const deviceCode = getParam(req, ["device"], "");
  const companyName = getParam(req, ["company"], "");

  return res.send(paymentStatusPage(
    "Confirmación de abono",
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

app.get("/pay/success", function (req, res) {
  const deviceCode = getParam(req, ["device"], "");
  return res.send(paymentStatusPage(
    "Confirmación de pago",
    "La confirmación definitiva llega de Mercado Pago. Si no recibís el crédito, contactá al responsable de la máquina.",
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

    if (!config.paymentsEnabled || !(await callRpc("paysync_device_available", {p_device_code:deviceCode})).ready) {
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

app.post("/device/coin/claim",async(req,res)=>{try {return ok(res,await callRpc("paysync_claim_coin",{p_device_code:getParam(req,["device"]),p_device_token:getParam(req,["token"]),p_boot_id:getParam(req,["boot_id"])}));}catch(e){return fail(res,e);}});
app.post("/device/coin/ack",async(req,res)=>{try {return ok(res,await callRpc("paysync_ack_coin",{p_device_code:getParam(req,["device"]),p_device_token:getParam(req,["token"]),p_command_id:getParam(req,["command_id"]),p_outcome:getParam(req,["outcome"])}));}catch(e){return fail(res,e);}});
app.use((req,res)=>res.status(404).json({ok:false,error:"Not found"}));
app.use((error,req,res,next)=>fail(res,error.type==="entity.parse.failed" ? rt.httpError(400,"Invalid JSON") : error));
return app;
}
if(require.main===module) {
  require("dotenv").config();
  createApp().listen(process.env.PORT || 10000,()=>console.log("PaySync backend ready"));
}
module.exports=createApp();
module.exports.createApp=createApp;
