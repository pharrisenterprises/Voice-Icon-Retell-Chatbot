'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import createRetellRealtime from '../lib/retellRealtime';

const FETCH_JSON = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export default function EmbedPage() {
  const search = useSearchParams();
  const autostart = search.get('autostart') === '1';
  const [chatId, setChatId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [micOn, setMicOn] = useState(true);         // mic starts ON
  const [muted, setMuted] = useState(false);        // output mute
  const [status, setStatus] = useState('idle');     // idle | connecting | ready | speaking | error
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', text: 'Hi! I\'m ready. You can speak, or type below.' },
  ]);

  const inputRef = useRef(null);
  const scrollerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const visualAmpRef = useRef(0); // 0..1 amplitude for visualizer

  // Retell helper instance (recreated on chat restart)
  const rtRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight + 9999, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Audio unlock detection (autoplay / iOS policies)
  useEffect(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') {
        setNeedsAudioUnlock(true);
      }
    } catch (e) {
      // AudioContext not supported; fallback TTS may still work
    }
  }, []);

  const pushMsg = useCallback((role, text) => {
    setMessages(prev => [...prev, { role, text }]);
  }, []);

  const replaceAssistantLiveLine = useCallback((text) => {
    setMessages(prev => {
      // Keep last message if it's an assistant streaming line; else append
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant_stream') {
        const next = prev.slice(0, -1);
        next.push({ role: 'assistant_stream', text });
        return next;
      } else {
        return [...prev, { role: 'assistant_stream', text }];
      }
    });
  }, []);

  const promoteAssistantLiveLine = useCallback(() => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant_stream') {
        const next = prev.slice(0, -1);
        next.push({ role: 'assistant', text: last.text });
        return next;
      }
      return prev;
    });
  }, []);

  const handleAgentText = useCallback((partialOrFinal, isFinal) => {
    // Update transcript live
    if (!partialOrFinal) return;
    if (isFinal) {
      replaceAssistantLiveLine(partialOrFinal);
      promoteAssistantLiveLine();
    } else {
      replaceAssistantLiveLine(partialOrFinal);
    }
  }, [replaceAssistantLiveLine, promoteAssistantLiveLine]);

  const handleUserTextFromMic = useCallback(async (userFinalText) => {
    if (!userFinalText || !userFinalText.trim()) return;
    pushMsg('user', userFinalText.trim());
    scrollToBottom();
    try {
      const data = await FETCH_JSON('/api/retell-chat/send', {
        method: 'POST',
        body: JSON.stringify({ chatId, content: userFinalText.trim() }),
      });
      const reply = (data && data.reply) || '';
      if (reply) {
        // Speak via helper (which honors mute)
        await rtRef.current.speakText(reply);
        pushMsg('assistant', reply);
      }
    } catch (e) {
      pushMsg('assistant', 'Sorry—there was a problem sending that.');
    }
  }, [chatId, pushMsg, scrollToBottom]);

  const handleAudioBuffer = useCallback((amplitude0to1) => {
    // Drive visualizer amplitude
    visualAmpRef.current = Math.max(0, Math.min(1, amplitude0to1 || 0));
  }, []);

  const updateStatus = useCallback((s) => setStatus(s), []);

  const connectHelper = useCallback(async (newChatId) => {
    setConnecting(true);
    // Create or reuse audio context (unlock may be needed first)
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {}
    }

    // Create helper
    const helper = createRetellRealtime();
    rtRef.current = helper;

    await helper.connect({
      // For a Retell realtime setup, you would pass apiKey/agentId here or a signed token.
      // apiKey: process.env.NEXT_PUBLIC_SOMETHING (not required for fallback),
      // agentId: process.env.NEXT_PUBLIC_AGENT_ID,
      onAgentText: handleAgentText,
      onAudioBuffer: handleAudioBuffer,
      onStatus: updateStatus,
      onUserText: handleUserTextFromMic, // extension beyond minimal spec to wire fallback ASR
      getChatId: () => newChatId,
      getMuted: () => muted,
    });

    setConnecting(false);
    if (micOn) {
      try {
        await helper.startMic(); // fallback uses Web Speech; realtime would use getUserMedia
      } catch (e) {
        setStatus('error');
        pushMsg('assistant', 'Mic permissions were blocked. You can still type below.');
        setMicOn(false);
        // Focus input if mic is off
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }
  }, [handleAgentText, handleAudioBuffer, handleUserTextFromMic, micOn, muted, updateStatus, pushMsg]);

  const startNewChat = useCallback(async () => {
    try {
      const data = await FETCH_JSON('/api/retell-chat/start');
      if (data && data.ok && data.chatId) {
        setChatId(data.chatId);
        await connectHelper(data.chatId);
      } else {
        throw new Error('No chatId');
      }
    } catch (e) {
      setStatus('error');
      pushMsg('assistant', 'Could not start a new chat. Please try again.');
    }
  }, [connectHelper, pushMsg]);

  // Autostart on first mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (autostart) {
        await startNewChat();
      }
      if (cancelled) return;
    })();
    return () => { cancelled = true; rtRef.current?.disconnect(); };
  }, [autostart, startNewChat]);

  // Visualizer animation loop (CSS vars or inline style)
  const [vizTick, setVizTick] = useState(0);
  useEffect(() => {
    let raf;
    const loop = () => {
      setVizTick(t => (t + 1) % 1000000); // just to refresh
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Handlers
  const onToggleMic = useCallback(async () => {
    if (!rtRef.current) return;
    if (micOn) {
      await rtRef.current.stopMic();
      setMicOn(false);
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      try {
        await rtRef.current.startMic();
        setMicOn(true);
      } catch (e) {
        setStatus('error');
        pushMsg('assistant', 'Mic permission denied. You can still type below.');
      }
    }
  }, [micOn, pushMsg]);

  const onToggleMute = useCallback(() => {
    setMuted(m => !m);
  }, []);

  const onRestart = useCallback(async () => {
    // Disconnect and clear chat, then start again
    rtRef.current?.disconnect();
    setMessages([]);
    pushMsg('assistant', 'Starting a fresh conversation...');
    setStatus('connecting');
    await startNewChat();
  }, [pushMsg, startNewChat]);

  const onSubmit = useCallback(async (e) => {
    e.preventDefault();
    const v = inputRef.current?.value || '';
    if (!v.trim()) return;
    inputRef.current.value = '';
    pushMsg('user', v.trim());
    try {
      const data = await FETCH_JSON('/api/retell-chat/send', {
        method: 'POST',
        body: JSON.stringify({ chatId, content: v.trim() }),
      });
      const reply = (data && data.reply) || '';
      if (reply) {
        await rtRef.current?.speakText(reply);
        pushMsg('assistant', reply);
      }
    } catch (e2) {
      pushMsg('assistant', 'Sorry—there was a problem sending that.');
    }
  }, [chatId, pushMsg]);

  const onUnlockAudio = useCallback(async () => {
    try {
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      // Fire a tiny silent utterance to unlock speechSynthesis on iOS/Safari
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0; // silent
        window.speechSynthesis.speak(u);
      } catch (e) {}
      setNeedsAudioUnlock(false);
    } catch (e) {
      // stays locked
    }
  }, []);

  // Viz bars heights based on amplitude
  const amp = visualAmpRef.current;
  const barHeights = useMemo(() => {
    const base = [0.3, 0.6, 0.9, 0.6, 0.3];
    return base.map((b, i) => {
      // jitter per tick for a more organic feel when "speaking"
      const j = (Math.sin((vizTick + i * 13) / 7) + 1) / 2 * 0.12;
      const h = (amp > 0 ? Math.max(amp, 0.2) : 0) * b + j;
      return Math.max(0.06, Math.min(1, h));
    });
  }, [amp, vizTick]);

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
          {barHeights.map((h, idx) => (
            <span key={idx} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>
        <div className="statusline">
          <span className="dot" data-state={status} />
          <span className="text">
            {status === 'connecting' && 'Connecting…'}
            {status === 'ready' && (micOn ? 'Listening' : 'Mic off')}
            {status === 'speaking' && 'Speaking'}
            {status === 'idle' && 'Ready'}
            {status === 'error' && 'Error'}
          </span>
        </div>

        <div className="controls">
          <button
            className={`btn ${micOn ? 'on' : 'off'}`}
            onClick={onToggleMic}
            title={micOn ? 'Turn mic off' : 'Turn mic on'}
            aria-label="Mic"
          >
            {micOn ? '🎙️ On' : '🎙️ Off'}
          </button>
          <button
            className={`btn ${!muted ? 'on' : 'off'}`}
            onClick={onToggleMute}
            title={!muted ? 'Mute output' : 'Unmute output'}
            aria-label="Mute output"
          >
            {!muted ? '🔊' : '🔇'}
          </button>
          <button className="btn" onClick={onRestart} title="Restart conversation" aria-label="Restart">
            ⟳
          </button>
        </div>
      </div>

      <div className="bottom">
        <div className="chat" ref={scrollerRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">{m.text}</div>
            </div>
          ))}
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
        .wrap {
          height: 100%;
          width: 100%;
          background: #0b0f19;
          color: #e6e8ee;
          display: grid;
          grid-template-rows: 1fr 1fr;
        }
        .audio-unlock {
          position: absolute;
          inset: 0;
          background: rgba(11,15,25,0.92);
          display: flex; align-items: center; justify-content: center;
          z-index: 5;
        }
        .unlock-btn {
          background: #2a6df1;
          border: none;
          color: white;
          padding: 10px 16px;
          border-radius: 10px;
          font-weight: 600;
          cursor: pointer;
        }
        .top { position: relative; padding: 16px; display: grid; grid-template-rows: auto auto auto; gap: 12px; }
        .visualizer {
          height: 120px; max-height: 35vh;
          background: radial-gradient(ellipse at center, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
          border-radius: 12px;
          display: grid; grid-template-columns: repeat(5, 1fr);
          align-items: end; gap: 8px;
          padding: 10px;
          overflow: hidden;
        }
        .visualizer span {
          display: block;
          width: 100%;
          background: linear-gradient(180deg, #7aa2ff, #2a6df1);
          border-radius: 6px 6px 0 0;
          transition: height 90ms ease;
        }
        .statusline { display: inline-flex; align-items: center; gap: 10px; opacity: .85; font-size: 12px; }
        .statusline .dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #5b6b82;
        }
        .statusline .dot[data-state="connecting"] { background: #f1c40f; }
        .statusline .dot[data-state="ready"] { background: #30d158; }
        .statusline .dot[data-state="speaking"] { background: #2a6df1; }
        .statusline .dot[data-state="error"] { background: #ff453a; }

        .controls { display: inline-flex; gap: 8px; }
        .btn {
          background: rgba(255,255,255,0.06);
          color: #e6e8ee;
          border: 1px solid rgba(255,255,255,0.1);
          padding: 8px 10px; border-radius: 10px;
          cursor: pointer; font-size: 13px;
        }
        .btn.on { background: rgba(42, 109, 241, 0.2); border-color: rgba(42, 109, 241, 0.4); }
        .btn.off { opacity: 0.85; }

        .bottom { display: grid; grid-template-rows: 1fr auto; min-height: 0; }
        .chat { overflow: auto; padding: 12px 12px 4px; }
        .msg { display: flex; margin: 6px 0; }
        .msg.user { justify-content: flex-end; }
        .msg .bubble {
          max-width: 80%;
          padding: 10px 12px; border-radius: 12px;
          background: rgba(255,255,255,0.06); color: #e6e8ee;
          font-size: 14px; line-height: 1.35;
          white-space: pre-wrap;
        }
        .msg.user .bubble { background: #2a6df1; color: white; }
        .msg.assistant_stream .bubble { border: 1px dashed rgba(255,255,255,0.25); background: rgba(255,255,255,0.04); }

        .composer {
          display: grid; grid-template-columns: 1fr auto; gap: 8px;
          padding: 8px 12px 12px; border-top: 1px solid rgba(255,255,255,0.08);
        }
        .composer input {
          background: rgba(255,255,255,0.06);
          color: #e6e8ee; border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; height: 38px; padding: 0 12px;
          outline: none;
        }
        .composer input:focus { border-color: rgba(42,109,241,0.6); }
        .composer .send {
          height: 38px; padding: 0 12px; border-radius: 10px;
          background: rgba(42,109,241,0.2); border: 1px solid rgba(42,109,241,0.5);
          color: #e6e8ee; cursor: pointer;
        }

        @media (max-width: 480px) {
          .visualizer { height: 90px; }
          .composer .send { padding: 0 10px; }
        }
      `}</style>
    </div>
  );
}
