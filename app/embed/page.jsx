'use client';
export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import createRetellRealtime from '../lib/retellRealtime';

const GET = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
};
const POST = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `POST ${url} -> ${r.status}`);
  return j;
};

export default function EmbedPage() {
  // read ?autostart=1 without useSearchParams (avoids prerender error)
  const [autostart, setAutostart] = useState(false);
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      setAutostart(p.get('autostart') === '1');
    } catch {}
  }, []);

  const [chatId, setChatId] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', text: "Hi! I'm ready. You can speak, or type below." },
  ]);

  // CALMER STATUS: only four states we surface to the user
  // 'idle' | 'ready' | 'speaking' | 'error'
  const [status, setStatus] = useState('idle');
  const setStatusCalm = useCallback((s) => {
    // collapse noisy transitions
    if (s === 'connecting') s = micOn ? 'ready' : 'idle';
    setStatus(s);
  }, [micOn]);

  const inputRef = useRef(null);
  const scrollerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const visualAmpRef = useRef(0);
  const rtRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight + 9999;
  }, []);
  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  // Audio unlock probe
  useEffect(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') setNeedsAudioUnlock(true);
    } catch {}
  }, []);

  const pushMsg = useCallback((role, text) => {
    setMessages((m) => [...m, { role, text }]);
  }, []);
  const replaceAssistantLiveLine = useCallback((text) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant_stream') {
        const next = prev.slice(0, -1);
        next.push({ role: 'assistant_stream', text });
        return next;
      }
      return [...prev, { role: 'assistant_stream', text }];
    });
  }, []);
  const promoteAssistantLiveLine = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant_stream') {
        const next = prev.slice(0, -1);
        next.push({ role: 'assistant', text: last.text });
        return next;
      }
      return prev;
    });
  }, []);

  // Agent partial/final text (used by realtime or when we TTS)
  const handleAgentText = useCallback((txt, isFinal) => {
    if (!txt) return;
    if (isFinal) {
      replaceAssistantLiveLine(txt);
      promoteAssistantLiveLine();
    } else {
      replaceAssistantLiveLine(txt);
    }
  }, [replaceAssistantLiveLine, promoteAssistantLiveLine]);

  // From fallback ASR when user finishes a phrase
  const handleUserTextFromMic = useCallback(async (finalText) => {
    if (!finalText || !finalText.trim()) return;
    const content = finalText.trim();
    pushMsg('user', content);
    try {
      const data = await POST('/api/retell-chat/send', { chatId, content });
      const reply = data?.reply || '';
      if (reply) {
        await rtRef.current?.speakText(reply);
        pushMsg('assistant', reply);
      } else {
        pushMsg('assistant', 'No reply from agent.');
      }
    } catch (e) {
      pushMsg('assistant', `There was a problem talking to the agent: ${e.message || e}`);
      setStatusCalm('error');
    }
  }, [chatId, pushMsg, setStatusCalm]);

  // Visualizer amp
  const handleAudioBuffer = useCallback((amp) => {
    // smooth to avoid flicker
    const prev = visualAmpRef.current;
    visualAmpRef.current = prev * 0.7 + (Math.max(0, Math.min(1, amp || 0))) * 0.3;
  }, []);

  const connectHelper = useCallback(async (newChatId) => {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    const helper = createRetellRealtime();
    rtRef.current = helper;
    await helper.connect({
      onAgentText: handleAgentText,
      onAudioBuffer: handleAudioBuffer,
      onStatus: setStatusCalm,      // calm version
      onUserText: handleUserTextFromMic,
      getChatId: () => newChatId,
      getMuted: () => muted,
    });
    // Only start mic if switch is ON
    if (micOn) {
      try {
        await helper.startMic();
        setStatusCalm('ready');
      } catch (e) {
        pushMsg('assistant', 'Mic permission was blocked. You can still type below.');
        setMicOn(false);
        setStatusCalm('idle');
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }
  }, [handleAgentText, handleAudioBuffer, handleUserTextFromMic, micOn, muted, setStatusCalm, pushMsg]);

  const startNewChat = useCallback(async () => {
    try {
      const data = await GET('/api/retell-chat/start');
      if (data?.ok && data.chatId) {
        setChatId(data.chatId);
        await connectHelper(data.chatId);
      } else {
        throw new Error('No chatId from /start');
      }
    } catch (e) {
      setStatusCalm('error');
      pushMsg('assistant', `Could not start a new chat. ${e.message || e}`);
    }
  }, [connectHelper, pushMsg, setStatusCalm]);

  // autostart
  useEffect(() => {
    let alive = true;
    (async () => { if (autostart) await startNewChat(); if (!alive) return; })();
    return () => { alive = false; rtRef.current?.disconnect(); };
  }, [autostart, startNewChat]);

  // UI actions
  const onToggleMic = useCallback(async () => {
    if (!rtRef.current) return;
    if (micOn) {
      await rtRef.current.stopMic();
      setMicOn(false);
      setStatusCalm('idle');
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      try {
        await rtRef.current.startMic();
        setMicOn(true);
        setStatusCalm('ready');
      } catch {
        pushMsg('assistant', 'Mic permission denied. You can still type below.');
        setStatusCalm('idle');
      }
    }
  }, [micOn, pushMsg, setStatusCalm]);

  const onToggleMute = useCallback(() => setMuted((m) => !m), []);
  const onRestart = useCallback(async () => {
    rtRef.current?.disconnect();
    setMessages([{ role: 'assistant', text: 'Starting a fresh conversation…' }]);
    setStatusCalm('idle');
    await startNewChat();
  }, [setStatusCalm, startNewChat]);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const v = inputRef.current?.value || '';
    if (!v.trim()) return;
    inputRef.current.value = '';
    pushMsg('user', v.trim());
    try {
      const data = await POST('/api/retell-chat/send', { chatId, content: v.trim() });
      const reply = data?.reply || '';
      if (reply) {
        await rtRef.current?.speakText(reply);
        pushMsg('assistant', reply);
      } else {
        pushMsg('assistant', 'No reply from agent.');
      }
    } catch (e2) {
      pushMsg('assistant', `There was a problem talking to the agent: ${e2.message || e2}`);
      setStatusCalm('error');
    }
  }, [chatId, pushMsg, setStatusCalm]);

  const onUnlockAudio = useCallback(async () => {
    try {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      // kick TTS once
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      } catch {}
      setNeedsAudioUnlock(false);
    } catch {}
  }, []);

  // visualizer bars
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf;
    const loop = () => { setTick((t) => (t + 1) % 1000000); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const amp = visualAmpRef.current;
  const barHeights = useMemo(() => {
    const base = [0.3, 0.6, 0.9, 0.6, 0.3];
    return base.map((b, i) => {
      const wiggle = (Math.sin((tick + i * 13) / 7) + 1) / 2 * 0.08;
      const h = (amp > 0 ? Math.max(amp, 0.2) : 0) * b + wiggle;
      return Math.max(0.06, Math.min(1, h));
    });
  }, [amp, tick]);

  return (
    <div className="wrap">
      {needsAudioUnlock && (
        <div className="audio-unlock">
          <button className="unlock-btn" onClick={onUnlockAudio} aria-label="Enable audio" title="Enable audio">
            Enable audio
          </button>
        </div>
      )}

      <div className="top">
        <div className={`visualizer ${status === 'speaking' ? 'talking' : ''}`}>
          {barHeights.map((h, idx) => (<span key={idx} style={{ height: `${Math.round(h * 100)}%` }} />))}
        </div>
        <div className="statusline">
          <span className="text">
            {status === 'ready' && (micOn ? 'Listening' : 'Mic off')}
            {status === 'speaking' && 'Speaking'}
            {status === 'idle' && (micOn ? 'Ready' : 'Mic off')}
            {status === 'error' && 'Error – check agent API'}
          </span>
        </div>

        <div className="controls">
          <button className={`btn ${micOn ? 'on' : 'off'}`} onClick={onToggleMic} title={micOn ? 'Turn mic off' : 'Turn mic on'} aria-label="Mic">
            {micOn ? '🎙️ On' : '🎙️ Off'}
          </button>
          <button className={`btn ${!muted ? 'on' : 'off'}`} onClick={onToggleMute} title={!muted ? 'Mute output' : 'Unmute output'} aria-label="Mute output">
            {!muted ? '🔊' : '🔇'}
          </button>
          <button className="btn" onClick={onRestart} title="Restart conversation" aria-label="Restart">⟳</button>
        </div>
      </div>

      <div className="bottom">
        <div className="chat" ref={scrollerRef}>
          {messages.map((m, i) => (<div key={i} className={`msg ${m.role}`}><div className="bubble">{m.text}</div></div>))}
        </div>
        <form className="composer" onSubmit={onSubmit}>
          <input
            ref={inputRef}
            type="text"
            placeholder={micOn ? 'Type a message… (mic is on)' : 'Type a message… (mic is off)'}
            aria-label="Message"
            autoComplete="off"
          />
          <button className="send" aria-label="Send" title="Send">↩︎</button>
        </form>
      </div>

      <style jsx>{`
        .wrap { height: 100%; width: 100%; background:#0b0f19; color:#e6e8ee; display:grid; grid-template-rows: 1fr 1fr; }
        .audio-unlock { position:absolute; inset:0; background:rgba(11,15,25,.92); display:flex; align-items:center; justify-content:center; z-index:5; }
        .unlock-btn { background:#2a6df1; border:none; color:#fff; padding:10px 16px; border-radius:10px; font-weight:600; cursor:pointer; }
        .top { position:relative; padding:16px; display:grid; grid-template-rows:auto auto auto; gap:12px; }
        .visualizer { height:120px; background:radial-gradient(ellipse at center, rgba(255,255,255,.06), rgba(255,255,255,.02)); border-radius:12px;
                      display:grid; grid-template-columns:repeat(5,1fr); align-items:end; gap:8px; padding:10px; overflow:hidden; }
        .visualizer span { display:block; width:100%; background:linear-gradient(180deg,#7aa2ff,#2a6df1); border-radius:6px 6px 0 0; transition:height 120ms ease; }
        .statusline { font-size:12px; opacity:.85; }
        .controls { display:inline-flex; gap:8px; }
        .btn { background:rgba(255,255,255,.06); color:#e6e8ee; border:1px solid rgba(255,255,255,.1); padding:8px 10px; border-radius:10px; cursor:pointer; font-size:13px; }
        .btn.on { background:rgba(42,109,241,.2); border-color:rgba(42,109,241,.4); }
        .btn.off { opacity:.85; }
        .bottom { display:grid; grid-template-rows:1fr auto; min-height:0; }
        .chat { overflow:auto; padding:12px 12px 4px; }
        .msg { display:flex; margin:6px 0; }
        .msg.user { justify-content:flex-end; }
        .msg .bubble { max-width:80%; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.06); color:#e6e8ee; font-size:14px; line-height:1.35; white-space:pre-wrap; }
        .msg.user .bubble { background:#2a6df1; color:#fff; }
        .msg.assistant_stream .bubble { border:1px dashed rgba(255,255,255,.25); background:rgba(255,255,255,.04); }
        .composer { display:grid; grid-template-columns:1fr auto; gap:8px; padding:8px 12px 12px; border-top:1px solid rgba(255,255,255,.08); }
        .composer input { background:rgba(255,255,255,.06); color:#e6e8ee; border:1px solid rgba(255,255,255,.1); border-radius:10px; height:38px; padding:0 12px; outline:none; }
        .composer input:focus { border-color:rgba(42,109,241,.6); }
        .composer .send { height:38px; padding:0 12px; border-radius:10px; background:rgba(42,109,241,.2); border:1px solid rgba(42,109,241,.5); color:#e6e8ee; cursor:pointer; }
        @media (max-width:480px){ .visualizer{ height:90px; } .composer .send{ padding:0 10px; } }
      `}</style>
    </div>
  );
}
