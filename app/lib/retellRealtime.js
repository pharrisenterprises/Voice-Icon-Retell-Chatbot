// app/lib/retellRealtime.js
// -----------------------------------------------------------
// Azure Neural TTS version – keeps all mic animations,
// amplitude visualization, and UI status logic identical.
// Only replaces browser speechSynthesis with Azure TTS.
// -----------------------------------------------------------

export default function createRetellRealtime() {
  const USE_REALTIME = false;
  if (USE_REALTIME) return createRealtimeStub();
  return createWebSpeechWithAzureTTS();
}

/* -------------------- 2) Web Speech + Azure TTS Hybrid -------------------- */

function createWebSpeechWithAzureTTS() {
  const SR =
    typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasASR = !!SR;

  let rec = null;
  let recActive = false;
  let mediaStream = null;
  let audioCtx = null;
  let analyser = null;
  let micSource = null;
  let ampRAF = null;
  let speakingTimer = null;

  let onAgentText = () => {};
  let onAudioBuffer = () => {};
  let onStatus = () => {};
  let onUserText = () => {};
  let getChatId = () => null;
  let getMuted = () => false;

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
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
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
    } catch {}
  }

  // -------------- 🔊 Azure Neural TTS Integration -----------------
  async function speakText(text) {
    if (!text || getMuted()) return;
    setStatus('speaking');

    // Cancel any previous playback
    clearInterval(speakingTimer);

    try {
      // Fetch neural speech from Azure via our API route
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Azure TTS failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      // Animate bars during playback
      if (!recActive) {
        speakingTimer = setInterval(() => {
          const amp = 0.2 + Math.random() * 0.6;
          try { onAudioBuffer(amp); } catch {}
        }, 90);
      }

      audio.onended = () => {
        clearInterval(speakingTimer);
        speakingTimer = null;
        try { onAudioBuffer(0); } catch {}
        setStatus(recActive ? 'ready' : 'idle');
      };

      await audio.play();
    } catch (e) {
      console.error('Azure TTS playback failed:', e);
      clearInterval(speakingTimer);
      speakingTimer = null;
      setStatus('error');
    }
  }

  // ---------------------------------------------------------------

  async function startMic(stream) {
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
            if (res.isFinal) finalText += res[0].transcript;
            else partial = res[0].transcript;
          }
          if (finalText.trim()) {
            try { onUserText(finalText.trim()); } catch {}
            partial = '';
          }
        };
        rec.onerror = () => {};
        rec.onend = () => {
          if (recActive) {
            try { rec.start(); } catch {}
          }
        };

        try { rec.start(); } catch {}
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
      if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
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
    ensureAudioCtx();
    setStatus('idle');
    return true;
  }

  async function disconnect() {
    try { await stopMic(); } catch {}
    setStatus('idle');
  }

  async function sendText(_text) {
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

/* -------------------- 1) Retell Realtime Stub (for later use) -------------------- */
function createRealtimeStub() {
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
