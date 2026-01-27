import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

// ===== CONFIG =====
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // APP_USR-...
const BASE_URL = process.env.BASE_URL;               // https://tu-app.onrender.com
const API_KEY = process.env.API_KEY;                 // clave tuya para el ESP

if (!MP_ACCESS_TOKEN || !BASE_URL || !API_KEY) {
  console.error("❌ Faltan env vars: MP_ACCESS_TOKEN, BASE_URL, API_KEY");
  process.exit(1);
}

// ===== DB SIMPLE (MVP) =====
const credits = Object.create(null);
function addCredit(machineId, amount = 1) {
  credits[machineId] = (credits[machineId] || 0) + amount;
}
function getCredits(machineId) {
  return credits[machineId] || 0;
}

// ===== helper fetch MercadoPago =====
async function mpFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// ===== HEALTH =====
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.send("OK"));

// ===== 1) Crear link de pago (preferencia) =====
app.post("/create_preference", async (req, res) => {
  try {
    const { machineId, price } = req.body;
    if (!machineId || !price) {
      return res.status(400).json({ ok: false, error: "machineId y price requeridos" });
    }

    const external_reference = `${machineId}-${Date.now()}`;

    const body = {
      items: [{ title: "Credito Arcade", quantity: 1, unit_price: Number(price) }],
      external_reference,
      notification_url: `${BASE_URL}/mp/webhook`,
    };

    const r = await mpFetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      console.error("❌ MP create preference failed:", r.status, r.text);
      return res.status(500).json({
        ok: false,
        error: "Mercado Pago no creó la preferencia",
        detail: r.json || r.text,
      });
    }

    return res.json({
      ok: true,
      machineId,
      price: Number(price),
      external_reference,
      init_point: r.json.init_point,
      preference_id: r.json.id,
    });
  } catch (e) {
    console.error("❌ create_preference error:", e);
    return res.status(500).json({ ok: false, error: "Fallo creando preferencia" });
  }
});

// ===== 2) Webhook Mercado Pago (robusto) =====
app.post("/mp/webhook", async (req, res) => {
  // Respondemos rápido a MP
  res.sendStatus(200);

  try {
    // MercadoPago puede mandar distintos formatos:
    // - Query: ?id=...&topic=payment
    // - Body: { data: { id }, type: "payment" }
    // - Body: { id, topic }
    const topic =
      req.query?.topic ||
      req.query?.type ||
      req.body?.type ||
      req.body?.topic;

    const id =
      req.query?.id ||
      req.body?.data?.id ||
      req.body?.id;

    console.log("🔔 Webhook recibido:", { topic, id });

    if (!id) {
      console.log("⚠️ Webhook sin id (ignorado)");
      return;
    }

    // Caso 1: topic/type = payment  => consultar pago directo
    if (topic === "payment" || topic === "payments") {
      await handlePaymentId(id);
      return;
    }

    // Caso 2: topic = merchant_order => hay que buscar payments dentro de la orden
    if (topic === "merchant_order") {
      await handleMerchantOrderId(id);
      return;
    }

    // Caso 3: si no viene topic, intentamos como payment igual (suele funcionar)
    await handlePaymentId(id);

  } catch (e) {
    console.error("❌ Webhook error:", e);
  }
});

async function handlePaymentId(paymentId) {
  const r = await mpFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: "GET",
  });

  if (!r.ok) {
    console.error("❌ MP get payment failed:", r.status, r.text);
    return;
  }

  const pay = r.json;
  console.log("💳 Payment:", {
    id: pay.id,
    status: pay.status,
    status_detail: pay.status_detail,
    external_reference: pay.external_reference,
  });

  if (pay.status === "approved") {
    const extRef = pay.external_reference || "";
    const machineId = extRef.split("-")[0];

    if (machineId) {
      addCredit(machineId, 1);
      console.log("✅ Pago aprobado. Crédito +1 para:", machineId, "Total:", getCredits(machineId));
    } else {
      console.log("⚠️ Pago aprobado pero extRef sin machineId:", extRef);
    }
  } else {
    console.log("ℹ️ Pago no aprobado. Status:", pay.status, pay.status_detail);
  }
}

async function handleMerchantOrderId(orderId) {
  const r = await mpFetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
    method: "GET",
  });

  if (!r.ok) {
    console.error("❌ MP get merchant_order failed:", r.status, r.text);
    return;
  }

  const order = r.json;
  const payments = Array.isArray(order.payments) ? order.payments : [];

  console.log("🧾 Merchant order:", {
    id: order.id,
    payments_count: payments.length,
  });

  // Buscamos algún pago aprobado dentro de la orden
  for (const p of payments) {
    if (p.status === "approved" && p.id) {
      await handlePaymentId(p.id);
      return;
    }
  }

  console.log("ℹ️ Merchant order sin pagos aprobados todavía.");
}

// ===== 3) Créditos (ESP) =====
app.get("/credits", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  return res.json({ ok: true, machine, credits: getCredits(machine) });
});

// ===== 4) Consumir crédito (ESP) =====
app.post("/consume", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });

  const c = getCredits(machine);
  if (c <= 0) return res.status(409).json({ ok: false, credits: 0 });

  credits[machine] = c - 1;
  return res.json({ ok: true, machine, credits: credits[machine] });
});

const port = process.env.PORT || 3000;
// ===== TEST: sumar créditos manualmente (solo para pruebas) =====
app.post("/test/add", (req, res) => {
  const { machine, key, amount } = req.query;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });

  const n = Number(amount || 1);
  credits[machine] = (credits[machine] || 0) + n;
  return res.json({ ok: true, machine, credits: credits[machine] });
});

app.listen(port, () => console.log("✅ Server on", port));
