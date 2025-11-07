'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * After this patch:
 * - Parent click calls __unlockGestureFromParent() synchronously (same gesture).
 * - That unlock resumes AudioContext, does a zero-volume WebSpeech tick, starts mic,
 *   and triggers the greet so Azure speaks within ~1s.
 * - Close cancels timers/audio; reopen repeats reliably and keeps the same chatId.
 */

const INITIAL_MIC_ON = true;
const INITIAL_SOUND_ON = true;
const IDLE_TIMEOUT_MS = 60_000;

const ECHO_GUARD_BEFORE_MS = 150;
const ECHO_GUARD_AFTER_MS = 1200;
const LISTEN_RESUME_DELAY_MS = 250;
const RESTART_BACKOFF_MS = 180;

const AZURE_RATE = 'medium';
const AZURE_PITCH = '+8%';
const AZURE_STYLE = 'cheerful';

function now() { return Date.now(); }
function cls(...a) { return a.filter(Boolean).join(' '); }

function useAutoScroll(depKey) {
  const listRef = useRef(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const t = setTimeout(() => { el.scrollTop = el.scrollHeight; }, 30);
    return () => clearTimeout(t);
  }, [depKey]);
  return listRef;
}

export default function EmbedPage() {
  const [micOn, setMicOn] = useState(INITIAL_MIC_ON);
  const [soundOn, setSoundOn] = useState(INITIAL_SOUND_ON);
  const [status, setStatus] = useState('');
  const [chatId, setChatId] = useState(null);

  const [messages, setMessages] = useState(() => [
    { role: 'assistant', content: "G’day! I’m Otto 👋  Type below or tap the mic to talk." }
  ]);
  const listRef = useAutoScroll(messages.length);

  const audioElRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyzerRef = useRef(null);
  const animRef = useRef(0);

  const recognizerRef = useRef(null);
  const wantListeningRef = useRef(INITIAL_MIC_ON);
  const speakingRef = useRef(false);
  const speakGuardUntilRef = useRef(0);

  const lastActivityRef = useRef(now());
  const idleTimerRef = useRef(0);

  const [speaking, setSpeaking] = useState(false);

  const sessionRef = useRef(0);
  const kickoffSeqRef = useRef(0);
  const kickoffTimerRef = useRef(0);

  const VOICE = useMemo(() => {
    const v =
      process.env.AZURE_TTS_VOICE ||
      process.env.NEXT_PUBLIC_AZURE_TTS_VOICE ||
      'en-AU-KimNeural';
    try { console.info('[Widget] Using Azure voice:', v); } catch {}
    return v;
  }, []);
  const azureRef = useRef({ token: null, region: null, exp: 0 });

  function ensureAudioContextArmed() {
    const audio = audioElRef.current;
    if (!audio) return;
    const create = () => {
      try {
        const Ctor = (window.AudioContext || window.webkitAudioContext);
        if (!Ctor) return;
        const ctx = new Ctor();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        analyzerRef.current = analyser;
      } catch {}
    };
    if (!audioCtxRef.current) { create(); }
    else { try { audioCtxRef.current.resume(); } catch {} }
  }

  function primeAutoplayUnlock() {
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const buffer = ctx.createBuffer(1, 64, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
      src.stop(0.01);
    } catch {}
  }

  function zeroVolumeWebSpeechTick() {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      try { window.speechSynthesis.cancel(); } catch {}
      const u = new SpeechSynthesisUtterance('unlock');
      u.volume = 0;
      u.onend = resolve;
      u.onerror = resolve;
      try { window.speechSynthesis.speak(u); } catch { resolve(); }
      setTimeout(resolve, 350);
    });
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/retell-chat/start', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (j?.ok && j.chatId) setChatId(j.chatId);
      } catch {}
    })();

    const audio = new Audio();
    audioElRef.current = audio;

    // pre-arm if user interacts inside iframe later
    const unlock = () => {
      if (!audioCtxRef.current) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          audioCtxRef.current = ctx;
          const src = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          analyser.connect(ctx.destination);
          analyzerRef.current = analyser;
        } catch {}
      } else {
        audioCtxRef.current.resume().catch(() => {});
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // expose teardown
    window.widgetStop = teardown;

    // expose a sync unlock called by parent during the same click gesture
    (window).__unlockGestureFromParent = async () => {
      // real user gesture context
      setSoundOn(true);
      wantListeningRef.current = true;
      setMicOn(true);
      ensureAudioContextArmed();
      try { audioCtxRef.current && audioCtxRef.current.resume(); } catch {}
      primeAutoplayUnlock();
      await zeroVolumeWebSpeechTick(); // keeps Azure as the audible voice later
      // start mic and schedule kickoff quickly
      startRecognition(false);
      try { clearTimeout(kickoffTimerRef.current || 0); } catch {}
      kickoffSeqRef.current += 1;
      const token = kickoffSeqRef.current;
      kickoffTimerRef.current = window.setTimeout(() => { kickoffAssistantFirst(token); }, 120);
    };

    return () => {
      try { delete window.widgetStop; } catch {}
      try { delete (window).__unlockGestureFromParent; } catch {}
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureMicPermission() {
    try {
      await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 }
      });
    } catch (e) { console.warn('Mic permission denied/unavailable', e); }
  }

  function armIdleTimer() {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      wantListeningRef.current = false;
      setMicOn(false);
      stopRecognition('idle');
      setStatus('Turn Mic On to Speak');
    }, IDLE_TIMEOUT_MS);
  }
  function bumpActivity() { lastActivityRef.current = now(); armIdleTimer(); }

  function createRecognizer() {
    // eslint-disable-next-line no-undef
    const R = new window.webkitSpeechRecognition();
    R.continuous = true;
    R.interimResults = false;
    R.lang = 'en-US';
    R.onstart = () => setStatus('Listening');
    R.onend = () => {
      if (wantListeningRef.current && !speakingRef.current) {
        setTimeout(() => { try { R.start(); } catch {} }, RESTART_BACKOFF_MS);
      } else {
        if (!wantListeningRef.current) setStatus('Turn Mic On to Speak'); else setStatus('');
      }
    };
    R.onerror = () => {
      if (wantListeningRef.current && !speakingRef.current) {
        setTimeout(() => { try { R.start(); } catch {} }, 400);
      }
    };
    R.onresult = (e) => {
      if (now() < speakGuardUntilRef.current || speakingRef.current) return;
      let t = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) t += (res[0]?.transcript || '');
      }
      t = (t || '').trim();
      if (!t) return;
      handleUserTranscript(t);
    };
    return R;
  }

  function startRecognition(fromUserToggle = false) {
    wantListeningRef.current = true;
    setMicOn(true);
    setStatus('Listening');

    if (!recognizerRef.current) {
      if (!('webkitSpeechRecognition' in window)) {
        setMicOn(false);
        wantListeningRef.current = false;
        setStatus('Mic not supported');
        return;
      }
      recognizerRef.current = createRecognizer();
    }
    try { recognizerRef.current.start(); } catch {}
    if (fromUserToggle) bumpActivity();
  }

  function stopRecognition() { try { recognizerRef.current?.stop(); } catch {} }

  async function getAzureToken() {
    const cache = azureRef.current;
    if (cache.token && cache.exp > now() + 10_000) return cache;
    const r = await fetch('/api/azure-tts-token', { method: 'GET', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!j?.ok || !j.token) throw new Error('azure token fetch failed');
    azureRef.current = { token: j.token, region: j.region, exp: now() + 9 * 60 * 1000 };
    return azureRef.current;
  }

  function buildSSML(text) {
    const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<?xml version="1.0"?>
<speak version="1.0" xml:lang="en-US">
  <voice name="${VOICE}">
    <prosody rate="${AZURE_RATE}" pitch="${AZURE_PITCH}">
      <mstts:express-as xmlns:mstts="https://www.w3.org/2001/mstts" style="${AZURE_STYLE}">
        ${esc(text)}
      </mstts:express-as>
    </prosody>
  </voice>
</speak>`;
  }

  async function playAzureTTS(text) {
    const mySession = sessionRef.current;
    const { token, region } = await getAzureToken();
    if (mySession !== sessionRef.current) throw new Error('cancelled');

    const ttsUrl = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const r = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
      },
      body: buildSSML(text)
    });
    if (!r.ok) throw new Error('azure tts failed');
    if (mySession !== sessionRef.current) throw new Error('cancelled');

    const buf = await r.arrayBuffer();
    if (mySession !== sessionRef.current) throw new Error('cancelled');

    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);

    const audio = audioElRef.current;
    return new Promise((resolve, reject) => {
      let cleaned = false;
      const cleanup = () => { if (cleaned) return; cleaned = true; try { URL.revokeObjectURL(url); } catch {} };

      try {
        if (mySession !== sessionRef.current) { cleanup(); return reject(new Error('cancelled')); }
        audio.onended = () => { cleanup(); resolve(); };
        audio.onerror  = () => { cleanup(); reject(new Error('audio error')); };
        audio.onplay   = () => {
          if (mySession !== sessionRef.current) { try { audio.pause(); } catch {}; cleanup(); reject(new Error('cancelled')); }
        };
        audio.src = url;
        const p = audio.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {}).catch((e) => { cleanup(); reject(e || new Error('play blocked')); });
        }
      } catch (e) { cleanup(); reject(e); }
    });
  }

  function playWebSpeech(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15; u.pitch = 1.08;
      u.onend = resolve; u.onerror = resolve;
      try { window.speechSynthesis.cancel(); } catch {}
      try { window.speechSynthesis.speak(u); } catch {}
    });
  }

  async function speakText(text) {
    if (!text) return;
    const mySession = sessionRef.current;
    speakingRef.current = true;
    setSpeaking(true);
    setStatus('Speaking');
    stopRecognition('tts');
    speakGuardUntilRef.current = now() + ECHO_GUARD_BEFORE_MS;

    const finish = () => {
      if (mySession !== sessionRef.current) return;
      speakGuardUntilRef.current = now() + ECHO_GUARD_AFTER_MS;
      speakingRef.current = false;
      setSpeaking(false);
      if (wantListeningRef.current) setTimeout(() => startRecognition(false), LISTEN_RESUME_DELAY_MS);
      else setStatus('Turn Mic On to Speak');
    };

    try {
      if (soundOn) {
        try { await playAzureTTS(text); }
        catch { await playWebSpeech(text); }
      } else {
        await new Promise((r) => setTimeout(r, 220));
      }
    } catch {} finally { finish(); }
  }

  async function sendToAgent(text) {
    if (!text) return '';
    try {
      const r = await fetch('/api/retell-chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, content: text })
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok && typeof j.reply === 'string') return j.reply;
    } catch {}
    return "Sorry—I'm having trouble right now.";
  }

  async function handleUserTranscript(text) {
    bumpActivity();
    setMessages((m) => [...m, { role: 'user', content: text }]);
    const reply = await sendToAgent(text);
    setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    bumpActivity();
    await speakText(reply);
  }

  function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const t = (fd.get('t') || '').toString().trim();
    if (!t) return;
    e.currentTarget.reset();
    handleUserTranscript(t);
  }

  function handleRestart() {
    setMessages([{ role: 'assistant', content: "G’day! I’m Otto 👋  Type below or tap the mic to talk." }]);
    fetch('/api/retell-chat/start', { cache: 'no-store' })
      .then(r => r.json().catch(() => ({})))
      .then(j => { if (j?.ok && j.chatId) setChatId(j.chatId); });
    if (micOn) {
      stopRecognition('restart');
      setTimeout(() => startRecognition(false), 120);
    }
  }

  function toggleMic() {
    if (micOn) {
      wantListeningRef.current = false;
      setMicOn(false);
      stopRecognition('toggle_off');
      setStatus('Turn Mic On to Speak');
    } else {
      ensureMicPermission().finally(() => {
        wantListeningRef.current = true;
        startRecognition(true);
      });
    }
  }

  function toggleSound() { setSoundOn((v) => !v); bumpActivity(); }

  const barsRef = useRef(null);
  useEffect(() => {
    let raf = 0;
    function draw() {
      const container = barsRef.current;
      if (!container) return;
      const analyser = analyzerRef.current;
      const children = container.children;
      if (!children || children.length === 0) return;

      if (analyser && (speaking || (audioElRef.current && !audioElRef.current.paused))) {
        const bufLen = analyser.frequencyBinCount;
        const data = new Uint8Array(bufLen);
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < children.length; i++) {
          const idx = ((i / children.length) * bufLen) | 0;
          const v = (data[idx] || 0) / 255;
          const h = 8 + Math.round(v * 36);
          children[i].style.transform = `scaleY(${Math.max(0.15, h / 36)})`;
          children[i].style.opacity = Math.max(0.35, v + 0.25).toString();
        }
      } else {
        const t = (now() / 550) % (2 * Math.PI);
        for (let i = 0; i < children.length; i++) {
          const v = (Math.sin(t + i * 0.35) + 1) / 2;
          const h = 8 + Math.round(v * 20);
          children[i].style.transform = `scaleY(${Math.max(0.15, h / 36)})`;
          children[i].style.opacity = (0.35 + v * 0.3).toString();
        }
      }
      raf = requestAnimationFrame(draw);
      animRef.current = raf;
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [speaking]);

  function teardown() {
    sessionRef.current++;
    try { clearTimeout(kickoffTimerRef.current || 0); } catch {}
    kickoffTimerRef.current = 0;

    try { recognizerRef.current?.stop(); } catch {}
    recognizerRef.current = null;

    wantListeningRef.current = false;
    setMicOn(false);

    try { clearTimeout(idleTimerRef.current); } catch {}
    idleTimerRef.current = 0;

    try { cancelAnimationFrame(animRef.current || 0); } catch {}
    animRef.current = 0;

    try {
      const a = audioElRef.current;
      if (a) { a.onended = null; a.onerror = null; a.onplay = null; a.pause(); a.src = ''; try { a.load(); } catch {} }
    } catch {}

    try { window.speechSynthesis?.cancel(); } catch {}

    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    analyzerRef.current = null;

    speakingRef.current = false;
    setSpeaking(false);
    setSoundOn(false);
    setStatus('Turn Mic On to Speak');
  }

  // Also handle postMessage open/close (kept for safety)
  useEffect(() => {
    function onMessage(evt) {
      try {
        const data = evt?.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'avatar-widget:close') {
          teardown();
        } else if (data.type === 'avatar-widget:open' || data.type === 'avatar-widget:kickoff') {
          // Fallback path if parent didn't call gesture() for some reason
          setSoundOn(true);
          wantListeningRef.current = true;
          setMicOn(true);
          ensureMicPermission().finally(() => startRecognition(false));
          try { clearTimeout(kickoffTimerRef.current || 0); } catch {}
          kickoffSeqRef.current += 1;
          const token = kickoffSeqRef.current;
          kickoffTimerRef.current = window.setTimeout(() => { kickoffAssistantFirst(token); }, 800);
        }
      } catch {}
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [chatId]);

  async function waitForChatId(maxMs = 6000) {
    const start = now();
    while (!chatId && now() - start < maxMs) {
      await new Promise(r => setTimeout(r, 50));
    }
    return !!chatId;
  }

  async function kickoffAssistantFirst(seqToken) {
    const ok = await waitForChatId(6000);
    if (!ok || seqToken !== kickoffSeqRef.current) return;

    ensureAudioContextArmed();
    primeAutoplayUnlock();

    const reply = await sendToAgent('Hello');
    if (seqToken !== kickoffSeqRef.current) return;
    setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    await speakText(reply);
  }

  return (
    <div className="wrap">
      <style>{styles}</style>

      <div className="top">
        <div className="statusRow">
          <div className={cls('pill', micOn ? (speaking ? 'pillSpeaking' : 'pillOn') : 'pillOff')}>
            {micOn ? (speaking ? 'Speaking' : (status || 'Listening')) : (status || 'Turn Mic On to Speak')}
          </div>

          <div className="controls">
            <button className={cls('btn', micOn ? '' : 'btnOff')} onClick={toggleMic} title={micOn ? 'Turn microphone off' : 'Turn microphone on'} aria-label="Toggle microphone">
              <span className="i">🎙️</span><span>{micOn ? 'Mic On' : 'Mic Off'}</span>
            </button>
            <button className={cls('btn', soundOn ? '' : 'btnOff')} onClick={toggleSound} title={soundOn ? 'Mute assistant' : 'Unmute assistant'} aria-label="Toggle sound">
              <span className="i">🔊</span><span>{soundOn ? 'Sound On' : 'Sound Off'}</span>
            </button>
            <button className="btn" onClick={handleRestart} title="Restart conversation" aria-label="Restart conversation">
              <span className="i">🔄</span><span>Restart</span>
            </button>
          </div>
        </div>

        <div className="bars" ref={barsRef} aria-hidden>
          {Array.from({ length: 48 }).map((_, i) => <span key={i} />)}
        </div>
      </div>

      <div className="chat">
        <header className="chatHead">
          <div className="title"><strong>Otto</strong> — <span>Your Auto-Mate!</span></div>
        </header>

        <div className="list" ref={listRef}>
          {messages.map((m, i) => (
            <div key={i} className={cls('bubble', m.role === 'user' ? 'user' : 'assistant')}>{m.content}</div>
          ))}
        </div>

        <form className="inputRow" onSubmit={handleSubmit}>
          <input name="t" className="inp" placeholder={`Type a message… ${micOn ? '(mic is on)' : '(mic is off)'}`} autoComplete="off" onFocus={bumpActivity} onKeyDown={bumpActivity} />
          <button className="send" aria-label="Send message" title="Send">➤</button>
        </form>
      </div>
    </div>
  );
}

const styles = `
/* styles unchanged */
.wrap{display:flex;flex-direction:column;width:100%;height:100%;background:#0B0F19;color:#E6E8EE;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.top{flex:0 0 45%;min-height:180px;padding:14px 14px 8px;display:flex;flex-direction:column}
.statusRow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.pill{font-size:12px;letter-spacing:.2px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08)}
.pillOn{background:rgba(22,163,74,0.15);border-color:rgba(22,163,74,0.35);color:#b9f6ca}
.pillSpeaking{background:rgba(59,130,246,0.18);border-color:rgba(59,130,246,0.45);color:#dbeafe}
.pillOff{background:rgba(148,163,184,0.12);border-color:rgba(148,163,184,0.28);color:#e2e8f0}
.controls{display:flex;gap:8px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;background:rgba(255,255,255,0.06);color:#E6E8EE;border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-size:12px;cursor:pointer;transition:all .15s ease}
.btn:hover{background:rgba(255,255,255,0.12)}
.btnOff{opacity:.7;background:rgba(15,23,42,0.6)}
.btn .i{font-size:14px}
.bars{flex:1;display:flex;align-items:flex-end;gap:4px;padding:14px 10px;background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02));border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden}
.bars span{display:block;width:calc((100% - 47*4px)/48);height:36px;transform-origin:bottom;background:linear-gradient(180deg,#7cc6ff,#3b82f6);border-radius:4px;opacity:.6;transform:scaleY(.3)}
.chat{flex:1;display:flex;flex-direction:column;border-top:1px solid rgba(255,255,255,0.06)}
.chatHead{flex:0 0 auto;padding:10px 14px;display:flex;align-items:center;justify-content:space-between}
.chatHead .title{font-size:13px;color:#c7d2fe}
.list{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.bubble{max-width:85%;padding:10px 12px;border-radius:12px;line-height:1.35;font-size:14px;white-space:pre-wrap;word-break:break-word}
.assistant{align-self:flex-start;background:rgba(30,41,59,0.7);border:1px solid rgba(148,163,184,0.25);color:#E6E8EE}
.user{align-self:flex-end;background:#3b82f6;color:white;border:1px solid rgba(59,130,246,0.65)}
.inputRow{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,0.06)}
.inp{flex:1;padding:10px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#E6E8EE;outline:none;font-size:14px}
.inp::placeholder{color:#9aa7bd}
.send{flex:0 0 auto;width:38px;height:38px;border-radius:12px;border:1px solid rgba(255,255,255,0.15);background:linear-gradient(180deg,#7cc6ff,#3b82f6);color:white;font-size:16px;cursor:pointer}
@media (max-width:520px){.top{flex-basis:40%}.bars span{width:calc((100% - 31*4px)/32)}}
`;
