'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

// Canvas visualizer that reacts to either mic or playback (AudioNode)
function Visualizer({ analyser }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const bufLen = analyser?.frequencyBinCount || 0;
    const data = new Uint8Array(bufLen);

    function draw() {
      raf = requestAnimationFrame(draw);
      if (!analyser) {
        // idle shimmer
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#1f2937';
        const barW = canvas.width / 32;
        for (let i = 0; i < 32; i++) {
          const h = 6 + 3 * Math.sin((Date.now() / 300) + i * 0.6);
          const x = i * barW + barW * 0.2;
          ctx.fillRect(x, canvas.height - h, barW * 0.6, h);
        }
        return;
      }

      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 40;
      const step = Math.floor(data.length / bars);
      const barW = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[i * step] / 255; // 0..1
        const h = Math.max(4, v * canvas.height * 0.9);
        // gradient-ish
        const g = ctx.createLinearGradient(0, canvas.height - h, 0, canvas.height);
        g.addColorStop(0, '#6EE7F9');
        g.addColorStop(1, '#4185F4');
        ctx.fillStyle = g;
        const x = i * barW + barW * 0.2;
        ctx.fillRect(x, canvas.height - h, barW * 0.6, h);
      }
    }

    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <canvas
      ref={canvasRef}
      width={1200}
      height={260}
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    />
  );
}

