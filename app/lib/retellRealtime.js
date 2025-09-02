// app/lib/retellRealtime.js
//
// Minimal voice helper with two modes:
// 1) Realtime (stubbed entry points for Retell streaming)  → TODO when you enable Retell Realtime
// 2) Fallback (ships now): Web Speech ASR + speechSynthesis TTS
//
// Public API the page expects:
//   const rt = createRetellRealtime();
//   await rt.connect({ onAgentText, onAudioBuffer, onStatus, onUserText, getChatId, getMuted });
//   await rt.startMic();  await rt.stopMic();
//   await rt.speakText(text);
//   await rt.sendText(text);   // (no-op here; page posts to /api/* itself)
//   rt.disconnect();

export default function createRetellRealtime() {
  // If you later wire Retell Realtime WS/WebRTC, flip this to true and fill in the TODOs.
  const USE_REALTIME = false;

  if (USE_REALTIME) return createRealtimeStub();
  return createWebSpeechFallback();
}

/* -------------------- 2) BROWSER FALLBACK: Web Speech -------------------- */

function createWebSpeechFallback() {
  // Feature detect
  const SR =
    typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasASR = !!SR;
  const hasTTS =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Internal state
  let rec = null;
  let recActive = false;
  let mediaStream = null;
  let audioCtx = null;
  let analyser = null;
  let micSource = null;
  let ampRAF = null;
  let speakingTimer = null;

  // Callbacks from the page
  let onAgentText = () => {};
  let onAudioBuffer = () => {};
  let onStatus = () => {};
  let onUserText = () => {};
  let getChatId = () => null;
  let getMuted = () => false;

  // Small helpers
  function setStatus(s) {
    try { onStatus(s); } catch {}
  }

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = Ctx ? new Ctx() : null;
      return audioCtx;
    } catch {
      return null;
    }
  }

  function startAmpLoop() {
    stopAmpLoop();
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      // Compute a rough amplitude 0..1
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length); // ~0..1
      try { onAudioBuffer(Math.min(1, rms * 3)); } catch {}
      ampRAF = requestAnimationFrame(loop);
    };
    ampRAF = requestAnimationFrame(loop);
  }
  function stopAmpLoop() {
    if (ampRAF) cancelAnimationFrame(ampRAF);
    ampRAF = null;
  }

  async function initMicAnalyser(stream) {
    const ctx = ensureAudioCtx();
    if (!ctx || !stream) return;
    try {
      micSource = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      micSource.connect(analyser);
      startAmpLoop();
    } catch {
      // Non-fatal; visualizer just won’t move
    }
  }

  // TTS with a little “unlock” dance for iOS/Autoplay
  function maybeUnlockTTS() {
    try {
      if (!hasTTS) return;
      // iOS can pause the engine; resume on user gesture or first call
      if (typeof window.speechSynthesis.resume === 'function') {
        window.speechSynthesis.resume();
      }
      // Send a silent utterance once to wake it
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {}
  }

  async function speakText(text) {
    if (!hasTTS) return;
    if (!text || getMuted()) return;
    setStatus('speaking');
    maybeUnlockTTS();

    try {
      // Cancel anything queued
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }
    } catch {}

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      // Tune voice feel here if you like:
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = getMuted() ? 0 : 1;

      // Animate the bars while speaking (if no mic analyser is active)
      clearInterval(speakingTimer);
      if (!recActive) {
        speakingTimer = setInterval(() => {
          // synthetic amplitude ~0.2..0.8 to make bars move
          const amp = 0.2 + Math.random() * 0.6;
          try { onAudioBuffer(amp); } catch {}
        }, 90);
      }

      u.onend = () => {
        clearInterval(speakingTimer);
        speakingTimer = null;
        setStatus(recActive ? 'ready' : 'idle');
        resolve();
      };
      u.onerror = () => {
        clearInterval(speakingTimer);
        speakingTimer = null;
        setStatus(recActive ? 'ready' : 'idle');
        resolve();
      };

      try {
        window.speechSynthesis.speak(u);
      } catch {
        // Fail silently; we still resolve to keep UI snappy
        clearInterval(speakingTimer);
        speakingTimer = null;
        setStatus(recActive ? 'ready' : 'idle');
        resolve();
      }
    });
  }

  async function startMic(stream) {
    // Called by page when user toggles Mic ON
    try {
      setStatus('connecting');
      const userStream =
        stream ||
        (await navigator.mediaDevices.getUserMedia({ audio: true }));
      mediaStream = userStream;
      await initMicAnalyser(userStream);

      if (hasASR) {
        rec = new SR();
        rec.lang = 'en-US';
        rec.continuous = true;
        rec.interimResults = true;

        let partial = '';
        rec.onresult = (e) => {
          let finalText = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) {
              finalText += res[0].transcript;
            } else {
              partial = res[0].transcript;
            }
          }
          // We show partial ASR as "assistant_stream" in the page, but
          // since it's user speech, we don't add to chat until final.
          if (finalText.trim()) {
            try { onUserText(finalText.trim()); } catch {}
            partial = '';
          }
        };
        rec.onerror = () => { /* ignore; Safari fires harmless errors */ };
        rec.onend = () => {
          // When mic is toggled off or browser halts recognition
          if (recActive) {
            // Try to keep it going unless user turned it off
            try { rec.start(); } catch {}
          }
        };

        try { rec.start(); } catch { /* some browsers need a delay */ }
      }

      recActive = true;
      setStatus('ready');
      return true;
    } catch (e) {
      recActive = false;
      setStatus('error');
      throw e;
    }
  }

  async function stopMic() {
    recActive = false;
    try { rec && rec.stop && rec.stop(); } catch {}
    rec = null;

    stopAmpLoop();
    try {
      if (micSource) micSource.disconnect();
      micSource = null;
      analyser = null;
    } catch {}

    try {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
      }
    } catch {}
    mediaStream = null;

    setStatus('idle');
  }

  async function connect(opts) {
    onAgentText = opts?.onAgentText || onAgentText;
    onAudioBuffer = opts?.onAudioBuffer || onAudioBuffer;
    onStatus = opts?.onStatus || onStatus;
    onUserText = opts?.onUserText || onUserText;
    getChatId = opts?.getChatId || getChatId;
    getMuted = opts?.getMuted || getMuted;

    // Prime audio so the page can decide to show "Enable audio"
    ensureAudioCtx();
    setStatus('idle');

    // Load TTS voices early (best-effort)
    if (hasTTS) {
      try {
        // iOS sometimes needs a resume after a user gesture; page handles overlay too
        window.speechSynthesis.onvoiceschanged = () => {};
      } catch {}
    }

    return true;
  }

  async function disconnect() {
    try { await stopMic(); } catch {}
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch {}
    setStatus('idle');
  }

  async function sendText(_text) {
    // The page already POSTs to /api/retell-chat/send and then calls speakText(reply).
    // We keep this method for parity with realtime mode.
    return true;
  }

  return {
    connect,
    startMic,
    stopMic,
    speakText,
    sendText,
    disconnect,
  };
}

