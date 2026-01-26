import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

// ===== CONFIG =====
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // APP_USR-...
const BASE_URL = process.env.BASE_URL;               // http://localhost:3000 o https://tu-app.onrender.com
const API_KEY = process.env.API_KEY;                 // clave tuya para el ESP

if (!MP_ACCESS_TOKEN || !BASE_URL || !API_KEY) {
  console.error("Faltan env vars: MP_ACCESS_TOKEN, BASE_URL, API_KEY");
  process.exit(1);
}

// ===== DB SIMPLE (MVP) =====
const credits = Object.create(null);
function addCredit(machineId, amount = 1) {
  credits[machineId] = (credits[machineId] || 0) + amount;
}

// ===== helper fetch =====
async function mpFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MP_ACCESS_TOKEN}`,
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// ===== health =====
app.get("/", (_, res) => res.send("OK"));

// ===== 1) Crear link de pago (preferencia) =====
app.post("/create_preference", async (req, res) => {
  try {
    const { machineId, price } = req.body;
    if (!machineId || !price) return res.status(400).json({ error: "machineId y price requeridos" });

    const external_reference = `${machineId}-${Date.now()}`;

    const body = {
      items: [
        { title: "Credito Arcade", quantity: 1, unit_price: Number(price) }
      ],
      external_reference,
      notification_url: `${BASE_URL}/mp/webhook`
    };

    const r = await mpFetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      console.error("MP create preference failed:", r.status, r.text);
      return res.status(500).json({ ok: false, error: "Mercado Pago no creó la preferencia", detail: r.json || r.text });
    }

    return res.json({
      ok: true,
      machineId,
      price,
      external_reference,
      init_point: r.json.init_point,
      preference_id: r.json.id
    });
  } catch (e) {
    console.error("create_preference error:", e);
    return res.status(500).json({ ok: false, error: "Fallo creando preferencia" });
  }
});

// ===== 2) Webhook Mercado Pago =====
app.post("/mp/webhook", async (req, res) => {
  try {
    // Respondemos rápido a MP
    res.sendStatus(200);

    // El ID puede venir de varias formas
    const paymentId =
      req.query?.id ||
      req.body?.data?.id ||
      req.body?.id;

    if (!paymentId) {
      console.log("Webhook recibido sin paymentId");
      return;
    }

    // Consultamos el pago para confirmar estado
    const r = await mpFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      method: "GET"
    });

    if (!r.ok) {
      console.error("MP get payment failed:", r.status, r.text);
      return;
    }

    const pay = r.json;

    if (pay.status === "approved") {
      const extRef = pay.external_reference || "";
      const machineId = extRef.split("-")[0];
      if (machineId) {
        addCredit(machineId, 1);
        console.log("Pago aprobado. Crédito +1 para:", machineId);
      } else {
        console.log("Pago aprobado pero extRef sin machineId:", extRef);
      }
    } else {
      console.log("Pago no aprobado. Status:", pay.status);
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ===== 3) Créditos (ESP) =====
app.get("/credits", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  return res.json({ machine, credits: credits[machine] || 0 });
});

// ===== 4) Consumir (ESP) =====
app.post("/consume", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  const c = credits[machine] || 0;
  if (c <= 0) return res.status(409).json({ ok: false, credits: 0 });

  credits[machine] = c - 1;
  return res.json({ ok: true, credits: credits[machine] });
});

const port = process.env.PORT || 3000;
app.get('/health', (req, res) => {
  res.send('OK');
});

app.listen(port, () => console.log("Server on", port));
