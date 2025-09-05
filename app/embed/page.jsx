'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/* =========================================================
   Neon visualizer (for OUTPUT audio only — never mic input)
   ========================================================= */
function Visualizer({ analyser }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const BARS = 42;
    let raf = 0;
    const buf = new Uint8Array(1024);

    function paintBar(x, y, w, h, glow) {
      const grad = ctx.createLinearGradient(0, y - h, 0, y);
      grad.addColorStop(0, '#7DD3FC');  // sky-300
      grad.addColorStop(1, '#60A5FA');  // blue-400
      ctx.fillStyle = grad;
      ctx.shadowColor = '#60A5FA';
      ctx.shadowBlur = 14 * glow;
      ctx.fillRect(x, y - h, w, h);
      ctx.shadowBlur = 0;
    }

    function drawIdle() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.width / BARS;
      for (let i = 0; i < BARS; i++) {
        const h = 6 + 4 * Math.sin((Date.now() / 320) + i * 0.55);
        paintBar(i * w + w * 0.25, canvas.height, w * 0.5, h, 0.35);
      }
    }

    function loop() {
      raf = requestAnimationFrame(loop);
      if (!analyser) return drawIdle();

      analyser.getByteFrequencyData(buf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const step = Math.max(1, Math.floor(analyser.frequencyBinCount / BARS));
      const w = canvas.width / BARS;

      for (let i = 0; i < BARS; i++) {
        const v = buf[i * step] / 255;
        const h = Math.max(6, v * canvas.height * 0.9);
        paintBar(i * w + w * 0.25, canvas.height, w * 0.5, h, 0.7 + v * 0.7);
      }
    }

    loop();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <canvas
      ref={canvasRef}
      width={1400}
      height={260}
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    />
  );
}

/* =========================================================
   Embed Page — voice-only UI (chat + mic + TTS output)
   ========================================================= */
