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
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
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

    return res.status(upstream.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao criar pagamento",
      detalhes: { message: error && error.message ? error.message : "Unknown error" }
    });
  }
};
