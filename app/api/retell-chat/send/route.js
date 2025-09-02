// app/api/retell-chat/send/route.js
export async function POST(req) {
  const headers = corsHeaders(req);
  try {
    const { chatId, content } = await req.json();

    if (!content || typeof content !== 'string') {
      return new Response(JSON.stringify({ ok: false, error: 'no_content' }), { status: 400, headers });
    }

    // 👉 Replace this with your real Retell text API call if desired.
    // For now, echo back a simple reply so the voice fallback speaks something.
    const reply = `You said: ${content}`;

    return new Response(JSON.stringify({ ok: true, reply, chatId }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'send_failed' }), { status: 500, headers });
  }
}

export function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
