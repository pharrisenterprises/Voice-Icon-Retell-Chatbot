// app/api/azure-tts-token/route.js
// Issues a short-lived Azure Speech token from the server (avoids CORS).
// Accepts both naming styles so it works with your current Vercel envs.
//
// Works with either:
//   AZURE_SPEECH_KEY / AZURE_SPEECH_REGION
//   AZURE_TTS_KEY    / AZURE_TTS_REGION

export async function GET(req) {
  const headers = cors(req);

  // Accept both styles:
  const key =
    process.env.AZURE_SPEECH_KEY ||
    process.env.AZURE_TTS_KEY ||
    "";
  const region =
    process.env.AZURE_SPEECH_REGION ||
    process.env.AZURE_TTS_REGION ||
    "";

  if (!key || !region) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "missing_env",
        need: ["AZURE_SPEECH_KEY or AZURE_TTS_KEY", "AZURE_SPEECH_REGION or AZURE_TTS_REGION"],
      }),
      { status: 500, headers }
    );
  }

  // Azure STS token endpoint
  const url = `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key },
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return new Response(
        JSON.stringify({ ok: false, error: "token_fetch_failed", status: r.status, text }),
        { status: 502, headers }
      );
    }

    const token = await r.text();
    return new Response(JSON.stringify({ ok: true, token, region }), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: "exception", message: String(e?.message || e) }),
      { status: 500, headers }
    );
  }
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
