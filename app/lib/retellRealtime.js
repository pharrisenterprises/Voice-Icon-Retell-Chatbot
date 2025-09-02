/* app/lib/retellRealtime.js
 *
 * Abstraction for Retell realtime voice sessions with a robust Web Speech fallback.
 *
 * Exports default factory: createRetellRealtime()
 * Returns an object with methods:
 *   - connect({ apiKey?, agentId?, onAgentText, onAudioBuffer, onStatus, onUserText?, getChatId, getMuted })
 *   - startMic()
 *   - stopMic()
 *   - sendText(text)           // (optional passthrough for realtime)
 *   - speakText(text)          // always available; honors getMuted()
 *   - disconnect()
 *
 * Modes:
 *  1) Realtime (preferred): Wire up Retell's WS/WebRTC here (TODO blocks clearly marked).
 *  2) Fallback (ships now): webkitSpeechRecognition ASR + speechSynthesis TTS.
 *
 * The fallback will:
 *   - convert user speech to text (final results only) and call options.onUserText(finalText)
 *   - speak assistant replies via TTS and call options.onAudioBuffer(amplitude) to drive the visualizer
 */

export default function createRetellRealtime() {
  // Detect Web Speech (ASR) availability
  const SpeechRecognition = (typeof window !== 'undefined') &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  const supportsTTS = (typeof window !== 'undefined') && 'speechSynthesis' in window;

  // Shared state
  let opts = null;
  let mode = 'fallback'; // 'realtime' | 'fallback'
  let speakingInterval = null;
  let recognizer = null;
  let micActive = false;
  let destroyed = false;

  // Simple amplitude driver while speaking (visualizer)
  function startSpeakingViz() {
    stopSpeakingViz();
    speakingInterval = setInterval(() => {
      // Push a faux amplitude; in a true realtime path, compute from audio buffer
      if (opts && typeof opts.onAudioBuffer === 'function') {
        const amp = 0.35 + Math.random() * 0.5;
        opts.onAudioBuffer(amp);
      }
    }, 80);
  }
  function stopSpeakingViz() {
    if (speakingInterval) clearInterval(speakingInterval);
    speakingInterval = null;
    if (opts && typeof opts.onAudioBuffer === 'function') {
      opts.onAudioBuffer(0);
    }
  }

  async function speakText(text) {
    if (!supportsTTS) return;
    if (!text) return;
    const muted = opts?.getMuted?.() === true;
    if (muted) return;
    try {
      if (opts && typeof opts.onStatus === 'function') opts.onStatus('speaking');
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1;
      utter.pitch = 1;
      utter.volume = 1.0;
      utter.onstart = () => startSpeakingViz();
      utter.onend = () => {
        stopSpeakingViz();
        if (opts && typeof opts.onStatus === 'function') opts.onStatus(micActive ? 'ready' : 'idle');
      };
      utter.onerror = () => {
        stopSpeakingViz();
        if (opts && typeof opts.onStatus === 'function') opts.onStatus(micActive ? 'ready' : 'idle');
      };
      window.speechSynthesis.speak(utter);
    } catch (e) {
      stopSpeakingViz();
    }
  }

  // Fallback ASR (final results only to avoid chat spam)
  function setupRecognizer() {
    if (!SpeechRecognition) return null;
    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = false;
    r.lang = 'en-US';
    r.maxAlternatives = 1;

    r.onstart = () => {
      if (opts && typeof opts.onStatus === 'function') opts.onStatus('ready');
    };
    r.onresult = async (ev) => {
      if (destroyed) return;
      const last = ev.results[ev.results.length - 1];
      if (!last || !last.isFinal) return;
      const transcript = String(last[0].transcript || '').trim();
      if (!transcript) return;
      if (typeof opts.onUserText === 'function') {
        // UI will POST to /api/retell-chat/send and then call speakText(reply)
        opts.onUserText(transcript);
      }
    };
    r.onerror = (ev) => {
      // Most common: "no-speech" / "audio-capture" / "not-allowed"
      if (opts && typeof opts.onStatus === 'function') opts.onStatus('error');
    };
    r.onend = () => {
      if (destroyed) return;
      if (micActive) {
        // Try to auto-restart to avoid idling under 2 minutes
        try { r.start(); } catch (e) {}
      } else {
        if (opts && typeof opts.onStatus === 'function') opts.onStatus('idle');
      }
    };
    return r;
  }

  async function connect(options) {
    opts = options || {};
    if (destroyed) destroyed = false;

    // ---- Realtime preferred path (TODO: insert Retell WS/WebRTC here) ----
    // If you are ready to wire Retell realtime:
    // 1) Acquire a signed client token from your server if required (not included here).
    // 2) Open a WebSocket / WebRTC to Retell with the agentId.
    // 3) On agent partial text, call opts.onAgentText(text, false)
    // 4) On agent final text,   call opts.onAgentText(text, true)
    // 5) For audio frames, push to WebAudio and compute RMS to call opts.onAudioBuffer(0..1)
    //
    // if (retellRealtimeIsAvailable) { mode = 'realtime'; ... } else { mode = 'fallback'; }

    mode = 'fallback';
    if (opts && typeof opts.onStatus === 'function') opts.onStatus('connecting');

    // Prepare fallback recognizer
    if (SpeechRecognition) recognizer = setupRecognizer();
    // Ready to roll
    if (opts && typeof opts.onStatus === 'function') {
      opts.onStatus('ready');
    }
  }

  async function startMic() {
    micActive = true;
    // Realtime path: getUserMedia + stream to Retell
    if (mode === 'realtime') {
      // TODO: Implement getUserMedia and stream PCM/Opus to Retell session.
      // Keep UI stable if session drops: reconnect silently here.
      return;
    }
    // Fallback path: start SpeechRecognition
    if (!recognizer) {
      recognizer = setupRecognizer();
      if (!recognizer) throw new Error('SpeechRecognition unavailable');
    }
    try {
      recognizer.start();
    } catch (e) {
      // Usually "not-allowed" or "already started"
      if (String(e && e.message || '').includes('starting')) {
        // swallow
      } else {
        throw e;
      }
    }
  }

  async function stopMic() {
    micActive = false;
    if (mode === 'realtime') {
      // TODO: stop sending mic to Retell
      if (opts && typeof opts.onStatus === 'function') opts.onStatus('idle');
      return;
    }
    try { recognizer && recognizer.stop && recognizer.stop(); } catch (e) {}
    if (opts && typeof opts.onStatus === 'function') opts.onStatus('idle');
  }

  async function sendText(text) {
    // Realtime path could pass text directly to the session
    if (mode === 'realtime') {
      // TODO: session.sendText(text);
    }
    // In fallback, UI posts to /api/retell-chat/send, then calls speakText(reply).
  }

  async function disconnect() {
    destroyed = true;
    stopSpeakingViz();
    try { await stopMic(); } catch (e) {}
    // TODO: close Retell WS/WebRTC
  }

  return {
    connect,
    startMic,
    stopMic,
    sendText,
    speakText,
    disconnect,
  };
}
