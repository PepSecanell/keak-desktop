import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import keakLogo from "./assets/icon_keak_2.png";
import keakLogoDark from "./assets/icon_keak_2.png";
import "./Overlay.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

type OverlayState = "idle" | "recording" | "processing" | "result" | "error" | "responding";

function getSession() {
  const stored = localStorage.getItem("keak_session");
  return stored ? JSON.parse(stored) : null;
}

function userIdFromToken(token: string): string | null {
  try {
    return JSON.parse(atob(token.split(".")[1])).sub ?? null;
  } catch {
    return null;
  }
}

function tokenExp(token: string): number {
  try {
    return JSON.parse(atob(token.split(".")[1])).exp || 0;
  } catch {
    return 0;
  }
}

// Access tokens expire after ~1h. If ours is expired (or about to), renew it with the refresh_token so
// transcription and every other authed call keeps working without re-signing in.
async function ensureFreshSession(session: any): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenExp(session.access_token) > now + 60) return session; // still valid
  if (!session.refresh_token) return session; // no way to refresh; caller will surface a sign-in hint
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        const ns = {
          access_token: data.access_token,
          email: session.email,
          refresh_token: data.refresh_token || session.refresh_token,
        };
        localStorage.setItem("keak_session", JSON.stringify(ns));
        return ns;
      }
    }
  } catch {
    // fall through with the old session
  }
  return session;
}

// Save a dictation to the shared History so it shows up on web/mobile too. Fire-and-forget —
// never block the text injection on it.
function saveHistory(session: any, fields: Record<string, unknown>) {
  try {
    const user_id = userIdFromToken(session.access_token);
    fetch(`${SUPABASE_URL}/rest/v1/transcriptions`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ user_id, ...fields }),
    }).catch(() => {});
  } catch {
    // history is best-effort
  }
}

// Warm up the voice list early (getVoices() is empty until the engine loads them).
try { window.speechSynthesis?.getVoices(); window.speechSynthesis?.addEventListener?.("voiceschanged", () => window.speechSynthesis.getVoices()); } catch {}

const BCP47: Record<string, string> = { es: "es-ES", en: "en-US", zh: "zh-CN", hi: "hi-IN", ar: "ar-SA" };

// Which language is this reply in? Use the pinned setting if concrete, else a light heuristic (Pep's
// two main languages are ES/EN). Getting this right is what stops the voice mixing languages mid-phrase.
function replyLang(text: string): string {
  const pinned = localStorage.getItem("keak_language");
  if (pinned && pinned !== "auto" && BCP47[pinned]) return pinned;
  if (/[ñ¿¡áéíóú]/i.test(text)) return "es";
  const t = ` ${text.toLowerCase()} `;
  const es = (t.match(/ (el|la|los|las|de|que|y|en|un|una|es|por|con|para|como|pero|más|está|hola|gracias|qué|cómo) /g) || []).length;
  const en = (t.match(/ (the|and|is|to|of|in|a|that|it|for|you|with|this|are|what|how|hello|thanks) /g) || []).length;
  return es > en ? "es" : "en";
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const byLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  // Prefer a natural/online/neural voice if the OS exposes one.
  return byLang.find((v) => /natural|online|neural/i.test(v.name)) || byLang[0] || null;
}

// The reply is spoken aloud and shown in a small pill, so it must be plain text — strip any markdown
// the model slips in (**bold**, bullets) and turn long dashes into commas.
function cleanReply(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Track whatever is currently speaking so a follow-up can interrupt it.
let currentAudio: HTMLAudioElement | null = null;
function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  const a = currentAudio;
  currentAudio = null;
  if (a) {
    try { a.pause(); } catch { /* ignore */ }
    try { a.onended?.(new Event("ended")); } catch { /* ignore */ } // resolve its pending promise
  }
}

// Free, built-in fallback voice — now language-locked so it stops mixing ES/EN in one phrase.
// Resolves when speaking finishes, so callers can time what happens next.
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const lang = replyLang(text);
      u.lang = BCP47[lang] || "en-US";
      const v = pickVoice(lang);
      if (v) u.voice = v;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch {
      resolve(); // speech synthesis unavailable — the text is still shown on screen
    }
  });
}

// Best voice: try the high-quality backend TTS (keak-tts); fall back to the free built-in voice.
// `onStart` fires the instant the voice actually begins, so the caller can reveal the text at the same
// moment (voice + text land together instead of text-then-silence). Resolves when playback ends.
async function speakReply(text: string, token: string, onStart?: () => void): Promise<void> {
  const gender = localStorage.getItem("keak_voice_gender") || "female";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/keak-tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: replyLang(text), gender }),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        const blob = new Blob([buf], { type: res.headers.get("content-type") || "audio/wav" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;
        onStart?.(); // audio is ready — reveal the text right as it plays
        await new Promise<void>((resolve) => {
          const done = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; resolve(); };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
        return;
      }
    }
  } catch {
    // fall through to the built-in voice
  }
  onStart?.(); // built-in voice starts effectively immediately
  await speak(text);
}

