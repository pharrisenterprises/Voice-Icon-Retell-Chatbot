// app/tts-test/page.jsx
"use client";

import { useState } from "react";

export default function TTSTestPage() {
  const [status, setStatus] = useState("idle");
  const [debug, setDebug] = useState(null);
  const [error, setError] = useState("");

  async function fetchDebug() {
    try {
      const r = await fetch("/api/tts/debug", { cache: "no-store" });
      const j = await r.json();
      setDebug(j);
    } catch (e) {
      setDebug({ ok: false, error: String(e?.message || e) });
    }
  }

  async function playAzure() {
    setError("");
    setStatus("fetching");
    try {
      const res = await fetch("/api/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text:
            "Hello! This is the Azure Neural voice test. If I sound smooth and natural, Azure is working.",
        }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Azure TTS failed ${res.status}: ${t}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      setStatus("playing");
      audio.onended = () => setStatus("idle");
      await audio.play();
    } catch (e) {
      setStatus("idle");
      setError(String(e?.message || e));
    }
  }

  return (
    <div style={{ maxWidth: 680, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Azure TTS — Quick Test</h1>
      <p>Use these two buttons to verify your server voice and play a sample.</p>

      <div style={{ display: "flex", gap: 12, margin: "16px 0" }}>
        <button onClick={fetchDebug} style={{ padding: "10px 14px" }}>
          1) Show Server TTS Settings
        </button>
        <button onClick={playAzure} style={{ padding: "10px 14px" }}>
          2) Play Azure Voice Sample
        </button>
      </div>

      <p><b>Status:</b> {status}</p>
      {error && (
        <p style={{ color: "red", whiteSpace: "pre-wrap" }}>
          <b>Error:</b> {error}
        </p>
      )}

      {debug && (
        <pre
          style={{
            background: "#111",
            color: "#0f0",
            padding: 12,
            borderRadius: 8,
            overflowX: "auto",
          }}
        >
{JSON.stringify(debug, null, 2)}
        </pre>
      )}

      <hr style={{ margin: "24px 0" }} />
      <p>
        If the sample sounds robotic, your browser is <i>not</i> playing this page’s audio — it’s still using the old browser voice elsewhere.
        This page <b>forces</b> Azure by calling <code>/api/tts/speak</code> and playing the audio file.
      </p>
    </div>
  );
}