/* -------------------- 1) RETELL REALTIME (stub to fill later) -------------------- */

function createRealtimeStub() {
  // This is a placeholder for when you enable Retell Realtime Streaming.
  // You would:
  //  - open a WS/WebRTC to Retell with your API key (server-signed token)
  //  - send mic PCM frames
  //  - receive audio frames and play via WebAudio
  //  - stream partial transcripts via onAgentText(partial, false) and final via onAgentText(final, true)

  let onAgentText = () => {};
  let onAudioBuffer = () => {};
  let onStatus = () => {};
  let onUserText = () => {};
  let getChatId = () => null;
  let getMuted = () => false;

  async function connect(opts) {
    onAgentText = opts?.onAgentText || onAgentText;
    onAudioBuffer = opts?.onAudioBuffer || onAudioBuffer;
    onStatus = opts?.onStatus || onStatus;
    onUserText = opts?.onUserText || onUserText;
    getChatId = opts?.getChatId || getChatId;
    getMuted = opts?.getMuted || getMuted;
    onStatus('idle');
    return true;
  }
  async function startMic() { onStatus('ready'); }
  async function stopMic() { onStatus('idle'); }
  async function speakText() {}
  async function sendText() { return true; }
  async function disconnect() { onStatus('idle'); }

  return { connect, startMic, stopMic, speakText, sendText, disconnect };
}