// "Thinking" filler: a tiny spoken acknowledgement ("Of course, Pep.") played the instant a Keak AI
// question is captured, so the seconds while the real answer is generated are covered by voice and it
// feels instant and conversational. The clip is generated once via keak-tts and cached (keyed by
// name+gender+language), so from then on it plays with zero latency. The real answer waits for the
// filler to finish (fillerDone) so they never overlap.
let fillerUrls: string[] = [];   // several cached clips; a random one plays each time so it never repeats
let fillerKey = "";
let fillerGenerating = false;
let fillerDone: Promise<void> = Promise.resolve();

// A handful of short, natural acknowledgements so the filler varies. Some use the name, some don't.
function fillerPhrases(name: string, lang: string): string[] {
  const n = name && name !== "there" ? name : "";
  if (lang === "es") {
    return [n ? `Claro, ${n}.` : "Claro.", "Por supuesto.", "Vamos a ver.", "Un momento.", n ? `Muy bien, ${n}.` : "Muy bien.", "Déjame ver."];
  }
  return [n ? `Of course, ${n}.` : "Of course.", "Sure thing.", "Let me see.", "One moment.", n ? `Alright, ${n}.` : "Alright.", "Got it."];
}

async function genClip(token: string, text: string, lang: string, gender: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/keak-tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: lang, gender }),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) {
        const blob = new Blob([buf], { type: res.headers.get("content-type") || "audio/wav" });
        return URL.createObjectURL(blob);
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Pre-generate the variety of filler clips once (keyed by name+gender+language). Clips are appended as
// they finish, so playFiller can use whatever is ready; the rest fill in shortly after.
async function ensureFillers(token: string): Promise<void> {
  const name = (localStorage.getItem("keak_user_name") || "").trim();
  const gender = localStorage.getItem("keak_voice_gender") || "female";
  let lang = localStorage.getItem("keak_language") || "en";
  if (lang === "auto" || lang === "bi") lang = "en";
  const key = `${name}|${gender}|${lang}`;
  if (key === fillerKey && fillerUrls.length > 0) return;
  if (fillerGenerating) return;
  fillerGenerating = true;
  fillerUrls.forEach((u) => URL.revokeObjectURL(u));
  const list: string[] = [];
  fillerUrls = list; // playFiller reads this same array as clips arrive
  fillerKey = key;
  try {
    for (const text of fillerPhrases(name, lang)) {
      const url = await genClip(token, text, lang, gender);
      if (url) list.push(url);
    }
  } finally {
    fillerGenerating = false;
  }
}

function playFiller(): Promise<void> {
  if (fillerUrls.length === 0) return Promise.resolve();
  const url = fillerUrls[Math.floor(Math.random() * fillerUrls.length)];
  return new Promise<void>((resolve) => {
    try {
      const audio = new Audio(url);
      currentAudio = audio;
      const done = () => { if (currentAudio === audio) currentAudio = null; resolve(); };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    } catch { resolve(); }
  });
}

// Small inline SVG icons (stroke = currentColor), so buttons look crisp and premium instead of emojis.
const IconMic = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" /><path d="M8.5 21h7" />
  </svg>
);
const IconStop = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
);
const IconClose = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const IconEye = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

