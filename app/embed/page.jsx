'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function useSearch() {
  // Safe client-only read of search params
  const [q, setQ] = useState(null);
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const obj = {};
      sp.forEach((v, k) => (obj[k] = v));
      setQ(obj);
    } catch {}
  }, []);
  return q || {};
}

export default function EmbedPage() {
  const search = useSearch();
  const autostart = String(search.autostart || '0') === '1';

  // UI state
  const [status, setStatus] = useState('idle'); // idle | ready | listening | muted | error
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState(() => [
    { role: 'assistant', content: "Hi! I'm ready. You can speak, or type below." },
  ]);
  const [input, setInput] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // refs
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const lastMsgRef = useRef(null);
  const recognitionRef = useRef(null);
  const micStreamRef = useRef(null);

  // auto-scroll
  useEffect(() => {
    if (lastMsgRef.current) {
      lastMsgRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [messages.length]);

  // --- helpers
  const ensureAudio = useCallback(async () => {
    if (!audioCtxRef.current) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const gain = ctx.createGain();
        gain.gain.value = muted ? 0 : 1;
        gain.connect(ctx.destination);
        audioCtxRef.current = ctx;
        gainRef.current = gain;
      } catch (e) {
        console.error('AudioContext error:', e);
        setStatus('error');
        return false;
      }
    }
    if (audioCtxRef.current.state !== 'running') {
      try {
        await audioCtxRef.current.resume();
      } catch (e) {
        // will require a user gesture
        return false;
      }
    }
    setAudioUnlocked(true);
    return true;
  }, [muted]);

  const requestMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      return true;
    } catch (e) {
      console.warn('Mic permission denied or failed:', e);
      return false;
    }
  }, []);

  const startRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('Web Speech Recognition not supported in this browser.');
      return false;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-AU'; // prefer Aussie for user speech
    rec.onstart = () => setStatus('listening');
    rec.onend = () => {
      // if mic still on, auto-restart (mobile can pause)
      if (micOn) {
        try { rec.start(); } catch {}
      } else {
        setStatus('ready');
      }
    };
    rec.onerror = (ev) => {
      console.warn('STT error:', ev?.error);
      setStatus('error');
    };
    rec.onresult = (ev) => {
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
      }
      if (finalText.trim()) {
        append({ role: 'user', content: finalText.trim() });
        sendToAgent(finalText.trim());
      }
    };
    try {
      rec.start();
      recognitionRef.current = rec;
      return true;
    } catch (e) {
      console.warn('rec.start failed:', e);
      return false;
    }
  }, [micOn]);

  const stopRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try { rec && rec.stop && rec.stop(); } catch {}
    const s = micStreamRef.current;
    micStreamRef.current = null;
    if (s) {
      try { s.getTracks().forEach(t => t.stop()); } catch {}
    }
  }, []);

  const pickAussieVoice = useCallback(() => {
    // Try to pick an AU male voice from Web Speech (as fallback when Azure isn't configured)
    const voices = window.speechSynthesis?.getVoices?.() || [];
    // best: en-AU and "male" hints in name
    let v = voices.find(v => /en[-_]AU/i.test(v.lang) && /male|william|australi/i.test(v.name));
    if (!v) v = voices.find(v => /en[-_]AU/i.test(v.lang));
    if (!v) v = voices.find(v => /en[-_](GB|UK)/i.test(v.lang) && /male/i.test(v.name));
    return v || voices[0] || null;
  }, []);

  const speak = useCallback(async (text) => {
    if (!text) return;
    // 1) Try Azure TTS via our API route (if not configured, it will 400 and we’ll fall back)
    try {
      const res = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), // voice picked server-side env
      });
      if (res.ok && res.headers.get('Content-Type')?.includes('audio/')) {
        const arrayBuffer = await res.arrayBuffer();
        await ensureAudio();
        const ctx = audioCtxRef.current;
        const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        setSpeaking(true);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(gainRef.current || ctx.destination);
        src.onended = () => setSpeaking(false);
        src.start(0);
        return;
      }
    } catch (e) {
      // swallow; we’ll fall back
      console.warn('Azure TTS fetch failed, falling back to Web Speech:', e);
    }

    // 2) Fallback: Web Speech API voices
    try {
      await ensureAudio(); // unlocks AudioContext so browser will allow TTS
      const utter = new SpeechSynthesisUtterance(text);
      const voice = pickAussieVoice();
      if (voice) utter.voice = voice;
      utter.rate = 1.03;
      utter.pitch = 1;
      utter.onstart = () => setSpeaking(true);
      utter.onend = () => setSpeaking(false);
      // honor mute
      if (muted) return; // silently skip speaking when muted
      window.speechSynthesis.cancel(); // stop any prior
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.warn('speechSynthesis failed:', e);
    }
  }, [ensureAudio, pickAussieVoice, muted]);

  const append = useCallback((m) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const startChat = useCallback(async () => {
    try {
      const r = await fetch('/api/retell-chat/start', { method: 'GET' });
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

  const sendToAgent = useCallback(async (text) => {
    if (!text?.trim()) return;
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
        append({ role: 'assistant', content: j.reply });
        speak(j.reply);
      } else {
        append({ role: 'assistant', content: 'Hmm, something went wrong reaching the agent.' });
      }
    } catch (e) {
      append({ role: 'assistant', content: 'Network error. Please try again.' });
    }
  }, [append, chatId, speak, startChat]);

  // mic toggle
  const toggleMic = useCallback(async () => {
    if (micOn) {
      setMicOn(false);
      stopRecognition();
      setStatus('ready');
      return;
    }
    // turning ON
    const okAudio = await ensureAudio();
    if (!okAudio) {
      // need a user gesture; overlay button will handle it
      return;
    }
    const gotMic = await requestMic();
    if (!gotMic) return;
    const started = startRecognition();
    if (started) {
      setMicOn(true);
      if (!chatId) await startChat();
    }
  }, [micOn, ensureAudio, requestMic, startRecognition, stopRecognition, chatId, startChat]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (gainRef.current) {
        gainRef.current.gain.value = next ? 0 : 1;
      }
      return next;
    });
  }, []);

  const doRestart = useCallback(async () => {
    stopRecognition();
    setMicOn(false);
    setMessages([{ role: 'assistant', content: "Fresh start. I'm listening." }]);
    setChatId(null);
    const cid = await startChat();
    // auto-start mic again if audio is unlocked
    if (audioUnlocked && cid) {
      await toggleMic();
    }
  }, [audioUnlocked, startChat, stopRecognition, toggleMic]);

  // autostart flow
  useEffect(() => {
    if (!autostart) return;
    (async () => {
      await startChat();
      // try to unlock audio & start mic immediately
      const okAudio = await ensureAudio();
      const gotMic = await requestMic();
      if (okAudio && gotMic) {
        startRecognition();
        setMicOn(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart]);

  // overlay click handler: guarantees audio unlock + mic prompt + start
  const handleEnableAudio = useCallback(async () => {
    const okAudio = await ensureAudio();
    const gotMic = await requestMic();
    if (okAudio && gotMic) {
      startRecognition();
      setMicOn(true);
      if (!chatId) await startChat();
    }
  }, [chatId, ensureAudio, requestMic, startChat, startRecognition]);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      const t = input.trim();
      if (!t) return;
      append({ role: 'user', content: t });
      setInput('');
      await sendToAgent(t);
    },
    [input, append, sendToAgent]
  );

  const needEnableOverlay = useMemo(() => {
    // show overlay if audio context isn't running yet
    return !audioUnlocked;
  }, [audioUnlocked]);

  return (
    <div className="h-screen w-screen bg-[#0B0F19] text-[#E6E8EE] flex flex-col">
      {/* Top: visualizer placeholder */}
      <div className="flex-1 relative border-b border-white/10">
        <div className="absolute inset-0 flex items-center justify-center">
          {/* simple equalizer bars that animate while speaking or listening */}
          <div className="flex gap-2">
            {[0,1,2,3].map(i => (
              <div key={i}
                   className="w-2 rounded bg-gradient-to-b from-[#6EE7F9] to-[#4185F4]"
                   style={{
                     height: speaking ? `${30 + 20*Math.sin((Date.now()/120)+(i*0.9))}px` : (status==='listening' ? '28px' : '6px'),
                     transition: 'height 120ms linear'
                   }}/>
            ))}
          </div>
        </div>

        {/* Enable audio overlay */}
        {needEnableOverlay && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center">
            <button
              onClick={handleEnableAudio}
              className="px-4 py-2 rounded bg-white/10 hover:bg-white/20 border border-white/20"
              title="Enable audio"
              aria-label="Enable audio"
            >
              Tap to enable audio
            </button>
          </div>
        )}
      </div>

      {/* Bottom: chat */}
      <div className="flex-[1] min-h-[50%] max-h-[50%] flex flex-col">
        {/* Controls */}
        <div className="flex items-center gap-2 p-3 border-b border-white/10">
          <span className="text-xs opacity-80">{status === 'listening' ? 'Listening' : status === 'ready' ? 'Ready' : status}</span>
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
              title={muted ? 'Unmute output' : 'Mute output'}
              aria-label="Mute output"
              className="px-3 py-2 rounded border border-white/20 text-sm hover:bg-white/10"
            >
              🔈 {muted ? 'Off' : 'On'}
            </button>
            <button
              onClick={doRestart}
              title="Restart conversation"
              aria-label="Restart"
              className="px-3 py-2 rounded border border-white/20 text-sm hover:bg-white/10"
            >
              ⟳
            </button>
          </div>
        </div>

        {/* transcript */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {messages.map((m, idx) => (
            <div key={idx} className={`max-w-[80%] px-3 py-2 rounded ${m.role==='user'?'ml-auto bg-white/10':'bg-white/5'}`}>
              {m.content}
            </div>
          ))}
          <div ref={lastMsgRef} />
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
