'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ================= Neon visualizer (output only — no loopback) ================= */
function Visualizer({ analyser }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    const BARS = 44;
    const fft = new Uint8Array(1024);
    let raf = 0;

    function bar(x, y, w, h, glow) {
      const g = ctx.createLinearGradient(0, y - h, 0, y);
      g.addColorStop(0, '#7DD3FC');
      g.addColorStop(1, '#60A5FA');
      ctx.fillStyle = g;
      ctx.shadowColor = '#60A5FA';
      ctx.shadowBlur = 16 * glow;
      ctx.fillRect(x, y - h, w, h);
      ctx.shadowBlur = 0;
    }
    function idle() {
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      const w = cvs.width / BARS;
      for (let i = 0; i < BARS; i++) {
        const h = 6 + 4 * Math.sin((Date.now() / 360) + i * 0.55);
        bar(i * w + w * 0.25, cvs.height, w * 0.5, h, 0.35);
      }
    }
    function loop() {
      raf = requestAnimationFrame(loop);
      if (!analyser) return idle();
      analyser.getByteFrequencyData(fft);
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      const step = Math.max(1, Math.floor(analyser.frequencyBinCount / BARS));
      const w = cvs.width / BARS;
      for (let i = 0; i < BARS; i++) {
        const v = fft[i * step] / 255;
        const h = Math.max(6, v * cvs.height * 0.9);
        bar(i * w + w * 0.25, cvs.height, w * 0.5, h, 0.7 + v * 0.7);
      }
    }
    loop();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} width={1400} height={260} style={{ width: '100%', height: '100%' }} aria-hidden="true" />;
}

