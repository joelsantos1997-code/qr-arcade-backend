import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

// ===== CONFIG =====
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // APP_USR-...
const BASE_URL = process.env.BASE_URL;               // https://qr-arcade-backend.onrender.com
const API_KEY = process.env.API_KEY;                 // tu clave para ESP

if (!MP_ACCESS_TOKEN || !BASE_URL || !API_KEY) {
  console.error("Faltan env vars: MP_ACCESS_TOKEN, BASE_URL, API_KEY");
  process.exit(1);
}

// ===== DB SIMPLE (MVP en memoria) =====
const credits = Object.create(null); // { machineId: number }
function addCredit(machineId, amount = 1) {
  credits[machineId] = (credits[machineId] || 0) + amount;
}

// Para evitar doble crédito por el mismo pago
const processedPayments = new Set(); // paymentId ya procesado

// Para evitar spamear a MP (rate limit simple)
const lastPollAt = Object.create(null); // { machineId: timestamp }

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
app.get("/health", (_, res) => res.send("OK"));

// ===== 1) Crear link de pago (preferencia) =====
app.post("/create_preference", async (req, res) => {
  try {
    const { machineId, price } = req.body;
    if (!machineId || !price) {
      return res.status(400).json({ error: "machineId y price requeridos" });
    }

    // Importante: que el external_reference SIEMPRE empiece por machineId-
    const external_reference = `${machineId}-${Date.now()}`;

    const body = {
      items: [{ title: "Credito Arcade", quantity: 1, unit_price: Number(price) }],
      external_reference,
      notification_url: `${BASE_URL}/mp/webhook` // queda listo para cuando MP habilite
    };

    const r = await mpFetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      console.error("MP create preference failed:", r.status, r.text);
      return res.status(500).json({
        ok: false,
        error: "Mercado Pago no creó la preferencia",
        detail: r.json || r.text
      });
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

// ===== 2) Webhook MP (lo dejamos, pero Plan A no depende de esto) =====
app.post("/mp/webhook", async (req, res) => {
  // Respondemos rápido
  res.sendStatus(200);

  try {
    const paymentId =
      req.query?.id ||
      req.body?.data?.id ||
      req.body?.id;

    console.log("🔔 /mp/webhook recibido. paymentId =", paymentId, "body=", JSON.stringify(req.body));

    if (!paymentId) return;
    if (processedPayments.has(String(paymentId))) return;

    const r = await mpFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });
    if (!r.ok) {
      console.error("MP get payment failed:", r.status, r.text);
      return;
    }

    const pay = r.json;
    if (pay.status === "approved") {
      const extRef = pay.external_reference || "";
      const machineId = extRef.split("-")[0];
      if (machineId) {
        processedPayments.add(String(paymentId));
        addCredit(machineId, 1);
        console.log("✅ Webhook: Pago aprobado. Crédito +1 para:", machineId, "paymentId:", paymentId);
      }
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ===== 3) PLAN A: Polling (buscar pagos aprobados) =====
// Llamada: GET /mp/poll?machine=arcade1&key=TU_API_KEY
// - Busca pagos aprobados recientes
// - Filtra los que tengan external_reference que empiece con "machine-"
// - Si el paymentId no fue procesado, suma crédito y lo marca
app.get("/mp/poll", async (req, res) => {
  try {
    const { machine, key } = req.query;
    if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
    if (!machine) return res.status(400).json({ error: "machine requerido" });

    // rate-limit por máquina (mínimo 2s)
    const now = Date.now();
    const last = lastPollAt[machine] || 0;
    if (now - last < 2000) {
      return res.json({ ok: true, machine, added: 0, note: "rate_limited" });
    }
    lastPollAt[machine] = now;

    // Traemos pagos aprobados recientes (últimos 20)
    const url =
      "https://api.mercadopago.com/v1/payments/search" +
      "?sort=date_created&criteria=desc&limit=20&status=approved";

    const r = await mpFetch(url, { method: "GET" });
    if (!r.ok) {
      console.error("MP search failed:", r.status, r.text);
      return res.status(502).json({ ok: false, error: "mp_search_failed", detail: r.json || r.text });
    }

    const results = r.json?.results || [];
    let added = 0;

    for (const pay of results) {
      const paymentId = String(pay.id || "");
      const extRef = String(pay.external_reference || "");

      // Solo pagos que sean de esta máquina
      if (!extRef.startsWith(`${machine}-`)) continue;

      // Anti-doble: si ya lo procesamos, lo ignoramos
      if (processedPayments.has(paymentId)) continue;

      processedPayments.add(paymentId);
      addCredit(machine, 1);
      added++;
      console.log("✅ Poll: Pago aprobado detectado. +1 crédito para", machine, "| paymentId:", paymentId, "| extRef:", extRef);
    }

    return res.json({ ok: true, machine, added, credits: credits[machine] || 0 });
  } catch (e) {
    console.error("mp/poll error:", e);
    return res.status(500).json({ ok: false, error: "poll_failed" });
  }
});

// ===== 4) Créditos (ESP) =====
app.get("/credits", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  return res.json({ machine, credits: credits[machine] || 0 });
});

// ===== 5) Consumir (ESP) =====
app.post("/consume", (req, res) => {
  const { machine, key } = req.query;
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });

  const c = credits[machine] || 0;
  if (c <= 0) return res.status(409).json({ ok: false, credits: 0 });

  credits[machine] = c - 1;
  return res.json({ ok: true, credits: credits[machine] });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on", port));
