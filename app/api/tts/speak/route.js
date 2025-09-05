// app/api/tts/speak/route.js
// High-quality TTS via Azure. If env vars are missing, returns 400 so the UI falls back to Web Speech.

export const dynamic = 'force-dynamic';

const AZURE_KEY = process.env.AZURE_TTS_KEY || '';
const AZURE_REGION = process.env.AZURE_TTS_REGION || '';
const AZURE_VOICE = process.env.AZURE_TTS_VOICE || 'en-AU-WilliamNeural'; // Aussie male

export async function POST(req) {
  const headers = cors(req);
  if (!AZURE_KEY || !AZURE_REGION) {
    return new Response(JSON.stringify({ ok: false, error: 'not_configured' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const text = (body?.text || '').toString().trim();
  const voice = (body?.voice || AZURE_VOICE).toString();
  if (!text) {
    return new Response(JSON.stringify({ ok: false, error: 'no_text' }), {
      status: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  const endpoint = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = `
<speak version="1.0" xml:lang="en-AU">
  <voice xml:lang="en-AU" name="${escapeXml(voice)}">
    <prosody rate="0%" pitch="0%">${escapeXml(text)}</prosody>
  </voice>
</speak>`.trim();

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return new Response(JSON.stringify({ ok: false, error: 'azure_error', status: r.status, body: t }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const buf = await r.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'fetch_failed', details: String(e?.message || e) }), {
      status: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

function cors(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