export default function EmbedPage() {
  // state
  const [status, setStatus] = useState('idle'); // idle | ready | listening | speaking | error
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState(() => [
    { role: 'assistant', content: "G'day! I'm Otto. Type below or click the mic to chat." },
  ]);
  const [input, setInput] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);

  // audio graph
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const analyserRef = useRef(null);
  const micStreamRef = useRef(null);
  const micSourceRef = useRef(null);

  // speech recognition
  const recognitionRef = useRef(null);

  // transcript scrolling
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  // create audio context lazily on first user gesture (clicking mic or play)
  const ensureAudioGraph = useCallback(async () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.85;
      gain.gain.value = muted ? 0 : 1;
      gain.connect(ctx.destination);
      analyser.connect(gain);

      audioCtxRef.current = ctx;
      gainRef.current = gain;
      analyserRef.current = analyser;
    }
    if (audioCtxRef.current.state !== 'running') {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    return !!audioCtxRef.current;
  }, [muted]);

  // start a Retell chat session (cheap text chat)
  const startChat = useCallback(async () => {
    try {
      const r = await fetch('/api/retell-chat/start');
      const j = await r.json();
      if (j?.ok && j?.chatId) {
        setChatId(j.chatId);
        setStatus('ready');
        return j.chatId;
      }
      throw new Error('start failed');
    } catch (e) {
      console.error('start error', e);
      setStatus('error');
      return null;
    }
  }, []);

  // send text to agent → speak back
  const speak = useCallback(async (text) => {
    if (!text) return;

    // Try Azure TTS
    try {
      await ensureAudioGraph();
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (res.ok && res.headers.get('Content-Type')?.includes('audio/')) {
        const arr = await res.arrayBuffer();
        const ctx = audioCtxRef.current;
        const buffer = await ctx.decodeAudioData(arr.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        // visualizer hookup
        if (analyserRef.current) src.connect(analyserRef.current);
        src.connect(gainRef.current || ctx.destination);

        setStatus('speaking');
        src.onended = () => setStatus(micOn ? 'listening' : 'ready');
        src.start(0);
        return;
      }
    } catch (e) {
      console.warn('Azure TTS failed, falling back to Web Speech:', e);
    }

    // Fallback: browser TTS (quick & simple)
    try {
      await ensureAudioGraph();
      const u = new SpeechSynthesisUtterance(text);
      // let browser pick en-AU if available
      const pick = () => {
        const vs = window.speechSynthesis.getVoices();
        let v = vs.find(v => /en[-_]AU/i.test(v.lang) && /william|cooper|male|australi/i.test(v.name));
        if (!v) v = vs.find(v => /en[-_]AU/i.test(v.lang));
        return v || vs[0];
      };
      u.voice = pick();
      u.rate = 1.15; // modest pep for fallback
      u.onstart = () => setStatus('speaking');
      u.onend = () => setStatus(micOn ? 'listening' : 'ready');
      if (!muted) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      }
    } catch (e) {
      console.warn('speechSynthesis error:', e);
    }
  }, [ensureAudioGraph, micOn, muted]);

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
        setMessages(m => [...m, { role: 'assistant', content: j.reply }]);
        if (!muted) speak(j.reply);
      } else {
        setMessages(m => [...m, { role: 'assistant', content: 'Hmm, I had trouble reaching the agent.' }]);
      }
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Network hiccup—try again.' }]);
    }
  }, [chatId, startChat, speak, muted]);

  // mic handling
  const startRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMessages(m => [...m, { role: 'assistant', content: 'This browser does not support speech recognition.' }]);
      return false;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-AU';
    rec.onstart = () => setStatus('listening');
    rec.onend = () => {
      // if still micOn, resume (mobile may auto-stop)
      if (micOn) {
        try { rec.start(); } catch {}
      } else {
        setStatus('ready');
      }
    };
    rec.onerror = () => setStatus('error');
    rec.onresult = (ev) => {
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
      }
      finalText = finalText.trim();
      if (finalText) {
        setMessages(m => [...m, { role: 'user', content: finalText }]);
        sendToAgent(finalText);
      }
    };

    try { rec.start(); recognitionRef.current = rec; return true; }
    catch (e) { console.warn('rec.start failed', e); return false; }
  }, [micOn, sendToAgent]);

  const stopRecognition = useCallback(() => {
    const r = recognitionRef.current;
    recognitionRef.current = null;
    try { r?.stop?.(); } catch {}
  }, []);

  const toggleMic = useCallback(async () => {
    if (micOn) {
      setMicOn(false);
      stopRecognition();
      // stop mic tracks & disconnect analyser input
      try {
        micSourceRef.current?.disconnect();
        micSourceRef.current = null;
      } catch {}
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
      }
      setStatus('ready');
      return;
    }
    // turn ON
    const okAudio = await ensureAudioGraph(); // user gesture
    if (!okAudio) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      if (audioCtxRef.current && analyserRef.current) {
        // hook mic to analyser for live bars
        const src = audioCtxRef.current.createMediaStreamSource(stream);
        micSourceRef.current = src;
        src.connect(analyserRef.current);
      }
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: 'Mic permission was blocked.' }]);
      return;
    }

    if (!(await startChat())) return; // ensure we have a chat session
    if (startRecognition()) {
      setMicOn(true);
    }
  }, [micOn, ensureAudioGraph, startChat, startRecognition, stopRecognition]);

  const toggleMute = useCallback(() => {
    setMuted(v => {
      const next = !v;
      if (gainRef.current) gainRef.current.gain.value = next ? 0 : 1;
      return next;
    });
  }, []);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const t = input.trim();
    if (!t) return;
    setMessages(m => [...m, { role: 'user', content: t }]);
    setInput('');
    await sendToAgent(t);
  }, [input, sendToAgent]);

  // Initialize a chat silently on load (for fast first reply); mic stays OFF.
  useEffect(() => { startChat(); }, [startChat]);

  return (
    <div className="h-screen w-screen bg-[#0B0F19] text-[#E6E8EE] flex flex-col">
      {/* Top half: waveform */}
      <div className="flex-1 relative border-b border-white/10">
        <Visualizer analyser={analyserRef.current} />
      </div>

      {/* Bottom half: chat + controls */}
      <div className="flex-[1] min-h-[50%] max-h-[50%] flex flex-col">
        {/* Controls */}
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <span className="text-xs opacity-80">
            {status === 'speaking' ? 'Otto is speaking' :
             status === 'listening' ? 'Listening…' :
             status === 'ready' ? 'Ready' :
             status}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={toggleMic}
              title={micOn ? 'Turn mic off' : 'Turn mic on'}
              aria-label="Mic"
              className={`px-3 py-2 rounded border text-sm ${micOn ? 'bg-[#1F2937] border-white/20' : 'bg-transparent border-white/20 hover:bg-white/10'}`}
            >
              🎙️ {micOn ? 'On' : 'Off'}
            </button>
            <button
              onClick={toggleMute}
              title={muted ? 'Unmute' : 'Mute output'}
              aria-label="Mute output"
              className="px-3 py-2 rounded border border-white/20 text-sm hover:bg-white/10"
            >
              🔈 {muted ? 'Off' : 'On'}
            </button>
          </div>
        </div>

        {/* transcript */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {messages.map((m, i) => (
            <div key={i} className={`max-w-[80%] px-3 py-2 rounded ${m.role==='user'?'ml-auto bg-white/10':'bg-white/5'}`}>
              {m.content}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* input */}
        <form onSubmit={onSubmit} className="p-3 border-t border-white/10 flex gap-2">
          <input
            className="flex-1 rounded bg-transparent border border-white/20 px-3 py-2 outline-none focus:border-white/40"
            placeholder={`Type a message… ${micOn ? '(mic is on)' : ''}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus={!micOn}
            aria-label="Type message"
          />
          <button
            type="submit"
            className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 border border-white/20"
            title="Send message"
            aria-label="Send"
          >
            ➤
          </button>
        </form>
      </div>
    </div>
  );
}
