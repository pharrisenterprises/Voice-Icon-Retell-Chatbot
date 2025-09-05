'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/* ===== Neon Visualizer ===== */
function Visualizer({ analyser }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let raf = 0;
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');

    const bins = analyser?.frequencyBinCount || 0;
    const data = new Uint8Array(bins);

    function bar(x, y, w, h, glow = 1) {
      const g = ctx.createLinearGradient(0, y - h, 0, y);
      g.addColorStop(0, '#7DD3FC'); g.addColorStop(1, '#60A5FA');
      ctx.fillStyle = g; ctx.shadowColor = '#60A5FA'; ctx.shadowBlur = 18 * glow;
      ctx.fillRect(x, y - h, w, h); ctx.shadowBlur = 0;
    }

    function idle() {
      ctx.clearRect(0, 0, c.width, c.height);
      const N = 44, w = c.width / N;
      for (let i = 0; i < N; i++) {
        const h = 6 + 4 * Math.sin((Date.now() / 320) + i * .55);
        bar(i * w + w * .25, c.height, w * .5, h, .35);
      }
    }

    function draw() {
      raf = requestAnimationFrame(draw);
      if (!analyser) return idle();
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, c.width, c.height);
      const N = 44, step = Math.max(1, Math.floor(data.length / N)), w = c.width / N;
      for (let i = 0; i < N; i++) {
        const v = data[i * step] / 255;
        const h = Math.max(6, v * c.height * .88);
        bar(i * w + w * .25, c.height, w * .5, h, .8 + v * .7);
      }
    }
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} width={1400} height={260} style={{ width: '100%', height: '100%' }} aria-hidden="true" />;
}