/* =============================== Embed page =============================== */
export default function EmbedPage() {
  /* ---------- UI state ---------- */
  const [muted, setMuted] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [status, setStatus] = useState('mic-off'); // listening | speaking | mic-off | error
  const [statusNote, setStatusNote] = useState('');
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [autoStopped, setAutoStopped] = useState(false); // to change pill text after auto-idle

  /* ---------- Chat state ---------- */
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "G'day! I'm Otto 👋  Type below or tap the mic to talk." },
  ]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  /* ---------- Audio OUT graph ---------- */
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const analyserRef = useRef(null);
  const ttsSourceRef = useRef(null);

  /* ---------- Speech runtime ---------- */
  const recognitionRef = useRef(null);
  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  const recActiveRef = useRef(false);
  const speakingRef = useRef(false);

  // Activity bookkeeping (used for auto-idle)
  const lastActivityRef = useRef(Date.now()); // updated on speech in/out + text send
  const INACTIVITY_MS = 60 * 1000; // 1 minute of true silence before we toggle mic off

  // Chrome sometimes stalls recognition; we "soft" restart if no events for a while
  const recIdleTimerRef = useRef(null);
  const clearRecIdle = () => { if (recIdleTimerRef.current) { clearTimeout(recIdleTimerRef.current); recIdleTimerRef.current = null; } };
  const armRecIdle = () => {
    clearRecIdle();
    recIdleTimerRef.current = setTimeout(() => {
      if (!micOn || speakingRef.current) return;
      try { recognitionRef.current?.stop?.(); } catch {}
      setTimeout(() => { if (micOn && !speakingRef.current) startRecognition(true); }, 250);
    }, 30000);
  };

  // Keep pill/button in sync by deriving from a single truth
  const syncStatus = useCallback((explicit) => {
    if (explicit) { setStatus(explicit); return; }
    if (speakingRef.current) setStatus('speaking');
    else if (micOn) setStatus('listening');
    else setStatus('mic-off');
  }, [micOn]);

  /* ---------- Audio graph ---------- */
  const ensureAudioGraph = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      analyser.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = muted ? 0 : 1;
      audioCtxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
    }
    try {
      if (audioCtxRef.current.state !== 'running') await audioCtxRef.current.resume();
      setNeedsAudioUnlock(false);
    } catch {
      setNeedsAudioUnlock(true);
    }
  }, [muted]);

  /* ---------- Server chat routes ---------- */
  const startChat = useCallback(async () => {
    try {
      const r = await fetch('/api/retell-chat/start', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j?.chatId) { setChatId(j.chatId); return j.chatId; }
    } catch {}
    setStatus('error');
    return null;
  }, []);

  const sendToAgent = useCallback(async (text) => {
    const cid = chatId || (await startChat());
    if (!cid) return;
    lastActivityRef.current = Date.now();
    try {
      const r = await fetch('/api/retell-chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: cid, content: text }),
      });
      const j = await r.json();
      if (j?.ok && j?.reply) {
        lastActivityRef.current = Date.now();
        setMessages(m => [...m, { role: 'assistant', content: j.reply }]);
        if (!muted) await speak(j.reply);
      } else {
        setMessages(m => [...m, { role: 'assistant', content: 'I had trouble reaching the agent just now.' }]);
      }
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Network hiccup—try again.' }]);
    }
  }, [chatId, startChat, muted]);

  /* ---------- TTS (Azure first, SpeechSynthesis fallback) ---------- */
  const speak = useCallback(async (text) => {
    if (!text) return;

    speakingRef.current = true;
    syncStatus(); // speaking
    try { ttsSourceRef.current?.stop?.(0); } catch {}

    // Azure
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
        lastActivityRef.current = Date.now();
        src.onended = () => {
          speakingRef.current = false;
          lastActivityRef.current = Date.now();
          syncStatus(); // back to listening if mic is on
          if (micOn) safeRestartRecognition();
        };
        src.start(0);
        ttsSourceRef.current = src;
        return;
      }
    } catch {}

    // Fallback
    try {
      await ensureAudioGraph();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const pick = () => {
        const vs = window.speechSynthesis.getVoices();
        let v = vs.find(v => /en[-_]AU/i.test(v.lang) && /(william|cooper|male|australi)/i.test(v.name));
        if (!v) v = vs.find(v => /en[-_]AU/i.test(v.lang));
        return v || vs[0];
      };
      u.voice = pick();
      u.rate = 1.15; u.pitch = 1.08;
      u.onstart = () => { lastActivityRef.current = Date.now(); speakingRef.current = true; syncStatus(); };
      u.onend = () => { speakingRef.current = false; lastActivityRef.current = Date.now(); syncStatus(); if (micOn) safeRestartRecognition(); };
      if (!muted) window.speechSynthesis.speak(u);
    } catch {}
  }, [ensureAudioGraph, micOn, muted, syncStatus]);

  /* ---------- Recognition ---------- */
  const startRecognition = useCallback((soft = false) => {
    if (!SR) {
      setMessages(m => [...m, { role: 'assistant', content: 'This browser does not support voice input.' }]);
      setStatus('error');
      return false;
    }
    try { recognitionRef.current?.stop?.(); } catch {}

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-AU';

    rec.onstart = () => {
      recActiveRef.current = true;
      lastActivityRef.current = Date.now();
      setAutoStopped(false);
      setStatusNote('');
      syncStatus();      // listening
      armRecIdle();
    };
    rec.onspeechstart = armRecIdle;
    rec.onaudiostart = armRecIdle;
    rec.onsoundstart = armRecIdle;

    rec.onresult = (e) => {
      armRecIdle();
      lastActivityRef.current = Date.now();
      if (speakingRef.current) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = (r[0] && r[0].transcript) ? r[0].transcript.trim() : '';
          if (!text) continue;
          setMessages(m => [...m, { role: 'user', content: text }]);
          sendToAgent(text);
        }
      }
    };

    rec.onerror = () => {
      recActiveRef.current = false;
      clearRecIdle();
      // Keep mic ON — just rearm recognition (Chrome quirk)
      if (micOn && !speakingRef.current) setTimeout(() => startRecognition(true), 300);
    };
    rec.onend = () => {
      recActiveRef.current = false;
      clearRecIdle();
      if (micOn && !speakingRef.current) {
        // Continuous re-arm to keep listening
        setTimeout(() => startRecognition(true), 150);
      }
    };

    try { rec.start(); } catch {}
    recognitionRef.current = rec;
    return true;
  }, [SR, micOn, sendToAgent, syncStatus]);

  const safeRestartRecognition = useCallback(() => {
    try { recognitionRef.current?.stop?.(); } catch {}
    setTimeout(() => { if (micOn) startRecognition(true); }, 120);
  }, [micOn, startRecognition]);

  /* ---------- Mic lifecycle ---------- */
  const startMic = useCallback(async () => {
    try {
      await ensureAudioGraph();
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicOn(true);
      setAutoStopped(false);
      setStatusNote('');
      lastActivityRef.current = Date.now();
      syncStatus(); // listening
      startRecognition();
      return true;
    } catch {
      setMicOn(false);
      syncStatus(); // mic-off
      setStatusNote('Please allow microphone access to talk.');
      return false;
    }
  }, [ensureAudioGraph, startRecognition, syncStatus]);

  const stopMic = useCallback((auto = false) => {
    try { recognitionRef.current?.stop?.(); } catch {}
    recActiveRef.current = false;
    clearRecIdle();
    setMicOn(false);
    setAutoStopped(!!auto);
    if (auto) setStatusNote(''); // message will be in pill text
    syncStatus(); // mic-off
  }, [syncStatus]);

  /* ---------- Auto-idle watchdog (1 min of true silence) ---------- */
  useEffect(() => {
    if (!micOn) return;
    const iv = setInterval(() => {
      if (!micOn) return;
      if (speakingRef.current) { lastActivityRef.current = Date.now(); return; }
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor >= INACTIVITY_MS) {
        stopMic(true); // auto-stop → pill shows instruction
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [micOn, stopMic]);

  /* ---------- Audio toggle ---------- */
  const handleToggleMute = useCallback(async () => {
    const next = !muted; setMuted(next);
    await ensureAudioGraph();
    if (gainRef.current) gainRef.current.gain.value = next ? 0 : 1;
  }, [muted, ensureAudioGraph]);

  const handleToggleMic = useCallback(async () => {
    if (micOn) stopMic(false);
    else await startMic();
  }, [micOn, startMic, stopMic]);

  const handleRestart = useCallback(async () => {
    stopMic(false);
    setMessages([{ role: 'assistant', content: "Let's start fresh—what would you like to do?" }]);
    setChatId(null);
    const cid = await startChat();
    if (cid) await startMic();
  }, [startChat, startMic, stopMic]);

  /* ---------- embed.js open/close ---------- */
  useEffect(() => {
    function onMsg(e) {
      const t = e?.data?.type;
      if (t === 'avatar-widget:open') {
        const params = new URLSearchParams(window.location.search);
        if (params.get('autostart') === '1') {
          (async () => { await ensureAudioGraph(); await startChat(); await startMic(); })();
        }
      } else if (t === 'avatar-widget:close') {
        stopMic(false);
        try { ttsSourceRef.current?.stop?.(0); } catch {}
        window.speechSynthesis?.cancel?.();
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [ensureAudioGraph, startChat, startMic, stopMic]);

  // Direct nav autostart
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      (async () => { await ensureAudioGraph(); await startChat(); await startMic(); })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Send text ---------- */
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    lastActivityRef.current = Date.now();
    setMessages((m) => [...m, { role: 'user', content: text }]);
    await sendToAgent(text);
    // Keep mic alive through text interactions too
    if (micOn) safeRestartRecognition();
  }, [input, sendToAgent, micOn, safeRestartRecognition]);

  /* ---------- Pill text ---------- */
  const pillText = micOn
    ? (status === 'speaking' ? 'speaking' : 'listening')
    : (autoStopped ? 'Turn Mic On to Speak' : 'mic off');

  /* -------------------------------- UI -------------------------------- */
  return (
    <div className="wrap">
      <div className="panel">
        <header className="bar">
          <div className="title">
            <strong>Otto</strong> — Your Auto-Mate!
            <span className={`pill ${status}`}>{pillText}</span>
            {statusNote && <span className="hint">{statusNote}</span>}
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

        <div className="viz"><Visualizer analyser={analyserRef.current} /></div>

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
            onClick={async () => { await ensureAudioGraph(); await startChat(); await startMic(); }}
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
        .title { font-size: 14px; letter-spacing: .2px; color: #E5EEFF; display:flex; gap:10px; align-items:center; flex-wrap: wrap; }
        .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #1f2937; color:#a5b4fc; text-transform: capitalize; white-space: nowrap; }
        .pill.listening { background: #0b3b2f; color: #34d399; }
        .pill.speaking  { background: #1e3a8a; color: #93c5fd; text-transform: none; }
        .pill.mic-off   { background: #3a243a; color: #f0abfc; text-transform: none; }
        .pill.error     { background: #3f1d1d; color: #fca5a5; }
        .hint { font-size: 12px; opacity: .9; color: #9fb3ff; }

        .controls { display:flex; gap:8px; }
        .btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 10px; border-radius: 10px; font-size: 12px;
          border: 1px solid rgba(255,255,255,0.08);
          background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
          color: #dbe7ff; cursor: pointer;
        }
        .btn.on { box-shadow: 0 0 0 1px rgba(99,102,241, .6), 0 0 18px rgba(99,102,241, .35) inset; }
        .btn:hover { background: rgba(255,255,255,.08); }
        .icon { filter: saturate(1.2); }

        .viz {
          flex: 0 0 140px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          background: radial-gradient(1200px 140px at 50% 100%, rgba(56, 189, 248, .15), transparent 70%);
        }
        .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .msg { display: flex; }
        .msg.user { justify-content: flex-end; }
        .bubble {
          max-width: 80%; padding: 10px 12px; border-radius: 14px;
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
          color: #e6efff; font-size: 14px; line-height: 1.35;
        }
        .msg.user .bubble {
          background: linear-gradient(180deg, rgba(96,165,250,.15), rgba(59,130,246,.08));
          border-color: rgba(96,165,250,.35);
        }
        .composer {
          flex: 0 0 58px; display: flex; gap: 8px; align-items: center;
          padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.06);
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
        .overlay { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(4,6,12,.66); backdrop-filter: blur(2px); }
        .unlock {
          padding: 12px 18px; border-radius: 14px; font-size: 14px; font-weight: 600;
          background: #111827; color: #dbe7ff; border: 1px solid rgba(99,102,241,.6);
          box-shadow: 0 0 0 1px rgba(99,102,241,.6), 0 18px 50px rgba(59,130,246,.25);
        }
      `}</style>
    </div>
  );
}
