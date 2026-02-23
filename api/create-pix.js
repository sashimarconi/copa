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

function normalizeTaxId(value) {
  if (!value) return "";
  return String(value).replace(/\D/g, "");
}

function normalizeEmail(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase();
}

const RATE_LIMIT = {
  ipWindowMs: 10 * 60 * 1000,
  ipMaxRequests: 8,
  ipMinIntervalMs: 8 * 1000,
  ipBlockMs: 30 * 60 * 1000,
  fingerprintWindowMs: 30 * 60 * 1000,
  fingerprintMaxRequests: 3
};

function getLimiterStore() {
  if (!globalThis.__pixRateLimitStore) {
    globalThis.__pixRateLimitStore = {
      ip: new Map(),
      fingerprint: new Map()
    };
  }

  return globalThis.__pixRateLimitStore;
}

function compactTimestamps(timestamps, now, windowMs) {
  const minTime = now - windowMs;
  return timestamps.filter((ts) => ts >= minTime);
}

function buildFingerprint(payload) {
  const customer = payload && payload.customer ? payload.customer : {};
  const email = normalizeEmail(customer.email);
  const taxId = normalizeTaxId(customer.taxId || customer.cpf);
  const phone = normalizePhone(customer.cellphone || customer.phone);
  const amount = String(Math.round(toNumber(payload && payload.amount) || 0));

  const base = [email, taxId, phone, amount].join("|");
  if (!email && !taxId && !phone) return "";
  return sha256(base);
}

function enforceRateLimit(req, payload) {
  const now = Date.now();
  const store = getLimiterStore();
  const ip = getClientIp(req) || "unknown";

  const ipState = store.ip.get(ip) || { timestamps: [], lastRequestAt: 0, blockedUntil: 0 };

  if (ipState.blockedUntil > now) {
    const retryAfter = Math.ceil((ipState.blockedUntil - now) / 1000);
    return { blocked: true, code: "ip_blocked", retryAfter };
  }

  if (ipState.lastRequestAt && now - ipState.lastRequestAt < RATE_LIMIT.ipMinIntervalMs) {
    const retryAfter = Math.ceil((RATE_LIMIT.ipMinIntervalMs - (now - ipState.lastRequestAt)) / 1000);
    return { blocked: true, code: "ip_too_fast", retryAfter };
  }

  ipState.timestamps = compactTimestamps(ipState.timestamps, now, RATE_LIMIT.ipWindowMs);
  ipState.timestamps.push(now);
  ipState.lastRequestAt = now;

  if (ipState.timestamps.length > RATE_LIMIT.ipMaxRequests) {
    ipState.blockedUntil = now + RATE_LIMIT.ipBlockMs;
    store.ip.set(ip, ipState);
    const retryAfter = Math.ceil(RATE_LIMIT.ipBlockMs / 1000);
    return { blocked: true, code: "ip_rate_exceeded", retryAfter };
  }

  store.ip.set(ip, ipState);

  const fingerprint = buildFingerprint(payload);
  if (fingerprint) {
    const fpState = store.fingerprint.get(fingerprint) || { timestamps: [] };
    fpState.timestamps = compactTimestamps(fpState.timestamps, now, RATE_LIMIT.fingerprintWindowMs);
    fpState.timestamps.push(now);

    if (fpState.timestamps.length > RATE_LIMIT.fingerprintMaxRequests) {
      store.fingerprint.set(fingerprint, fpState);
      const retryAfter = Math.ceil(RATE_LIMIT.fingerprintWindowMs / 1000);
      return { blocked: true, code: "fingerprint_rate_exceeded", retryAfter };
    }

    store.fingerprint.set(fingerprint, fpState);
  }

  return { blocked: false };
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
  const testEventCode = process.env.TIKTOK_TEST_EVENT_CODE || "TEST49607";

  const customer = payload.customer || {};
  const emailHash = hashIfPresent(customer.email);
  const phoneHash = hashIfPresent(normalizePhone(customer.cellphone || customer.phone));
  const externalIdHash = hashIfPresent(customer.taxId || customer.cpf || customer.email || "");

  const value = normalizeAmountToCurrency(payload.amount);
  const txid = String(
    responseData.txid || responseData.id || responseData.order_id || responseData.orderId || Date.now()
  );

  const requestBody = {
    event_source: "web",
    event_source_id: pixelCode,
    data: [
      {
        event: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: txid,
        user: {
          email: emailHash,
          phone_number: phoneHash,
          external_id: externalIdHash,
          ttclid: payload.ttclid || undefined,
          ip: getClientIp(req) || undefined,
          user_agent: payload.user_agent || req.headers["user-agent"] || undefined
        },
        page: {
          url: payload.tracking && payload.tracking.src ? payload.tracking.src : undefined
        },
        properties: {
          value,
          currency: "BRL",
          content_type: "product",
          content_name: payload.description || "Pagamento PIX",
          payment_method: "pix"
        }
      }
    ]
  };

  if (testEventCode) {
    requestBody.test_event_code = testEventCode;
  }

  const tiktokResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Access-Token": accessToken
    },
    body: JSON.stringify(requestBody)
  });

  const tiktokText = await tiktokResponse.text();
  let tiktokJson = {};

  try {
    tiktokJson = tiktokText ? JSON.parse(tiktokText) : {};
  } catch (_) {
    tiktokJson = { raw: tiktokText };
  }

  if (!tiktokResponse.ok || tiktokJson.code !== 0) {
    throw new Error(
      "TikTok Events API falhou: " +
        JSON.stringify({
          http_status: tiktokResponse.status,
          response: tiktokJson
        })
    );
  }
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
    const rateLimitCheck = enforceRateLimit(req, payload);

    if (rateLimitCheck.blocked) {
      if (rateLimitCheck.retryAfter) {
        res.setHeader("Retry-After", String(rateLimitCheck.retryAfter));
      }

      return res.status(429).json({
        error: "Muitas tentativas. Aguarde e tente novamente.",
        code: rateLimitCheck.code
      });
    }

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
      } catch (trackingError) {
        console.error("[tiktok] erro ao enviar Purchase", trackingError && trackingError.message ? trackingError.message : trackingError);
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