export default function EmbedPage() {
  // UI / status
  const [status, setStatus] = useState('ready'); // ready | listening | speaking | error
  const [muted, setMuted] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);

  // Chat
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "G'day! I'm Otto 👋  Type below or tap the mic to talk." },
  ]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  // Audio graph (OUTPUT chain only)
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const analyserRef = useRef(null);
  const ttsSourceRef = useRef(null);

  // Mic stream + recognition
  const micStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const reconnTimerRef = useRef(null);

  // Echo guard — ignore recognition results while/after we speak
  const speakingRef = useRef(false);
  const speakGuardUntilRef = useRef(0);

  // Open/close event wiring from parent embed.js
  const openedRef = useRef(false);

  /* ------------------------ Helpers ------------------------ */

  const ensureAudioGraph = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      gain.gain.value = muted ? 0 : 1;
      analyser.connect(gain);
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
    }
    try {
      if (audioCtxRef.current.state !== 'running') {
        await audioCtxRef.current.resume();
      }
      setNeedsAudioUnlock(false);
    } catch {
      // Needs user gesture
      setNeedsAudioUnlock(true);
    }
  }, [muted]);

  const startChat = useCallback(async () => {
    try {
      const r = await fetch('/api/retell-chat/start', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j?.chatId) {
        setChatId(j.chatId);
        return j.chatId;
      }
    } catch {}
    setStatus('error');
    return null;
  }, []);

  const sendToAgent = useCallback(async (text) => {
    const cid = chatId || (await startChat());
    if (!cid) return;

    try {
      const r = await fetch('/api/retell-chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: cid, content: text }),
      });
      const j = await r.json();
      if (j?.ok && j?.reply) {
        setMessages((m) => [...m, { role: 'assistant', content: j.reply }]);
        if (!muted) await speak(j.reply);
      } else {
        setMessages((m) => [
          ...m,
          { role: 'assistant', content: 'I had trouble reaching the agent just now.' },
        ]);
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: 'Network hiccup—try again.' }]);
    }
  }, [chatId, startChat, muted]);

  /* ---------------------- Speech (TTS) --------------------- */

  const speak = useCallback(async (text) => {
    if (!text) return;

    // Guard recognition while we speak
    speakingRef.current = true;
    speakGuardUntilRef.current = Date.now() + 2000;

    // Stop any playing buffer
    try { ttsSourceRef.current?.stop?.(0); } catch {}

    // Azure endpoint first (if configured)
    try {
      await ensureAudioGraph();
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok && res.headers.get('Content-Type')?.includes('audio/')) {
        const buf = await res.arrayBuffer();
        const ctx = audioCtxRef.current;
        const audioBuf = await ctx.decodeAudioData(buf.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        if (analyserRef.current) src.connect(analyserRef.current);
        src.connect(gainRef.current || ctx.destination);
        setStatus('speaking');
        src.onended = () => {
          speakingRef.current = false;
          speakGuardUntilRef.current = Date.now() + 400;
          setStatus(micOn ? 'listening' : 'ready');
        };
        src.start(0);
        ttsSourceRef.current = src;
        return;
      }
    } catch {
      // fall through to browser TTS
    }

    // Browser TTS fallback
    try {
      await ensureAudioGraph();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);

      // Try an AU male voice if present
      const pickVoice = () => {
        const vs = window.speechSynthesis.getVoices();
        let v = vs.find(v => /en[-_]AU/i.test(v.lang) && /(william|cooper|male|australi)/i.test(v.name));
        if (!v) v = vs.find(v => /en[-_]AU/i.test(v.lang));
        return v || vs[0];
      };

      // Slight speed/pitch lift for energetic Otto
      u.voice = pickVoice();
      u.rate = 1.15;
      u.pitch = 1.08;

      u.onstart = () => setStatus('speaking');
      u.onend = () => {
        speakingRef.current = false;
        speakGuardUntilRef.current = Date.now() + 400;
        setStatus(micOn ? 'listening' : 'ready');
      };

      if (!muted) window.speechSynthesis.speak(u);
    } catch {
      // swallow
    }
  }, [ensureAudioGraph, micOn, muted]);

  /* ------------------- Speech Recognition ------------------ */

  const startRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMessages(m => [...m, { role: 'assistant', content: 'This browser does not support voice input.' }]);
      return false;
    }

    // Stop old instance if any
    try { recognitionRef.current?.stop?.(); } catch {}

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;      // reduces duplicates / feedback loops
    rec.lang = 'en-AU';

    rec.onstart = () => setStatus('listening');
    rec.onerror = () => {
      // Chrome often fires 'no-speech' / 'audio-capture' etc.; just attempt to restart.
      if (micOn) {
        clearTimeout(reconnTimerRef.current);
        reconnTimerRef.current = setTimeout(() => {
          try { recognitionRef.current?.start?.(); } catch {}
        }, 600);
      }
    };
    rec.onend = () => {
      if (micOn) {
        clearTimeout(reconnTimerRef.current);
        reconnTimerRef.current = setTimeout(() => {
          try { recognitionRef.current?.start?.(); } catch {}
        }, 300);
      } else {
        setStatus('ready');
      }
    };
    rec.onresult = (e) => {
      // If we’re speaking or within the guard window, ignore
      if (speakingRef.current || Date.now() < speakGuardUntilRef.current) return;

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const text = (res[0] && res[0].transcript) ? res[0].transcript.trim() : '';
          if (!text) continue;
          setMessages((m) => [...m, { role: 'user', content: text }]);
          sendToAgent(text);
        }
      }
    };

    try { rec.start(); } catch {}
    recognitionRef.current = rec;
    return true;
  }, [micOn, sendToAgent]);

  /* --------------------- Mic lifecycle --------------------- */

  const startMic = useCallback(async () => {
    try {
      await ensureAudioGraph();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;     // not piped to speakers => no acoustic echo
      setMicOn(true);
      startRecognition();
      setStatus('listening');
      return true;
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Please allow microphone access to talk.' }]);
      setStatus('ready');
      setMicOn(false);
      return false;
    }
  }, [ensureAudioGraph, startRecognition]);

  const stopMic = useCallback(() => {
    try { recognitionRef.current?.stop?.(); } catch {}
    try {
      micStreamRef.current?.getTracks?.().forEach(t => t.stop());
    } catch {}
    micStreamRef.current = null;
    setMicOn(false);
    if (!speakingRef.current) setStatus('ready');
  }, []);

  /* ------------------- UI control handlers ------------------ */

  const handleToggleMic = useCallback(async () => {
    if (micOn) stopMic();
    else await startMic();
  }, [micOn, startMic, stopMic]);

  const handleToggleMute = useCallback(async () => {
    const next = !muted;
    setMuted(next);
    await ensureAudioGraph();
    if (gainRef.current) gainRef.current.gain.value = next ? 0 : 1;
  }, [muted, ensureAudioGraph]);

  const handleRestart = useCallback(async () => {
    stopMic();
    setMessages([{ role: 'assistant', content: "Let's start fresh—what would you like to do?" }]);
    setChatId(null);
    const cid = await startChat();
    if (cid) await startMic();
  }, [startChat, startMic, stopMic]);

  /* ------------------ Open/Close from parent ----------------- */

  useEffect(() => {
    function onMsg(e) {
      const t = e?.data?.type;
      if (t === 'avatar-widget:open') {
        openedRef.current = true;
        // autostart if ?autostart=1
        const params = new URLSearchParams(window.location.search);
        const auto = params.get('autostart') === '1';
        if (auto) {
          (async () => {
            await ensureAudioGraph();
            await startChat();
            await startMic();
          })();
        }
      } else if (t === 'avatar-widget:close') {
        openedRef.current = false;
        stopMic();
        // stop any TTS still playing
        try { ttsSourceRef.current?.stop?.(0); } catch {}
        window.speechSynthesis?.cancel?.();
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [ensureAudioGraph, startChat, startMic, stopMic]);

  /* ---------------------- First load tweaks ------------------- */

  // If the iframe navigates directly (not opened by embed.js), still allow autostart via query
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      (async () => {
        await ensureAudioGraph();
        await startChat();
        await startMic();
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- Send text ------------------------ */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    await sendToAgent(text);
  }, [input, sendToAgent]);

  /* -------------------------- Render -------------------------- */
  return (
    <div className="wrap">
      <div className="panel">
        <header className="bar">
          <div className="title">
            <strong>Otto</strong> – Auto-Mate
            <span className={`dot ${status}`}>{status}</span>
          </div>
          <div className="controls">
            <button className={`btn ${micOn ? 'on' : ''}`} onClick={handleToggleMic} title="Mic on/off" aria-label="Mic on/off">
              <span className="icon">🎙️</span>{micOn ? 'Mic On' : 'Mic Off'}
            </button>
            <button className={`btn ${muted ? '' : 'on'}`} onClick={handleToggleMute} title="Sound on/off" aria-label="Sound on/off">
              <span className="icon">{muted ? '🔇' : '🔊'}</span>{muted ? 'Sound Off' : 'Sound On'}
            </button>
            <button className="btn" onClick={handleRestart} title="Restart" aria-label="Restart conversation">
              <span className="icon">↻</span>
            </button>
          </div>
        </header>

        <div className="viz">
          <Visualizer analyser={analyserRef.current} />
        </div>

        <div className="scroll">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">{m.content}</div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="composer">
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Type a message… ${micOn ? '(mic is on)' : ''}`}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            aria-label="Type a message"
          />
          <button className="send" onClick={handleSend} aria-label="Send">➤</button>
        </div>
      </div>

      {needsAudioUnlock && (
        <div className="overlay">
          <button
            className="unlock"
            onClick={async () => {
              await ensureAudioGraph();
              await startChat();
              await startMic();
            }}
          >
            Tap to enable audio
          </button>
        </div>
      )}

      <style jsx>{`
        .wrap { height: 100vh; background: #0b0f19; color: #dbe7ff; }
        .panel { height: 100%; display: flex; flex-direction: column; }
        .bar {
          flex: 0 0 50px; display: flex; align-items: center; justify-content: space-between;
          padding: 0 12px; background: rgba(20, 26, 40, 0.9);
          border-bottom: 1px solid rgba(255,255,255,0.08);
          position: sticky; top: 0; z-index: 2;
        }
        .title { font-size: 14px; letter-spacing: .2px; color: #E5EEFF; display:flex; gap:10px; align-items:center; }
        .dot { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #1f2937; color:#a5b4fc; text-transform: capitalize; }
        .dot.listening { background: #0b3b2f; color: #34d399; }
        .dot.speaking { background: #1e3a8a; color: #93c5fd; }
        .dot.error { background: #3f1d1d; color: #fca5a5; }
        .controls { display:flex; gap:8px; }
        .btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: 10px; font-size: 12px;
          border: 1px solid rgba(255,255,255,0.08);
          background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
          color: #dbe7ff; cursor: pointer;
        }
        .btn.on { box-shadow: 0 0 0 1px rgba(99, 102, 241, .6), 0 0 18px rgba(99, 102, 241, .35) inset; }
        .btn:hover { background: rgba(255,255,255,.08); }
        .icon { filter: saturate(1.2); }

        .viz {
          flex: 0 0 140px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          background: radial-gradient(1200px 140px at 50% 100%, rgba(56, 189, 248, .15), transparent 70%);
        }

        /* This is the important scroll fix */
        .scroll {
          flex: 1 1 auto; min-height: 0;
          overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px;
        }
        .msg { display: flex; }
        .msg.user { justify-content: flex-end; }
        .bubble {
          max-width: 80%;
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.08);
          color: #e6efff; font-size: 14px; line-height: 1.35;
        }
        .msg.user .bubble {
          background: linear-gradient(180deg, rgba(96,165,250,.15), rgba(59,130,246,.08));
          border-color: rgba(96,165,250,.35);
        }

        /* Composer is always visible */
        .composer {
          flex: 0 0 58px; display: flex; gap: 8px; align-items: center;
          padding: 8px 10px;
          border-top: 1px solid rgba(255,255,255,0.06);
          background: rgba(10,14,24,.95); position: sticky; bottom: 0; z-index: 2;
        }
        .input {
          flex: 1; min-width: 0; height: 40px; border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.04);
          color: #e7eeff; padding: 0 12px; font-size: 14px;
        }
        .input::placeholder { color: #93a4c7; }
        .send {
          height: 40px; padding: 0 14px; border-radius: 12px; cursor: pointer;
          background: linear-gradient(180deg, rgba(99,102,241,.9), rgba(59,130,246,.9));
          border: 1px solid rgba(147,197,253,.5); color: #fff; font-weight: 600;
          box-shadow: 0 6px 22px rgba(59,130,246,.25);
        }

        /* Autoplay unlock overlay */
        .overlay {
          position: absolute; inset: 0; display: grid; place-items: center;
          background: rgba(4,6,12,.66); backdrop-filter: blur(2px);
        }
        .unlock {
          padding: 12px 18px; border-radius: 14px; font-size: 14px; font-weight: 600;
          background: #111827; color: #dbe7ff; border: 1px solid rgba(99,102,241,.6);
          box-shadow: 0 0 0 1px rgba(99,102,241,.6), 0 18px 50px rgba(59,130,246,.25);
        }
      `}</style>
    </div>
  );
}
