// app/api/retell-chat/start/route.js
// Creates a real Retell chat session and returns its chat_id.
// Uses new endpoints: POST /create-chat  (v1 is deprecated)

export const dynamic = 'force-dynamic';

const API_KEY = process.env.RETELL_API_KEY;
const AGENT_ID = process.env.RETELL_CHAT_AGENT_ID;
// Optional override if Retell gives you a specific base URL.
const BASE = (process.env.RETELL_BASE_URL || '').replace(/\/+$/, '');
const CANDIDATE_BASES = [BASE, 'https://api.retell.ai', 'https://api.retellai.com'].filter(Boolean);

export async function GET(req) {
  const headers = cors(req);

  if (!API_KEY || !AGENT_ID) {
    return json(
      { ok: false, error: 'missing_env', details: 'RETELL_API_KEY and RETELL_CHAT_AGENT_ID must be set.' },
      500,
      headers
    );
  }

  const payload = { agent_id: AGENT_ID };
  const last = [];

  for (const b of CANDIDATE_BASES) {
    try {
      const res = await fetch(`${b}/create-chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch {}

      if (!res.ok) {
        last.push({ base: b, status: res.status, body: data || text || null });
        continue;
      }

      const chatId = data?.chat_id;
      if (!chatId) {
        last.push({ base: b, status: res.status, body: data || text || null, reason: 'no_chat_id' });
        continue;
      }

      return json({ ok: true, chatId }, 200, headers);
    } catch (e) {
      last.push({ base: b, error: String(e?.message || e) });
    }
  }

  return json({ ok: false, error: 'retell_error', tried: CANDIDATE_BASES, details: last.slice(-1)[0] || null }, 502, headers);
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

/* -------- utils -------- */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
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