/* ===== Page ===== */
export default function EmbedPage() {
  // status & chat
  const [status, setStatus] = useState('ready');   // ready | listening | speaking | error
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([{ role: 'assistant', content: "G'day! I’m Otto 👋  Type below or click the mic to talk." }]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  // controls
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);

  // audio graph nodes
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const analyserRef = useRef(null);
  const srcRef = useRef(null);
  const playingRef = useRef(false);

  // mic & recognition
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);
  const recognitionRef = useRef(null);
  const resumeAfterSpeakRef = useRef(false);

  const ensureAudioGraph = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.86;
      gain.gain.value = muted ? 0 : 1;
      gain.connect(ctx.destination);
      analyser.connect(gain);
      audioCtxRef.current = ctx; gainRef.current = gain; analyserRef.current = analyser;
    }
    if (audioCtxRef.current.state !== 'running') try { await audioCtxRef.current.resume(); } catch {}
    return true;
  }, [muted]);

  const startChat = useCallback(async () => {
    try {
      const r = await fetch('/api/retell-chat/start', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && j?.chatId) { setChatId(j.chatId); return j.chatId; }
    } catch {}
    setStatus('error'); return null;
  }, []);

  // --- TTS (Azure first, fallback to browser) ---
  const speak = useCallback(async (text) => {
    if (!text) return;
    try {
      await ensureAudioGraph();
      const res = await fetch('/api/tts/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (res.ok && res.headers.get('Content-Type')?.includes('audio/')) {
        const buf = await res.arrayBuffer();
        const ctx = audioCtxRef.current;
        const audioBuf = await ctx.decodeAudioData(buf.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        if (analyserRef.current) src.connect(analyserRef.current);
        src.connect(gainRef.current || ctx.destination);
        playingRef.current = true;
        setStatus('speaking');
        // half-duplex: pause mic recognition while speaking
        if (recognitionRef.current) { resumeAfterSpeakRef.current = micOn; try { recognitionRef.current.stop(); } catch {} }
        src.onended = () => {
          playingRef.current = false;
          setStatus(micOn ? 'listening' : 'ready');
          if (resumeAfterSpeakRef.current) { resumeAfterSpeakRef.current = false; try { recognitionRef.current?.start?.(); } catch {} }
        };
        src.start(0);
        srcRef.current = src;
        return;
      }
    } catch (e) { /* fall through */ }

    // Fallback to browser voice
    try {
      await ensureAudioGraph();
      const u = new SpeechSynthesisUtterance(text);
      const pick = () => {
        const vs = window.speechSynthesis.getVoices();
        let v = vs.find(v => /en[-_]AU/i.test(v.lang) && /william|cooper|male|australi/i.test(v.name));
        if (!v) v = vs.find(v => /en[-_]AU/i.test(v.lang));
        return v || vs[0];
      };
      u.voice = pick();
      u.rate = 1.15; u.pitch = 1.08;
      u.onstart = () => {
        setStatus('speaking');
        if (recognitionRef.current) { resumeAfterSpeakRef.current = micOn; try { recognitionRef.current.stop(); } catch {} }
      };
      u.onend = () => {
        setStatus(micOn ? 'listening' : 'ready');
        if (resumeAfterSpeakRef.current) { resumeAfterSpeakRef.current = false; try { recognitionRef.current?.start?.(); } catch {} }
      };
      if (!muted) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }
    } catch {}
  }, [ensureAudioGraph, micOn, muted]);

  const sendToAgent = useCallback(async (text) => {
    const cid = chatId || (await startChat()); if (!cid) return;
    try {
      const r = await fetch('/api/retell-chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: cid, content: text }),
      });
      const j = await r.json();
      if (j?.ok && j?.reply) { setMessages(m => [...m, { role: 'assistant', content: j.reply }]); if (!muted) speak(j.reply); }
      else { setMessages(m => [...m, { role: 'assistant', content: 'Hmm, I had trouble reaching the agent.' }]); }
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Network hiccup—try again.' }]);
    }
  }, [chatId, startChat, speak, muted]);

  // --- Mic & ASR (Web Speech) ---
  const startRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setMessages(m => [...m, { role: 'assistant', content: 'This browser does not support speech recognition.' }]); return false; }
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = 'en-AU';
    rec.onstart = () => setStatus('listening');
    rec.onend = () => { if (micOn) { try { rec.start(); } catch {} } else { setStatus('ready'); } };
    rec.onerror = () => setStatus('error');
    rec.onresult = (ev) => {
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalText += r[0].transcript; }
      finalText = finalText.trim();
      if (finalText) { setMessages(m => [...m, { role: 'user', content: finalText }]); sendToAgent(finalText); }
    };
    try { rec.start(); recognitionRef.current = rec; return true; } catch { return false; }
  }, [micOn, sendToAgent]);

  const stopRecognition = useCallback(() => {
    const r = recognitionRef.current; recognitionRef.current = null;
    try { r?.stop?.(); } catch {}
  }, []);

  const startMic = useCallback(async () => {
    await ensureAudioGraph(); // user gesture path or postMessage(open)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      micStreamRef.current = stream;
      if (audioCtxRef.current && analyserRef.current) {
        const src = audioCtxRef.current.createMediaStreamSource(stream);
        micSourceRef.current = src;
        src.connect(analyserRef.current);
      }
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Mic permission was blocked.' }]);
      return false;
    }
    if (!(await startChat())) return false;
    const ok = startRecognition(); if (ok) setMicOn(true);
    return ok;
  }, [ensureAudioGraph, startChat, startRecognition]);

  const stopMic = useCallback(() => {
    setMicOn(false);
    stopRecognition();
    try { micSourceRef.current?.disconnect(); micSourceRef.current = null; } catch {}
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (playingRef.current && srcRef.current) { try { srcRef.current.stop(0); } catch {} }
    setStatus('ready');
  }, [stopRecognition]);

  const toggleMic = useCallback(async () => { if (micOn) stopMic(); else await startMic(); }, [micOn, startMic, stopMic]);
  const toggleMute = useCallback(() => { setMuted(v => { const n = !v; if (gainRef.current) gainRef.current.gain.value = n ? 0 : 1; return n; }); }, []);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const t = input.trim(); if (!t) return;
    setMessages(m => [...m, { role: 'user', content: t }]); setInput(''); await sendToAgent(t);
  }, [input, sendToAgent]);

  // warm chat
  useEffect(() => { startChat(); }, [startChat]);

  // handle parent open/close
  useEffect(() => {
    function onMsg(ev) {
      const type = ev?.data?.type;
      if (type === 'avatar-widget:open') { startMic(); }
      if (type === 'avatar-widget:close') { stopMic(); }
    }
    window.addEventListener('message', onMsg);
    return () => { window.removeEventListener('message', onMsg); stopMic(); };
  }, [startMic, stopMic]);

  /* -------------- UI -------------- */
  return (
    <div className="wrap" role="application" aria-label="Otto voice widget">
      <div className="hdr">
        <div className="left"><div className="pulse" /> <div className="title">Otto – Auto-Mate</div></div>
        <div className="right">
          <button className={`btn ${micOn ? 'on' : ''}`} onClick={toggleMic} title={micOn ? 'Turn mic off' : 'Turn mic on'} aria-label="Mic">
            <span className="ico">🎙️</span>{micOn ? 'Mic On' : 'Mic Off'}
          </button>
          <button className={`btn ${muted ? 'off' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute output'} aria-label="Mute output">
            <span className="ico">🔈</span>{muted ? 'Muted' : 'Sound On'}
          </button>
        </div>
      </div>

      <div className="viz">
        <Visualizer analyser={analyserRef.current} />
        <div className="state">{status === 'speaking' ? 'Otto is speaking' : status === 'listening' ? 'Listening…' : 'Ready'}</div>
      </div>

      <div className="chat">
        <div className="msgs" role="log" aria-live="polite">
          {messages.map((m,i) => <div key={i} className={`msg ${m.role}`}>{m.content}</div>)}
          <div ref={endRef} />
        </div>
        <form className="composer" onSubmit={onSubmit}>
          <input
            aria-label="Type message"
            placeholder={`Type a message… ${micOn ? '(mic is on)' : ''}`}
            value={input}
            onChange={e => setInput(e.target.value)}
            autoFocus={!micOn}
          />
          <button type="submit" className="send" title="Send">➤</button>
        </form>
      </div>

      <style jsx>{`
        .wrap {
          height: 100vh; width: 100%;
          display: grid; grid-template-rows: 56px 170px 1fr;
          background: radial-gradient(1200px 600px at 100% -10%, rgba(96,165,250,.15), transparent),
                      radial-gradient(900px 500px at -10% 110%, rgba(56,189,248,.12), transparent),
                      #0B0F19;
          color: #E6E8EE; font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
          overflow: hidden;
        }
        .hdr {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08);
          background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
        }
        .left { display: flex; align-items: center; gap: 10px; }
        .pulse { width: 12px; height: 12px; border-radius: 50%; background: #34D399;
          box-shadow: 0 0 14px #34D399, 0 0 30px rgba(52,211,153,.6); animation: p 2.2s infinite; }
        @keyframes p { 0%{box-shadow:0 0 12px #34D399,0 0 24px rgba(52,211,153,.5)} 50%{box-shadow:0 0 18px #34D399,0 0 36px rgba(52,211,153,.8)} 100%{box-shadow:0 0 12px #34D399,0 0 24px rgba(52,211,153,.5)} }
        .title { font-weight: 600; letter-spacing: .3px; opacity: .95; }
        .right { display: flex; gap: 8px; }
        .btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
          background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #E6E8EE; cursor: pointer;
          transition: transform .06s ease, background .2s ease, border-color .2s ease; }
        .btn:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.2); transform: translateY(-1px); }
        .btn:active { transform: translateY(0) scale(.99); }
        .btn.on { background: linear-gradient(90deg, rgba(125,211,252,.22), rgba(96,165,250,.22)); border-color: rgba(125,211,252,.4); }
        .btn.off { background: rgba(255,255,255,.04); opacity: .9; }

        .viz { position: relative; border-bottom: 1px solid rgba(255,255,255,.08); padding: 6px 8px; }
        .state { position: absolute; right: 12px; top: 10px; font-size: 12px; opacity: .8;
          padding: 4px 8px; border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); }

        .chat { display: grid; grid-template-rows: 1fr auto; height: 100%; }
        .msgs { overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
        .msg { max-width: 80%; padding: 10px 12px; border-radius: 12px; }
        .msg.assistant { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); }
        .msg.user { margin-left: auto; background: rgba(125,211,252,.14); border: 1px solid rgba(125,211,252,.35); }
        .composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(255,255,255,.08); position: sticky; bottom: 0; background: rgba(11,15,25,.92); }
        .composer input { flex: 1; border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.12); color: #E6E8EE; outline: none; }
        .composer input:focus { border-color: rgba(125,211,252,.55); box-shadow: 0 0 0 3px rgba(125,211,252,.15) inset; }
        .send { padding: 10px 14px; border-radius: 12px; background: linear-gradient(90deg, rgba(125,211,252,.22), rgba(96,165,250,.22)); border: 1px solid rgba(125,211,252,.4); color: #E6E8EE; cursor: pointer; }
        @media (max-width: 480px) { .wrap { grid-template-rows: 56px 140px 1fr; } .msg { max-width: 92%; } }
      `}</style>
    </div>
  );
}
