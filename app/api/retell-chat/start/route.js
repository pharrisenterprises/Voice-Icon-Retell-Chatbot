// app/api/retell-chat/start/route.js
export async function GET(req) {
  const headers = corsHeaders(req);
  try {
    // Your backend may want to create a server-side session.
    // For now, generate a random chatId so the frontend can group messages.
    const chatId = 'chat_' + Math.random().toString(36).slice(2);
    return new Response(JSON.stringify({ ok: true, chatId }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'failed_to_start' }), { status: 500, headers });
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
