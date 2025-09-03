// app/api/retell-chat/send/route.js
// Proxies a user message to Retell *text chat* agent, returns { ok, reply }.
export const dynamic = 'force-dynamic';

const API_KEY = process.env.RETELL_API_KEY;
const AGENT_ID = process.env.RETELL_CHAT_AGENT_ID;

// If Retell ever changes the path, you can override with RETELL_CHAT_API_URL
const CHAT_API_URL = process.env.RETELL_CHAT_API_URL || 'https://api.retellai.com/v1/chat/completions';

export async function POST(req) {
  const headers = cors(req);

  if (!API_KEY || !AGENT_ID) {
    return json({ ok: false, error: 'missing_env', details: 'RETELL_API_KEY and/or RETELL_CHAT_AGENT_ID are not set in the widget project.' }, 500, headers);
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { chatId, content } = body || {};

  if (!content || typeof content !== 'string') {
    return json({ ok: false, error: 'no_content' }, 400, headers);
  }

  // Shape the payload for Retell chat. We keep it conservative and non-streaming.
  const payload = {
    agent_id: AGENT_ID,
    messages: [{ role: 'user', content }],
    // Many providers accept a conversation/chat id. If Retell ignores it, harmless.
    chat_id: chatId || undefined,
    stream: false,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const res = await fetch(CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch((e) => {
      // fetch threw before res exists (network/abort)
      throw new Error(`network_error: ${String(e && e.message || e)}`);
    });
    clearTimeout(timeout);

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!res.ok) {
      // Shape a helpful error
      return json({
        ok: false,
        error: 'retell_error',
        status: res.status,
        response: data || text || null,
      }, 502, headers);
    }

    // Try common fields used by chat APIs
    const reply =
      (data && (data.reply || data.message || data.output || data.text)) ??
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ??
      '';

    if (!reply) {
      return json({ ok: false, error: 'empty_reply', raw: data }, 502, headers);
    }

    return json({ ok: true, reply, chatId }, 200, headers);
  } catch (err) {
    return json({ ok: false, error: 'server_error', details: String(err && err.message || err) }, 500, headers);
  }
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...(headers || {}) } });
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
