// app/api/retell-chat/send/route.js
export async function POST(req) {
  const headers = cors(req);
  const { chatId, content } = await req.json().catch(() => ({}));
  if (!content) {
    return new Response(JSON.stringify({ ok: false, error: 'no_content' }), { status: 400, headers });
  }
  // Echo reply so the fallback can speak something
  const reply = `You said: ${content}`;
  return new Response(JSON.stringify({ ok: true, reply, chatId }), { status: 200, headers });
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
