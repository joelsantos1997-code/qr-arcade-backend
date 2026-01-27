import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== CONFIG =====
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://qr-arcade-backend.onrender.com";
const MP_TOKEN = process.env.MP_ACCESS_TOKEN; // EN RENDER
const API_KEY = "Laluna123";

// ===== MEMORIA SIMPLE (MVP) =====
const machines = {}; // { arcade1: { credits: 0 } }

// ===== HELPERS =====
async function mpFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  }).then(async r => ({
    ok: r.ok,
    status: r.status,
    json: await r.json().catch(() => ({}))
  }));
}

// ===== HEALTH =====
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// ===== CREDITS =====
app.get("/credits", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  if (!machines[machine]) machines[machine] = { credits: 0 };
  res.json({ machine, credits: machines[machine].credits });
});

// ===== CONSUME =====
app.post("/consume", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  if (!machines[machine] || machines[machine].credits <= 0) {
    return res.status(400).json({ error: "no credits" });
  }

  machines[machine].credits -= 1;
  res.json({ ok: true, credits: machines[machine].credits });
});

// ===== TEST MANUAL (CMD) =====
app.post("/test/add", (req, res) => {
  const { machine, amount, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  if (!machines[machine]) machines[machine] = { credits: 0 };
  machines[machine].credits += Number(amount || 1);

  res.json({ ok: true, machine, credits: machines[machine].credits });
});

// ===== WEBHOOK MP =====
app.post("/mp/webhook", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const r = await mpFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`);
    if (!r.ok) return res.sendStatus(200);

    const p = r.json;
    if (p.status !== "approved") return res.sendStatus(200);

    const machine = p.external_reference?.split("-")[0];
    if (!machine) return res.sendStatus(200);

    if (!machines[machine]) machines[machine] = { credits: 0 };
    machines[machine].credits += 1;

    console.log("✅ Pago aprobado → crédito agregado:", machine);
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    res.sendStatus(200);
  }
});

// ===== QR FIJO (SOLUCION IPHONE) =====
app.get("/pay", async (req, res) => {
  try {
    const { machine, price } = req.query;
    if (!machine || !price) return res.status(400).send("faltan datos");

    const external_reference = `${machine}-${Date.now()}`;

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

    if (!r.ok) return res.status(500).send("MP error");

    // 🔥 REDIRECCIONA SIEMPRE A UN LINK NUEVO
    res.redirect(r.json.init_point);
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log("🚀 Server on", PORT);
});
