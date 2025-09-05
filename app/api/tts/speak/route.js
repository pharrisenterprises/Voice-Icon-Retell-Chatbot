// app/api/tts/speak/route.js
// Azure Neural TTS with lively defaults + CORS.
// If keys are missing, returns 400 so the UI falls back to Web Speech.

export const dynamic = 'force-dynamic';

const AZURE_KEY = process.env.AZURE_TTS_KEY || '';
const AZURE_REGION = process.env.AZURE_TTS_REGION || '';
const VOICE = process.env.AZURE_TTS_VOICE || 'en-AU-WilliamNeural';

// Optional tunables (strings Azure accepts: e.g. "+15%", "-5%")
const RATE  = process.env.AZURE_TTS_RATE  || '+12%';  // faster = more energetic
const PITCH = process.env.AZURE_TTS_PITCH || '+4%';   // slight lift
const STYLE = process.env.AZURE_TTS_STYLE || 'cheerful'; // ignored by voices that don't support it
const STYLE_DEGREE = process.env.AZURE_TTS_STYLE_DEGREE || '1.0'; // 0–2 range typically

export async function POST(req) {
  const headers = cors(req);

  if (!AZURE_KEY || !AZURE_REGION) {
    return json({ ok: false, error: 'not_configured' }, 400, headers);
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const text = (body?.text || '').toString().trim();
  const voice = (body?.voice || VOICE).toString();

  if (!text) return json({ ok: false, error: 'no_text' }, 400, headers);

  const endpoint = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  // SSML with lively defaults; <mstts:express-as> is ignored if the voice doesn't support it.
  const ssml = `
<speak version="1.0" xml:lang="en-AU" xmlns:mstts="https://www.w3.org/2001/mstts">
  <voice xml:lang="en-AU" name="${xml(voice)}">
    <mstts:express-as style="${xml(STYLE)}" styledegree="${xml(STYLE_DEGREE)}">
      <prosody rate="${xml(RATE)}" pitch="${xml(PITCH)}">${xml(text)}</prosody>
    </mstts:express-as>
  </voice>
</speak>`.trim();

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        // 24kHz mono MP3 is a good balance of size/quality
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return json({ ok: false, error: 'azure_error', status: r.status, body: t }, 502, headers);
    }

    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return json({ ok: false, error: 'fetch_failed', details: String(e?.message || e) }, 500, headers);
  }
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

/* ---------------- utils ---------------- */
function cors(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(headers || {}), 'Content-Type': 'application/json' },
  });
}
function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
