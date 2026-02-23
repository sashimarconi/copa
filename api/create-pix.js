const crypto = require("crypto");

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeAmountToCurrency(amount) {
  const raw = toNumber(amount);
  if (raw <= 0) return 0;
  return raw >= 100 ? raw / 100 : raw;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hashIfPresent(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return sha256(normalized);
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return "";
}

async function fireTikTokPurchase({ req, payload, responseData }) {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN || "67d585120da6af7d8bb58b43acd1aff188cb20db";
  const pixelCode = process.env.TIKTOK_PIXEL_CODE || "D6DJH53C77U5LKV8P0H0";

  if (!accessToken || !pixelCode) {
    return;
  }

  const endpoint = process.env.TIKTOK_EVENTS_API_URL || "https://business-api.tiktok.com/open_api/v1.3/event/track/";
  const testEventCode = process.env.TIKTOK_TEST_EVENT_CODE;

  const customer = payload.customer || {};
  const emailHash = hashIfPresent(customer.email);
  const phoneHash = hashIfPresent(normalizePhone(customer.cellphone || customer.phone));
  const externalIdHash = hashIfPresent(customer.taxId || customer.cpf || customer.email || "");

  const value = normalizeAmountToCurrency(payload.amount);
  const txid = String(
    responseData.txid || responseData.id || responseData.order_id || responseData.orderId || Date.now()
  );

  const requestBody = {
    pixel_code: pixelCode,
    event: "Purchase",
    event_id: txid,
    timestamp: new Date().toISOString(),
    properties: {
      value,
      currency: "BRL",
      content_type: "product",
      content_name: payload.description || "Pagamento PIX",
      payment_method: "pix"
    },
    context: {
      ad: {
        callback: payload.ttclid || ""
      },
      page: {
        url: payload.tracking && payload.tracking.src ? payload.tracking.src : ""
      },
      ip: getClientIp(req),
      user_agent: payload.user_agent || req.headers["user-agent"] || "",
      user: {
        email: emailHash,
        phone_number: phoneHash,
        external_id: externalIdHash
      }
    }
  };

  if (testEventCode) {
    requestBody.test_event_code = testEventCode;
  }

  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Access-Token": accessToken
    },
    body: JSON.stringify(requestBody)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SEALPAY_API_KEY;
  const upstreamUrl = process.env.SEALPAY_UPSTREAM_URL || "https://abacate-5eo1.onrender.com/create-pix3";

  if (!apiKey) {
    return res.status(500).json({
      error: "SEALPAY_API_KEY nao configurada"
    });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const upstreamPayload = {
      ...payload,
      api_key: apiKey
    };

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamPayload)
    });

    const text = await upstream.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { error: "Resposta invalida do gateway" };
    }

    if (upstream.ok) {
      try {
        await fireTikTokPurchase({ req, payload, responseData: data });
      } catch (_) {
        // Nao bloqueia a criacao do PIX se o tracking do TikTok falhar.
      }
    }

    return res.status(upstream.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao criar pagamento",
      detalhes: { message: error && error.message ? error.message : "Unknown error" }
    });
  }
};