// Live voice waveform: bars react to the mic level in real time while recording. Taps the already-warm
// mic stream via an AnalyserNode; updates bar heights directly (no per-frame React re-render) for speed.
function Waveform({ active, streamRef }: { active: boolean; streamRef: React.MutableRefObject<MediaStream | null> }) {
  const N = 7;
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const rafRef = useRef<number | null>(null);
  const [live, setLive] = useState(false); // true = real analyser drives the bars; false = CSS pulse fallback

  useEffect(() => {
    if (!active) { setLive(false); return; }
    const stream = streamRef.current;
    if (!stream) return;
    let cancelled = false;
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      const bins = analyser.frequencyBinCount; // 32
      const data = new Uint8Array(bins);
      setLive(true);
      const tick = () => {
        if (cancelled) return;
        analyser.getByteFrequencyData(data);
        for (let i = 0; i < N; i++) {
          const idx = 1 + Math.floor((i / N) * (bins - 2));
          const v = data[idx] / 255; // 0..1
          const s = 0.18 + Math.pow(v, 0.8) * 0.82; // scaleY 0.18..1.0, slight curve so quiet speech still moves
          const el = barsRef.current[i];
          if (el) el.style.transform = `scaleY(${s.toFixed(2)})`;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setLive(false); // Web Audio unavailable — CSS keeps the bars gently pulsing as a fallback.
    }
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      ctx?.close().catch(() => {});
      barsRef.current.forEach((el) => { if (el) el.style.transform = ""; });
      setLive(false);
    };
  }, [active, streamRef]);

  return (
    <div className={`wave${active ? " wave--on" : ""}${live ? " wave--live" : ""}`} aria-hidden="true">
      {Array.from({ length: N }).map((_, i) => (
        <span key={i} ref={(el) => { barsRef.current[i] = el; }} className="wave-bar" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}

export default function Overlay() {
  const isPaid = ["starter", "pro", "team"].includes(localStorage.getItem("keak_plan") ?? "free");
  const canSeeScreen = ["pro", "team"].includes(localStorage.getItem("keak_plan") ?? "free"); // screen vision: Pro + Team
  const [state, setState] = useState<OverlayState>("idle");
  const stateRef = useRef<OverlayState>("idle");
  const [result, setResult] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [thoughtDump, setThoughtDump] = useState(false);
  const thoughtDumpRef = useRef(false); // read at processing time (state may be stale in the closure)
  const modeRef = useRef<"dictate" | "assistant" | "rewrite">("dictate");
  const rewriteTextRef = useRef(""); // the selected text captured for a Rewrite
  const [rewriting, setRewriting] = useState(false);
  const [assistant, setAssistant] = useState(false); // Keak AI panel active
  const [aiReply, setAiReply] = useState("");
  // A write/outward action Keak AI proposed and is waiting for the user to confirm before it runs.
  const [pendingAction, setPendingAction] = useState<
    null | { connector: string; action: string; args: Record<string, unknown>; summary: string }
  >(null);
  const [seeScreen, setSeeScreen] = useState(false); // include a screenshot with the next Keak AI question
  const seeScreenRef = useRef(false); // read at processing time (state may be stale in the closure)
  const screenOffThisTurnRef = useRef(false); // user explicitly turned screen OFF for this question
  const [attachedScreen, setAttachedScreen] = useState(false); // a screenshot was actually sent this turn
  const [screenAllowed, setScreenAllowed] = useState(() => localStorage.getItem("keak_screen_vision_allowed") === "1");
  const historyRef = useRef<{ role: string; text: string }[]>([]); // Keak AI conversation memory
  const closeTimerRef = useRef<number | null>(null); // pending auto-close of the assistant panel
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null); // the (warm) mic stream, reused between dictations
  const micReleaseRef = useRef<number | null>(null); // idle timer that turns the mic off after use
  const readyToStop = useRef(false);

  function setStateSafe(s: OverlayState) {
    stateRef.current = s;
    setState(s);
  }

  // Pre-generate the "thinking" filler clip once (best-effort) so the very first Keak AI question already
  // has an instant spoken acknowledgement.
  useEffect(() => {
    const s = getSession();
    if (s?.access_token) ensureFillers(s.access_token);
  }, []);

  // Push-to-talk. Ctrl+Win = Dictate; Ctrl+Alt = Keak AI or Thought Dump (per the user's setting).
  useEffect(() => {
    const startP = listen<boolean>("ptt-start", (e) => {
      if (stateRef.current === "idle") {
        modeRef.current = "dictate";
        setAssistant(false); // leaving any open Keak AI conversation
        setAiReply("");
        historyRef.current = [];
        const dump = e.payload === true;
        thoughtDumpRef.current = dump;
        setThoughtDump(dump);
        startRecording();
      }
    });
    const stopP = listen("ptt-stop", () => {
      if (stateRef.current === "recording") stopRecording();
    });
    // Ctrl+Alt — decide Keak AI vs Thought Dump from the saved setting.
    const altStartP = listen("alt-start", () => {
      if (stateRef.current !== "idle") return;
      const alt = localStorage.getItem("keak_alt_mode") || "keak_ai";
      if (alt === "thought_dump") {
        modeRef.current = "dictate";
        thoughtDumpRef.current = true;
        setThoughtDump(true);
        startRecording();
      } else {
        modeRef.current = "assistant";
        setAssistant(true);
        setAiReply("");
        setAttachedScreen(false);
        screenOffThisTurnRef.current = false;
        // Screen is OFF by default every question. Keak only looks at your screen when you deliberately
        // tap "See screen" for that question, so ordinary questions never send a screenshot.
        seeScreenRef.current = false;
        setSeeScreen(false);
        // Refresh the permission from the account so the "See screen" button shows for eligible users.
        refreshScreenPermission();
        startRecording();
      }
    });
    const altStopP = listen("alt-stop", () => {
      if (stateRef.current === "recording") stopRecording();
    });
    // Win+Alt — Rewrite the current selection. Record the spoken instruction now; the selection itself
    // is captured after release (in processAudio) so the Ctrl+C isn't polluted by the held modifiers.
    const rewriteStartP = listen("rewrite-start", () => {
      if (stateRef.current !== "idle") return;
      modeRef.current = "rewrite";
      setAssistant(false); // leaving any open Keak AI conversation
      setAiReply("");
      historyRef.current = [];
      setRewriting(true);
      startRecording();
    });
    const rewriteStopP = listen("rewrite-stop", () => {
      if (stateRef.current === "recording") stopRecording();
    });
    return () => {
      startP.then((f) => f());
      stopP.then((f) => f());
      altStartP.then((f) => f());
      altStopP.then((f) => f());
      rewriteStartP.then((f) => f());
      rewriteStopP.then((f) => f());
    };
  }, []);

  function cancelAssistantClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }
  // Keep the panel up for a bit after Keak AI speaks, so you can ask a follow-up (hold Ctrl+Alt again).
  function scheduleAssistantClose(ms: number) {
    cancelAssistantClose();
    closeTimerRef.current = window.setTimeout(() => { doClose(); }, ms);
  }

  // Keep the mic "warm" between dictations so recording starts INSTANTLY and never clips the first
  // word. Acquiring getUserMedia takes 100-300ms; doing it once and reusing the live stream removes that
  // gap for every dictation after the first. Clean mono capture with the browser's DSP on (echo/noise/
  // gain). We do NOT force sampleRate: Opus in WebM encodes at 48kHz, and pinning the track to 16kHz can
  // create a container/codec mismatch that OpenAI rejects as "corrupted".
  async function getWarmStream(): Promise<MediaStream> {
    const existing = streamRef.current;
    if (existing && existing.getAudioTracks().some((t) => t.readyState === "live")) return existing;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    streamRef.current = stream;
    return stream;
  }

  function cancelMicRelease() {
    if (micReleaseRef.current !== null) { clearTimeout(micReleaseRef.current); micReleaseRef.current = null; }
  }

  // Turn the mic off a while after the last dictation, so the OS mic indicator does not stay on forever.
  function releaseMicSoon() {
    cancelMicRelease();
    micReleaseRef.current = window.setTimeout(() => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      micReleaseRef.current = null;
    }, 90000);
  }

  async function startRecording() {
    cancelAssistantClose(); // a new question cancels any pending auto-close
    cancelMicRelease(); // we're about to use the mic; don't let the idle timer stop it mid-use
    stopSpeaking(); // interrupt any answer still playing so you can talk over it
    chunks.current = [];
    readyToStop.current = false;
    try {
      const stream = await getWarmStream();
      // Prefer Opus in WebM — efficient, high-quality speech codec.
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType: mime });
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mr.onstop = () => processAudio();
      mrRef.current = mr;
      mr.start(100); // collect data every 100ms
      readyToStop.current = true;
      setStateSafe("recording"); // only after recorder is live
      cancelAssistantClose(); // kill any close scheduled while the mic was being acquired
    } catch {
      setStateSafe("error");
      setErrorMsg("Microphone access denied");
    }
  }

  function stopRecording() {
    if (!readyToStop.current || !mrRef.current) return;
    readyToStop.current = false;
    if (mrRef.current.state !== "inactive") {
      mrRef.current.stop();
    }
    setStateSafe("processing");
  }

  function handleMicClick() {
    if (stateRef.current === "idle") {
      startRecording();
    } else if (stateRef.current === "recording") {
      stopRecording();
    }
  }

  async function processAudio() {
    releaseMicSoon(); // keep the mic warm for the next dictation, then turn it off after idle

    let session = getSession();
    if (!session) {
      setStateSafe("error");
      setErrorMsg("Not signed in. Open Keak settings first.");
      return;
    }

    if (chunks.current.length === 0) {
      await invoke("hide_overlay");
      reset();
      return;
    }

    // Renew the token if it expired (~1h), so authed calls don't silently fail.
    session = await ensureFreshSession(session);

    try {
      const blob = new Blob(chunks.current, { type: "audio/webm" });
      // A header-only clip (too short a hold, or the mic gave nothing) is a few hundred bytes and
      // OpenAI rejects it as "corrupted". Treat it as "didn't catch that" instead of a scary error.
      if (blob.size < 1500) {
        if (modeRef.current === "assistant") {
          setAiReply("I didn't catch that. Hold Ctrl + Alt, speak, then release.");
          setStateSafe("idle");
          scheduleAssistantClose(9000);
        } else {
          await invoke("hide_overlay");
          reset();
        }
        return;
      }
      const form = new FormData();
      form.append("file", blob, "rec.webm");
      // Pin the language if the user chose one (else let the model auto-detect).
      const lang = localStorage.getItem("keak_language");
      if (lang && lang !== "auto") form.append("language", lang);

      const tRes = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: form,
      });
      const tData = await tRes.json().catch(() => ({} as any));
      // Surface the REAL reason instead of a blank "nothing transcribed".
      if (!tRes.ok) {
        const detail = tData?.error || tData?.message || `error ${tRes.status}`;
        const friendly =
          tRes.status === 401 || tRes.status === 403
            ? "Session expired. Open Keak settings and sign in again."
            : tRes.status === 402
            ? "You're out of dictation minutes this month. Upgrade your plan or buy a minutes pack in Keak settings."
            : `Transcription failed: ${detail}`;
        if (modeRef.current === "assistant") {
          setAiReply(friendly);
          setStateSafe("idle");
          scheduleAssistantClose(9000);
        } else {
          setStateSafe("error");
          setErrorMsg(friendly);
        }
        return;
      }
      if (!tData.text || !String(tData.text).trim()) {
        // Empty transcription (silence, a very short hold, or a transcribe hiccup). Handle it kindly.
        if (modeRef.current === "assistant") {
          setAiReply("I didn't catch that. Hold Ctrl + Alt and try again.");
          setStateSafe("idle");
          scheduleAssistantClose(9000);
        } else {
          // Dictation / Rewrite: just close quietly, Wispr-style, no scary error.
          await invoke("hide_overlay");
          reset();
        }
        return;
      }

      // Keak AI branch: ask the assistant and speak the answer, instead of injecting text.
      if (modeRef.current === "assistant") {
        // Play the "thinking" filler immediately so there's no dead air while the answer is generated.
        // The real answer (runAssistant) waits for fillerDone before speaking, so they never overlap.
        fillerDone = playFiller();
        ensureFillers(session.access_token); // refresh the cached clips for next time (no-op if unchanged)

        let image: string | undefined;
        // Only capture when the user deliberately turned "See screen" on for THIS question.
        const wantScreen = seeScreenRef.current;
        if (wantScreen) {
          // Don't answer blind. If the screenshot fails, tell the user WHY instead of
          // silently pretending Keak has no eyes.
          try {
            image = await invoke<string>("capture_screen");
            if (!image || image.length < 100) throw new Error("the screenshot came back empty");
            setAttachedScreen(true); // visible confirmation the screen was actually sent
          } catch (err: any) {
            const why = err?.message || String(err);
            setAiReply(`I couldn't capture your screen (${why}). Make sure you're on the latest Keak build, then toggle See screen off and on and ask again.`);
            setStateSafe("idle");
            scheduleAssistantClose(11000);
            return;
          }
        }
        await runAssistant(tData.text, session.access_token, image);
        return;
      }

      // Rewrite branch: the transcription is the INSTRUCTION. Now grab the selection (clean Ctrl+C,
      // modifiers released) and apply the instruction to it.
      if (modeRef.current === "rewrite") {
        const selected = ((await invoke<string>("capture_selection")) || "").trim();
        if (!selected) {
          await invoke("restore_clipboard");
          setStateSafe("error");
          setErrorMsg("Select some text first, then hold Win+Alt");
          return;
        }
        rewriteTextRef.current = selected;
        await runRewrite(tData.text, session.access_token);
        return;
      }

      const stylePrompt = localStorage.getItem("keak_default_style") || null;
      const eRes = await fetch(`${SUPABASE_URL}/functions/v1/enhance`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: tData.text,
          mode: thoughtDumpRef.current ? "thought_dump" : "normal",
          style_prompt: stylePrompt,
        }),
      });
      const eData = await eRes.json();
      const finalText = eData.enhanced_text || tData.text;
      // Wispr-style: drop the cleaned text straight where the cursor was, no review step.
      await invoke("inject_text", { text: finalText });
      // Save to shared History (best-effort) so it shows across web/mobile/desktop.
      saveHistory(session, {
        raw_text: tData.text,
        final_text: finalText,
        mode: thoughtDumpRef.current ? "thought_dump" : "normal",
        duration_seconds: tData.duration_seconds ?? null,
      });
      reset();
    } catch (e: any) {
      setStateSafe("error");
      setErrorMsg(e.message || "Something went wrong");
    }
  }

  // One-shot listener for a "browser-result" page_snapshot from the Chrome extension.
  // Returns the parsed snapshot or null on timeout.
  function waitForBrowserResult(timeoutMs: number): Promise<any | null> {
    return new Promise(async (resolve) => {
      let settled = false;
      const settle = (val: any) => { if (settled) return; settled = true; resolve(val); };
      const timer = setTimeout(() => settle(null), timeoutMs);
      const unlisten = await listen<string>("browser-result", (event) => {
        try {
          const data = JSON.parse(event.payload);
          if (data.type === "page_snapshot") { clearTimeout(timer); unlisten(); settle(data); }
        } catch {}
      });
      if (settled) unlisten();
    });
  }

  // Plan-then-execute: Keak AI returns all steps upfront, we run them in sequence with no
  // extra AI calls between steps. Fastest path — one AI round trip for the whole task.
  async function executeBrowserPlan(task: string, plan: any[], announcement: string, token: string) {
    const announce = cleanReply(announcement || `On it — ${plan.length} steps.`);
    setAiReply(announce);
    setStateSafe("idle");

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      setAiReply(`${announce} (${i + 1}/${plan.length})`);
      try {
        await invoke("send_browser_command", {
          command: JSON.stringify({ id: Date.now(), ...step }),
        });
      } catch {
        setAiReply("Browser Bridge not connected. Reload the Chrome extension.");
        setStateSafe("idle");
        scheduleAssistantClose(9000);
        return;
      }
      // Wait for the page snapshot that confirms the step landed
      await waitForBrowserResult(1500);
    }

    const doneMsg = "Done.";
    historyRef.current.push({ role: "user", text: task }, { role: "assistant", text: doneMsg });
    let revealed = false;
    const reveal = () => { if (revealed) return; revealed = true; setAiReply(doneMsg); setStateSafe("idle"); };
    const safety = window.setTimeout(reveal, 10000);
    try {
      await speakReply(doneMsg, token, () => { clearTimeout(safety); reveal(); });
    } finally {
      clearTimeout(safety);
      reveal();
      if (stateRef.current === "idle") scheduleAssistantClose(10000);
    }
  }

  // Multi-step browser agent. Sends commands and feeds page snapshots back to Keak AI
  // until the task is done (no browser_action returned) or MAX_STEPS is reached.
  async function runBrowserAgent(task: string, firstResp: any, token: string) {
    const MAX_STEPS = 6;
    const userName = localStorage.getItem("keak_user_name") || "there";
    const assistantName = localStorage.getItem("keak_assistant_name") || "Keak";
    let resp = firstResp;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (!resp.browser_action?.type) {
        // Task complete — speak the final reply
        const reply = cleanReply(resp.reply || "Done.");
        historyRef.current.push({ role: "user", text: task }, { role: "assistant", text: reply });
        let revealed = false;
        const reveal = () => { if (revealed) return; revealed = true; setAiReply(reply); setStateSafe("idle"); };
        const safety = window.setTimeout(reveal, 20000);
        try {
          await fillerDone;
          await speakReply(reply, token, () => { clearTimeout(safety); reveal(); });
        } finally {
          clearTimeout(safety);
          reveal();
          if (stateRef.current === "idle") scheduleAssistantClose(12000);
        }
        return;
      }

      // Show what we're doing this step
      const stepMsg = cleanReply(resp.reply || `Working on step ${step + 1}…`);
      setAiReply(stepMsg);
      setStateSafe("idle");

      // Send the browser command
      try {
        await invoke("send_browser_command", {
          command: JSON.stringify({ id: Date.now(), ...resp.browser_action }),
        });
      } catch {
        setAiReply("Keak Browser Bridge isn't connected. Reload the Chrome extension.");
        setStateSafe("idle");
        scheduleAssistantClose(9000);
        return;
      }

      // Wait for the page snapshot the extension sends after each action
      const snap = await waitForBrowserResult(1500);
      let pageCtx = "";
      if (snap?.page) {
        const pg = snap.page;
        const btns = (pg.buttons || []).slice(0, 12).join(", ");
        pageCtx = `URL: ${pg.url} | Title: "${pg.title}" | Buttons: [${btns}] | Content: ${(pg.text || "").slice(0, 600)}`;
      }

      // Ask Keak AI what to do next
      try {
        const nextRes = await fetch(`${SUPABASE_URL}/functions/v1/keak-assistant`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: pageCtx
              ? `[Task]: ${task}\n[Page after step ${step + 1}]: ${pageCtx}\n[Continue the task or reply done if finished.]`
              : task,
            user_name: userName,
            assistant_name: assistantName,
            history: historyRef.current.slice(-6).map(h => ({ role: h.role, content: h.text })),
          }),
        });
        resp = await nextRes.json();
      } catch {
        setAiReply("Lost connection mid-task. Try again.");
        setStateSafe("idle");
        scheduleAssistantClose(9000);
        return;
      }
    }

    // Reached max steps
    const doneMsg = cleanReply(resp.reply || "I've completed all the steps I can.");
    setAiReply(doneMsg);
    setStateSafe("idle");
    scheduleAssistantClose(9000);
  }

  async function runAssistant(question: string, token: string, image?: string) {
    cancelAssistantClose();
    const assistantName = localStorage.getItem("keak_assistant_name") || "Keak";
    const userName = localStorage.getItem("keak_user_name") || "there";
    try {
      const aRes = await fetch(`${SUPABASE_URL}/functions/v1/keak-assistant`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: question,
          user_name: userName,
          assistant_name: assistantName,
          // Short conversation memory for follow-ups. The backend expects { role, content }, so map
          // our internal { role, text } turns onto that shape (this is why follow-ups had no memory).
          history: historyRef.current.slice(-10).map((h) => ({ role: h.role, content: h.text })),
          ...(image ? { image } : {}), // screen-vision screenshot (base64 JPEG), when enabled
        }),
      });
      if (aRes.status === 404 || aRes.status === 501) {
        setAiReply("Keak AI isn't switched on yet — deploy the keak-assistant function in Lovable to activate it.");
        setStateSafe("idle");
        scheduleAssistantClose(9000);
        return;
      }
      if (aRes.status === 402) {
        setAiReply("You're out of Keak AI credits this month. Upgrade your plan or buy a credit pack in Keak settings.");
        setStateSafe("idle");
        scheduleAssistantClose(11000);
        return;
      }
      const aData = await aRes.json();

      // Multi-step plan (fastest path — all steps in one AI call, no AI between steps).
      if (Array.isArray(aData.browser_plan) && aData.browser_plan.length > 0) {
        await executeBrowserPlan(question, aData.browser_plan, aData.reply, token);
        return;
      }
      // Single browser action — fall back to the step-by-step agent loop.
      if (aData.browser_action?.type) {
        await runBrowserAgent(question, aData, token);
        return;
      }

      // Diagnostic: if we DID send a screenshot but the backend didn't attach it to the model
      // (saw_screen === false), the account permission wasn't read. Say so plainly instead of
      // letting the model claim it "has no eyes".
      if (image && aData.saw_screen === false) {
        setAiReply("I captured your screen but the server didn't use it (screen permission wasn't read). This needs the keak-assistant function updated.");
        setStateSafe("idle");
        scheduleAssistantClose(11000);
        return;
      }
      // Action proposal: Keak AI wants to DO something (save a note, add an event…). Never auto-run it —
      // show a confirm card and speak the confirm line; the action only fires when the user taps Confirm.
      if (aData.proposed_action && aData.proposed_action.connector && aData.proposed_action.action) {
        const pa = aData.proposed_action as {
          connector: string; action: string; args?: Record<string, unknown>; summary?: string;
        };
        const spoken = cleanReply(aData.reply || "I can do that. Confirm?");
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: spoken });
        setPendingAction({ connector: pa.connector, action: pa.action, args: pa.args ?? {}, summary: pa.summary || spoken });
        setStateSafe("responding");
        let shown = false;
        const show = () => { if (shown) return; shown = true; setAiReply(spoken); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 20000);
        try {
          await fillerDone;
          await speakReply(spoken, token, () => { clearTimeout(safety); show(); });
        } finally {
          clearTimeout(safety);
          show();
          // Give the user time to decide; don't auto-close mid-confirmation. Long fallback only.
          if (stateRef.current === "idle") scheduleAssistantClose(30000);
        }
        return;
      }

      const reply = cleanReply(aData.reply || aData.error || "Sorry, I couldn't answer that.");
      historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: reply });
      setStateSafe("responding"); // orb shows "Responding" while the voice is generated

      // Reveal the text at the EXACT moment the voice starts, so text + voice appear together. speakReply
      // fires onStart right before it plays. The safety timer only exists to unstick the panel if the
      // voice never starts at all (network stall) — it is long enough to never preempt a normal (even
      // slow) voice, so it won't cause the text-before-voice gap.
      let revealed = false;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        setAiReply(reply);
        setStateSafe("idle"); // idle immediately so you can reply even while it is still talking
      };
      const safety = window.setTimeout(reveal, 20000);
      try {
        await fillerDone; // let the "thinking" filler finish first, so filler and answer don't overlap
        await speakReply(reply, token, () => { clearTimeout(safety); reveal(); });
      } finally {
        clearTimeout(safety);
        reveal();
        // Start the close countdown only AFTER the voice has finished, so long answers are never cut
        // off. If you've already begun a follow-up (state = recording), leave it alone.
        if (stateRef.current === "idle") scheduleAssistantClose(12000);
      }
    } catch {
      setAiReply("Couldn't reach Keak AI. Check your connection.");
      setStateSafe("idle");
      scheduleAssistantClose(9000);
    }
  }

  // User tapped Confirm on a proposed action: run it through keak-actions, then speak the outcome.
  async function confirmAction() {
    const pa = pendingAction;
    if (!pa) return;
    setPendingAction(null);
    cancelAssistantClose();
    const session = getSession();
    if (!session) { setAiReply("Please sign in to Keak again."); setStateSafe("idle"); return; }
    setStateSafe("responding");
    try {
      const token = (await ensureFreshSession(session)).access_token;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/keak-actions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ connector: pa.connector, action: pa.action, args: pa.args }),
      });
      const data = await res.json().catch(() => ({} as any));
      const ok = res.ok && data?.ok;
      const line = cleanReply(
        ok
          ? (data.result_summary || "Done.")
          : data?.error === "not_connected"
            ? "That app isn't connected yet. Connect it in Keak settings first."
            : (data?.error || "That didn't work."),
      );
      historyRef.current.push({ role: "assistant", text: line });
      let shown = false;
      const show = () => { if (shown) return; shown = true; setAiReply(line); setStateSafe("idle"); };
      const safety = window.setTimeout(show, 20000);
      try {
        await speakReply(line, token, () => { clearTimeout(safety); show(); });
      } finally {
        clearTimeout(safety);
        show();
        if (stateRef.current === "idle") scheduleAssistantClose(9000);
      }
    } catch {
      setAiReply("Couldn't complete that action. Check your connection.");
      setStateSafe("idle");
      scheduleAssistantClose(9000);
    }
  }

  // User tapped Cancel: drop the proposed action, no API call.
  function cancelAction() {
    setPendingAction(null);
    setAiReply("Okay, cancelled.");
    setStateSafe("idle");
    scheduleAssistantClose(6000);
  }

  // Pull the live screen-vision permission from the profile so a web toggle takes effect without a
  // desktop restart. Updates the toggle's visibility + default for this question.
  async function refreshScreenPermission() {
    const session = getSession();
    if (!session) return;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=ai_screen_vision`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const rows = await res.json();
      const allowed = !!rows?.[0]?.ai_screen_vision;
      localStorage.setItem("keak_screen_vision_allowed", allowed ? "1" : "0");
      setScreenAllowed(allowed);
      // This only controls whether the "See screen" button is available. It never auto-enables capture:
      // the screen is sent only when the user taps the button for that question. If permission was
      // revoked, make sure it is off.
      if (!allowed) {
        seeScreenRef.current = false;
        setSeeScreen(false);
      }
    } catch {
      // keep whatever we had cached
    }
  }

  async function runRewrite(instruction: string, token: string) {
    const lang = localStorage.getItem("keak_language");
    try {
      const rRes = await fetch(`${SUPABASE_URL}/functions/v1/keak-rewrite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: rewriteTextRef.current,
          instruction,
          language: lang && lang !== "auto" ? lang : undefined,
        }),
      });
      if (rRes.status === 404 || rRes.status === 501) {
        setStateSafe("error");
        setErrorMsg("Rewrite isn't switched on yet — deploy keak-rewrite in Lovable.");
        await invoke("restore_clipboard");
        return;
      }
      const rData = await rRes.json();
      const out = rData.rewritten;
      if (!out) throw new Error(rData.error || "Rewrite failed");
      // Types over the still-highlighted selection, replacing it in place.
      await invoke("inject_text", { text: out });
      await invoke("restore_clipboard");
      reset();
    } catch (e: any) {
      await invoke("restore_clipboard");
      setStateSafe("error");
      setErrorMsg(e.message || "Rewrite failed");
    }
  }

  async function insertText() {
    await invoke("inject_text", { text: result });
    reset();
  }

  async function copyText() {
    await navigator.clipboard.writeText(result);
    await doClose();
  }

  async function doClose() {
    cancelAssistantClose();
    cancelMicRelease();
    readyToStop.current = false;
    if (mrRef.current && mrRef.current.state !== "inactive") {
      mrRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    await invoke("hide_overlay");
    reset();
  }

  function reset() {
    cancelAssistantClose();
    setStateSafe("idle");
    setResult("");
    setErrorMsg("");
    setAiReply("");
    setPendingAction(null);
    setAssistant(false);
    setRewriting(false);
    setSeeScreen(false);
    seeScreenRef.current = false;
    setAttachedScreen(false);
    screenOffThisTurnRef.current = false;
    rewriteTextRef.current = "";
    historyRef.current = [];
    modeRef.current = "dictate";
  }

  const statusWord =
    state === "recording" ? "Listening"
    : state === "processing" ? "Keaking"
    : state === "responding" ? "Responding"
    : "";

  return (
    <div className="overlay-root">
      {assistant && (
        <div className="assistant-orb-wrap" onClick={doClose} title="Click to dismiss">
          <div className={`orb orb--${state}`} />
          {state === "error" ? (
            <p className="ai-reply">{errorMsg}</p>
          ) : aiReply ? (
            <p className="ai-reply">{aiReply}</p>
          ) : (
            <span className="status-word">{statusWord}</span>
          )}
          {pendingAction && (
            <div className="action-confirm" onClick={(e) => e.stopPropagation()}>
              <p className="action-summary">{pendingAction.summary}</p>
              <div className="action-buttons">
                <button className="btn-confirm" onClick={(e) => { e.stopPropagation(); confirmAction(); }}>Confirm</button>
                <button className="btn-cancel" onClick={(e) => { e.stopPropagation(); cancelAction(); }}>Cancel</button>
              </div>
            </div>
          )}
          {state === "idle" && aiReply && !pendingAction && (
            <span className="ai-hint">Hold Ctrl + Alt to reply</span>
          )}
          {attachedScreen && <span className="screen-sent">📸 screen sent</span>}
          {canSeeScreen && screenAllowed && (
            <button
              className={`screen-toggle${seeScreen ? " screen-toggle--on" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                const v = !seeScreen;
                setSeeScreen(v);
                seeScreenRef.current = v;
                screenOffThisTurnRef.current = !v; // remember an explicit OFF for this question
              }}
              title="Let Keak AI look at your screen for your next question"
            >
              <IconEye /> {seeScreen ? "Seeing your screen" : "See screen"}
            </button>
          )}
        </div>
      )}

      {!assistant && (state === "idle" || state === "recording" || state === "processing") && (
        <div className={`pill${state === "recording" ? " pill--recording" : ""}`} data-tauri-drag-region>
          <img src={isPaid ? keakLogoDark : keakLogo} className="k-badge-img" alt="Keak" />

          {state === "recording" ? (
            <div className="pill-live">
              <Waveform active streamRef={streamRef} />
              <span className="pill-label">{rewriting ? "Rewrite" : thoughtDump ? "Thought Dump" : "Listening"}</span>
            </div>
          ) : state === "processing" ? (
            <div className="pill-live">
              <span className="thinking-dots"><i /><i /><i /></span>
              <span className="pill-label">{rewriting ? "Rewriting" : "Thinking"}</span>
            </div>
          ) : (
            <span className="pill-hint">{thoughtDump ? "Thought Dump on · click mic" : "Click mic to speak"}</span>
          )}

          {state !== "processing" && (
            <>
              <button
                className={`mic-btn${state === "recording" ? " mic-btn--recording" : ""}`}
                onClick={handleMicClick}
                title={state === "recording" ? "Stop" : "Speak"}
              >
                {state === "recording" ? <IconStop /> : <IconMic />}
              </button>
              {state === "idle" && (
                <button
                  className={`dump-btn${thoughtDump ? " dump-btn--on" : ""}`}
                  onClick={() => setThoughtDump((v) => { thoughtDumpRef.current = !v; return !v; })}
                  title="Thought Dump: restructures messy speech into clean text"
                >
                  TD
                </button>
              )}
            </>
          )}

          <button className="close-btn" onClick={doClose} title="Close"><IconClose /></button>
        </div>
      )}

      {!assistant && state === "result" && (
        <div className="pill result-pill" data-tauri-drag-region>
          <p className="result-text">{result}</p>
          <div className="result-actions">
            <button className="btn-insert" onClick={insertText}>Insert</button>
            <button className="btn-copy" onClick={copyText}>Copy</button>
            <button className="btn-retry" onClick={reset}>Redo</button>
            <button className="btn-discard" onClick={doClose} title="Discard"><IconClose /></button>
          </div>
        </div>
      )}

      {!assistant && state === "error" && (
        <div className="pill error-pill" data-tauri-drag-region>
          <span className="error-icon">⚠</span>
          <span className="pill-hint error-text">{errorMsg}</span>
          <button className="close-btn" onClick={doClose} title="Close"><IconClose /></button>
        </div>
      )}
    </div>
  );
}
