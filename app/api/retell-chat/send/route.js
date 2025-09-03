// app/api/retell-chat/send/route.js
// Calls Retell *text chat* agent and returns { ok, reply }.
// Robust: tries multiple known endpoints until one succeeds.

export const dynamic = 'force-dynamic';

const API_KEY = process.env.RETELL_API_KEY;
const AGENT_ID = process.env.RETELL_CHAT_AGENT_ID;

// If you know your exact URL, set RETELL_CHAT_API_URL in Vercel and we'll use it.
// Otherwise we'll try a list of common paths automatically.
const CANDIDATE_URLS = [
  process.env.RETELL_CHAT_API_URL,                   // optional override
  'https://api.retell.ai/v1/chat/completions',
  'https://api.retellai.com/v1/chat/completions',
  'https://api.retell.ai/v2/chat/completions',
  'https://api.retellai.com/v2/chat/completions',
].filter(Boolean);

export async function POST(req) {
  const headers = cors(req);

  if (!API_KEY || !AGENT_ID) {
    return json(
      { ok: false, error: 'missing_env', details: 'RETELL_API_KEY and RETELL_CHAT_AGENT_ID must be set on the widget project.' },
      500,
      headers
    );
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { chatId, content } = body || {};
  if (!content || typeof content !== 'string') {
    return json({ ok: false, error: 'no_content' }, 400, headers);
  }

  // Common payload for Retell chat APIs.
  const payload = {
    agent_id: AGENT_ID,
    messages: [{ role: 'user', content }],
    // Some APIs accept chat_id / conversation id; harmless if ignored.
    chat_id: chatId || undefined,
    stream: false,
  };

  const lastErrors = [];
  for (const url of CANDIDATE_URLS) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20000);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch((e) => {
        throw new Error(`network_error: ${String(e?.message || e)}`);
      });
      clearTimeout(t);

      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = null; }

      if (!res.ok) {
        lastErrors.push({ url, status: res.status, body: data || text || null });
        continue; // try next candidate
      }

      // Extract a reply from common shapes:
      const reply =
        (data && (data.reply || data.message || data.output || data.text)) ??
        (data && data.choices && data.choices[0]?.message?.content) ??
        (Array.isArray(data?.messages) && data.messages.find(m => m.role === 'assistant')?.content) ??
        '';

      if (!reply) {
        lastErrors.push({ url, status: res.status, body: data || text || null, reason: 'empty_reply' });
        continue; // try next candidate
      }

      // Success 🎉
      return json({ ok: true, reply, chatId }, 200, headers);
    } catch (err) {
      lastErrors.push({ url, error: String(err?.message || err) });
      // continue to next url
    }
  }

  // No candidate worked
  return json(
    { ok: false, error: 'retell_error', tried: CANDIDATE_URLS, details: lastErrors.slice(-1)[0] || lastErrors[0] || null },
    502,
    headers
  );
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

/* ---------------- utils ---------------- */

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
