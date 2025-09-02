// app/api/retell-chat/start/route.js
export async function GET(req) {
  const headers = cors(req);
  const chatId = 'chat_' + Math.random().toString(36).slice(2);
  return new Response(JSON.stringify({ ok: true, chatId }), { status: 200, headers });
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
