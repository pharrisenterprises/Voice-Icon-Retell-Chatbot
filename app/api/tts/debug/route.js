// app/api/tts/debug/route.js
// Safe: returns NON-SECRET Azure TTS config so we can verify the server is reading env vars.

export const dynamic = 'force-dynamic';

export async function GET() {
  const out = {
    ok: true,
    voice: process.env.AZURE_TTS_VOICE || '(unset)',
    region: process.env.AZURE_TTS_REGION || '(unset)',
    rate: process.env.AZURE_TTS_RATE || '(unset)',
    pitch: process.env.AZURE_TTS_PITCH || '(unset)',
    style: process.env.AZURE_TTS_STYLE || '(unset)',
    styleDegree: process.env.AZURE_TTS_STYLE_DEGREE || '(unset)',
    // IMPORTANT: we do NOT return the key
    hasKey: !!process.env.AZURE_TTS_KEY, // just true/false
  };

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
