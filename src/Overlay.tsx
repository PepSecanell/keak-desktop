import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import keakLogo from "./assets/icon_keak_2.png";
import keakLogoDark from "./assets/icon_keak_2.png";
import { effectiveDefaults, saveDefaultOverride } from "./agents-defaults";
import { readRoutines, isRoutineDue, setRoutineRun, upsertRoutine, newRoutineId, nextRunLabel, type Routine } from "./routines";
import { useUiLang } from "./i18n";
import { runKeakLiveTest } from "./keakLive"; // EXPERIMENTAL — see keakLive.ts. Delete this line + the
// liveTestLog/testKeakLive block below + the gated panel in the render to remove the experiment.
import { LiveKeak, liveInfo, type LiveMode } from "./liveKeak"; // real live voice for the Ctrl+Alt Keak AI turn
import "./Overlay.css";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "https://c--8d6c4aab-d6cd-4281-ad41-da14196d68fc-prod.lovable.cloud") as string;
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_GjF5OPvQRDcdLyuiFGroOg_FiyrnhjN") as string;

// Keak Sovereign: auto-detect local whisper server — no manual toggle needed.
// Just run start.bat and Keak switches to local automatically.
const LOCAL_WHISPER = "http://127.0.0.1:9889";
let _sovereignCache: { ok: boolean; ts: number } | null = null;
async function isLocalServerUp(): Promise<boolean> {
  const now = Date.now();
  if (_sovereignCache && now - _sovereignCache.ts < 20_000) return _sovereignCache.ok;
  const ok = await fetch(`${LOCAL_WHISPER}/health`, { signal: AbortSignal.timeout(400) })
    .then((r) => r.ok)
    .catch(() => false);
  _sovereignCache = { ok, ts: now };
  return ok;
}

type OverlayState = "idle" | "recording" | "processing" | "result" | "error" | "responding";

function getSession() {
  const stored = localStorage.getItem("keak_session");
  return stored ? JSON.parse(stored) : null;
}

// base64 -> Blob, for the WAV chunks the Rust recap engine hands back.
function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

// Encode mono Float32 PCM as a 16-bit WAV blob (the format the transcribe endpoint reliably accepts).
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
  return new Blob([view], { type: "audio/wav" });
}
// Telegram voice notes are OGG/Opus. Decode them in the app to 16k mono WAV so transcription is reliable.
async function oggB64ToWav(b64: string): Promise<Blob | null> {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const data = audio.getChannelData(0);
    const out = new Float32Array(data.length); out.set(data);
    try { await ctx.close(); } catch { /* ignore */ }
    return encodeWav(out, audio.sampleRate || 16000);
  } catch { return null; }
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

const BCP47: Record<string, string> = { es: "es-ES", en: "en-US", zh: "zh-CN", hi: "hi-IN", ar: "ar-SA", fr: "fr-FR", de: "de-DE", pt: "pt-PT", it: "it-IT" };

// Which language is this reply in? Use the pinned dictation setting if concrete, else the interface language
// (keak_ui_lang) if the user chose one, else a light heuristic (Pep's two main languages are ES/EN). Getting
// this right is what stops the voice mixing languages mid-phrase.
function replyLang(text: string): string {
  const pinned = localStorage.getItem("keak_language");
  if (pinned && pinned !== "auto" && BCP47[pinned]) return pinned;
  const ui = localStorage.getItem("keak_ui_lang");
  if (ui && ui !== "en" && BCP47[ui] && !/[ñ¿¡áéíóú]/i.test(text)) return ui;
  if (/[ñ¿¡áéíóú]/i.test(text)) return "es";
  const t = ` ${text.toLowerCase()} `;
  const es = (t.match(/ (el|la|los|las|de|que|y|en|un|una|es|por|con|para|como|pero|más|está|hola|gracias|qué|cómo) /g) || []).length;
  const en = (t.match(/ (the|and|is|to|of|in|a|that|it|for|you|with|this|are|what|how|hello|thanks) /g) || []).length;
  return es > en ? "es" : "en";
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  // If the user chose a specific voice in Settings, honor it (when it fits the language, or always if they
  // picked one). This is the "pick a better Windows voice" path.
  const savedUri = localStorage.getItem("keak_voice_uri") || "";
  if (savedUri) {
    const saved = voices.find((v) => v.voiceURI === savedUri);
    if (saved) return saved;
  }
  const byLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = byLang.length ? byLang : voices;
  // Rank voices so the fallback sounds good: natural/neural/online + known-good names win; the old robotic
  // "Microsoft David/Zira Desktop" voices lose. This is what plays when the premium keak-tts voice is down.
  const score = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase();
    let s = 0;
    if (/natural|neural/.test(n)) s += 12;
    if (/online/.test(n)) s += 7;
    if (/google/.test(n)) s += 6;
    if (/aria|jenny|michelle|ana|libby|sofia|elvira|sonia|nova|guy|christopher|dalia/.test(n)) s += 4;
    if (/desktop/.test(n)) s -= 4;
    if (/david|zira|mark|hazel|helena|sabina/.test(n)) s -= 3;
    return s;
  };
  return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

// Extract city name from weather queries in English or Spanish.
function extractWeatherCity(task: string): string | null {
  const m =
    task.match(/weather\s+(?:in|for)\s+([A-Za-zÀ-ÿ\s,]+?)(?:\?|$)/i) ||
    task.match(/(?:tiempo|clima|temperatura)\s+(?:en|de)\s+([A-Za-zÀ-ÿ\s,]+?)(?:\?|$)/i) ||
    task.match(/(?:what(?:'s| is)(?: the)? weather.*?in)\s+([A-Za-zÀ-ÿ\s,]+?)(?:\?|$)/i);
  return m ? m[1].trim() : null;
}

function weatherDesc(code: number, lang: string): string {
  const key =
    code === 0 ? "clear" : code <= 3 ? "partly" : code <= 48 ? "fog" :
    code <= 57 ? "drizzle" : code <= 67 ? "rain" : code <= 77 ? "snow" :
    code <= 82 ? "showers" : "storm";
  const EN: Record<string, string> = { clear: "clear sky", partly: "partly cloudy", fog: "foggy", drizzle: "drizzling", rain: "raining", snow: "snowing", showers: "showers", storm: "stormy" };
  const ES: Record<string, string> = { clear: "cielo despejado", partly: "parcialmente nublado", fog: "niebla", drizzle: "llovizna", rain: "lluvia", snow: "nieve", showers: "chubascos", storm: "tormenta" };
  return (lang === "es" ? ES : EN)[key] ?? "unknown";
}

async function fetchWeatherSpeech(city: string): Promise<string | null> {
  try {
    const lang = localStorage.getItem("keak_language") || "en";
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
    const geoData = await geoRes.json();
    const loc = geoData.results?.[0];
    if (!loc) return null;
    const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code,wind_speed_10m&wind_speed_unit=kmh`);
    const wData = await wRes.json();
    const cur = wData.current;
    if (!cur) return null;
    const temp = Math.round(cur.temperature_2m);
    const wind = Math.round(cur.wind_speed_10m);
    const desc = weatherDesc(cur.weather_code, lang);
    return lang === "es"
      ? `En ${loc.name} hay ${temp}°C con ${desc}, y vientos de ${wind} km/h.`
      : `In ${loc.name}, it's ${temp}°C with ${desc}, and winds at ${wind} km/h.`;
  } catch {
    return null;
  }
}

// Local calendar-intent parser. Deterministic (no model round trip) so the event TITLE and DAY always
// land — the old path let Keak AI open a blank Google Calendar link with nothing filled in. Returns
// { title, start, end } or null when it's not confidently a calendar request.
function parseCalendarEvent(task: string): { title: string; start: Date; end: Date } | null {
  const t = task.toLowerCase();
  // Don't fire on QUESTIONS about the calendar ("what's my schedule today") — only on commands.
  const isQuestion = /\b(what|when|where|which|who|how|do i|is there|are there|show|tell|check|list|qué|que|cuándo|cuando|dónde|donde|tengo|hay)\b/.test(t) && !/\bremind me\b/.test(t);
  if (isQuestion) return null;
  const intent =
    /\b(add|create|schedule|set ?up|make|put|new|book|arrange)\b[\s\S]{0,40}\b(event|meeting|appointment|reminder|calendar|call|invite)\b/.test(t) ||
    /\b(event|meeting|appointment)\b[\s\S]{0,25}\b(on|at|for|tomorrow|today|this|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t) ||
    /\bremind me\b/.test(t) ||
    /\badd\b[\s\S]{0,40}\bto (my |the )?calendar\b/.test(t) ||
    /\b(crea|añade|agrega|agenda|programa|pon)\b[\s\S]{0,40}\b(evento|reunión|reunion|cita|recordatorio)\b/.test(t);
  if (!intent) return null;

  const now = new Date();
  const start = new Date(now);
  let matchedDay = false;

  if (/\btomorrow\b|\bmañana\b/.test(t)) { start.setDate(now.getDate() + 1); matchedDay = true; }
  else if (/\btoday\b|\bhoy\b/.test(t)) { matchedDay = true; }
  else {
    const en = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    let di = en.findIndex((d) => t.includes(d));
    if (di < 0) {
      const es: [RegExp, number][] = [[/domingo/, 0], [/lunes/, 1], [/martes/, 2], [/mi[eé]rcoles/, 3], [/jueves/, 4], [/viernes/, 5], [/s[aá]bado/, 6]];
      const hit = es.find(([re]) => re.test(t)); if (hit) di = hit[1];
    }
    if (di >= 0) { let diff = (di - now.getDay() + 7) % 7; if (diff === 0) diff = 7; start.setDate(now.getDate() + diff); matchedDay = true; }
  }

  let hour = 9, min = 0, matchedTime = false;
  const tm = t.match(/\b(?:at|a las|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (tm) {
    hour = parseInt(tm[1], 10); min = tm[2] ? parseInt(tm[2], 10) : 0;
    const ap = tm[3] || "";
    if (/p/.test(ap) && hour < 12) hour += 12;
    if (/a/.test(ap) && hour === 12) hour = 0;
    matchedTime = true;
  }
  start.setHours(hour, min, 0, 0);
  if (!matchedDay && !matchedTime) return null;
  if (!matchedDay && matchedTime && start.getTime() < now.getTime()) start.setDate(now.getDate() + 1);

  const end = new Date(start.getTime() + 60 * 60 * 1000);

  let title = "";
  const q = task.match(/["“'']([^"”'']{2,60})["”'']/);
  const named = task.match(/\b(?:called|titled|named|about|llamad[oa]|titulad[oa]|sobre)\s+(.+?)(?:\s+(?:on|at|tomorrow|today|this|next|a las|el|mañana|hoy)\b|$)/i);
  if (q) title = q[1].trim();
  else if (named) title = named[1].trim();
  if (!title) {
    title = task
      .replace(/\b(hey |ok )?keak[,]?\s*/i, "")
      .replace(/\b(please|can you|could you|add|create|schedule|set ?up|make|put|new|book|to|my|the|a|an|event|meeting|appointment|reminder|calendar|google|remind me|crea|añade|agrega|agenda|programa|pon|un|una|evento|reunión|reunion|cita|recordatorio|calendario)\b/gi, " ")
      .replace(/\b(tomorrow|today|mañana|hoy|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi, " ")
      .replace(/\b(?:at|a las|@)\s*\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, " ")
      .replace(/\b(on|el)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
  }
  if (!title || title.length < 2) title = "New event";
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return { title, start, end };
}

function fmtCalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // Floating local time (no Z) so Google Calendar uses the user's own timezone.
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

function buildCalendarUrl(ev: { title: string; start: Date; end: Date }): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${fmtCalDate(ev.start)}/${fmtCalDate(ev.end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// How far Keak is allowed to go when it takes an action, set by the user in Keak settings:
//   full = finish the job (click Save on the event, hit Send on the reply) with no extra tap
//   ask  = set everything up but leave the final click to the user (safe default)
//   off  = don't run local action handlers at all — Keak only talks/dictates
function actionMode(): "full" | "ask" | "off" {
  const m = localStorage.getItem("keak_action_mode");
  return m === "full" || m === "off" ? m : "ask";
}

// Turns the 0-100 personality dials into a system-prompt instruction (used by Keak AI answers).
function personaLines(): string {
  const g = (k: string, d: number) => parseInt(localStorage.getItem(k) || String(d), 10);
  const band = (v: number, a: string, b: string, c: string, d: string) =>
    v < 16 ? a : v < 41 ? b : v < 71 ? c : d;
  const humor = band(g("keak_humor", 20),
    "Keep your tone neutral and professional; do not joke.",
    "A light, occasional touch of humor is welcome.",
    "Be playful and witty where it naturally fits.",
    "Be very funny and playful; joke around a lot while still being genuinely helpful.");
  const warmth = band(g("keak_warmth", 50),
    "Stay matter-of-fact.", "Be friendly.", "Be warm and encouraging.",
    "Be very warm, caring and supportive.");
  const formality = band(g("keak_formality", 30),
    "Use casual, conversational language and contractions.", "Use a relaxed, natural tone.",
    "Use a fairly polished tone.", "Use formal, professional language.");
  const directness = band(g("keak_directness", 50),
    "Be gentle and diplomatic.", "Be clear and straightforward.", "Be direct and to the point.",
    "Be blunt and direct; no sugar-coating.");
  return `${humor} ${warmth} ${formality} ${directness}`;
}

// Lets the user tune Keak AI's personality by voice ("be funnier", "less formal", "set humor to 80").
// Writes the dial to localStorage and returns a spoken confirmation, or null if it wasn't a tune command.
function adjustPersonaFromSpeech(task: string): string | null {
  const t = task.toLowerCase();
  // Trigger verbs (EN + ES). "change" and "put" were missing before, so "change the humor to 70" fell through
  // to a normal answer — Keak said "done" without moving the dial.
  if (!/\b(be|make|act|sound|more|less|turn|increase|decrease|raise|lower|bump|set|change|put|adjust|tone|dial|funnier|warmer|gentler|softer|serious|casual|colder|cambia|cambiar|pon|poner|sube|subir|baja|bajar|ajusta|más|mas|menos)\b/.test(t)) return null;
  const dials: { re: RegExp; key: string; label: string; downRe: RegExp }[] = [
    { re: /\b(humou?r|funny|funnier|joke|jokes|playful|gracioso|divertido)\b/, key: "keak_humor", label: "humor", downRe: /\b(serious|serio)\b/ },
    { re: /\b(warm|warmer|warmth|friendly|friendlier|caring|kind|nicer|c[áa]lido|amable)\b/, key: "keak_warmth", label: "warmth", downRe: /\b(cold|colder|fr[íi]o)\b/ },
    { re: /\b(formal|formality|professional|casual|formalidad)\b/, key: "keak_formality", label: "formality", downRe: /\b(casual|informal)\b/ },
    { re: /\b(direct|directness|blunt|honest|straightforward|gentle|gentler|softer|diplomatic|directo)\b/, key: "keak_directness", label: "directness", downRe: /\b(gentle|gentler|softer|diplomatic|suave)\b/ },
  ];
  const hit = dials.find((d) => d.re.test(t));
  if (!hit) return null;
  // Drop "not/instead of <num>" first, so "to 70 not 100" keeps 70 (not the last number seen).
  const cleaned = t.replace(/\b(?:not|no|instead of|rather than|but not|en vez de)\s+\d{1,3}\b/g, " ");
  // Prefer a number introduced by to/at/on/=/of; else the first bare number.
  const absM = cleaned.match(/\b(?:to|at|on|=|:|of|a|al)\s*(\d{1,3})\b/) || cleaned.match(/\b(\d{1,3})\b/);
  let dir = 1;
  const abs: number | null = absM ? parseInt(absM[1], 10) : null;
  if (abs == null) {
    const down = /\b(less|tone down|lower|decrease|turn down|menos|baja|bajar)\b/.test(t);
    dir = down ? -1 : 1;
    if (hit.downRe.test(t)) dir = -1;
  }
  const cur = parseInt(localStorage.getItem(hit.key) || "50", 10);
  const next = Math.max(0, Math.min(100, abs != null ? abs : cur + dir * 25));
  localStorage.setItem(hit.key, String(next));
  return `Done, ${hit.label} is now ${next} out of 100.`;
}

// Lets the user switch the connected AI's model/provider (or the Claude effort) by voice:
// "change the model to Sonnet", "switch to ChatGPT", "use Haiku", "set effort to high". Writes the same
// localStorage keys the Connect window uses, so the picker and the voice command stay in sync. Returns a
// spoken confirmation, or null if it wasn't a switch command.
function parseModelSwitch(task: string): string | null {
  const t = task.toLowerCase().trim();

  // Never hijack a genuine question ABOUT models ("which is better, opus or sonnet?", "what model are you").
  if (/^(?:what|which|who|why|how|whats|what's|is |are |does |do |tell me|explain|compare|difference)\b/.test(t)) return null;

  // Intent: an explicit switch/change verb (EN + ES), or the word model/effort itself.
  const hasIntent =
    /\b(switch|change|swap|set|use|using|select|pick|put|go with|activate|turn on|make it)\b/.test(t) ||
    /\b(cambia|cambiar|cámbia|usa|usar|pon|ponlo|poner|activa|selecciona|quiero|dame|ponme|pasa a)\b/.test(t) ||
    /\b(model|models|modelo|effort|esfuerzo)\b/.test(t);
  if (!hasIntent) return null;

  console.log("[KEAK] model-switch intent:", JSON.stringify(t));

  // Effort (Claude): "set effort to high", "maximum effort", "esfuerzo alto".
  const effM = t.match(/\b(?:effort|esfuerzo)\b[^a-z]*(low|medium|high|max|maximum|bajo|medio|alto|máximo|maximo)\b|\b(low|medium|high|max|maximum|bajo|medio|alto|máximo|maximo)\b[^a-z]*(?:effort|esfuerzo)\b/);
  if (effM) {
    const raw = (effM[1] || effM[2] || "");
    const map: Record<string, string> = { maximum: "max", bajo: "low", medio: "medium", alto: "high", "máximo": "max", maximo: "max" };
    const word = map[raw] || raw;
    localStorage.setItem("keak_cu_claude_effort", word);
    return `Done, effort is set to ${word}.`;
  }

  // A named model — switch provider AND set that provider's model in one go.
  const models: { rx: RegExp; provider: string; model: string; say: string }[] = [
    { rx: /\bopus\b/, provider: "claude", model: "claude-opus-4-8", say: "Claude Opus" },
    { rx: /\bsonnet\b|\bsonet\b/, provider: "claude", model: "claude-sonnet-5", say: "Claude Sonnet 5" },
    { rx: /\bhaiku\b|\bhaikú\b/, provider: "claude", model: "claude-haiku-4-5", say: "Claude Haiku" },
    { rx: /\bfable\b|\bfábula\b/, provider: "claude", model: "claude-fable-5", say: "Claude Fable" },
    { rx: /\bgpt[\s-]?5(?:\.\d)?\b|\bgpt five\b|\bchat ?gpt 5\b/, provider: "openai", model: "gpt-5.6", say: "GPT 5.6" },
    { rx: /\bgpt[\s-]?4o?\b|\bgpt four\b|\b4o\b/, provider: "openai", model: "gpt-4o", say: "GPT 4o" },
    { rx: /\bgemini\s?flash\b|\b3\.5\s?flash\b|\bflash\s?lite\b|\bflash\b|\blite\b|\b2\.5\s?flash\b|\bgemini\s?pro\b|\b2\.5\s?pro\b/, provider: "gemini", model: "gemini-3.5-flash", say: "Gemini Flash" },
  ];
  for (const m of models) {
    if (m.rx.test(t)) {
      localStorage.setItem("keak_cu_provider", m.provider);
      localStorage.setItem(`keak_cu_${m.provider}_model`, m.model);
      console.log("[KEAK] switched model ->", m.model);
      return `Done, I switched to ${m.say}.`;
    }
  }

  // Just a provider named, no specific model — switch the provider only.
  const providers: { rx: RegExp; provider: string; say: string }[] = [
    { rx: /\b(claude|anthropic)\b/, provider: "claude", say: "Claude" },
    { rx: /\b(chat\s?gpt|open\s?ai|gpt)\b/, provider: "openai", say: "ChatGPT" },
    { rx: /\b(gemini|google)\b/, provider: "gemini", say: "Gemini" },
    { rx: /\b(local|ollama|offline|on[\s-]?device|my own (?:model|ai)|mi propio|local model)\b/, provider: "ollama", say: "your local model" },
  ];
  for (const p of providers) {
    if (p.rx.test(t)) {
      localStorage.setItem("keak_cu_provider", p.provider);
      console.log("[KEAK] switched provider ->", p.provider);
      return `Done, I switched to ${p.say}.`;
    }
  }

  // They clearly want to change the model but didn't name one — offer the menu instead of letting the
  // model answer "I can't do that".
  if (/\b(model|models|modelo|effort|esfuerzo)\b/.test(t)) {
    return "Sure. Which one? You can say Opus, Sonnet, Haiku, Fable, ChatGPT, Gemini, or your local model.";
  }
  return null;
}

// Decides whether a command should drive the real screen agent (TARS) instead of the old navigate-only
// assistant. Since screen control is opt-in (a provider is connected + not "off"), we can be generous:
// anything that needs real clicking/typing goes to the agent. Pure questions stay as normal answers.
function parseComputerTask(task: string): string | null {
  const stripped = task.trim().replace(/^\s*(?:hey |ok )?keak[, ]*/i, "");
  const low = stripped.toLowerCase();
  if (stripped.length < 3) return null;

  // Strong explicit triggers — always take over.
  const strong = stripped.match(/^(?:\/do|take over|take control|control my screen|use my (?:computer|screen)|do this for me|do it for me)\b[:,]?\s*(?:and\s+)?(.*)/i);
  if (strong) return (strong[1] && strong[1].trim().length >= 3) ? strong[1].trim() : stripped;

  // Plain questions are never screen tasks.
  if (/^(?:what|why|how|when|who|which|where|is |are |am |do |does |did |can you (?:tell|explain|say)|tell me|explain|summar|translate)\b/i.test(low)) return null;

  // On-screen manipulation the old navigate-only path can't do (the real differentiator = clicking).
  if (/\b(click|double[- ]?click|select|choose|tap|press|play|scroll|drag|hover|check the box|tick|untick|toggle|fill (?:in|out)|add to cart|reply|compose|download|install|sign in|log in)\b/i.test(low)) {
    return stripped;
  }
  // Compound "open/go to X and <do Y>" — more than just navigating somewhere.
  if (/\b(?:open|go to|navigate to|launch|find|search)\b.+\b(?:and|then)\b/i.test(low)) return stripped;
  return null;
}

// ---- Agents (Phase 7) ------------------------------------------------------------------------------
// A big multi-part job ("research X and build Y and write Z") gets split across named "star" sub-agents,
// each running on the user's OWN connected AI (so it costs nothing). They animate as drifting orbs in the
// fullscreen click-through "agents" window; results roll back up into a spoken summary + a "See it" panel.
type OwnAI = { provider: string; credential: string; accountId: string; isSub: boolean; model: string; effort: string };

// Detect an agent-worthy job. Explicit ("use your team to…", "/agents …", ES "usa tus agentes…") or a
// clear multi-step build/research command (2+ deliverables joined by and/then). Returns the job or null.
function parseAgentJob(task: string): string | null {
  const raw = task.trim();
  const t = raw.toLowerCase();

  // Explicit delegation wins: "/agents …", "use your team to …", "with the team …", ES "usa tus agentes …".
  // The whole utterance is passed to the planner — it handles the "use your team to" preamble fine.
  const slash = /^\s*\/agents?\b/i.test(raw);
  const explicitDelegate = /\b(?:use|using|with|spin up|bring in|deploy|unleash|get|usa|utiliza|con|despliega)\b[\s\S]{0,20}\b(?:agents?|team|squad|equipo|agentes)\b/i.test(raw);
  if (slash || explicitDelegate) {
    const rest = raw.replace(/^\s*\/agents?\b[:,]?\s*/i, "").trim();
    return rest.length >= 3 ? rest : raw;
  }

  // Not a pure question.
  if (/^(?:what|why|how|when|who|which|where|is |are |can you (?:tell|explain))\b/.test(t)) return null;
  const teamWord = /\b(agents?|team|squad|equipo|agentes)\b/.test(t);
  const verbs = t.match(/\b(build|create|make|research|write|draft|design|plan|analys?e|analyze|summari[sz]e|compare|generate|investigate|outline|construye|crea|investiga|escribe|dise[nñ]a|planifica)\b/g) || [];
  const joined = /\b(and|then|also|plus|y|luego|además)\b/.test(t) || raw.includes(",");
  if (teamWord && verbs.length >= 1) return raw;                    // "team" + a task
  if (verbs.length >= 2 && joined && raw.length > 24) return raw;   // multi-part build/research job
  return null;
}

// "show me the agents", "make all the agents appear on screen", ES "muestra los agentes" — DISPLAY every
// agent as an orb without giving them work. Distinct from a delegation job (which has a build/research verb).
function parseShowAgents(task: string): boolean {
  const t = task.trim().toLowerCase();
  if (!/\b(agents?|team|equipo|agentes)\b/.test(t)) return false;
  const wantsShow = /\bappear\b|\bon (?:the )?screen\b|\ball (?:the |of the )?agents\b|\bevery agent\b|\bwhole team\b|en la pantalla|todos los agentes|\b(show|see|display|reveal|bring up|pull up|muestra|mu[eé]strame|ens[eé]ñame|ver)\b/.test(t);
  const isDelegation = /\buse your team\b|\busa tus agentes\b|\bhave (?:the )?(?:team|agents)\s+\w/.test(t);
  const jobVerb = /\b(research|draft|analy|summari|compare|investigate|build (?:me|a|an)|create (?:me|a|an)|write (?:me|a|an)|investiga|escribe)\b/.test(t);
  return wantsShow && !isDelegation && !jobVerb;
}

// Catch-all: is this an imperative that needs the real screen/computer or a tool (not a question)? Used as a
// last resort before answering, so Keak DOES the thing (open YouTube, create a folder, book a slot) via screen
// control instead of replying "I can't". Screen actions are still gated by Ask/Full/Off, so Ask asks first.
function looksLikeAction(task: string): boolean {
  const t = task.trim().toLowerCase().replace(/^(?:hey |ok )?keak[, ]*/i, "");
  if (t.length < 4) return false;
  if (/^(?:what|why|how|when|who|which|where|is |are |am |do |does |did |can you (?:tell|explain|say|list)|could you (?:tell|explain)|tell me|explain|summar|translate|define|who's|what's|whats|whos|give me a)\b/.test(t)) return false;
  const webVerb = /\b(open|go to|navigate to|launch|play|download|upload|install|uninstall|sign in|log ?in|log ?out|book|reserve|schedule|order|buy|checkout|add to cart|send (?:an? )?(?:email|message|dm|text)|post|publish|look up)\b/.test(t);
  const appNoun = /\b(youtube|gmail|calendar|spotify|chrome|browser|desktop|folder|file|pdf|document|spreadsheet|slides?|website|web ?site|app|project|account|playlist|tab|window)\b/.test(t);
  const makeArtifact = /\b(create|make|build|generate|set up|start|draft|design|write|save)\b/.test(t) && appNoun;
  return webVerb || makeArtifact;
}

// "read my inbox", "any new emails", ES "lee mis correos" → read Gmail aloud.
function parseGmailRead(task: string): boolean {
  const t = task.trim().toLowerCase();
  const mail = /\b(email|emails|e-?mail|mail|inbox|correos?|bandeja)\b/.test(t);
  const read = /\b(read|check|show|any|new|what|do i have|leer?|lee|revisa|mira|tengo|hay|nuevos?)\b/.test(t);
  return mail && read;
}
// "send an email to a@b.com saying …", ES "envía un correo a a@b.com diciendo …" → send Gmail.
function parseGmailSend(task: string): { to: string; subject: string; body: string } | null {
  const t = task.trim();
  if (!(/\bsend\b[\s\S]*\b(email|e-?mail|mail)\b/i.test(t) || /\benv[ií]a\b[\s\S]*\b(correo|email|mail)\b/i.test(t))) return null;
  const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
  if (!email) return null; // need an address (name→email needs contacts, not built yet)
  let body = "";
  const bm = t.match(/\b(?:saying|that says|telling (?:him|her|them)|diciendo(?:le)?|que diga)\s+([\s\S]+)$/i);
  if (bm) body = bm[1].trim();
  let subject = "";
  const sm = t.match(/\b(?:about|subject|regarding|asunto|sobre)\s+([^,.]+?)(?:\s+(?:saying|that says|diciendo|que diga)\b|[,.]|$)/i);
  if (sm) subject = sm[1].trim();
  if (!subject) subject = body ? body.split(/[.!?\n]/)[0].slice(0, 60) : "Message from Keak";
  return { to: email, subject, body };
}
// "save this to my Drive", ES "guarda esto en Drive" → save the last thing made to Google Drive.
function parseSaveToDrive(task: string): boolean {
  const t = task.trim().toLowerCase();
  return /\b(drive|google drive)\b/.test(t) && /\b(save|upload|put|store|guarda|sube|guardar)\b/.test(t);
}
// Broad "this is about a calendar event" intent (looser than parseCalendarEvent's strict date/time regex),
// so when Google is connected we always create it via the API instead of falling through to screen control.
function isCalendarIntent(task: string): boolean {
  const t = task.trim().toLowerCase();
  if (/^(?:what|when|which|is |are |do |does |how|why|tell me|show me my|list)\b/.test(t)) return false;
  return /\b(calendar|event|meeting|appointment|schedule|book|remind me|reminder|calendario|evento|reuni[oó]n|cita|agenda|ag[eé]ndame|recu[eé]rdame|recordatorio)\b/.test(t);
}

// ---- Google (Calendar/Gmail/Drive) --------------------------------------------------------------------
// A valid Google access token, refreshing it via the stored refresh token + client creds when it's expired.
async function ensureGoogleToken(): Promise<string | null> {
  const token = localStorage.getItem("keak_google_token") || "";
  const refresh = localStorage.getItem("keak_google_refresh") || "";
  const expiry = parseInt(localStorage.getItem("keak_google_expiry") || "0", 10);
  if (!refresh) return token || null;
  if (token && Date.now() < expiry - 60000) return token; // still valid (60s safety margin)
  const clientId = localStorage.getItem("keak_google_client_id") || "";
  const clientSecret = localStorage.getItem("keak_google_client_secret") || "";
  if (!clientId || !clientSecret) return token || null;
  try {
    const raw = await invoke<string>("google_refresh", { args: { clientId, clientSecret, refreshToken: refresh } });
    const t = JSON.parse(raw);
    if (t.access_token) {
      localStorage.setItem("keak_google_token", t.access_token);
      localStorage.setItem("keak_google_expiry", String(Date.now() + (t.expires_in || 3600) * 1000));
      return t.access_token;
    }
  } catch (e) { console.log("[KEAK] google refresh failed:", String(e)); }
  return token || null;
}
// RFC3339 wall-clock time (no zone suffix) — paired with the user's IANA timezone so Google reads it right.
function toLocalRfc3339(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
// Create the event on the user's real Google Calendar. Returns the event link, or null if not connected/failed.
async function createGoogleEvent(ev: { title: string; start: Date; end: Date }): Promise<string | null> {
  const token = await ensureGoogleToken();
  if (!token) return null;
  const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
  try {
    const raw = await invoke<string>("google_calendar_create", { args: {
      accessToken: token, summary: ev.title, description: "Created by Keak",
      start: toLocalRfc3339(ev.start), end: toLocalRfc3339(ev.end), timezone,
    } });
    const r = JSON.parse(raw);
    return r.htmlLink || "ok";
  } catch (e) { console.log("[KEAK] gcal create failed:", String(e)); return null; }
}

// ---- Microsoft (Outlook Calendar / Mail / OneDrive) ---------------------------------------------------
function msConnected(): boolean { return !!localStorage.getItem("keak_ms_refresh"); }
// A valid Microsoft Graph access token, refreshed via the stored refresh token when expired.
async function ensureMsToken(): Promise<string | null> {
  const token = localStorage.getItem("keak_ms_token") || "";
  const refresh = localStorage.getItem("keak_ms_refresh") || "";
  const expiry = parseInt(localStorage.getItem("keak_ms_expiry") || "0", 10);
  if (!refresh) return token || null;
  if (token && Date.now() < expiry - 60000) return token;
  const clientId = localStorage.getItem("keak_ms_client_id") || "";
  const clientSecret = localStorage.getItem("keak_ms_client_secret") || "";
  if (!clientId) return token || null;
  try {
    const raw = await invoke<string>("ms_refresh", { args: { clientId, clientSecret, refreshToken: refresh } });
    const t = JSON.parse(raw);
    if (t.access_token) {
      localStorage.setItem("keak_ms_token", t.access_token);
      if (t.refresh_token) localStorage.setItem("keak_ms_refresh", t.refresh_token);
      localStorage.setItem("keak_ms_expiry", String(Date.now() + (t.expires_in || 3600) * 1000));
      return t.access_token;
    }
  } catch (e) { console.log("[KEAK] ms refresh failed:", String(e)); }
  return token || null;
}
// Create the event on the user's Outlook calendar. Returns the event link, or null if not connected/failed.
async function createMsEvent(ev: { title: string; start: Date; end: Date }): Promise<string | null> {
  const token = await ensureMsToken();
  if (!token) return null;
  const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
  try {
    const raw = await invoke<string>("ms_calendar_create", { args: {
      accessToken: token, summary: ev.title, description: "Created by Keak",
      start: toLocalRfc3339(ev.start), end: toLocalRfc3339(ev.end), timezone,
    } });
    const r = JSON.parse(raw);
    return r.webLink || "ok";
  } catch (e) { console.log("[KEAK] outlook create failed:", String(e)); return null; }
}
// Create a calendar event on whichever provider is connected — Google first, then Microsoft.
async function createEventAnyProvider(ev: { title: string; start: Date; end: Date }): Promise<string | null> {
  if (localStorage.getItem("keak_google_refresh")) { const l = await createGoogleEvent(ev); if (l) return l; }
  if (msConnected()) { const l = await createMsEvent(ev); if (l) return l; }
  return null;
}

// ---- Plug-in tools (Perplexity, Slack, …) -------------------------------------------------------------
function toolKey(id: string): string { return localStorage.getItem(`keak_tool_${id}`) || ""; }
// Live web research with citations via the user's own Perplexity key. Returns the answer text, or null.
async function askPerplexity(query: string): Promise<string | null> {
  const key = toolKey("perplexity");
  if (!key) return null;
  try { return await invoke<string>("perplexity_ask", { args: { apiKey: key, query, model: "" } }); }
  catch (e) { console.log("[KEAK] perplexity failed:", String(e)); return null; }
}
// Live web research via Tavily when Perplexity is not connected. Returns the answer text, or null.
async function askTavily(query: string): Promise<string | null> {
  const key = toolKey("tavily");
  if (!key) return null;
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, search_depth: "basic", max_results: 5 }),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
    if (!d.results?.length) return null;
    return d.results.slice(0, 5).map((res) => `${res.title || ""}: ${res.content || ""} (${res.url || ""})`).join("\n").slice(0, 3000);
  } catch (e) { console.log("[KEAK] tavily failed:", String(e)); return null; }
}
// Post a message to Slack with the user's connected token. Returns true on success.
async function postToSlack(channel: string, text: string): Promise<boolean> {
  const token = localStorage.getItem("keak_slack_token") || "";
  if (!token) return false;
  try { await invoke("slack_post", { args: { token, channel, text } }); return true; }
  catch (e) { console.log("[KEAK] slack post failed:", String(e)); return false; }
}
// ElevenLabs voiceover → returns the saved mp3 path, or null.
async function makeVoiceover(text: string): Promise<string | null> {
  const key = toolKey("elevenlabs"); if (!key) return null;
  const voiceId = localStorage.getItem("keak_tool_elevenlabs_voice") || "";
  try { return await invoke<string>("elevenlabs_tts", { args: { apiKey: key, text, voiceId } }); }
  catch (e) { console.log("[KEAK] elevenlabs failed:", String(e)); return String(e); }
}
// Gamma deck → returns the gamma URL, or an error string.
async function makeDeck(prompt: string): Promise<string | null> {
  const key = toolKey("gamma"); if (!key) return null;
  try { return await invoke<string>("gamma_generate", { args: { apiKey: key, prompt } }); }
  catch (e) { console.log("[KEAK] gamma failed:", String(e)); return String(e); }
}
// HeyGen avatar video → returns the video URL, or an error string.
async function makeVideo(script: string): Promise<string | null> {
  const key = toolKey("heygen"); if (!key) return null;
  const avatarId = localStorage.getItem("keak_tool_heygen_avatar") || "";
  const voiceId = localStorage.getItem("keak_tool_heygen_voice") || "";
  try { return await invoke<string>("heygen_video", { args: { apiKey: key, script, avatarId, voiceId } }); }
  catch (e) { console.log("[KEAK] heygen failed:", String(e)); return String(e); }
}
// Fire an automation. Make runs the chosen scenario via its API; n8n fires a Catch-Hook webhook URL.
async function fireAutomation(text: string): Promise<boolean> {
  const mtoken = localStorage.getItem("keak_make_token");
  const mscenario = localStorage.getItem("keak_make_scenario");
  const mregion = localStorage.getItem("keak_make_region") || "eu2";
  if (mtoken && mscenario) {
    try { await invoke("make_run", { args: { token: mtoken, region: mregion, scenarioId: mscenario } }); return true; }
    catch (e) { console.log("[KEAK] make run failed:", String(e)); /* fall through to n8n if present */ }
  }
  const url = toolKey("n8n");
  if (!url) return false;
  try { await invoke("webhook_post", { args: { url, text } }); return true; }
  catch (e) { console.log("[KEAK] webhook failed:", String(e)); return false; }
}
function looksLikePath(s: string | null): boolean { return !!s && /^[a-zA-Z]:\\|^\/|\.mp3$/.test(s); }
function looksLikeUrl(s: string | null): boolean { return !!s && /^https?:\/\//.test(s); }
// Manus: hand off a whole task to the autonomous agent. Returns the task URL, or an error string.
async function runManus(prompt: string): Promise<string | null> {
  const key = toolKey("manus"); if (!key) return null;
  try { return await invoke<string>("manus_task", { args: { apiKey: key, prompt } }); }
  catch (e) { console.log("[KEAK] manus failed:", String(e)); return String(e); }
}
// Higgsfield: cinematic image/video from a prompt. Returns the asset URL, or an error string.
async function runHiggsfield(prompt: string): Promise<string | null> {
  const key = toolKey("higgsfield"); if (!key) return null;
  try { return await invoke<string>("higgsfield_generate", { args: { apiKey: key, prompt } }); }
  catch (e) { console.log("[KEAK] higgsfield failed:", String(e)); return String(e); }
}
// Resend: send an email with the user's Resend key. Returns true on success.
async function sendViaResend(to: string, subject: string, body: string): Promise<boolean> {
  const key = toolKey("resend"); if (!key) return false;
  const from = localStorage.getItem("keak_tool_resend_from") || "";
  try { await invoke("resend_send", { args: { apiKey: key, from, to, subject, body } }); return true; }
  catch (e) { console.log("[KEAK] resend failed:", String(e)); return false; }
}

// One-time migration: drop retired model IDs saved in localStorage so a stale pick doesn't keep 404-ing
// (e.g. gemini-2.5-pro / gemini-2.0-flash, which the UI can't show but the value was still being sent).
const DEAD_GEMINI = /gemini-2\.5-flash\b|gemini-2\.0-flash\b|gemini-2\.5-pro\b|gemini-1\.5|^gemini-pro$/i;
try {
  const gm = localStorage.getItem("keak_cu_gemini_model") || "";
  if (DEAD_GEMINI.test(gm)) localStorage.removeItem("keak_cu_gemini_model");
} catch { /* ignore */ }
// Map any retired model ID to "" (provider default) at read time, as a backstop for the migration above.
function cleanModel(provider: string, model: string): string {
  if (provider === "gemini" && DEAD_GEMINI.test(model)) return "";
  return model;
}

// Resolve the user's connected AI into a credential bundle (shared by Keak AI answers + agents).
function resolveOwnAI(): OwnAI | null {
  const provider = localStorage.getItem("keak_cu_provider") || "";
  if (!provider) return null;
  let credential = "", accountId = "", isSub = false;
  if (provider === "openai") {
    const sub = localStorage.getItem("keak_cu_openai_token") || "";
    if (sub) { credential = sub; accountId = localStorage.getItem("keak_cu_openai_account") || ""; isSub = true; }
    else credential = localStorage.getItem("keak_cu_openai_key") || "";
  } else if (provider === "gemini") credential = localStorage.getItem("keak_cu_gemini_key") || "";
  else if (provider === "claude") credential = localStorage.getItem("keak_cu_claude_token") || "";
  else if (provider === "ollama") credential = "local";
  else if (provider === "copilot") credential = localStorage.getItem("keak_cu_copilot_token") || "";
  else credential = localStorage.getItem(`keak_cu_${provider}_key`) || ""; // deepseek, mistral, xai
  if (!credential) return null;
  const model = cleanModel(provider, localStorage.getItem(`keak_cu_${provider}_model`) || "");
  const effort = provider === "claude" ? (localStorage.getItem("keak_cu_claude_effort") || "") : "";
  return { provider, credential, accountId, isSub, model, effort };
}

// Resolve a SPECIFIC provider + model into a credential bundle (for per-agent model choices, possibly a
// different company than the main Keak AI). Returns null if that provider isn't connected.
function resolveProviderAI(provider: string, model: string): OwnAI | null {
  let credential = "", accountId = "", isSub = false, m = cleanModel(provider, model);
  if (provider === "openai") {
    const sub = localStorage.getItem("keak_cu_openai_token") || "";
    if (sub) { credential = sub; accountId = localStorage.getItem("keak_cu_openai_account") || ""; isSub = true; }
    else credential = localStorage.getItem("keak_cu_openai_key") || "";
  } else if (provider === "gemini") credential = localStorage.getItem("keak_cu_gemini_key") || "";
  else if (provider === "claude") credential = localStorage.getItem("keak_cu_claude_token") || "";
  else if (provider === "ollama") { credential = "local"; if (!m) m = localStorage.getItem("keak_cu_ollama_model") || ""; }
  else if (provider === "copilot") credential = localStorage.getItem("keak_cu_copilot_token") || "";
  else credential = localStorage.getItem(`keak_cu_${provider}_key`) || ""; // deepseek, mistral, xai
  if (!credential) return null;
  const effort = provider === "claude" ? (localStorage.getItem("keak_cu_claude_effort") || "") : "";
  return { provider, credential, accountId, isSub, model: m || "", effort };
}

// A model "choice" is stored as "provider|model" (e.g. "claude|claude-haiku-4-5"), or "" to mean "use the
// fallback" (the main Keak AI). Falls back if the chosen provider isn't connected.
function resolveChoice(choice: string, fallback: OwnAI): OwnAI {
  if (!choice) return fallback;
  const [provider, model] = choice.split("|");
  return resolveProviderAI(provider, model || "") || fallback;
}

// A provider error that means "this AI is out of usage" (credits/quota gone) or "the login expired"
// (subscription/session token dead). Either way, the fix is the same: switch to the free local model so
// Keak keeps working instead of failing. Rate-limits (429) are NOT included — those clear on their own.
function isExhaustedOrExpired(msg: string): boolean {
  const m = msg.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(m)) return false; // temporary, don't burn the fallback
  return /insufficient_quota|exceeded your current quota|out of (credits|quota|tokens)|credit balance|billing|payment required|\b402\b|balance too low|no credits|quota/.test(m)
    || /\b401\b|\b403\b|unauthor|invalid_grant|token (?:has )?expired|expired|session expired|please (?:re)?connect|reconnect|not logged in|login expired|sign ?in again/.test(m);
}
// The user's local Ollama model, if they've set one up. Empty = no local fallback available.
function localFallbackModel(): string {
  return (localStorage.getItem("keak_cu_ollama_model") || "").trim();
}
// Cloud providers in fallback priority order (subscriptions/free-tier first, API-key last).
const CLOUD_PROVIDER_ORDER = ["openai", "claude", "copilot", "gemini", "xai", "deepseek", "kimi", "mistral"];
// Returns every connected cloud provider except the one that just failed, in priority order.
function connectedFallbacks(skipProvider: string): OwnAI[] {
  return CLOUD_PROVIDER_ORDER
    .filter((p) => p !== skipProvider)
    .map((p) => resolveProviderAI(p, ""))
    .filter((ai): ai is OwnAI => ai !== null);
}

// One-shot call to the user's own model via the Rust cu_chat brain. Returns raw text (throws on error).
// Fallback chain on exhausted/expired errors: primary → other connected cloud providers → local Ollama.
async function askOwnAIRaw(ai: OwnAI, system: string, message: string): Promise<string> {
  const call = (a: OwnAI) =>
    invoke<string>("cu_chat", { args: { provider: a.provider, credential: a.credential, accountId: a.accountId, isSubscription: a.isSub, model: a.model, effort: a.effort, system, history: [], message } });
  try {
    return await call(ai);
  } catch (e) {
    if (!isExhaustedOrExpired(String(e))) throw e;
    console.log("[KEAK] provider exhausted/expired:", ai.provider, String(e).slice(0, 80));
    if (ai.provider !== "ollama") {
      for (const fb of connectedFallbacks(ai.provider)) {
        try {
          console.log("[KEAK] trying fallback provider:", fb.provider);
          return await call(fb);
        } catch (e2) {
          if (!isExhaustedOrExpired(String(e2))) throw e2;
          console.log("[KEAK] fallback also exhausted:", fb.provider);
        }
      }
    }
    // Last resort: local Ollama.
    const lm = localFallbackModel();
    if (lm) {
      console.log("[KEAK] all cloud providers exhausted, falling back to local Ollama");
      return await call({ provider: "ollama", credential: "local", accountId: "", isSub: false, model: lm, effort: "" });
    }
    throw e;
  }
}

// ---- Translate-while-dictating -------------------------------------------------------------------
// Speak one language, write another. When keak_translate_to is set to a target language, dictation
// transcribes the speech (in whatever language it was spoken) and then translates the cleaned text into
// the target before it lands at the cursor. The translation runs on the user's OWN connected AI, so it
// works with any provider and offline in Sovereign mode. If no AI is connected, the cloud `enhance`
// function can do it instead (it accepts an optional target_language).
const TRANSLATE_LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", ca: "Catalan", fr: "French", de: "German",
  it: "Italian", pt: "Portuguese", zh: "Chinese", hi: "Hindi", ar: "Arabic",
};
// The armed target language code ("" / "off" = disabled).
function translateTarget(): string {
  const v = (localStorage.getItem("keak_translate_to") || "").trim();
  return v && v !== "off" ? v : "";
}
function translateSystem(langCode: string): string {
  const name = TRANSLATE_LANG_NAMES[langCode] || langCode;
  return `You are a translation engine. Translate the user's text into ${name}. Output ONLY the translation, ` +
    `with no quotes, no notes, no preamble. Keep the meaning, tone, line breaks and any formatting.`;
}

// ---- Keak Sovereign (zero-cloud dictation) -------------------------------------------------------
// When keak_sovereign is on, dictation must never touch the cloud: transcription is forced to the local
// speech server (no cloud fallback) and the clean-up step runs on the user's own connected model instead
// of the cloud `enhance` function. If no model is connected, the raw local transcript is used as-is
// (whisper output is already clean), so it still works fully offline.
function sovereignOn(): boolean {
  return localStorage.getItem("keak_sovereign") === "1";
}
// System prompt that reproduces what the cloud `enhance` function does (clean spoken text into polished
// writing, apply the chosen Style, keep the SAME language), for the local model in Sovereign mode.
function localCleanupSystem(thoughtDump: boolean, stylePrompt: string | null): string {
  const base = thoughtDump
    ? "You reorganize messy, rambling dictation into clear, well-structured writing. Keep every idea, drop the filler."
    : "You clean up dictated speech into polished written text: fix punctuation, capitalization and obvious speech errors.";
  const style = stylePrompt ? ` Apply this style: ${stylePrompt}.` : "";
  return `${base}${style} Keep the SAME language as the input. Output ONLY the cleaned text, no notes or preamble.`;
}

// ---- "Change any setting by voice" ---------------------------------------------------------------
// Keak AI can adjust the personality dials, the model/effort, the voice source, and create or edit agents
// just by being asked. The fast regex parsers (adjustPersonaFromSpeech / parseModelSwitch) handle the common
// dial + model cases instantly; this AI-backed handler catches everything else and any phrasing they miss.
// Ctrl+Win dictation gate: paid plans (Pro/Team = unlimited) dictate freely; Free/lapsed plans get the free
// minute taste, then dictation locks. The transcribe backend is the hard backstop (402); this just blocks up
// front so we don't record a clip that will be rejected. Uses usage stored at sign-in (App.tsx fetchProfile).
function dictationBlocked(): boolean {
  const limit = parseInt(localStorage.getItem("keak_dictation_limit") || "-1", 10);
  if (isNaN(limit) || limit < 0) return false; // unlimited (Pro/Team) or unknown -> allow
  const used = parseInt(localStorage.getItem("keak_dictation_used") || "0", 10) || 0;
  const extra = parseInt(localStorage.getItem("keak_dictation_extra") || "0", 10) || 0;
  return used >= limit + extra;
}
function looksLikeSettingsCommand(t: string): boolean {
  const s = t.toLowerCase();
  const domain = /\b(humou?r|warmth|formal|formality|direct(?:ness)?|tone|personality|voice|sound|agent|agents|team|model|effort)\b/.test(s);
  const verb = /\b(set|change|make|adjust|switch|swap|turn|raise|lower|increase|decrease|create|new|add|edit|rename|update|use|put|be|more|less|cambia|cambiar|crea|crear|nuevo|nueva|edita|editar|pon|poner|sube|subir|baja|bajar|ajusta|a[ñn]ade|agrega)\b/.test(s);
  return domain && verb;
}
// "Message me on Telegram" — the user wants Keak to actually SEND them a one-off message now (not schedule a
// routine). Requires a messaging channel word + a send verb.
function looksLikeSendMessage(t: string): boolean {
  const s = t.toLowerCase();
  const channel = /\btelegram\b/.test(s);
  const verb = /\b(send|message|text|write|shoot|ping|deliver|drop)\b/.test(s);
  return channel && verb;
}
// Pull the first {...} JSON object out of a model reply (tolerates code fences / stray prose).
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}
const SETTINGS_SYSTEM = `You turn a spoken command into ONE settings action as strict minified JSON and nothing else.
Actions:
{"action":"dial","dial":"humor|warmth|formality|directness","value":<0-100 integer>}
{"action":"model","provider":"claude|openai|gemini|copilot|xai|deepseek|mistral|ollama","model":"<model id or empty>"}
{"action":"effort","value":"low|medium|high|max"}
{"action":"voice","source":"auto|gemini|openai|elevenlabs|system|keak"}
{"action":"createAgent","name":"<short name>","description":"<what it is good at>","personality":"<tone, optional>","color":"<#RRGGBB optional>","model":"<provider|model optional>"}
{"action":"editAgent","name":"<existing agent name>","description":"<optional>","personality":"<optional>","color":"<#RRGGBB optional>","model":"<provider|model optional>"}
{"action":"none"}
Model ids: claude -> claude-opus-4-8 | claude-sonnet-5 | claude-haiku-4-5 | claude-fable-5; openai -> gpt-5 | gpt-4o; gemini -> gemini-3.5-flash; xai -> grok-4 | grok-3; deepseek -> deepseek-chat | deepseek-reasoner; mistral -> mistral-large-latest. For "model" action, set provider only (empty model) unless the user named a specific model. For agents, "model" is "provider|modelid" (e.g. "claude|claude-haiku-4-5") or empty for the default. If it is not a settings/config command, return {"action":"none"}. Return ONLY the JSON object.`;
async function parseAndApplySettings(question: string): Promise<string | null> {
  if (!looksLikeSettingsCommand(question)) return null;
  const ai = resolveOwnAI();
  if (!ai) return null;
  const agents = allAgents().map((a) => a.name).join(", ");
  let raw = "";
  try { raw = await askOwnAIRaw(ai, `${SETTINGS_SYSTEM}\nExisting agents: ${agents}.`, question); }
  catch { return null; }
  const action = extractJsonObject(raw) as Record<string, string> | null;
  if (!action || !action.action || action.action === "none") return null;
  return applySettingsAction(action);
}
function applySettingsAction(a: Record<string, string>): string | null {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c || "");
  switch (a.action) {
    case "dial": {
      const map: Record<string, [string, string]> = { humor: ["keak_humor", "humor"], warmth: ["keak_warmth", "warmth"], formality: ["keak_formality", "formality"], directness: ["keak_directness", "directness"] };
      const hit = map[String(a.dial)]; if (!hit) return null;
      const v = clamp(Number(a.value)); localStorage.setItem(hit[0], String(v));
      return `Done, ${hit[1]} is now ${v} out of 100.`;
    }
    case "model": {
      const providers = ["claude", "openai", "gemini", "copilot", "xai", "deepseek", "mistral", "ollama"];
      const p = String(a.provider || "").toLowerCase(); if (!providers.includes(p)) return null;
      localStorage.setItem("keak_cu_provider", p);
      if (a.model) localStorage.setItem(`keak_cu_${p}_model`, String(a.model));
      const nice: Record<string, string> = { claude: "Claude", openai: "ChatGPT", gemini: "Gemini", copilot: "Copilot", xai: "Grok", deepseek: "DeepSeek", mistral: "Mistral", ollama: "your local model" };
      return `Done, Keak now runs on ${nice[p]}${a.model ? `, ${a.model}` : ""}.`;
    }
    case "effort": {
      const v = String(a.value || "").toLowerCase(); if (!["low", "medium", "high", "max"].includes(v)) return null;
      localStorage.setItem("keak_cu_claude_effort", v);
      return `Done, effort is set to ${v}.`;
    }
    case "voice": {
      const s = String(a.source || "").toLowerCase(); if (!["auto", "gemini", "openai", "elevenlabs", "system", "keak"].includes(s)) return null;
      localStorage.setItem("keak_voice_engine", s);
      const sysVoiceName = (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "")) ? "a Mac voice" : "a Windows voice";
      const nice: Record<string, string> = { auto: "automatic", gemini: "your Gemini voice", openai: "your OpenAI voice", elevenlabs: "your ElevenLabs voice", system: sysVoiceName, keak: "Keak's own voice" };
      return `Done, the voice is now ${nice[s]}.`;
    }
    case "createAgent": {
      const name = String(a.name || "").trim(); if (!name) return null;
      const roster = readAgentRoster();
      const palette = ["#D4A49A", "#C9A24A", "#8FA47D", "#B08A72", "#9A7060", "#C68B7E", "#D8B86A", "#6E8FA0"];
      const color = isHex(String(a.color)) ? String(a.color) : palette[roster.length % palette.length];
      roster.push({ name, description: String(a.description || ""), color, personality: String(a.personality || ""), choice: String(a.model || ""), tools: [] });
      localStorage.setItem("keak_agents_roster", JSON.stringify(roster));
      return `Done, I created a new agent called ${name}.`;
    }
    case "editAgent": {
      const name = String(a.name || "").trim().toLowerCase(); if (!name) return null;
      const patch: Partial<RosterAgent> = {};
      if (a.description) patch.description = String(a.description);
      if (a.personality) patch.personality = String(a.personality);
      if (isHex(String(a.color))) patch.color = String(a.color);
      if (a.model !== undefined) patch.choice = String(a.model || "");
      const roster = readAgentRoster();
      const idx = roster.findIndex((r) => r.name.toLowerCase() === name);
      if (idx >= 0) { roster[idx] = { ...roster[idx], ...patch }; localStorage.setItem("keak_agents_roster", JSON.stringify(roster)); return `Done, I updated ${roster[idx].name}.`; }
      const eff = effectiveDefaults().find((e) => e.name.toLowerCase() === name || e.base.toLowerCase() === name);
      if (eff) { saveDefaultOverride(eff.base, patch); return `Done, I updated ${eff.name}.`; }
      return `I couldn't find an agent called ${a.name}.`;
    }
  }
  return null;
}

// Optional "know a lot about you" context: when the user turns it on, Keak loads a summary of their Second
// Brain (folder map + README / CLAUDE / AGENTS) into every answer. Memoized per folder so it's read once.
let _brainContextCache: { key: string; text: string } | null = null;
async function getBrainContext(): Promise<string> {
  const root = localStorage.getItem("keak_brain_path") || "";
  if (!root || localStorage.getItem("keak_brain_autocontext") !== "1") return "";
  if (_brainContextCache && _brainContextCache.key === root) return _brainContextCache.text;
  let text = "";
  try {
    const tree = await invoke<string>("sb_tree", { args: { root, maxDepth: 2, maxEntries: 250 } });
    const parts: string[] = [`Folder map (relative paths): ${tree}`];
    for (const f of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
      try { const c = await invoke<string>("sb_read", { args: { root, path: f } }); if (c) parts.push(`${f}:\n${c.slice(0, 1500)}`); } catch { /* file may not exist */ }
    }
    text = parts.join("\n\n");
  } catch { text = ""; }
  _brainContextCache = { key: root, text };
  return text;
}

// ---- Keak Memory: opt-in, compounding facts about the user. Stored LOCALLY only (keak_memories), never on
//      Keak's side. Injected into Keak AI's system prompt so it gets more personal over time, and shown +
//      editable in Settings so the user always sees and controls what it knows.
export type MemFact = { id: string; text: string; ts: number };
function memoryOn(): boolean { return localStorage.getItem("keak_memory_on") === "1"; }
function getMemories(): MemFact[] { try { const l = JSON.parse(localStorage.getItem("keak_memories") || "[]"); return Array.isArray(l) ? l : []; } catch { return []; } }
function saveMemories(list: MemFact[]) { localStorage.setItem("keak_memories", JSON.stringify(list.slice(0, 200))); }
function memoryBlock(): string {
  if (!memoryOn()) return "";
  const facts = getMemories();
  if (!facts.length) return "";
  return `\n\nWhat you remember about ${localStorage.getItem("keak_user_name") || "the user"} (use naturally to be personal; never read this list aloud):\n` + facts.slice(0, 60).map((f) => `- ${f.text}`).join("\n");
}
// After a Keak AI turn, quietly ask the user's own AI whether anything durable is worth remembering, and add
// the new facts (deduped). Best-effort and fire-and-forget so it never slows the spoken reply.
async function captureMemories(userText: string, assistantText: string): Promise<void> {
  if (!memoryOn()) return;
  const ai = resolveOwnAI();
  if (!ai) return;
  const existing = getMemories();
  const sys = `You maintain a short long-term memory of durable facts about the user: their name, role, business, projects, preferences, people they mention, goals, ongoing situations. From the exchange, extract ONLY genuinely durable facts worth remembering later. Ignore one-off questions, small talk, and anything temporary. Do NOT repeat facts already known. Reply with ONLY a JSON array of short strings (max 5), or [] if nothing is worth keeping. Each string is one fact, third person, under 15 words.`;
  const msg = `Already known:\n${existing.slice(0, 80).map((f) => "- " + f.text).join("\n") || "(nothing yet)"}\n\nUser said: ${userText}\nAssistant said: ${assistantText}`;
  let facts: string[] = [];
  try { const raw = await askOwnAIRaw(ai, sys, msg); const m = raw.match(/\[[\s\S]*\]/); if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) facts = arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 120)); } } catch { return; }
  if (!facts.length) return;
  const seen = new Set(existing.map((f) => f.text.toLowerCase()));
  const add = facts.filter((f) => !seen.has(f.toLowerCase())).slice(0, 5);
  if (!add.length) return;
  const merged = [...add.map((text, i) => ({ id: `${Date.now()}_${i}`, text, ts: Date.now() })), ...existing];
  saveMemories(merged);
  emitTo("connect", "memory-updated", {}).catch(() => { /* Connect may be closed */ });
}

// ---- Control the on-screen agent orbs by voice ("make the agents move in circles", "follow my mouse",
//      "make them stay still", "gather them", "Sirius, follow my cursor", "hide the names") -------------
function looksLikeVizCommand(t: string): boolean {
  const s = t.toLowerCase();
  const subj = /\b(agents?|orbs?|stars?|balls?|dots?|them|they|agentes?|orbes?|estrellas?|bolas?|ellos|los)\b/.test(s);
  const verb = /\b(move|moving|movement|circle|circles|spin|spinning|still|stop|freeze|frozen|don'?t move|do ?n'?t move|follow|gather|together|come together|plane|fly|flying|dance|around|show (the )?names?|hide (the )?names?|c[ií]rculos?|mueve|muevan|mu[eé]vanse|quiet[oa]s?|par[ae]n?|det[eé]n|congela|sigue|sigan|junt[ae]n?|vuel[ae]|avi[oó]n|nombres?)\b/.test(s);
  return subj && verb;
}
const VIZ_SYSTEM = `You control the on-screen AGENT ORBS. Turn the command into ONE JSON action and nothing else.
{"action":"motion","mode":"drift|still|circle|plane|gather|follow","target":"all or an agent name"}
{"action":"labels","on":true or false}
{"action":"hide"}
{"action":"none"}
Modes: drift = wander freely (the default); still = stop and hold position; circle = move in circles; plane = fly across like a plane; gather = come together near the Keak orb; follow = follow the mouse cursor. If the user names ONE agent (e.g. Sirius), set target to that exact name, else "all". "show/hide the names" -> labels. "stop showing them / clear / hide the agents" -> hide. If it is not about the agent orbs, return {"action":"none"}. Return ONLY the JSON.`;
async function parseVizCommand(question: string): Promise<string | null> {
  if (!looksLikeVizCommand(question)) return null;
  const ai = resolveOwnAI();
  if (!ai) return null;
  const names = allAgents().map((a) => a.name).join(", ");
  let raw = "";
  try { raw = await askOwnAIRaw(ai, `${VIZ_SYSTEM}\nAgent names: ${names}.`, question); } catch { return null; }
  const a = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!a || !a.action || a.action === "none") return null;
  if (a.action === "labels") {
    const on = a.on === true || a.on === "true";
    localStorage.setItem("keak_agent_labels", on ? "1" : "0");
    emitTo("agents", "agents-update", { labels: on }).catch(() => { /* ignore */ });
    return on ? "Okay, I'll show the agent names." : "Okay, I hid the agent names.";
  }
  if (a.action === "hide") {
    try { await invoke("hide_agents"); } catch { /* ignore */ }
    writeAgentState([]);
    return "Okay, I cleared the agents.";
  }
  if (a.action === "motion") {
    const mode = String(a.mode || "drift");
    const target = a.target ? String(a.target) : "all";
    localStorage.setItem("keak_agents_viz", JSON.stringify({ mode, target }));
    emitTo("agents", "agents-update", { viz: { mode, target } }).catch(() => { /* ignore */ });
    // Make sure some orbs are on screen so the effect is visible.
    let has = false;
    try { const d = JSON.parse(localStorage.getItem("keak_agents") || "{}"); has = Array.isArray(d.agents) && d.agents.length > 0; } catch { /* ignore */ }
    if (!has) {
      const team = [...effectiveDefaults(), ...readAgentRoster()];
      writeAgentState(team.map((x) => ({ name: x.name, status: "working", color: x.color })));
    }
    try { await invoke("show_agents"); } catch { /* ignore */ }
    const desc: Record<string, string> = { drift: "drifting freely", still: "holding still", circle: "moving in circles", plane: "flying across like a plane", gather: "gathering together", follow: "following your mouse" };
    const d = desc[mode] || "moving";
    return target && target !== "all" ? `Okay, ${target} is now ${d}.` : `Okay, the agents are now ${d}.`;
  }
  return null;
}

// ---- Create a Routine by voice ("schedule a routine every day at 5am to…") -----------------------
function looksLikeRoutineCommand(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(routines?|schedule|scheduled|every day|each day|every morning|every week|every monday|every tuesday|every wednesday|every thursday|every friday|every saturday|every sunday|daily|weekly|remind me|tomorrow at|each morning|at \d{1,2}\s?(am|pm)|rutinas?|programa|cada d[íi]a|cada ma[ñn]ana|cada semana|recu[ée]rdame|ma[ñn]ana a las)\b/.test(s);
}
const ROUTINE_SYSTEM = `Convert the user's request into ONE scheduled routine as strict minified JSON and nothing else. Shape:
{"name":"<short name>","freq":"once|daily|weekly","day":<0-6 Sun-Sat, only for weekly>,"hour":<0-23>,"minute":<0-59>,"onceDate":"<ISO datetime, only for freq once>","instructions":"<what to do on each run, self-contained>","output":"keak|telegram|email","outputTarget":"<email address if the output needs one, else empty>","tools":["perplexity"] if it needs live web research else []}
Rules: default output "telegram" unless the user names keak/email. "5am" -> hour 5 minute 0; "5:30pm" -> hour 17 minute 30. "tomorrow at 3pm" or a specific date -> freq "once" with onceDate computed from the provided NOW. Repeats every day -> "daily"; a named weekday -> "weekly" + day (0=Sunday). Research / monitor / competitor / news / market tasks should include "perplexity" in tools. Return ONLY the JSON object.`;
async function parseRoutineCommand(question: string, force = false): Promise<string | null> {
  if (!force && !looksLikeRoutineCommand(question)) return null;
  const ai = resolveOwnAI();
  if (!ai) return null;
  let raw = "";
  try { raw = await askOwnAIRaw(ai, `${ROUTINE_SYSTEM}\nNow is ${new Date().toString()}.`, question); }
  catch { return null; }
  const obj = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!obj || !obj.instructions || !obj.freq) return null;
  const num = (v: unknown, d: number, max: number) => { const n = parseInt(String(v), 10); return isNaN(n) ? d : Math.max(0, Math.min(max, n)); };
  const freq = ["once", "daily", "weekly"].includes(String(obj.freq)) ? (obj.freq as Routine["freq"]) : "daily";
  const output = ["keak", "telegram", "email"].includes(String(obj.output)) ? (obj.output as Routine["output"]) : "telegram";
  const r: Routine = {
    id: newRoutineId(),
    name: String(obj.name || "Routine").slice(0, 60),
    freq,
    day: typeof obj.day === "number" ? obj.day : undefined,
    hour: num(obj.hour, 9, 23),
    minute: num(obj.minute, 0, 59),
    onceDate: obj.onceDate ? String(obj.onceDate) : undefined,
    instructions: String(obj.instructions),
    output,
    outputTarget: obj.outputTarget ? String(obj.outputTarget) : undefined,
    tools: Array.isArray(obj.tools) ? (obj.tools as unknown[]).filter((x) => typeof x === "string") as string[] : [],
    enabled: true,
  };
  upsertRoutine(r);
  emitTo("connect", "routines-updated", {}).catch(() => { /* Connect window may be closed */ });
  return `Done. I scheduled "${r.name}", ${nextRunLabel(r)}.`;
}

// The user's custom agent roster: their own named agents with a description (specialty) and a colour.
// Empty → the default star agents (Sirius…Naos) are used. Managed in the Connect window.
type RosterAgent = { name: string; description: string; color: string; choice?: string; personality?: string; tools?: string[] };
function readAgentRoster(): RosterAgent[] {
  try {
    const raw = localStorage.getItem("keak_agents_roster");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((a: RosterAgent) => a && a.name) : [];
  } catch { return []; }
}

// Every agent the user can call by name: the (possibly edited) built-in stars + their custom roster.
type NamedAgent = { name: string; description: string; color: string; choice?: string; personality?: string; tools?: string[] };
function allAgents(): NamedAgent[] {
  return [...effectiveDefaults().map((a) => ({ name: a.name, description: a.description, color: a.color, personality: a.personality, choice: a.choice || "", tools: a.tools })), ...readAgentRoster()];
}
// Slug used as an agent's wake-word key. MUST match the same function in Connect.tsx so training and
// detection line up ("Nova" -> "nova", "AI Coach" -> "ai_coach").
function agentKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// If the user addresses a specific agent by name ("Sirius, research X", "ask Rigel to write the copy"),
// return that agent + the task so we run just that one orb. Star names are distinctive, so this is safe.
function detectNamedAgent(task: string): { agent: { name: string; description: string; color: string; choice?: string; personality?: string; tools?: string[] }; task: string } | null {
  const raw = task.trim();
  for (const a of allAgents()) {
    const name = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      raw.match(new RegExp(`^\\s*${name}\\b[,:]?\\s*(?:to\\s+|please\\s+|can you\\s+)?(.*)$`, "i")) ||
      raw.match(new RegExp(`\\b(?:ask|tell|use|get|have|send|let)\\s+${name}\\b[,:]?\\s*(?:to\\s+|please\\s+)?(.*)$`, "i"));
    if (m) {
      const rest = (m[1] || "").trim();
      return { agent: a, task: rest.length >= 3 ? rest : raw };
    }
  }
  return null;
}

// The agents window draws which orbs from this state. localStorage is NOT shared across Tauri webview windows
// (each is its own WebView2), so we ALSO emit a Tauri event to the "agents" window — that is the real
// cross-window channel. localStorage is kept only as a same-window fallback.
function writeAgentState(agents: { name: string; status: string; color?: string }[]) {
  try { localStorage.setItem("keak_agents", JSON.stringify({ ts: Date.now(), agents })); } catch { /* ignore */ }
  emitTo("agents", "agents-update", { agents }).catch(() => { /* ignore */ });
}
function updateAgentStatus(name: string, status: string) {
  try {
    const raw = localStorage.getItem("keak_agents");
    const data = raw ? JSON.parse(raw) : { agents: [] };
    const agents = (data.agents || []).map((a: { name: string; status: string }) => (a.name === name ? { ...a, status } : a));
    localStorage.setItem("keak_agents", JSON.stringify({ ts: Date.now(), agents }));
    emitTo("agents", "agents-update", { agents }).catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

// True when an agent actually built something openable (a full HTML page).
function isHtmlArtifact(s: string): boolean {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test((s || "").trim());
}

// A soft, low-alpha version of a custom agent's colour, for the name chip in the results panel.
function hexToSoft(hex: string, alpha = 0.2): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return "rgba(212,164,154,0.22)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Render an agent's markdown-ish output as clean, readable lines (no raw ** or ### clutter on screen).
function RichText({ text }: { text: string }) {
  const strip = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`(.+?)`/g, "$1");
  const lines = (text || "").replace(/\r/g, "").split("\n");
  return (
    <div className="rich">
      {lines.map((raw, i) => {
        const line = strip(raw);
        const h = line.match(/^\s*#{1,6}\s+(.*)$/);
        if (h) return <div key={i} className="rich-h">{h[1]}</div>;
        const b = line.match(/^\s*[-*]\s+(.*)$/);
        if (b) return <div key={i} className="rich-li">{b[1]}</div>;
        const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (num) return <div key={i} className="rich-li">{num[1]}. {num[2]}</div>;
        if (!line.trim()) return <div key={i} className="rich-gap" />;
        return <div key={i} className="rich-p">{line}</div>;
      })}
    </div>
  );
}

// "See it": save an agent's output to a temp file and open it (HTML in the browser, else as text).
async function openArtifact(name: string, content: string) {
  try {
    const fname = (name || "artifact").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) + (isHtmlArtifact(content) ? ".html" : ".txt");
    const path = await invoke<string>("save_artifact", { name: fname, content });
    await invoke("open_url", { url: path });
  } catch { /* ignore */ }
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

// Keep spoken text short so the high-quality keak-tts voice doesn't choke on long text (which drops us to
// the robotic browser fallback). Cuts at a sentence boundary and points to the See it panel for the rest.
function shortSpoken(text: string, max = 260): string {
  const clean = cleanReply(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const head = stop > 90 ? cut.slice(0, stop + 1) : cut.trim() + ".";
  return `${head} Tap See it for the full thing.`;
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

// The OS voice list is empty on the very first getVoices() call in some webviews; wait for it so pickVoice
// can actually choose a good natural voice instead of falling back to the default robotic one.
function voicesReady(): Promise<void> {
  return new Promise((resolve) => {
    const vs = window.speechSynthesis?.getVoices?.() || [];
    if (vs.length) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    try { window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true }); } catch { /* ignore */ }
    setTimeout(finish, 400);
  });
}

// Free, built-in fallback voice — language-locked so it stops mixing ES/EN in one phrase.
// Resolves when speaking finishes, so callers can time what happens next.
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    (async () => {
      try {
        await voicesReady();
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const lang = replyLang(text);
        u.lang = BCP47[lang] || "en-US";
        const v = pickVoice(lang);
        if (v) u.voice = v;
        u.rate = 1.0;
        u.pitch = 1.03;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      } catch {
        resolve(); // speech synthesis unavailable — the text is still shown on screen
      }
    })();
  });
}

// Play a base64 audio clip (given a data: URL mime). Returns true when it finishes playing, false on error.
async function playClip(dataUrl: string, onStart?: () => void): Promise<boolean> {
  try {
    const audio = new Audio(dataUrl);
    currentAudio = audio;
    onStart?.();
    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { if (currentAudio === audio) currentAudio = null; resolve(ok); };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  } catch { return false; }
}

// Premium spoken voice on the user's OWN OpenAI API key (gpt-4o-mini-tts). Returns true if it played, so
// speakReply can fall through to other engines on any failure. Costs Pep nothing — runs on the user's key.
async function openaiSpeak(text: string, onStart?: () => void): Promise<boolean> {
  const key = (localStorage.getItem("keak_cu_openai_key") || "").trim(); // needs a real sk- key, not the sub token
  if (!key.startsWith("sk-")) return false;
  const voice = localStorage.getItem("keak_openai_voice") || "nova";
  try {
    const b64 = await invoke<string>("openai_tts", { args: { credential: key, voice, model: "", text } });
    if (!b64) return false;
    return await playClip(`data:audio/mp3;base64,${b64}`, onStart);
  } catch { return false; }
}

// Premium spoken voice on the user's OWN Gemini API key. Free to Pep (their key; Gemini has a free tier), so
// this is the answer for Gemini users AND for Claude-only users who paste a free Gemini key just for voice.
async function geminiSpeak(text: string, onStart?: () => void): Promise<boolean> {
  const key = (localStorage.getItem("keak_cu_gemini_key") || "").trim();
  if (!key) return false;
  const voice = localStorage.getItem("keak_gemini_voice") || "Kore";
  try {
    const b64 = await invoke<string>("gemini_tts", { args: { credential: key, voice, model: "", text } });
    if (!b64) return false;
    return await playClip(`data:audio/wav;base64,${b64}`, onStart);
  } catch { return false; }
}

// The user's own ElevenLabs voice (their key, from the AI tools). The most realistic option, costs the user
// their ElevenLabs credits. Returns true if it played so speakReply can fall through on failure.
async function elevenSpeak(text: string, onStart?: () => void): Promise<boolean> {
  const key = (localStorage.getItem("keak_tool_elevenlabs") || "").trim();
  if (!key) return false;
  const voiceId = localStorage.getItem("keak_tool_elevenlabs_voice") || "";
  try {
    const b64 = await invoke<string>("elevenlabs_speak", { args: { apiKey: key, text, voiceId } });
    if (!b64) return false;
    return await playClip(`data:audio/mp3;base64,${b64}`, onStart);
  } catch { return false; }
}

// Best voice, in the order the user chose in Settings (keak_voice_engine):
//  - "openai" → their own OpenAI premium voice (best), falls through if it fails
//  - "system" → a chosen natural Windows voice, no network
//  - "keak" (default) → Keak's ElevenLabs voice, falling back to the built-in voice
// `onStart` fires the instant the voice actually begins, so the caller can reveal the text at the same
// moment (voice + text land together instead of text-then-silence). Resolves when playback ends.
async function speakReply(text: string, token: string, onStart?: () => void): Promise<void> {
  const gender = localStorage.getItem("keak_voice_gender") || "female";
  // Default is "auto": always use the user's OWN key for the voice (free to Pep), else a free Windows voice.
  // Only the explicit "keak" engine uses Pep's paid backend voice.
  const engine = localStorage.getItem("keak_voice_engine") || "auto";
  // Cap what we send to keak-tts. Long text can make the premium voice error out, which drops us to the
  // robotic built-in voice — the exact "the voice got bad" complaint. The full text still shows on screen.
  const spoken = text.length > 650 ? shortSpoken(text, 620) : text;
  // Automatic: their own Gemini voice → their own OpenAI voice → a free Windows voice. Never Pep's paid backend.
  if (engine === "auto") {
    if (await geminiSpeak(spoken, onStart)) return;
    if (await openaiSpeak(spoken, onStart)) return;
    onStart?.(); await speak(spoken); return;
  }
  // The user's own Gemini voice when selected (only if a Gemini key is set).
  if (engine === "gemini") {
    if (await geminiSpeak(spoken, onStart)) return;
    // no key or it failed — fall through to the built-in voice
    onStart?.(); await speak(spoken); return;
  }
  // The user's own OpenAI voice when selected (only if a real sk- key is set).
  if (engine === "openai") {
    if (await openaiSpeak(spoken, onStart)) return;
    onStart?.(); await speak(spoken); return;
  }
  // The user's own ElevenLabs voice when selected (needs an ElevenLabs key under AI tools).
  if (engine === "elevenlabs") {
    if (await elevenSpeak(spoken, onStart)) return;
    onStart?.(); await speak(spoken); return;
  }
  // A hand-picked Windows voice: skip the network entirely, use the chosen natural voice.
  if (engine === "system") { onStart?.(); await speak(spoken); return; }
  // "keak" engine only: Pep's paid backend voice, then the built-in voice as a fallback.
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/keak-tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, language: replyLang(spoken), gender }),
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
  await speak(spoken);
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

// Guess the language of a transcript so the spoken filler + reply match what the user actually said. Rough
// but enough to pick a filler set; stored as keak_last_lang and used when the language setting is "auto".
function detectLang(text: string): string {
  const s = " " + (text || "").toLowerCase() + " ";
  if (/[ñ¿¡]/.test(s) || /\b(que|de|el|la|los|las|una|para|con|por|pero|hola|gracias|c[oó]mo|qu[eé]|est[aá]|soy|quiero|hacer|porque|tambi[eé]n)\b/.test(s)) return "es";
  if (/[àâçéèêëîïôûù]/.test(s) && /\b(le|les|une|des|pour|avec|bonjour|merci|comment|est|je|vous|c'est)\b/.test(s)) return "fr";
  if (/[äöüß]/.test(s) || /\b(der|die|das|und|ich|nicht|mit|f[üu]r|eine|hallo|danke|wie|kannst)\b/.test(s)) return "de";
  if (/[ãõ]/.test(s) || /\b(um|uma|n[ãa]o|obrigad[oa]|voc[eê]|como|est[aá]|fazer|com|ol[aá]|porque)\b/.test(s)) return "pt";
  if (/\b(che|di|il|una|per|con|ciao|grazie|come|sono|voglio|fare|perch[eé]|anche)\b/.test(s)) return "it";
  return "en";
}

// A handful of short, natural acknowledgements so the filler varies. Some use the name, some don't.
function fillerPhrases(name: string, lang: string): string[] {
  const n = name && name !== "there" ? name : "";
  switch (lang) {
    case "es": return [n ? `Claro, ${n}.` : "Claro.", "Por supuesto.", "Vamos a ver.", "Un momento.", n ? `Muy bien, ${n}.` : "Muy bien.", "Déjame ver."];
    case "fr": return [n ? `Bien sûr, ${n}.` : "Bien sûr.", "D'accord.", "Voyons voir.", "Un instant.", n ? `Très bien, ${n}.` : "Très bien.", "Je regarde."];
    case "de": return [n ? `Klar, ${n}.` : "Klar.", "Natürlich.", "Mal sehen.", "Einen Moment.", n ? `Alles klar, ${n}.` : "Alles klar.", "Ich schaue."];
    case "pt": return [n ? `Claro, ${n}.` : "Claro.", "Com certeza.", "Vamos ver.", "Um momento.", n ? `Muito bem, ${n}.` : "Muito bem.", "Deixa ver."];
    case "it": return [n ? `Certo, ${n}.` : "Certo.", "Senz'altro.", "Vediamo.", "Un momento.", n ? `Benissimo, ${n}.` : "Benissimo.", "Fammi vedere."];
    default:   return [n ? `Of course, ${n}.` : "Of course.", "Sure thing.", "Let me see.", "One moment.", n ? `Alright, ${n}.` : "Alright.", "Got it."];
  }
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
  let lang = localStorage.getItem("keak_language") || "auto";
  // "auto" means detect-from-speech: follow the language of the last thing the user actually said, so the
  // spoken filler matches (e.g. Spanish), instead of always defaulting to English.
  if (lang === "auto" || lang === "bi") {
    lang = localStorage.getItem("keak_last_lang") || (navigator.language || "en").slice(0, 2).toLowerCase() || "en";
  }
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
  const [, , t] = useUiLang();
  const isPaid = ["starter", "pro", "team"].includes(localStorage.getItem("keak_plan") ?? "free");
  const canSeeScreen = ["pro", "team"].includes(localStorage.getItem("keak_plan") ?? "free"); // screen vision: Pro + Team
  const [state, setState] = useState<OverlayState>("idle");
  const stateRef = useRef<OverlayState>("idle");
  const [result, setResult] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [thoughtDump, setThoughtDump] = useState(false);
  const thoughtDumpRef = useRef(false); // read at processing time (state may be stale in the closure)
  // Ctrl+Space forces a one-off translation into the shortcut target for THIS dictation only. The ref is
  // read at processing time; the state drives the pill badge.
  const translateOnceRef = useRef<string>("");
  const [liveTranslate, setLiveTranslate] = useState("");
  const [liveText, setLiveText] = useState(""); // Keak Streaming: the words appearing live in the pill as you talk
  const recogRef = useRef<{ stop: () => void; abort?: () => void } | null>(null);
  const streamRawRef = useRef(""); // at-cursor mode: the cleaned text typed live so far
  const streamFinalLenRef = useRef(0);
  const recogGotResultRef = useRef(false); // did the live engine produce anything (else fall back to the normal pipeline)
  const pendingInterimRef = useRef(""); // the not-yet-finalised tail, flushed on release so nothing is lost
  const recogStoppingRef = useRef(false);
  const typedFinalsRef = useRef(0); // how many finalised sentences we've already queued to type
  const cleanChainRef = useRef<Promise<void>>(Promise.resolve()); // sequential clean+type queue (keeps order)
  const modeRef = useRef<"dictate" | "assistant" | "rewrite">("dictate");
  const rewriteTextRef = useRef(""); // the selected text captured for a Rewrite
  const [rewriting, setRewriting] = useState(false);
  const [assistant, setAssistant] = useState(false); // Keak AI panel active
  const [fromCorner, setFromCorner] = useState(""); // "" = normal centered orb; "br"/"bl"/"tr"/"tl" = flew in from that corner (Standby)
  const [activeAgent, setActiveAgent] = useState<NamedAgent | null>(null); // set when you wake an agent by name ("Hey Nova") — the turn runs as that agent + shows its orb
  const activeAgentRef = useRef<NamedAgent | null>(null);
  useEffect(() => { activeAgentRef.current = activeAgent; }, [activeAgent]);
  useEffect(() => { if (!assistant) setActiveAgent(null); }, [assistant]); // agent context is per conversation; drop it when the panel closes
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
  // Computer-use ("TARS") state: the agent loop drives the real mouse/keyboard.
  const [cuActive, setCuActive] = useState(false);
  const cuActiveRef = useRef(false);
  const cuAbortRef = useRef(false);
  const [cuConfirmGoal, setCuConfirmGoal] = useState<string | null>(null);
  const cuConfirmResolveRef = useRef<((v: boolean) => void) | null>(null);
  // Agents: results of the last delegated job + whether the "See it" panel is open.
  const [agentResults, setAgentResults] = useState<{ name: string; title: string; output: string; color: string }[]>([]);
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  // EXPERIMENTAL — Keak Live validation test (see keakLive.ts). Not part of the real Ctrl+Alt flow.
  const [liveTestLog, setLiveTestLog] = useState<string[]>([]);
  const [liveTestRunning, setLiveTestRunning] = useState(false);
  async function testKeakLive() {
    if (liveTestRunning) return;
    setLiveTestRunning(true);
    setLiveTestLog([]);
    await runKeakLiveTest(6, (m) => setLiveTestLog((l) => [...l, m]));
    setLiveTestRunning(false);
  }
  const closeTimerRef = useRef<number | null>(null); // pending auto-close of the assistant panel
  const assistantVisibleRef = useRef(false); // true while the assistant orb is on screen
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  // Live voice (Gemini Live / OpenAI Realtime) for the Keak AI turn: the session, whether it's active, and
  // the turn mode set by the entry point ("ptt" for Ctrl+Alt / orb click-toggle, "handsfree" for wake word).
  const liveRef = useRef<LiveKeak | null>(null);
  const liveActiveRef = useRef<boolean>(false);
  const liveModeRef = useRef<LiveMode>("ptt");
  const liveFinishPendingRef = useRef<boolean>(false); // a release that arrived while the session was still opening
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

  // Standby orb: bring the corner orb back on startup if the user had it on last session.
  useEffect(() => {
    if (localStorage.getItem("keak_standby") === "1") {
      invoke("set_standby", { on: true, corner: localStorage.getItem("keak_orb_corner") || "br" }).catch(() => { /* ignore */ });
    }
  }, []);

  // Reset the orb's "listening" ring whenever the turn ends — on idle OR error (else it spins forever).
  useEffect(() => {
    if (state === "idle" || state === "error") emitTo("orb", "orb-idle").catch(() => { /* ignore */ });
  }, [state]);

  // ONE orb only (Standby). When the Keak AI panel opens, hide the corner orb and remember which corner it
  // sat in so the centered orb can fly in from there. When the panel closes, bring the corner orb back. This
  // is why you never see two orbs: the corner orb and the centered orb are never on screen at the same time.
  // When Standby is OFF, this does nothing — Ctrl+Alt just shows the centered orb as before.
  useEffect(() => {
    if (localStorage.getItem("keak_standby") !== "1") return;
    const corner = localStorage.getItem("keak_orb_corner") || "br";
    if (assistant) { setFromCorner(corner); invoke("orb_hide").catch(() => { /* ignore */ }); }
    else { setFromCorner(""); invoke("set_standby", { on: true, corner }).catch(() => { /* ignore */ }); }
  }, [assistant]);

  // Hey Keak wake word: a detection from the on-device engine starts a hands-free Keak AI turn on the HIDDEN
  // overlay (records, auto-stops after you go quiet, answers out loud). Restart the engine on load if it was on.
  useEffect(() => {
    if (localStorage.getItem("keak_wake") === "1") invoke("wake_start").catch(() => { /* not trained yet */ });
    // Silence-based auto-stop for hands-free turns: wait for speech, then stop after ~1.2s of quiet.
    const startVad = () => {
      const stream = streamRef.current;
      if (!stream) return;
      const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      let ctx: AudioContext;
      try { ctx = new AC(); } catch { return; }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let spoke = false, silenceStart = 0;
      const startT = performance.now();
      const tick = () => {
        if (stateRef.current !== "recording") { ctx.close().catch(() => {}); return; }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > 0.045) { spoke = true; silenceStart = 0; }
        else if (spoke && silenceStart === 0) { silenceStart = now; }
        else if (spoke && now - silenceStart > 1200) { stopRecording(); ctx.close().catch(() => {}); return; }
        if (now - startT > 14000) { stopRecording(); ctx.close().catch(() => {}); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const wakeP = listen<string>("wake-detected", async (e) => {
      if (stateRef.current !== "idle") return; // busy — ignore
      const which = (e.payload as string) || "hey_keak";
      // "hey_keak" wakes Keak AI; anything else is an agent's wake word ("Hey Nova") -> run as that agent.
      const agent = which === "hey_keak" ? null : (allAgents().find((a) => agentKey(a.name) === which) || null);
      // Keak AI needs a connected AI; agents need the user's OWN AI. If there's nothing to answer with, ignore
      // the wake instead of recording into a dead end (that was the old "spins forever" bug).
      if (agent && !resolveOwnAI()) return;
      if (which === "hey_keak" && !resolveOwnAI() && !getSession()?.access_token) return;
      setActiveAgent(agent);
      modeRef.current = "assistant";
      liveModeRef.current = "handsfree"; // wake word is hands-free: the live session ends on its own silence
      if (assistantVisibleRef.current) { cancelAssistantClose(); }
      else { assistantVisibleRef.current = true; setAssistant(true); setAiReply(""); historyRef.current = []; }
      setAttachedScreen(false);
      screenOffThisTurnRef.current = false;
      seeScreenRef.current = false;
      setSeeScreen(false);
      refreshScreenPermission();
      invoke("orb_show").catch(() => {}); // show the Keak AI panel so the answer is visible
      emitTo("orb", "orb-active").catch(() => {});
      await startRecording();
      if (!liveInfo()) startVad(); // live sessions detect end-of-speech themselves; classic flow needs the VAD
    });
    return () => { wakeP.then((f) => f()); };
  }, []);

  // Push-to-talk. Ctrl+Win = Dictate; Ctrl+Alt = Keak AI or Thought Dump (per the user's setting).
  useEffect(() => {
    const startP = listen<{ dump?: boolean; translate?: boolean } | boolean>("ptt-start", (e) => {
      if (stateRef.current === "idle") {
        // Plan gate: dictation is the paid feature. If the plan's minutes are used up, don't record — show the
        // upgrade message. Keak AI (Ctrl+Alt) still works because it runs on the user's own AI.
        if (dictationBlocked()) {
          modeRef.current = "dictate";
          setStateSafe("error");
          setErrorMsg("You've used all the dictation minutes on your plan. Upgrade or renew in Keak settings to keep dictating. Keak AI still works on your own AI.");
          return;
        }
        modeRef.current = "dictate";
        assistantVisibleRef.current = false;
        setAssistant(false); // leaving any open Keak AI conversation
        setAiReply("");
        historyRef.current = [];
        const p = e.payload;
        const dump = p === true || (typeof p === "object" && p?.dump === true);
        const translate = typeof p === "object" && p?.translate === true;
        thoughtDumpRef.current = dump;
        setThoughtDump(dump);
        // Ctrl+Space: translate this dictation into the chosen language (the target set in Settings, else the
        // last language picked, else English).
        const forced = translate ? (translateTarget() || localStorage.getItem("keak_translate_shift") || "en") : "";
        translateOnceRef.current = forced;
        setLiveTranslate(forced);
        startRecording();
      }
    });
    const stopP = listen("ptt-stop", () => {
      if (stateRef.current === "recording") stopRecording();
    });
    // Ctrl+Alt is ALWAYS Keak AI. (Thought Dump was removed as a Ctrl+Alt mode; it lives on only as the TD
    // button on the dictation pill.) We ignore any old keak_alt_mode value so a stale "thought_dump" from an
    // earlier install can never make Ctrl+Alt behave like dictation on a fresh machine.
    const altStartP = listen("alt-start", () => {
      // Allow interrupting the AI mid-response to ask a follow-up in the same conversation.
      const interruptable = assistantVisibleRef.current
        && (stateRef.current === "responding" || stateRef.current === "processing" || stateRef.current === "result");
      if (stateRef.current !== "idle" && !interruptable) return;
      if (interruptable) {
        stopSpeaking();
        setStateSafe("idle");
      }
      modeRef.current = "assistant";
      liveModeRef.current = "ptt"; // Ctrl+Alt / orb: ends when you release (or click the orb again)
      if (assistantVisibleRef.current) {
        // Overlay still visible (or was interrupted mid-response) — continue the conversation.
        cancelAssistantClose();
      } else {
        // Overlay was already closed — start a fresh Keak AI conversation (not an agent).
        setActiveAgent(null);
        assistantVisibleRef.current = true;
        setAssistant(true);
        setAiReply("");
        historyRef.current = [];
      }
      setAttachedScreen(false);
      screenOffThisTurnRef.current = false;
      // Screen is OFF by default every question; Keak only looks when you tap "See screen".
      seeScreenRef.current = false;
      setSeeScreen(false);
      refreshScreenPermission();
      startRecording();
    });
    const altStopP = listen("alt-stop", () => {
      if (stateRef.current === "recording") stopRecording();
    });
    // Win+Alt — Rewrite the current selection. Record the spoken instruction now; the selection itself
    // is captured after release (in processAudio) so the Ctrl+C isn't polluted by the held modifiers.
    const rewriteStartP = listen("rewrite-start", () => {
      if (stateRef.current !== "idle") return;
      modeRef.current = "rewrite";
      assistantVisibleRef.current = false;
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

  // Keak Streaming: a live, best-effort preview of your words in the pill while you talk, using the browser's
  // built-in speech recognition. It NEVER touches the recording or the injected text (which still comes from
  // our accurate pipeline on release), so if it fails, dictation is completely unaffected. Toggle: keak_streaming.
  function streamMode(): "off" | "pill" | "cursor" {
    const v = localStorage.getItem("keak_streaming");
    if (v === "0" || v === "off") return "off";
    // "cursor" (true at-the-cursor live typing) is deferred to the proper local streaming engine — until then
    // any old "cursor" setting behaves as the reliable pill preview. The cursor code below stays for later.
    return "pill";
  }
  // Clean one recognised sentence (punctuation, capitalisation, tidy) on the fast enhance backend, translating
  // if Ctrl+Space translate is armed. Falls back to the raw sentence if the call fails.
  async function cleanSentence(raw: string): Promise<string> {
    const text = raw.trim();
    if (!text) return "";
    const session = getSession();
    const outLang = translateOnceRef.current;
    const targetName = outLang ? (TRANSLATE_LANG_NAMES[outLang] || outLang) : "";
    try {
      const body: Record<string, unknown> = { text, mode: "normal", style_prompt: targetName ? `Translate the text into ${targetName}. Output ONLY the ${targetName} text, nothing else.` : "" };
      if (targetName) body.target_language = targetName;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/enhance`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token || ""}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({} as { enhanced_text?: string }));
      return (d.enhanced_text && d.enhanced_text.trim()) ? d.enhanced_text.trim() : text;
    } catch { return text; }
  }
  // Queue a sentence to be cleaned then typed at the cursor, keeping order.
  function enqueueClean(raw: string) {
    const text = raw.trim();
    if (!text) return;
    cleanChainRef.current = cleanChainRef.current.then(async () => {
      const cleaned = await cleanSentence(text);
      if (!cleaned) return;
      const piece = (streamRawRef.current ? " " : "") + cleaned;
      streamRawRef.current += piece;
      try { await invoke("stream_type", { text: piece }); } catch { /* ignore */ }
    });
  }
  function startLivePreview() {
    if (streamMode() === "off") return;
    try {
      const SR = (window as unknown as { webkitSpeechRecognition?: new () => any; SpeechRecognition?: new () => any }).webkitSpeechRecognition
        || (window as unknown as { SpeechRecognition?: new () => any }).SpeechRecognition;
      if (!SR) return;
      const l = localStorage.getItem("keak_language") || "auto";
      const M: Record<string, string> = { es: "es-ES", ca: "ca-ES", en: "en-US", fr: "fr-FR", de: "de-DE", pt: "pt-PT", it: "it-IT" };
      const rec: any = new SR();
      rec.continuous = true; rec.interimResults = true;
      rec.lang = (l !== "auto" && M[l]) ? M[l] : (navigator.language || "en-US");
      recogStoppingRef.current = false;
      rec.onresult = (e: any) => {
        if (recogStoppingRef.current) return;
        recogGotResultRef.current = true;
        const finals: string[] = [];
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finals.push(r[0].transcript); else interim += r[0].transcript;
        }
        // Cursor mode types at the cursor, so DON'T also show the words in the pill (that was the confusion —
        // it looked like it typed "in the pill"). Pill mode shows them in the pill.
        if (streamMode() === "cursor" && modeRef.current === "dictate") {
          for (let k = typedFinalsRef.current; k < finals.length; k++) enqueueClean(finals[k]);
          typedFinalsRef.current = finals.length;
          pendingInterimRef.current = interim;
        } else {
          setLiveText((finals.join(" ") + " " + interim).replace(/\s+/g, " ").trim());
        }
      };
      rec.onerror = () => { /* best-effort, ignore */ };
      recogRef.current = rec;
      rec.start();
    } catch { /* ignore — preview is optional */ }
  }
  function stopLivePreview() {
    recogStoppingRef.current = true;
    // Flush the last (not-yet-finalised) words so the tail of your sentence isn't lost.
    const tail = pendingInterimRef.current.trim();
    pendingInterimRef.current = "";
    if (tail && streamMode() === "cursor" && modeRef.current === "dictate") enqueueClean(tail);
    try { recogRef.current?.stop(); } catch { /* ignore */ }
    recogRef.current = null;
  }

  async function startRecording() {
    cancelAssistantClose(); // a new question cancels any pending auto-close
    cancelMicRelease(); // we're about to use the mic; don't let the idle timer stop it mid-use
    stopSpeaking(); // interrupt any answer still playing so you can talk over it
    if (liveActiveRef.current) { liveRef.current?.close(); liveActiveRef.current = false; } // end any live session first
    // Live voice: a Keak AI turn on a live-capable provider (Gemini Live / OpenAI Realtime) goes straight to
    // the realtime session instead of the record -> transcribe -> answer -> TTS chain.
    if (modeRef.current === "assistant" && liveInfo()) { await startLiveTurn(liveModeRef.current); return; }
    chunks.current = [];
    setLiveText("");
    streamRawRef.current = ""; streamFinalLenRef.current = 0;
    recogGotResultRef.current = false; pendingInterimRef.current = ""; recogStoppingRef.current = false;
    typedFinalsRef.current = 0; cleanChainRef.current = Promise.resolve();
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
      startLivePreview(); // show words forming live (best-effort, never blocks the above)
    } catch {
      setStateSafe("error");
      setErrorMsg("Microphone access denied");
    }
  }

  function stopRecording() {
    // Live voice: end the user's turn -> the model replies out loud. finishTurn() is guarded/idempotent.
    // If the session is still opening, mark it pending so startLiveTurn finishes as soon as it's ready.
    if (liveActiveRef.current) {
      if (liveRef.current) liveRef.current.finishTurn(); else liveFinishPendingRef.current = true;
      setStateSafe("processing"); return;
    }
    if (!readyToStop.current || !mrRef.current) return;
    readyToStop.current = false;
    stopLivePreview();
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

    // Keak Streaming "at cursor" mode: the clean sentences were already typed at the cursor live. Wait for the
    // last queued sentence to finish typing, then finish — don't transcribe + inject again. Only when the live
    // engine produced nothing do we fall through to the normal accurate pipeline (so dictation never breaks).
    if (modeRef.current === "dictate" && streamMode() === "cursor" && recogGotResultRef.current) {
      try { await cleanChainRef.current; } catch { /* ignore */ }
      const finalText = streamRawRef.current.trim();
      if (finalText) {
        // The clean sentences were typed at the cursor live — finish without transcribing/injecting again.
        await invoke("hide_overlay");
        saveHistory(session, { raw_text: finalText, final_text: finalText, mode: thoughtDumpRef.current ? "thought_dump" : "normal", duration_seconds: null });
        setLiveTranslate("");
        reset();
        return;
      }
      // Nothing actually landed (recognition gave only interim, or typing failed) — fall through to the normal
      // accurate pipeline so your dictation still gets injected.
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

      // ── Keak Sovereign: force fully-local, zero-cloud ────────────────────
      // When Sovereign is on we ALWAYS use the local server and never fall back to the cloud (below, if
      // the local server isn't up it errors out instead of transcribing in the cloud). Otherwise we
      // auto-detect: if a local server is running (e.g. start.bat), use it; else use the cloud.
      const offlineMode = sovereignOn() ? true : await isLocalServerUp();
      let tData: any;
      if (offlineMode) {
        const localRes = await fetch("http://127.0.0.1:9889/transcribe", {
          method: "POST",
          body: form,
        }).catch(() => null);
        if (!localRes || !localRes.ok) {
          const friendly = "Offline mode: local server not running. Start PROJECTS/KEAK/local-whisper/start.bat first, or disable with: localStorage.setItem('keak_offline_mode','false')";
          if (modeRef.current === "assistant") {
            setAiReply(friendly);
            setStateSafe("idle");
            scheduleAssistantClose(9000);
          } else {
            setStateSafe("error");
            setErrorMsg("Offline mode: local server not running. Run start.bat first.");
          }
          return;
        }
        tData = await localRes.json().catch(() => ({} as any));
      } else {
        // ── Cloud path (default) ───────────────────────────────────────────
        const tRes = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: form,
        });
        tData = await tRes.json().catch(() => ({} as any));
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
      }
      // ─────────────────────────────────────────────────────────────────────
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

      // Whisper hallucination guard: on silence or ambient/keyboard noise the model often "hears" its own
      // vocabulary ("Keak", "Keoly") or a stock filler ("Thank you", "Subtitles by…"). That is NOT real
      // speech — never inject it at the cursor (this is what wrote "keak and keoly" while typing). Only guards
      // dictation/rewrite; the assistant already handles junk by just answering.
      if (modeRef.current !== "assistant") {
        const junk = String(tData.text).toLowerCase().replace(/[.,!¡¿?"'()\-–—:;\s]+/g, " ").replace(/\s+/g, " ").trim();
        const HALLUCINATIONS = new Set([
          "", "keak", "keoly", "keak keoly", "keak and keoly", "keoly keak", "keak keak", "keoly keoly",
          "you", "thank you", "thanks", "thanks for watching", "thank you for watching", "bye", "amen", "the",
          "subtitles by the amara org community", "subtitulos realizados por la comunidad de amara org", "subtitulos amara org", "amara org",
        ]);
        if (junk === "" || HALLUCINATIONS.has(junk)) { await invoke("hide_overlay"); reset(); return; }
      }

      // Remember the language of what was actually said, so fillers + auto-detect replies match it (Spanish
      // question -> Spanish acknowledgement), even when the language setting is left on "auto".
      localStorage.setItem("keak_last_lang", detectLang(String(tData.text)));

      // Keak AI branch: ask the assistant and speak the answer, instead of injecting text.
      if (modeRef.current === "assistant") {
        // Play the "thinking" filler immediately so there's no dead air while the answer is generated.
        // The real answer (runAssistant) waits for fillerDone before speaking, so they never overlap.
        fillerDone = playFiller();
        ensureFillers(session.access_token); // refresh the cached clips for next time (no-op if unchanged)

        let image: string | undefined;
        // Capture when the user clicked "See screen" OR when their voice request clearly implies it.
        const screenLookIntent = /\b(look at|see|check|read|what(?:'s| is) on|what do you see on|analyz[ae]|examine|capture|show me)\s*(my\s+)?(screen|display|desktop)\b|what'?s\s+on\s+(my\s+)?screen|look(ing)? at (my|the) screen/i.test(String(tData.text));
        const wantScreen = seeScreenRef.current || (canSeeScreen && screenAllowed && screenLookIntent);
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

      // Kodes: check if the transcription matches any saved trigger and expand it.
      // Fetch the user's kodes, replace any triggers found in the text, and if any matched
      // inject the result directly (skip enhance — kodes are exact, not AI-rewritten).
      try {
        const kRes = await fetch(
          `${SUPABASE_URL}/rest/v1/kodes?select=trigger,expansion`,
          { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` } }
        );
        if (kRes.ok) {
          const kodes: { trigger: string; expansion: string }[] = await kRes.json();
          if (kodes.length > 0) {
            let expanded = tData.text;
            for (const k of kodes) {
              if (!k.trigger || !k.expansion) continue;
              const escaped = k.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              expanded = expanded.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi"), k.expansion);
            }
            if (expanded !== tData.text) {
              await invoke("inject_text", { text: expanded });
              saveHistory(session, { raw_text: tData.text, final_text: expanded, mode: "kode" });
              reset();
              return;
            }
          }
        }
      } catch { /* kodes are best-effort — fall through to normal enhance */ }

      const stylePrompt = localStorage.getItem("keak_default_style") || null;
      // Translate-while-dictating: if a target language is armed, the cleaned text is translated into it
      // before injecting. Prefer the user's own connected AI (free, works offline / in Sovereign); if none
      // is connected, fall back to Keak's cloud AI — except in Sovereign mode, which must stay zero-cloud.
      // Only Ctrl+Win+Shift translates. Plain Ctrl+Win always writes the spoken language, no translation.
      const forcedLang = translateOnceRef.current;
      translateOnceRef.current = "";
      const outLang = forcedLang;
      const targetName = outLang ? (TRANSLATE_LANG_NAMES[outLang] || outLang) : "";
      // The user's own model — used for translation, and for the clean-up step in Sovereign mode.
      const ownAi = (outLang || sovereignOn()) ? resolveOwnAI() : null;
      let finalText: string;
      if (sovereignOn()) {
        // Zero-cloud: clean up the transcript on the user's own model. No connected model → use the raw
        // transcript (whisper output is already clean). The cloud enhance function is never called.
        if (ownAi) {
          try {
            finalText = (await askOwnAIRaw(ownAi, localCleanupSystem(!!thoughtDumpRef.current, stylePrompt), tData.text)).trim() || tData.text;
          } catch { finalText = tData.text; }
        } else {
          finalText = tData.text;
        }
      } else {
        const enhanceBody: Record<string, unknown> = {
          text: tData.text,
          mode: thoughtDumpRef.current ? "thought_dump" : "normal",
          style_prompt: stylePrompt,
        };
        const eRes = await fetch(`${SUPABASE_URL}/functions/v1/enhance`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(enhanceBody),
        });
        const eData = await eRes.json();
        finalText = eData.enhanced_text || tData.text;
      }
      // Translate the cleaned text into the target language. Own AI first (free/offline); if that isn't
      // available or fails, a dedicated cloud enhance call does the translation — so it works even with no
      // model connected. Never hits the cloud in Sovereign mode.
      if (outLang) {
        let translated = "";
        if (ownAi) {
          try { translated = (await askOwnAIRaw(ownAi, translateSystem(outLang), finalText)).trim(); }
          catch { /* fall through to the cloud fallback below */ }
        }
        if (!translated && !sovereignOn()) {
          try {
            const tRes = await fetch(`${SUPABASE_URL}/functions/v1/enhance`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${session.access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: finalText,
                mode: "normal",
                style_prompt: `Translate the text into ${targetName}. Output ONLY the ${targetName} translation, nothing else — no notes, no quotes, no original text.`,
                target_language: targetName,
              }),
            });
            const tData2 = await tRes.json();
            if (tData2.enhanced_text && tData2.enhanced_text.trim()) translated = tData2.enhanced_text.trim();
          } catch { /* translation is best-effort — fall back to the untranslated text */ }
        }
        if (translated) finalText = translated;
      }
      // Wispr-style: drop the cleaned text straight where the cursor was, no review step.
      await invoke("inject_text", { text: finalText });
      setLiveTranslate(""); // clear the one-off translate badge now the dictation is done
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

    let lastSnap: any = null;
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
      // Wait longer on the last step so the page has time to fully load
      const snap = await waitForBrowserResult(i === plan.length - 1 ? 3000 : 1500);
      if (snap) lastSnap = snap;
    }

    // For weather queries: call Open-Meteo directly — reliable, no page snapshot needed.
    // For everything else: try to summarize from the page snapshot.
    let doneMsg = "Done.";
    const weatherCity = extractWeatherCity(task);
    if (weatherCity) {
      const weatherMsg = await fetchWeatherSpeech(weatherCity);
      if (weatherMsg) doneMsg = weatherMsg;
    } else if (lastSnap?.page) {
      const pg = lastSnap.page;
      const pageCtx = `URL: ${pg.url} | Title: "${pg.title}" | Content: ${(pg.text || "").slice(0, 1000)}`;
      const assistantName = localStorage.getItem("keak_assistant_name") || "Keak";
      const userName = localStorage.getItem("keak_user_name") || "there";
      try {
        const sumRes = await fetch(`${SUPABASE_URL}/functions/v1/keak-assistant`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[Task]: ${task}\n[Page result]: ${pageCtx}\n[Summarize the answer to the task in 1-2 natural spoken sentences. No browser actions needed. Reply only with the spoken answer.]`,
            user_name: userName,
            assistant_name: assistantName,
            history: [],
          }),
        });
        if (sumRes.ok) {
          const sumData = await sumRes.json();
          if (sumData.reply) doneMsg = cleanReply(sumData.reply);
        }
      } catch { /* fall through to "Done." */ }
    }

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

  // Local "reply to this email" handler: read the open email from the page, ask Keak AI to WRITE the
  // reply body (text only), then click Reply and TYPE it in. Deterministic DOM work — the model is
  // only used to write the text, so it actually writes the reply instead of describing how to.
  async function replyToEmailLocally(question: string, token: string): Promise<void> {
    const userName = localStorage.getItem("keak_user_name") || "there";
    const assistantName = localStorage.getItem("keak_assistant_name") || "Keak";
    // 1. Grab the open email's text via the extension.
    try {
      await invoke("send_browser_command", { command: JSON.stringify({ id: Date.now(), type: "get_page_info" }) });
    } catch {
      setAiReply("Keak Browser Bridge isn't connected. Reload the Chrome extension.");
      setStateSafe("idle"); scheduleAssistantClose(9000); return;
    }
    const snap = await waitForBrowserResult(2500);
    const pageText = (snap?.page?.text || "").slice(0, 2200);
    // 2. Ask Keak AI to write the reply BODY only.
    let body = "";
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/keak-assistant`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Write a reply to this email as if I wrote it. Output ONLY the reply body as plain text, ready to send, no subject line and no commentary. My instruction: "${question}". The email on my screen:\n${pageText}`,
          user_name: userName, assistant_name: assistantName, history: [],
        }),
      });
      if (r.ok) { const d = await r.json(); body = cleanReply(d.reply || ""); }
    } catch { /* fall through */ }
    if (!body) { setAiReply("I couldn't draft that reply. Try again."); setStateSafe("idle"); scheduleAssistantClose(9000); return; }
    // 3. Click Reply, then type the drafted body into the compose box.
    const steps = [{ type: "click", text: "Reply" }, { type: "type", text: body, append: false }];
    for (let i = 0; i < steps.length; i++) {
      try { await invoke("send_browser_command", { command: JSON.stringify({ id: Date.now(), ...steps[i] }) }); }
      catch { setAiReply("Keak Browser Bridge isn't connected. Reload the Chrome extension."); setStateSafe("idle"); scheduleAssistantClose(9000); return; }
      await waitForBrowserResult(i === 0 ? 1300 : 700);
    }
    // Full access = also hit Send for you (Gmail "Send" / Spanish "Enviar"). Ask mode leaves it to you.
    let sent = false;
    if (actionMode() === "full") {
      await new Promise((r) => setTimeout(r, 500));
      for (const label of ["Send", "Enviar"]) {
        try { await invoke("send_browser_command", { command: JSON.stringify({ id: Date.now(), type: "click", text: label }) }); }
        catch { break; }
        const rr = await waitForBrowserResult(1500);
        if (rr?.success) { sent = true; break; }
      }
    }
    const spoken = sent
      ? "Done, I wrote the reply and sent it for you."
      : "Done, I wrote the reply. Check it and hit send when you're happy.";
    historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: spoken });
    let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(spoken); setStateSafe("idle"); };
    const safety = window.setTimeout(show, 15000);
    try { await speakReply(spoken, token, () => { clearTimeout(safety); show(); }); }
    finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(11000); }
  }

  // Keak team-to-team (Telegram group): log each interaction for the Connect "Team" tab.
  function pushTeamLog(e: { ts: number; dir: string; who: string; body: string; result?: string }) {
    try { const prev = JSON.parse(localStorage.getItem("keak_team_log") || "[]"); const h = Array.isArray(prev) ? prev : []; h.unshift(e); localStorage.setItem("keak_team_log", JSON.stringify(h.slice(0, 40))); } catch { /* ignore */ }
  }
  // A teammate addressed my Keak in the team Telegram group. Run the task on MY own AI (optionally with my
  // Second Brain) and return the finished result to post back in the group. Runs entirely on my side.
  async function answerForTeam(task: string, fromName: string): Promise<string> {
    const ai = resolveOwnAI();
    if (!ai) return "Couldn't run it — no AI is connected on my Keak.";
    const access = localStorage.getItem("keak_team_access") || "ai";
    let ctx = "";
    if (access === "brain") { try { ctx = await getBrainContext(); } catch { /* ignore */ } }
    const myNm = localStorage.getItem("keak_team_name") || localStorage.getItem("keak_user_name") || "me";
    const system = `You are ${myNm}'s Keak assistant, helping in a team group chat. ${fromName} asked you to do a task. Do it as well as you can and reply with ONLY the finished result, concise and ready to read in the group.${ctx ? `\n\nContext from ${myNm}'s Second Brain (use if relevant, never dump it verbatim):\n${ctx}` : ""}`;
    try { return (await askOwnAIRaw(ai, system, task)).trim() || "(no result)"; } catch (e) { return `Hit an error: ${String(e).slice(0, 140)}`; }
  }

  // Keak Recap by voice: stop the capture, transcribe it in chunks, summarise on the user's own AI, speak a
  // short version and save the full recap so it shows in the Recap tab.
  async function runRecapVoice(token: string) {
    setStateSafe("responding"); setAiReply("Wrapping up the recap...");
    let res: [string, number];
    try { res = await invoke<[string, number]>("recap_stop"); }
    catch (e) { await sayAndClose(`I couldn't stop the recap: ${String(e).slice(0, 120)}`, token); return; }
    const secs = res[1] || 0;
    if (secs < 1.5) { await sayAndClose("There was nothing to recap. Start it while the meeting audio is playing.", token); return; }
    let count = 0; try { count = await invoke<number>("recap_chunk_count", { chunkSecs: 120 }); } catch { /* ignore */ }
    const session = getSession();
    const lang = localStorage.getItem("keak_language");
    let transcript = "";
    for (let i = 0; i < count; i++) {
      setAiReply(`Transcribing the recap ${i + 1}/${count}...`);
      let b64 = ""; try { b64 = await invoke<string>("recap_chunk_b64", { index: i, chunkSecs: 120 }); } catch { /* ignore */ }
      if (!b64) continue;
      const form = new FormData();
      form.append("file", b64ToBlob(b64, "audio/wav"), "chunk.wav");
      if (lang && lang !== "auto") form.append("language", lang);
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token || ""}` }, body: form });
        const d = await r.json().catch(() => ({} as { text?: string }));
        if (d.text) transcript += (transcript ? " " : "") + String(d.text).trim();
      } catch { /* skip a bad chunk */ }
    }
    transcript = transcript.trim();
    if (!transcript) { await sayAndClose("I captured audio but couldn't hear any speech to recap.", token); return; }
    setAiReply("Writing the recap...");
    const ai = resolveOwnAI();
    const uiCode = localStorage.getItem("keak_ui_lang") || "en";
    const LN: Record<string, string> = { es: "Spanish", ca: "Catalan", fr: "French", de: "German", pt: "Portuguese", it: "Italian", en: "English" };
    const system = `You are given a raw transcript of a call or meeting captured from the user's computer audio. Write a clean recap in ${LN[uiCode] || "English"} with these markdown sections: a one-paragraph Summary, Key points (bullets), Decisions, and Action items (with the owner if named). Be faithful to the transcript and never invent anything. Keep it tight.`;
    let recap = transcript;
    if (ai) { try { recap = (await askOwnAIRaw(ai, system, transcript.slice(0, 24000))).trim() || transcript; } catch { /* keep the raw transcript */ } }
    try { const prev = JSON.parse(localStorage.getItem("keak_recap_history") || "[]"); const h = Array.isArray(prev) ? prev : []; h.unshift({ ts: Date.now(), secs, recap, transcript }); localStorage.setItem("keak_recap_history", JSON.stringify(h.slice(0, 20))); } catch { /* ignore */ }
    emitTo("connect", "recap-done", { recap }).catch(() => { /* Connect may be closed */ });
    historyRef.current.push({ role: "user", text: "Recap the meeting" }, { role: "assistant", text: recap });
    await sayAndClose(shortSpoken(recap) + " I saved the full recap in the Recap tab.", token, 18000);
  }

  // Keak Ledger by voice: parse a spoken money entry (expense OR income) on the user's own AI and append a
  // clean CSV row to "Keak Ledger/ledger.csv" inside the connected Second Brain folder. Privacy by design:
  // the row only ever lives in the user's own folder, never on Keak's side. No dedicated UI — you just ask.
  async function runLedgerVoice(question: string, token: string) {
    const root = localStorage.getItem("keak_brain_path") || "";
    if (!root) { await sayAndClose("To keep your ledger, connect your Second Brain folder in settings first.", token); return; }
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your AI first so I can read the entry.", token); return; }
    setStateSafe("responding"); setAiReply("Adding it to your ledger...");
    const defCur = (localStorage.getItem("keak_ledger_currency") || "EUR").toUpperCase();
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const system = `You turn a spoken money entry into ONE JSON object and nothing else: {"type":"expense" or "income","amount":number,"currency":"3-letter code","category":"one or two word category","description":"what it was for","vendor":"who was paid or who paid, or empty","date":"YYYY-MM-DD"}. Decide type: money going out (spent, bought, paid a bill) = expense; money coming in (earned, invoice paid, client paid me, revenue) = income. Use ${defCur} if no currency is said. Use ${iso} if no date is said; understand relative dates like "yesterday" or "last Monday" against ${iso}. Category examples: Food, Travel, Software, Office, Client, Marketing, Sales. Keep description short. Reply with ONLY the JSON.`;
    let row: { type?: unknown; amount?: unknown; currency?: unknown; category?: unknown; description?: unknown; vendor?: unknown; date?: unknown } | null = null;
    try { const raw = await askOwnAIRaw(ai, system, question); const m = raw.match(/\{[\s\S]*\}/); if (m) row = JSON.parse(m[0]); } catch { /* ignore */ }
    const amount = typeof row?.amount === "number" ? row.amount : parseFloat(String(row?.amount ?? ""));
    if (!row || !isFinite(amount)) { await sayAndClose("I didn't catch an amount. Try: log forty euros, lunch with a client.", token); return; }
    const kind = String(row.type || "").toLowerCase().startsWith("inc") ? "Income" : "Expense";
    const cur = String(row.currency || defCur).toUpperCase().slice(0, 6);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")) ? String(row.date) : iso;
    const category = String(row.category || "").slice(0, 40);
    const description = String(row.description || "").slice(0, 200);
    const vendor = String(row.vendor || "").slice(0, 80);
    const esc = (s: string | number) => { const v = String(s ?? "").replace(/"/g, '""'); return /[",\n]/.test(v) ? `"${v}"` : v; };
    const line = [date, kind, amount, cur, esc(category), esc(description), esc(vendor)].join(",");
    const path = "Keak Ledger/ledger.csv";
    const perm = localStorage.getItem("keak_brain_perm") || "full";
    const header = "Date,Type,Amount,Currency,Category,Description,Vendor";
    let existing = "";
    try { existing = await invoke<string>("sb_read", { args: { root, path } }); } catch { /* file doesn't exist yet */ }
    const body = existing.trim() ? `${existing.replace(/\s+$/, "")}\n${line}\n` : `${header}\n${line}\n`;
    try { await invoke("sb_write", { args: { root, path, content: body, perm } }); }
    catch (e) { await sayAndClose(`I couldn't save it: ${String(e).slice(0, 120)}`, token); return; }
    historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: `Logged ${kind.toLowerCase()} ${amount} ${cur} ${category}` });
    const curWord = cur === "EUR" ? "euros" : cur === "USD" ? "dollars" : cur === "GBP" ? "pounds" : cur;
    const verb = kind === "Income" ? "Added income of" : "Logged";
    await sayAndClose(`${verb} ${amount} ${curWord}${category ? " for " + category.toLowerCase() : ""}. It's in your ledger.`, token);
  }

  async function runAssistant(question: string, token: string, image?: string) {
    cancelAssistantClose();
    const assistantName = localStorage.getItem("keak_assistant_name") || "Keak";
    const userName = localStorage.getItem("keak_user_name") || "there";
    try {
      // Keak Recap by voice. "start a recap / record this meeting" begins capture; "finish/stop the recap /
      // recap the meeting" stops and writes it. Checked first so these never get treated as a question.
      if (/\b(start|begin|empieza|inicia|comienza)\b[\s\S]*\b(recap|recording|record|grabaci[oó]n|grabar|resumen)\b|\brecord (?:this|the) (?:meeting|call)\b|\bgraba (?:esta|la) (?:reuni[oó]n|llamada)\b/i.test(question)) {
        await invoke("recap_start", { mic: localStorage.getItem("keak_recap_mic") !== "0" }).catch(() => {});
        await sayAndClose("Recording the meeting. Say finish the recap when you are done.", token);
        return;
      }
      if (/\b(finish|stop|end|finali[sz]e|termina|finaliza|para)\b[\s\S]*\b(recap|recording|grabaci[oó]n|resumen)\b|\brecap (?:the|this|it|that)\b|\bhaz (?:el|un) resumen\b/i.test(question)) {
        await runRecapVoice(token);
        return;
      }
      // Keak Ledger by voice: "log 40 euros for lunch", "add an expense", "track 500 euros income from a
      // client", "apunta un gasto de 20 euros". Parses the spoken money entry (expense OR income) on your own
      // AI and appends a clean row to Keak Ledger/ledger.csv in your connected Second Brain folder. Never
      // stored on Keak's side.
      {
        const ledgerVerb = /\b(log|add|record|note|track|jot|apunta|an[oó]ta|registra|a[ñn]ade|ap[uú]nta(?:me)?|guarda)\b/i.test(question);
        const moneyNoun = /\b(expenses?|spend|spent|cost|costs|purchase|payment|paid|bought|receipt|income|earned|earning|revenue|received|invoice|got paid|gasto|gastos|gast[eé]|compr[eé]|pagu[eé]|recibo|ticket|ingresos?|ingres[eé]|cobr[eé]|factura|ganancia)\b/i.test(question);
        const currencyWord = /\b(euros?|dollars?|pounds?|d[oó]lares?|libras?|usd|eur|gbp)\b|[€$£]/i.test(question);
        const money = /(\d+([.,]\d+)?)\s*(€|\$|£|euros?|dollars?|pounds?|usd|eur|gbp|d[oó]lares?|libras?)|[€$£]\s*\d/i.test(question);
        const toLedger = /\b(?:to|in) (?:my|the) (?:ledger|expenses?|income|accounts?|books?)\b|\b(?:al?|en) (?:mi|el|la) (?:libro|ledger|gastos|ingresos|cuentas?|contabilidad)\b/i.test(question);
        if ((ledgerVerb && (moneyNoun || money || currencyWord)) || toLedger) {
          await runLedgerVoice(question, token);
          return;
        }
      }
      // [KEAK-DEBUG v1.2] confirms the new local handlers are running + shows what was heard.
      console.log("[KEAK v1.2] heard:", JSON.stringify(question));
      // Computer-use: an explicit "take control and do X" command runs the screen agent (TARS) instead
      // of answering. Only fires when a provider is connected and the phrasing is clearly a command.
      // "Show me the agents" / "make all the agents appear" → just display the whole team, no work.
      if (parseShowAgents(question)) { await showAllAgents(token); return; }

      // Post to Slack when connected: "post to Slack #team saying …", "send it to slack".
      if (localStorage.getItem("keak_slack_token") && /\b(post|send|share|message)\b[\s\S]*\bslack\b|\bslack\b[\s\S]*\b(saying|message)\b/i.test(question)) {
        const chMatch = question.match(/#([a-z0-9_-]+)/i) || question.match(/\b(?:to|on|in)\s+(?:the\s+)?([a-z0-9_-]+)\s+channel/i);
        const channel = chMatch ? (chMatch[1].startsWith("#") ? chMatch[1] : `#${chMatch[1]}`) : "#general";
        const sayMatch = question.match(/\b(?:saying|that says?|message[:]?|:)\s*([\s\S]+)$/i);
        let text = sayMatch ? sayMatch[1].trim() : "";
        if (!text) { const hist = JSON.parse(localStorage.getItem("keak_agent_history") || "[]"); text = hist?.[0]?.results?.[0]?.output?.slice(0, 900) || question; }
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply(`Posting to Slack ${channel}...`);
        const ok = await postToSlack(channel, text);
        await sayAndClose(ok ? `Posted it to Slack ${channel}.` : "I couldn't post to Slack. Check the token and that the app is in that channel.", token);
        return;
      }

      // Direct research via Perplexity when connected. Broad triggers so "search the internet", "latest AI
      // news", "what's new", "look it up", ES "busca en internet / noticias" all reach live web search.
      const wantsWeb = /\b(search (?:the )?(?:internet|web|online)|on the (?:internet|web)|look ?up|find out|latest|newest|recent(?:ly)?|current|today'?s?|this week|the news|headlines|what'?s (?:new|happening)|breaking|price of|weather|who won)\b/i.test(question)
        || /^\s*(research|investiga|busca|averigua|google|noticias)\b/i.test(question)
        || /\b(search the internet|busca en internet|en internet|noticias|últimas noticias)\b/i.test(question)
        || /\bperplexity\b/i.test(question);
      if (toolKey("perplexity") && wantsWeb) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Researching that live...");
        const r = await askPerplexity(question);
        if (r) {
          try {
            const prev = JSON.parse(localStorage.getItem("keak_agent_history") || "[]");
            const hist = Array.isArray(prev) ? prev : [];
            hist.unshift({ ts: Date.now(), job: question, results: [{ name: "Perplexity", title: "Research", output: r, color: "#D4A49A" }] });
            localStorage.setItem("keak_agent_history", JSON.stringify(hist.slice(0, 20)));
          } catch { /* ignore */ }
          setAgentResults([{ name: "Perplexity", title: "Research", output: r, color: "#D4A49A" }]);
          setShowAgentPanel(false);
          historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: r });
          await sayAndClose(shortSpoken(r), token, 16000);
        } else {
          await sayAndClose("I couldn't reach Perplexity. Check your key in settings.", token);
        }
        return;
      }

      // ---- Plug-in tool actions (ElevenLabs voiceover, Gamma deck, HeyGen video, n8n/Make automation) ----
      // The topic/text after a leading command verb + "about/of/on/that says" (or the whole thing).
      const subjectOf = (q: string) => {
        const m = q.match(/\b(?:about|of|on|that says?|saying|sobre|de|del|acerca de)\s+([\s\S]+)$/i);
        if (m && m[1].trim().length > 1) return m[1].trim();
        return q.replace(/^\s*(?:please\s+|por favor\s+)?(?:make|create|generate|build|write|record|hazme|haz|cr[eé]a|gener[ao]|graba|escr[ií]beme|dame)\s+(?:me\s+)?(?:a|an|una|un|el|la|los|las)?\s*/i, "").trim() || q;
      };
      const lastOutput = (): string => { try { const h = JSON.parse(localStorage.getItem("keak_agent_history") || "[]"); return h?.[0]?.results?.[0]?.output || ""; } catch { return ""; } };

      // ElevenLabs voiceover: "make a voiceover of X", "read this out loud", "grábame una voz diciendo…".
      if (toolKey("elevenlabs") && /\b(voice ?over|voiceover|narration|read (?:this|it|that) (?:out loud|aloud)|voz|l[eé]elo|n[aá]rralo|eleven ?labs)\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Recording the voiceover...");
        const say = subjectOf(question) || lastOutput();
        const out = await makeVoiceover(say.slice(0, 2500));
        if (looksLikePath(out)) { try { await invoke("open_url", { url: out! }); } catch { /* ignore */ } await sayAndClose("Done, I made the voiceover and opened it.", token); }
        else await sayAndClose(`I couldn't make the voiceover. ${(out || "").slice(0, 120)}`, token);
        return;
      }

      // Gamma deck: "make a deck about X", "create a presentation on Y", "hazme unas diapositivas de Z".
      if (toolKey("gamma") && /\b(deck|slide deck|slides|presentation|pitch deck|diapositivas?|presentaci[oó]n|gamma)\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Building your deck in Gamma...");
        const out = await makeDeck(subjectOf(question).slice(0, 1500));
        if (looksLikeUrl(out)) { try { await invoke("open_url", { url: out! }); } catch { /* ignore */ } await sayAndClose("Your deck is ready, I opened it in Gamma.", token); }
        else await sayAndClose(`I couldn't build the deck. ${(out || "").slice(0, 120)}`, token);
        return;
      }

      // Higgsfield cinematic image/video: "make a cinematic shot of X", "higgsfield a video of Y".
      if (toolKey("higgsfield") && /\b(higgsfield|cinematic)\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Generating it with Higgsfield...");
        const out = await runHiggsfield(subjectOf(question.replace(/\bhiggsfield\b/i, "")).slice(0, 1200));
        if (looksLikeUrl(out)) { try { await invoke("open_url", { url: out! }); } catch { /* ignore */ } await sayAndClose("Done, I opened what Higgsfield made.", token); }
        else await sayAndClose(`${(out || "I couldn't generate that.").slice(0, 150)}`, token);
        return;
      }

      // HeyGen avatar video: "make a video about X", "crea un vídeo sobre Y". Write a short script first.
      if (toolKey("heygen") && (/\bhey ?gen\b/i.test(question) || (/\b(video|v[ií]deo|avatar)\b/i.test(question) && /\b(make|create|generate|record|hazme|haz|cr[eé]a|gener[ao]|graba)\b/i.test(question)))) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Creating your video (this takes a couple of minutes)...");
        let script = subjectOf(question);
        const ownAI = resolveOwnAI();
        if (ownAI) {
          try { script = await askOwnAIRaw(ownAI, "Write a short spoken video script, 40 to 70 words, plain text, no headings, that an on-camera avatar will read. Topic follows.", subjectOf(question)) || script; }
          catch { /* keep the raw subject */ }
        }
        const out = await makeVideo(script.slice(0, 1500));
        if (looksLikeUrl(out)) { try { await invoke("open_url", { url: out! }); } catch { /* ignore */ } await sayAndClose("Your video is ready, I opened it.", token); }
        else await sayAndClose(`${(out || "I couldn't make the video.").slice(0, 150)}`, token);
        return;
      }

      // n8n / Make automation: "trigger my automation", "run my scenario", "dispara mi automatización".
      if ((toolKey("n8n") || toolKey("make")) && /\b(trigger|run|fire|start|dispara|lanza|ejecuta)\b[\s\S]*\b(automation|workflow|scenario|webhook|n8n|make|automatizaci[oó]n|flujo|escenario)\b|\b(automation|workflow|scenario|webhook)\b[\s\S]*\b(trigger|run|fire)\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Firing your automation...");
        const ok = await fireAutomation(subjectOf(question) || question);
        await sayAndClose(ok ? "Done, I triggered your automation." : "I couldn't reach that webhook. Check the URL in settings.", token);
        return;
      }

      // Resend: send an email through Resend when the user names it ("send an email via Resend to …").
      if (toolKey("resend") && /\bresend\b/i.test(question) && /\b(email|e-?mail|correo|mensaje)\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Sending it via Resend...");
        let parsed = parseGmailSend(question);
        if (!parsed || !parsed.to) {
          const ai = resolveOwnAI();
          if (ai) {
            try {
              const raw = await askOwnAIRaw(ai, "Extract an email from the request. Reply ONLY with JSON {\"to\":\"email\",\"subject\":\"short subject\",\"body\":\"the message\"}. No prose, no code fences.", question);
              const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]);
            } catch { /* ignore */ }
          }
        }
        if (parsed && parsed.to) {
          const ok = await sendViaResend(parsed.to, parsed.subject || "(no subject)", parsed.body || "");
          await sayAndClose(ok ? `Sent it via Resend to ${parsed.to}.` : "I couldn't send it via Resend. Check the key, and verify a domain in Resend to email other people.", token);
        } else await sayAndClose("Tell me who to email and what to say.", token);
        return;
      }

      // Supabase "do anything": run a query/insert/update/delete on the user's database.
      if (localStorage.getItem("keak_supabase_url") && (/\bsupabase\b/i.test(question) || /\b(database|my db|table|row|record|query|insert into|delete from|update .*(set|row))\b/i.test(question))) {
        await supabaseDo(question, token); return;
      }

      // Figma "do anything the API allows": read files, export frames, comments.
      if (localStorage.getItem("keak_figma_token") && /\bfigma\b/i.test(question)) {
        await figmaDo(question, token); return;
      }

      // GitHub "do anything": repos, issues, PRs, gists.
      if (localStorage.getItem("keak_github_token") && (/\bgithub\b/i.test(question) || /\b(repo|repository|issue|pull request|\bpr\b|commit|gist)\b/i.test(question))) {
        await githubDo(question, token); return;
      }

      // Shopify "do anything": products, orders, customers.
      if (localStorage.getItem("keak_shopify_token") && (/\bshopify\b/i.test(question) || /\b(store|order|product|inventory|customer)\b/i.test(question))) {
        await shopifyDo(question, token); return;
      }

      // YouTube (read): channel stats, my videos, search — via the Google account's YouTube Data API scope.
      if (localStorage.getItem("keak_google_refresh") && /\byoutube\b/i.test(question)) {
        await youtubeDo(question, token); return;
      }

      // Gumloop: trigger the saved flow.
      if (localStorage.getItem("keak_gumloop_key") && /\bgumloop\b|\b(run|start|trigger|fire) (my )?(flow|pipeline)\b/i.test(question)) {
        await runGumloop(question, token); return;
      }

      // Second Brain OS "do anything": read/list/search your folders, or create/edit/delete files, folders and
      // skills inside the connected folder. Gated on being connected. Skip it for routine/schedule requests so
      // "create a routine…" makes a real routine instead of a file in the brain.
      if (localStorage.getItem("keak_brain_path") && !looksLikeRoutineCommand(question) && (
        /\b(second brain|my brain|my notes|my os)\b/i.test(question) ||
        /\bskills?\b/i.test(question) ||
        /\bmy (files?|folders?|projects?|notes?|documents?)\b/i.test(question) ||
        /\b(create|make|new|write|edit|update|delete|remove|read|open|look at|list|show|find|search)\b[\s\S]*\b(file|folder|note|skill|project|document|doc|readme)\b/i.test(question) ||
        /\bin (my|the) (folder|projects?|second brain|brain|os)\b/i.test(question)
      )) {
        await brainDo(question, token); return;
      }

      // Manus: hand a whole task to the autonomous agent ("Manus, plan my launch", "use Manus to…").
      if (toolKey("manus") && /\bmanus\b/i.test(question)) {
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        setStateSafe("responding"); setAiReply("Handing it to Manus...");
        const task = question.replace(/\b(hey\s+)?manus\b[,:]?\s*/i, "").trim() || question;
        const out = await runManus(task);
        if (looksLikeUrl(out)) { try { await invoke("open_url", { url: out! }); } catch { /* ignore */ } await sayAndClose("Manus is on it. I opened the task so you can watch it work.", token); }
        else await sayAndClose(`I couldn't start the Manus task. ${(out || "").slice(0, 120)}`, token);
        return;
      }

      // A specific agent called by name ("Sirius, research X", "ask Rigel to write it") → run just that orb.
      const namedAgent = detectNamedAgent(question);
      if (namedAgent && localStorage.getItem("keak_cu_provider")) {
        await runAgents(namedAgent.task, token, namedAgent.agent);
        return;
      }

      // Agents FIRST: a "use your team to…" / multi-part "research X and build Y" job → delegate to named
      // star agents on the user's own AI. Checked before the screen agent so "search … and …" phrasing
      // isn't stolen by computer-use. Agents always run on the connected provider, never Keak's credits.
      const agentJob = parseAgentJob(question);
      console.log("[KEAK] agentJob:", JSON.stringify(agentJob), "provider:", localStorage.getItem("keak_cu_provider"));
      if (agentJob && localStorage.getItem("keak_cu_provider")) {
        await runAgents(agentJob, token);
        return;
      }

      // Google Calendar via the API wins over screen control when Google is connected — do it invisibly.
      if (await tryGoogleCalendar(question, token)) return;

      const cuGoal = parseComputerTask(question);
      if (cuGoal && localStorage.getItem("keak_cu_provider")) {
        await runComputerTask(cuGoal);
        return;
      }

      // Voice model switch: "change the model to Sonnet", "switch to ChatGPT", "set effort to high" —
      // flip the connected AI's provider/model, confirm out loud. Same keys the Connect picker writes.
      const modelMsg = parseModelSwitch(question);
      if (modelMsg) {
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: modelMsg });
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(modelMsg); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 12000);
        try { await speakReply(modelMsg, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(8000); }
        return;
      }

      // Voice personality tuning: "be funnier", "less formal", "set humor to 80" — move the dial + confirm.
      const personaMsg = adjustPersonaFromSpeech(question);
      if (personaMsg) {
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: personaMsg });
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(personaMsg); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 12000);
        try { await speakReply(personaMsg, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(8000); }
        return;
      }

      // Control the agent orbs by voice ("make them move in circles", "follow my mouse", "stay still",
      // "gather", "Sirius follow my cursor", "hide the names"). Checked before settings because these mention
      // "agents". The orbs keep animating until the user dismisses Keak AI, so we don't auto-close here.
      const vizMsg = localStorage.getItem("keak_cu_provider") ? await parseVizCommand(question) : null;
      if (vizMsg) {
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: vizMsg });
        setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(vizMsg); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 12000);
        try { await speakReply(vizMsg, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); }
        return;
      }

      // Any other settings command by voice: change the voice source, create a new agent, edit an existing
      // one, or any dial/model phrasing the fast parsers above missed. The connected AI turns it into one
      // structured action and Keak applies it deterministically, then confirms out loud.
      const settingsMsg = localStorage.getItem("keak_cu_provider") ? await parseAndApplySettings(question) : null;
      if (settingsMsg) {
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: settingsMsg });
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(settingsMsg); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 12000);
        try { await speakReply(settingsMsg, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(8000); }
        return;
      }

      // Schedule a routine by voice: "every day at 5am research my competitors and email me a summary",
      // "remind me tomorrow at 9am to…". Keak turns it into a saved routine that fires at its time.
      const routineMsg = localStorage.getItem("keak_cu_provider") ? await parseRoutineCommand(question) : null;
      if (routineMsg) {
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: routineMsg });
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(routineMsg); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 12000);
        try { await speakReply(routineMsg, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(8000); }
        return;
      }

      // "Message me on Telegram" right now. After the routine handler so "every day message me…"
      // still becomes a scheduled routine; this catches the one-off "send me a telegram saying hi".
      if (!looksLikeRoutineCommand(question) && looksLikeSendMessage(question)) {
        if (await sendMessageMe(question, token)) return;
      }
      // Local calendar handler: open a PREFILLED Google Calendar event (title + day always filled) via
      // the Browser Bridge. Deterministic, so it never opens a blank calendar link.
      const mode = actionMode();
      const calEv = mode === "off" ? null : parseCalendarEvent(question);
      console.log("[KEAK v1.2] calendar match:", calEv, "mode:", mode);
      if (calEv) {
        // Google or Microsoft connected → create it directly on the real calendar, no browser tab, no Save click.
        if (localStorage.getItem("keak_google_refresh") || msConnected()) {
          const whenG = calEv.start.toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
          const link = await createEventAnyProvider(calEv);
          if (link) {
            const spoken = cleanReply(`Done, I added ${calEv.title} to your calendar for ${whenG}.`);
            historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: spoken });
            let shownG = false; const showG = () => { if (shownG) return; shownG = true; setAiReply(spoken); setStateSafe("idle"); };
            const safetyG = window.setTimeout(showG, 15000);
            try { await speakReply(spoken, token, () => { clearTimeout(safetyG); showG(); }); }
            finally { clearTimeout(safetyG); showG(); if (stateRef.current === "idle") scheduleAssistantClose(10000); }
            return;
          }
          // couldn't create via API → fall back to the prefilled browser link below
        }
        const url = buildCalendarUrl(calEv);
        const when = calEv.start.toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
        // open_url opens the prefilled event in the default browser (new tab), so it works even if the
        // Browser Bridge extension isn't connected and doesn't hijack the tab the user is on.
        try {
          await invoke("open_url", { url });
        } catch {
          setAiReply("Couldn't open the calendar. Try again.");
          setStateSafe("idle"); scheduleAssistantClose(9000); return;
        }
        // Full access = finish the job: give the prefilled page time to render, then click Save
        // in the browser via the Bridge (Spanish "Guardar" or English "Save").
        let saved = false;
        if (mode === "full") {
          await new Promise((r) => setTimeout(r, 2600));
          for (const label of ["Guardar", "Save"]) {
            try { await invoke("send_browser_command", { command: JSON.stringify({ id: Date.now(), type: "click", text: label }) }); }
            catch { break; }
            const rr = await waitForBrowserResult(1400);
            if (rr?.success) { saved = true; break; }
          }
        }
        const spoken = cleanReply(
          saved
            ? `Done, I saved a calendar event, ${calEv.title}, for ${when}.`
            : `Opening a calendar event, ${calEv.title}, for ${when}. Just hit save.`
        );
        historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: spoken });
        let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(spoken); setStateSafe("idle"); };
        const safety = window.setTimeout(show, 15000);
        try { await speakReply(spoken, token, () => { clearTimeout(safety); show(); }); }
        finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(10000); }
        return;
      }

      // Gmail / Drive (Google) or Outlook Mail / OneDrive (Microsoft) via the API when connected.
      // Reading the inbox is Google-only (Microsoft is send-only via Mail.Send). Send + save work on either.
      if (localStorage.getItem("keak_google_refresh")) {
        if (parseGmailRead(question)) { await readGmail(token); return; }
      }
      if (localStorage.getItem("keak_google_refresh") || msConnected()) {
        const gsend = parseGmailSend(question);
        if (gsend) { await sendGmail(gsend, token); return; }
        if (parseSaveToDrive(question)) { await saveLastToDrive(token); return; }
      }

      // Local "reply to this email/message" handler.
      const wantsReply = mode !== "off" && (/\b(reply|respond)\b/i.test(question) || /\b(responde|contesta|responder)\b/i.test(question));
      const emailish = /\b(email|e-?mail|message|correo|mensaje|this|that|it|esto|eso)\b/i.test(question);
      console.log("[KEAK v1.2] reply match:", wantsReply && emailish);
      if (wantsReply && emailish) { await replyToEmailLocally(question, token); return; }

      // Action catch-all: if it's clearly an imperative that needs the screen or a tool (open YouTube, create
      // a folder, book a slot, make a doc) and we didn't already route it, DO it via screen control instead of
      // answering "I can't". Ask/Full/Off still applies (Ask asks first). Vision questions are left to answer.
      if (!image && localStorage.getItem("keak_cu_provider") && mode !== "off" && looksLikeAction(question)) {
        await runComputerTask(question);
        return;
      }

      // Keak AI answers on the user's OWN connected AI. If their AI errors, SHOW it (don't silently burn
      // Keak's Gemini). Screen-vision questions still use the hosted path for now.
      if (!image && localStorage.getItem("keak_cu_provider") && localStorage.getItem("keak_ai_use_own") !== "0") {
        const r = await answerWithOwnAI(question, token);
        if (r.answered) return;
        if (r.error) {
          const friendly = /\b429\b|rate.?limit/i.test(r.error)
            ? "Your AI is rate-limited right now. Give it a minute and try again."
            : /\b401\b|unauthor|invalid/i.test(r.error)
            ? "Your AI login expired. Reconnect it in Connect your AI."
            : `Your AI couldn't answer: ${r.error}`;
          setAiReply(friendly);
          setStateSafe("idle"); scheduleAssistantClose(13000); return;
        }
        // no credential resolved → fall through to the plan gate below
      }
      // Hosted Keak AI (our Gemini) is ONLY for paid plans — free users must connect their own AI so
      // they never spend Keak's credits.
      if (!["starter", "pro", "team"].includes(localStorage.getItem("keak_plan") || "free")) {
        setAiReply("Connect your own AI in Keak settings to use Keak AI, or upgrade to Pro.");
        setStateSafe("idle"); scheduleAssistantClose(12000); return;
      }

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
          // Personality dials (0-100) so the hosted keak-assistant function can match the same tone.
          persona: {
            humor: parseInt(localStorage.getItem("keak_humor") || "20", 10),
            warmth: parseInt(localStorage.getItem("keak_warmth") || "50", 10),
            formality: parseInt(localStorage.getItem("keak_formality") || "30", 10),
            directness: parseInt(localStorage.getItem("keak_directness") || "50", 10),
          },
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
  // Ask-mode start confirmation for the screen agent (resolves when the user taps Start/Cancel).
  function askCuStart(goal: string): Promise<boolean> {
    setCuConfirmGoal(goal);
    return new Promise((res) => { cuConfirmResolveRef.current = res; });
  }
  function resolveCuStart(v: boolean) {
    setCuConfirmGoal(null);
    const r = cuConfirmResolveRef.current;
    cuConfirmResolveRef.current = null;
    r?.(v);
  }

  // Global Esc = panic-stop the screen agent (works whenever the overlay has focus, e.g. between steps).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && cuActiveRef.current) { cuAbortRef.current = true; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Telegram bridge: poll the bot when a token is set, answer each message, reply to the phone. The first
  // chat to message the bot gets bound as the owner, so strangers can't drive the computer.
  useEffect(() => {
    let alive = true; let offset = 0; let timer: number | undefined;
    async function loop() {
      const tk = localStorage.getItem("keak_telegram_token") || "";
      if (tk) {
        try {
          const raw = await invoke<string>("telegram_poll", { args: { token: tk, offset } });
          const data = JSON.parse(raw);
          if (data.ok && Array.isArray(data.result)) {
            for (const upd of data.result) {
              offset = Math.max(offset, (upd.update_id || 0) + 1);
              const msg = upd.message; const chatId = msg?.chat?.id; let textIn = msg?.text;
              // Voice notes: download the OGG from Telegram, decode it to WAV, transcribe it, and use it as the
              // message text. If it can't be understood, reply so the user isn't left with silence.
              if (!textIn && (msg?.voice?.file_id || msg?.audio?.file_id) && chatId) {
                const fileId = msg?.voice?.file_id || msg?.audio?.file_id;
                try {
                  const b64 = await invoke<string>("telegram_get_voice", { args: { token: tk, fileId } });
                  if (b64) {
                    // Refresh the token first — an expired session (~1h) is the #1 reason a voice note silently
                    // fails while a typed message works (typed text never hits transcribe).
                    let sess = getSession();
                    if (sess) sess = await ensureFreshSession(sess);
                    const lang = localStorage.getItem("keak_language");
                    const doTranscribe = async (blob: Blob, name: string): Promise<string> => {
                      const form = new FormData();
                      form.append("file", blob, name);
                      if (lang && lang !== "auto") form.append("language", lang);
                      const rr = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, { method: "POST", headers: { Authorization: `Bearer ${sess?.access_token || ""}` }, body: form });
                      const dd = await rr.json().catch(() => ({} as { text?: string }));
                      return dd.text ? String(dd.text).trim() : "";
                    };
                    // Telegram voice notes are OGG/Opus and Whisper accepts them directly, so send the raw bytes
                    // (exactly like dictation sends raw webm). No fragile in-webview decode on the happy path.
                    try { textIn = await doTranscribe(b64ToBlob(b64, "audio/ogg"), "voice.ogg"); } catch { /* try the wav fallback */ }
                    // Only if the raw upload comes back empty, decode to WAV in-app and retry once.
                    if (!textIn) { const wav = await oggB64ToWav(b64); if (wav) { try { textIn = await doTranscribe(wav, "voice.wav"); } catch { /* ignore */ } } }
                  }
                } catch { /* fall through to the failure reply below */ }
                if (!textIn) {
                  try { await invoke("telegram_send", { args: { token: tk, chatId: String(chatId), text: "I couldn't understand that voice note. Try again or type it." } }); } catch { /* ignore */ }
                  continue;
                }
              }
              if (!chatId || !textIn) continue;
              const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
              if (isGroup) {
                // TEAM GROUP: my Keak only acts on messages that address ME by name ("Pep, do X"), and never on
                // another bot's post (so the teammates' Keaks don't react to each other's results). Everyone in
                // the group sees the task and the reply. The first group the bot is added to becomes the team room.
                if (msg?.from?.is_bot) continue;
                let grp = localStorage.getItem("keak_team_group") || "";
                if (!grp) { grp = String(chatId); localStorage.setItem("keak_team_group", grp); }
                if (String(chatId) !== grp) continue;
                const myName = (localStorage.getItem("keak_team_name") || localStorage.getItem("keak_user_name") || "").trim();
                if (!myName) continue;
                const esc = myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const m = textIn.match(new RegExp("^\\s*@?" + esc + "\\b[\\s,:]+([\\s\\S]+)$", "i"));
                if (!m || !m[1].trim()) continue; // not addressed to me
                const task = m[1].trim();
                const fromName = msg?.from?.first_name || msg?.from?.username || "A teammate";
                let out = "";
                try { out = await answerForTeam(task, fromName); } catch (e) { out = `Error: ${String(e).slice(0, 140)}`; }
                pushTeamLog({ ts: Date.now(), dir: "in-task", who: fromName, body: task, result: out });
                try { await invoke("telegram_send", { args: { token: tk, chatId: String(chatId), text: `${myName}: ${out}`.slice(0, 3900) } }); } catch { /* ignore */ }
                continue;
              }
              let owner = localStorage.getItem("keak_telegram_chat") || "";
              if (!owner) { owner = String(chatId); localStorage.setItem("keak_telegram_chat", owner); }
              if (String(chatId) !== owner) continue; // only the linked phone
              let reply = "";
              // Let the phone know Keak is working on anything slow (search, research, an agent step), so you
              // never sit in silence wondering if it heard you. The final answer follows when it's ready.
              const notify = (m: string) => { invoke("telegram_send", { args: { token: tk, chatId: String(chatId), text: m } }).catch(() => { /* ignore */ }); };
              try { reply = await answerForTelegram(textIn, notify); } catch (e) { reply = `Error: ${String(e).slice(0, 140)}`; }
              try { await invoke("telegram_send", { args: { token: tk, chatId: String(chatId), text: (reply || "Done.").slice(0, 3900) } }); } catch { /* ignore */ }
            }
          }
        } catch { /* transient network — keep polling */ }
      }
      if (alive) timer = window.setTimeout(loop, tk ? 2500 : 8000);
    }
    loop();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Routine scheduler: every ~30s, fire any routine whose time has come. Runs while Keak is alive (it stays in
  // the tray when the window is closed). The first pass also catches up a one-time routine whose moment passed
  // while Keak was shut. We mark lastRun BEFORE running so a routine can't double-fire within its minute.
  useEffect(() => {
    let alive = true; let timer: number | undefined; let firstPass = true;
    const tick = async () => {
      try {
        // "Run now" from the Connect window: it drops a routine id here for us to fire immediately.
        const runNow = localStorage.getItem("keak_routine_run_now");
        if (runNow) {
          localStorage.removeItem("keak_routine_run_now");
          const r = readRoutines().find((x) => x.id === runNow);
          if (r) await runRoutine(r);
        }
        const now = new Date();
        for (const r of readRoutines()) {
          if (!r.enabled) continue;
          let due = isRoutineDue(r, now);
          if (!due && firstPass && r.freq === "once" && !r.lastRun && r.onceDate && now.getTime() >= new Date(r.onceDate).getTime()) due = true;
          if (!due) continue;
          setRoutineRun(r.id, Date.now(), undefined, r.freq === "once" ? false : undefined);
          await runRoutine(r);
        }
      } catch { /* ignore a bad tick, keep scheduling */ }
      firstPass = false;
      if (alive) timer = window.setTimeout(tick, 30000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The screen-agent loop: screenshot -> ask the connected AI for the next action -> do it natively -> repeat.
  async function runComputerTask(goal: string) {
    cancelAssistantClose();
    const provider = localStorage.getItem("keak_cu_provider") || "";
    let credential = "", accountId = "", isSub = false;
    if (provider === "openai") {
      const sub = localStorage.getItem("keak_cu_openai_token") || "";
      if (sub) { credential = sub; accountId = localStorage.getItem("keak_cu_openai_account") || ""; isSub = true; }
      else credential = localStorage.getItem("keak_cu_openai_key") || "";
    } else if (provider === "gemini") {
      credential = localStorage.getItem("keak_cu_gemini_key") || "";
    } else if (provider === "claude") {
      credential = localStorage.getItem("keak_cu_claude_token") || "";
    } else if (provider === "ollama") {
      credential = "local"; // no key; the model name carries the config
    }
    // The user's chosen model for this provider (e.g. claude-opus-4-8). Empty = provider default.
    const cuModel = cleanModel(provider, localStorage.getItem(`keak_cu_${provider}_model`) || "");
    const cuEffort = provider === "claude" ? (localStorage.getItem("keak_cu_claude_effort") || "") : "";
    if (!provider || !credential) {
      setAiReply("Connect your AI first — open Keak settings and set up Connect your AI.");
      setStateSafe("idle"); scheduleAssistantClose(10000); return;
    }
    const mode = actionMode();
    if (mode === "off") {
      setAiReply("Screen actions are off. Turn them on in settings to let me do this.");
      setStateSafe("idle"); scheduleAssistantClose(10000); return;
    }
    if (mode === "ask") {
      const ok = await askCuStart(goal);
      if (!ok) { setAiReply("Okay, I won't touch your screen."); setStateSafe("idle"); scheduleAssistantClose(8000); return; }
    }

    cuAbortRef.current = false;
    cuActiveRef.current = true; setCuActive(true);
    setStateSafe("responding");
    const history: string[] = [];
    const MAX_STEPS = 10;
    let finished = false;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (cuAbortRef.current) break;
        let shot: { b64: string; shot_w: number; shot_h: number; real_w: number; real_h: number; off_x: number; off_y: number };
        try { shot = JSON.parse(await invoke<string>("capture_screen_full")); }
        catch { setAiReply("I couldn't capture your screen."); break; }
        if (cuAbortRef.current) break;
        let actionRaw: string;
        try {
          actionRaw = await invoke<string>("cu_step", { args: {
            provider, credential, accountId, isSubscription: isSub, model: cuModel, effort: cuEffort,
            goal, screenshotB64: shot.b64, shotW: shot.shot_w, shotH: shot.shot_h,
            history: history.slice(-8).join(" -> "),
          } });
        } catch (e) { setAiReply(`Screen agent stopped: ${String(e).slice(0, 140)}. To control the screen I need a vision model — connect Claude, GPT-4o, Gemini, or a vision Ollama model in Keak settings.`); break; }
        if (cuAbortRef.current) break;
        let act: { action?: string; x?: number; y?: number; text?: string; key?: string; amount?: number; say?: string };
        // A non-JSON reply almost always means the connected model can't see the screenshot (text-only model).
        try { act = JSON.parse(actionRaw); } catch { setAiReply("I couldn't read the screen with the model you have connected. Screen control needs a vision model — connect Claude, GPT-4o, Gemini, or a vision Ollama model, then try again."); break; }
        const say = act.say || "";
        if (say && localStorage.getItem("keak_show_captions") !== "0") setAiReply(say);
        if (act.action === "done") { finished = true; break; }

        // Map model coordinates (in the downscaled screenshot) back to real screen pixels.
        const sx = shot.real_w / Math.max(1, shot.shot_w);
        const sy = shot.real_h / Math.max(1, shot.shot_h);
        const rx = Math.round((act.x || 0) * sx) + shot.off_x;
        const ry = Math.round((act.y || 0) * sy) + shot.off_y;
        try {
          if (act.action === "click") await invoke("mouse_click", { x: rx, y: ry });
          else if (act.action === "double_click") await invoke("mouse_click", { x: rx, y: ry, double: true });
          else if (act.action === "right_click") await invoke("mouse_click", { x: rx, y: ry, button: "right" });
          else if (act.action === "type") await invoke("type_text", { text: act.text || "" });
          else if (act.action === "key") await invoke("press_key", { combo: act.key || "enter" });
          else if (act.action === "scroll") await invoke("mouse_scroll", { amount: act.amount || 5 });
          else if (act.action === "wait") await new Promise((r) => setTimeout(r, 800));
        } catch (e) { setAiReply(`That action failed: ${String(e).slice(0, 100)}`); break; }
        history.push(`${act.action}${act.x != null ? `(${act.x},${act.y})` : ""}`);
        await new Promise((r) => setTimeout(r, 750)); // let the screen settle before the next shot
      }
    } finally {
      cuActiveRef.current = false; setCuActive(false);
    }
    const done = cuAbortRef.current ? "Stopped." : finished ? "Done." : "I did what I could — take a look at the screen.";
    historyRef.current.push({ role: "user", text: goal }, { role: "assistant", text: done });
    if (localStorage.getItem("keak_show_captions") !== "0") setAiReply(done);
    setStateSafe("idle"); scheduleAssistantClose(9000);
  }

  // Build Keak AI's system prompt (persona, agent team, web ability, language, Second Brain context, Memory).
  // Shared by the classic cu_chat path AND the live voice session so live Keak knows the user just the same.
  async function buildAssistantSystem(): Promise<string> {
    const activeAg = activeAgentRef.current; // set when the user woke an agent by name ("Hey Nova")
    const assistantName = activeAg ? activeAg.name : (localStorage.getItem("keak_assistant_name") || "Keak");
    const agentLine = activeAg ? ` You are speaking AS the agent "${activeAg.name}"${activeAg.description ? `, ${activeAg.description}` : ""}. Stay fully in that role and answer as ${activeAg.name}.${activeAg.personality ? ` Your tone: ${activeAg.personality}.` : ""}` : "";
    const webLine = toolKey("perplexity")
      ? " You CAN search the live web yourself when asked about current, online, or news topics, so never tell the user you cannot browse the internet."
      : " You cannot browse the live web right now. If the user asks for current or online info, tell them to enable web search by connecting Perplexity in Keak settings (Connect your AI, then Tools). Do NOT say an agent will do the search for you.";
    const userName = localStorage.getItem("keak_user_name") || "there";
    const team = [...effectiveDefaults(), ...readAgentRoster()];
    const teamInfo = team.map((a) => `${a.name} (${a.description || "general help"})`).join("; ");
    const brainCtx = await getBrainContext();
    const UILN: Record<string, string> = { es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian", en: "English" };
    const uiCode = localStorage.getItem("keak_ui_lang") || "en";
    const langLine = uiCode !== "en" && UILN[uiCode] ? ` Always reply in ${UILN[uiCode]} unless the user clearly writes to you in another language, then reply in that language.` : "";
    return `You are ${assistantName}, a friendly voice assistant talking to ${userName}. Your reply is read ALOUD, so keep it concise and spoken, usually 1 to 3 sentences. Plain text only, no markdown. When the user explicitly asks you to list something (like your agents), you may give a short plain list. You have a team of ${team.length} agents the user can call on: ${teamInfo}. If asked about your agents or team, tell them how many there are and their names and roles from that list, do NOT say you have no access. To put them to work, the user says "use your team to..." or calls one by name, like "Sirius, research X".${webLine}${agentLine}${langLine} ${personaLines()}${brainCtx ? `\n\nContext about ${userName} from their Second Brain (use it to be accurate and personal; never read it aloud verbatim):\n${brainCtx}` : ""}${memoryBlock()}`;
  }

  // A LEAN system prompt for the LIVE voice: the live model reads the whole prompt before it can start
  // talking, so a big one makes the first word slow. Keep just persona + language + Memory + a short slice of
  // the Second Brain, and drop the heavy agent roster / web boilerplate (live can't call tools anyway).
  async function buildLiveSystem(): Promise<string> {
    const activeAg = activeAgentRef.current;
    const assistantName = activeAg ? activeAg.name : (localStorage.getItem("keak_assistant_name") || "Keak");
    const userName = localStorage.getItem("keak_user_name") || "there";
    const persona = activeAg?.personality ? ` Your tone: ${activeAg.personality}.` : "";
    const UILN: Record<string, string> = { es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian", en: "English" };
    const uiCode = localStorage.getItem("keak_ui_lang") || "en";
    const langLine = uiCode !== "en" && UILN[uiCode] ? ` Reply in ${UILN[uiCode]} unless the user clearly speaks another language.` : "";
    let ctx = "";
    try { const b = await getBrainContext(); if (b) ctx = `\n\nAbout ${userName} (use to be personal, never read aloud): ${b.slice(0, 700)}`; } catch { /* ignore */ }
    const mem = memoryBlock();
    const searchLine = localStorage.getItem("keak_brain_path") ? " If the user asks about their own notes, projects, people, or anything you are not sure of, call the search_second_brain tool to look it up before answering." : "";
    // The live model must ACT, not just talk. Tell it exactly which tools do real work so it calls them instead
    // of describing what it would do. do_task is the catch-all that runs the full assistant (screen, apps, agents).
    const actLine = " You are not just a chatbot, you can take real actions with your tools. When the user asks you to DO something, actually call the tool instead of only talking about it: schedule_routine to schedule or set reminders, create_calendar_event to add calendar events, web_search for anything current or unknown, and do_task for anything that needs the computer, an app, their connected tools, their agents, email, or creating things (like finding and using an app to make images). Never say you can't do something, use do_task. After a tool runs, tell the user in one short sentence what you did.";
    const teamRoster = [...effectiveDefaults(), ...readAgentRoster()];
    const teamShort = teamRoster.length ? ` Your team of agents: ${teamRoster.map((a) => a.name).join(", ")}. Use do_task to put them to work, or the user can call one by name.` : "";
    return `You are ${assistantName}, ${userName}'s voice assistant, in a live spoken conversation. Reply in one or two short spoken sentences, warm and quick, plain text, no markdown.${actLine}${teamShort}${searchLine}${langLine}${persona} ${personaLines()}${ctx}${mem ? mem.slice(0, 700) : ""}`;
  }

  // Start a REAL live Keak AI turn (Gemini Live / OpenAI Realtime): open the session, stream the mic, and
  // play Keak's spoken reply the instant you stop. Called from startRecording when the turn is a Keak AI
  // turn and a live-capable provider is connected. `mode` = "ptt" (Ctrl+Alt / orb) or "handsfree" (wake).
  async function startLiveTurn(mode: LiveMode) {
    const info = liveInfo();
    if (!info) return false;
    cancelAssistantClose();
    setLiveText("");
    liveActiveRef.current = true;          // claim active now so a fast release routes to finishTurn
    liveFinishPendingRef.current = false;
    const instructions = await buildLiveSystem(); // lean prompt = faster first word
    const brainRoot = localStorage.getItem("keak_brain_path") || "";
    // do_task hands the whole request to the full assistant engine (screen control, agents, email, apps,
    // creating things) after this live turn. Guarded so it only fires once.
    let handedOff = false;
    const runHandoff = async (request: string, image?: string) => {
      if (handedOff) return; handedOff = true;
      let s = getSession(); if (s) s = await ensureFreshSession(s);
      const tok = s?.access_token || "";
      try { liveRef.current?.close(); } catch { /* noop */ }
      liveActiveRef.current = false;
      cancelAssistantClose();
      await runAssistant(request, tok, image);
    };
    const session = new LiveKeak(mode, info.provider, info.apiKey, instructions, {
      // The live model can call tools mid-conversation to actually DO things. Each returns a short string that
      // the model then speaks. Kept in sync with KEAK_TOOLS in liveKeak.ts.
      onToolCall: async (name, args) => {
        const A = (args || {}) as Record<string, unknown>;
        const capOn = localStorage.getItem("keak_show_captions") !== "0";
        try {
          if (name === "search_second_brain") {
            if (!brainRoot) return "No Second Brain folder is connected, so I can't search it.";
            const q = String(A.query || "").trim();
            if (capOn) setAiReply(`Searching your Second Brain for "${q}"...`);
            const raw = await invoke<string>("sb_search", { args: { root: brainRoot, query: q, maxResults: 8 } });
            const hits = JSON.parse(raw || "[]") as Array<{ path?: string; snippet?: string }>;
            if (!Array.isArray(hits) || !hits.length) return `Nothing found in the Second Brain about "${q}".`;
            return hits.slice(0, 8).map((h) => `${h.path || ""}: ${h.snippet || ""}`).join("\n").slice(0, 3000);
          }
          if (name === "web_search") {
            const q = String(A.query || "").trim();
            if (capOn) setAiReply(`Searching the web for "${q}"...`);
            const a = await askPerplexity(q) || await askTavily(q);
            return a ? a.slice(0, 3000) : "Web search isn't connected. Add a Perplexity or Tavily key under AI tools to enable it.";
          }
          if (name === "schedule_routine") {
            const req = String(A.request || "").trim();
            if (capOn) setAiReply("Setting up that routine...");
            const msg = await parseRoutineCommand(req, true);
            return msg || "I couldn't set that up. Tell me when it should run and what it should do.";
          }
          if (name === "create_calendar_event") {
            const title = String(A.title || "").trim() || "Event";
            const start = new Date(String(A.start_iso || ""));
            if (isNaN(start.getTime())) return "I need a valid date and time for the event.";
            const end = A.end_iso && !isNaN(new Date(String(A.end_iso)).getTime()) ? new Date(String(A.end_iso)) : new Date(start.getTime() + 60 * 60 * 1000);
            const ev = { title, start, end };
            const whenTxt = start.toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
            if (capOn) setAiReply(`Adding ${title} to your calendar...`);
            if (localStorage.getItem("keak_google_refresh") || msConnected()) {
              const link = await createEventAnyProvider(ev);
              if (link) return `Added "${title}" to the calendar for ${whenTxt}.`;
            }
            try { await invoke("open_url", { url: buildCalendarUrl(ev) }); return `Opened a prefilled calendar event, "${title}", for ${whenTxt}. Ask the user to hit save.`; }
            catch { return "I couldn't open the calendar."; }
          }
          if (name === "do_task") {
            const req = String(A.request || "").trim();
            let shot = "";
            try { shot = await invoke<string>("capture_screen"); } catch { /* ignore */ }
            setTimeout(() => { void runHandoff(req, shot || undefined); }, 40);
            return "On it, doing that now.";
          }
        } catch (e) { return "That didn't work: " + String(e).slice(0, 120); }
        return "Unknown tool.";
      },
      onListening: () => { setStateSafe("recording"); }, // listening again for your reply (conversation)
      onResponding: () => { setStateSafe("responding"); },
      onKeakText: (t) => { if (localStorage.getItem("keak_show_captions") !== "0") setAiReply(t); },
      onDone: (userText, keakText) => {
        // One turn finished. In conversation mode the session keeps listening, so just record the turn here;
        // the panel/state cleanup happens in onClosed when the whole conversation ends.
        if (keakText) {
          historyRef.current.push({ role: "user", text: userText || "(spoken)" }, { role: "assistant", text: keakText });
          void captureMemories(userText || "", keakText); // Keak Memory learns from live turns too
        }
      },
      onClosed: () => {
        liveActiveRef.current = false;
        emitTo("orb", "orb-idle").catch(() => {});
        try { invoke("hide_agents"); } catch { /* ignore */ }
        setStateSafe("idle");
        scheduleAssistantClose(6000);
      },
      onError: (msg) => {
        liveActiveRef.current = false;
        setStateSafe("error"); setErrorMsg(msg);
        emitTo("orb", "orb-idle").catch(() => {});
        scheduleAssistantClose(6000);
      },
    }, true); // conversation mode: keep the chat going without pressing Ctrl+Alt again
    liveRef.current = session;
    setStateSafe("recording");
    try { await invoke("show_agents"); } catch { /* ignore */ }
    await session.open();
    if (liveFinishPendingRef.current) { liveFinishPendingRef.current = false; session.finishTurn(); } // release came during setup
    return true;
  }

  // Answer a normal Keak AI question using the user's OWN connected model (via the Rust cu_chat brain).
  // Returns true if it answered, false to fall back to the hosted keak-assistant path.
  async function answerWithOwnAI(question: string, token: string): Promise<{ answered: boolean; error?: string }> {
    const provider = localStorage.getItem("keak_cu_provider") || "";
    let credential = "", accountId = "", isSub = false;
    if (provider === "openai") {
      const sub = localStorage.getItem("keak_cu_openai_token") || "";
      if (sub) { credential = sub; accountId = localStorage.getItem("keak_cu_openai_account") || ""; isSub = true; }
      else credential = localStorage.getItem("keak_cu_openai_key") || "";
    } else if (provider === "gemini") {
      credential = localStorage.getItem("keak_cu_gemini_key") || "";
    } else if (provider === "claude") {
      credential = localStorage.getItem("keak_cu_claude_token") || "";
    } else if (provider === "ollama") {
      credential = "local";
    } else if (provider === "copilot") {
      credential = localStorage.getItem("keak_cu_copilot_token") || "";
    } else {
      credential = localStorage.getItem(`keak_cu_${provider}_key`) || ""; // deepseek, mistral, xai
    }
    if (!credential) return { answered: false, error: `no ${provider} token found — reconnect in Connect your AI` };
    const chatModel = cleanModel(provider, localStorage.getItem(`keak_cu_${provider}_model`) || "");
    // Spoken chat doesn't need deep thinking — default Claude to low effort so it replies much faster (the
    // user can still raise it in Settings or by voice). This is the biggest speed win for Claude answers.
    const chatEffort = provider === "claude" ? (localStorage.getItem("keak_cu_claude_effort") || "low") : "";

    let system = await buildAssistantSystem();
    // If the user says "use the [skill name] skill", inject its content into the system prompt.
    const skillMatch = question.match(/\buse\s+(?:the\s+)?([a-zA-Z0-9 _-]+?)\s+skill\b/i);
    if (skillMatch) {
      const slug = skillMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
      let skillContent = localStorage.getItem(`keak_marketplace_skill_${slug}`) || "";
      if (!skillContent) {
        const root = localStorage.getItem("keak_brain_path") || "";
        if (root) { try { skillContent = await invoke<string>("sb_read", { args: { root, path: `AI/skills/${slug}/SKILL.md` } }); } catch { /* not found */ } }
      }
      if (skillContent) system += `\n\nThe user wants you to use the "${slug}" skill. Follow its instructions:\n${skillContent.slice(0, 6000)}`;
    }
    // Claude requires messages that start with "user" and strictly alternate. Trim any leading assistant
    // turn and trailing user turn from recent history before we append the new question, or Claude 400s.
    let hist = historyRef.current.slice(-4); // fewer turns = fewer tokens = it starts answering sooner
    while (hist.length && hist[0].role === "assistant") hist = hist.slice(1);
    while (hist.length && hist[hist.length - 1].role === "user") hist = hist.slice(0, -1);
    const history = hist.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.text }));
    let reply = "";
    const callChat = (m: string) => invoke<string>("cu_chat", { args: { provider, credential, accountId, isSubscription: isSub, model: m, effort: chatEffort, system, history, message: question } });
    // Free local model, used automatically if the connected AI runs out of usage or its login expires.
    const localModel = localFallbackModel();
    const callLocal = () => invoke<string>("cu_chat", { args: { provider: "ollama", credential: "local", accountId: "", isSubscription: false, model: localModel, effort: "", system, history, message: question } });
    let usedLocal = false;
    try {
      reply = await callChat(chatModel);
    } catch (e) {
      const msg = String(e);
      // Claude's subscription throttles Opus/Sonnet far harder than Haiku. On a rate-limit, auto-retry on
      // Haiku so even a basic question still gets answered instead of failing.
      if (/\b429\b|rate.?limit/i.test(msg) && provider === "claude" && !chatModel.includes("haiku")) {
        try { reply = await callChat("claude-haiku-4-5"); }
        catch (e2) {
          if (localModel && isExhaustedOrExpired(String(e2))) {
            try { reply = await callLocal(); usedLocal = true; } catch { return { answered: false, error: String(e2).slice(0, 180) }; }
          } else return { answered: false, error: String(e2).slice(0, 180) };
        }
      } else if (provider !== "ollama" && localModel && isExhaustedOrExpired(msg)) {
        // Out of credits / quota, or the login expired → keep working on the free local model.
        console.log("[KEAK] Keak AI provider out/expired, switching to local model:", msg.slice(0, 120));
        try { reply = await callLocal(); usedLocal = true; } catch { return { answered: false, error: msg.slice(0, 180) }; }
      } else {
        return { answered: false, error: msg.slice(0, 180) };
      }
    }
    // Let the user know it quietly switched, so a change in answer quality isn't a mystery.
    if (usedLocal) { try { emitTo("connect", "keak-toast", { text: "Your AI ran out, so I switched to your local model." }).catch(() => {}); } catch { /* noop */ } }
    reply = cleanReply(reply || "");
    if (!reply) return { answered: false, error: "your AI returned an empty reply" };
    historyRef.current.push({ role: "user", text: question }, { role: "assistant", text: reply });
    // Keak Memory: quietly remember durable facts from this exchange (opt-in, best-effort, non-blocking).
    void captureMemories(question, reply);
    // Substantial answers Keak AI makes also land in the Work log (not just agent runs).
    if (reply.length > 160) {
      try {
        const prev = JSON.parse(localStorage.getItem("keak_agent_history") || "[]");
        const h = Array.isArray(prev) ? prev : [];
        h.unshift({ ts: Date.now(), job: question, results: [{ name: "Keak AI", title: "Answer", output: reply, color: "#C68B7E" }] });
        localStorage.setItem("keak_agent_history", JSON.stringify(h.slice(0, 20)));
      } catch { /* ignore */ }
    }
    let shown = false;
    const show = () => { if (shown) return; shown = true; setAiReply(reply); setStateSafe("idle"); };
    const safety = window.setTimeout(show, 15000);
    try { await speakReply(reply, token, () => { clearTimeout(safety); show(); }); }
    finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(12000); }
    return { answered: true };
  }

  // Just SHOW the whole team on screen (no work). Lights up an orb for every agent, names them out loud.
  async function showAllAgents(token: string) {
    const all = allAgents();
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setShowAgentPanel(false); setAgentResults([]);
    setStateSafe("responding");
    writeAgentState(all.map((a) => ({ name: a.name, status: "working", color: a.color })));
    try { await invoke("show_agents"); } catch (e) { console.log("[KEAK] show_agents failed:", String(e)); }
    // Settle them after a beat so they drift calmly, and keep them on screen a while.
    window.setTimeout(() => all.forEach((a) => updateAgentStatus(a.name, "done")), 1600);
    window.setTimeout(() => { try { invoke("hide_agents"); } catch { /* ignore */ } writeAgentState([]); }, 9000);
    const names = all.map((a) => a.name);
    const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "no one yet";
    const summary = cleanReply(`Here's the whole team: ${who}. ${all.length} agents ready.`);
    historyRef.current.push({ role: "user", text: "show me the agents" }, { role: "assistant", text: summary });
    let shown = false;
    const show = () => { if (shown) return; shown = true; setAiReply(summary); setStateSafe("idle"); };
    const safety = window.setTimeout(show, 12000);
    try { await speakReply(summary, token, () => { clearTimeout(safety); show(); }); }
    finally { clearTimeout(safety); show(); scheduleAssistantClose(11000); }
  }

  // Speak a short reply + close (shared by the Gmail/Drive handlers).
  async function sayAndClose(spoken: string, token: string, closeMs = 11000) {
    const line = cleanReply(spoken);
    historyRef.current.push({ role: "assistant", text: line });
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    let shown = false; const show = () => { if (shown) return; shown = true; setAiReply(line); setStateSafe("idle"); };
    const safety = window.setTimeout(show, 15000);
    try { await speakReply(line, token, () => { clearTimeout(safety); show(); }); }
    finally { clearTimeout(safety); show(); if (stateRef.current === "idle") scheduleAssistantClose(closeMs); }
  }

  // Read the user's Gmail out loud (unread inbox, top few).
  async function readGmail(token: string) {
    setStateSafe("responding"); setAiReply("Checking your inbox...");
    const gtoken = await ensureGoogleToken();
    if (!gtoken) { await sayAndClose("Connect Google first in Keak settings to read your email.", token); return; }
    try {
      const raw = await invoke<string>("gmail_list", { args: { accessToken: gtoken, query: "in:inbox is:unread", max: 5 } });
      const msgs = JSON.parse(raw) as { from: string; subject: string; snippet: string }[];
      if (!Array.isArray(msgs) || msgs.length === 0) { await sayAndClose("Your inbox is clear, no unread emails.", token); return; }
      const nameOf = (from: string) => (from.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1]?.trim() || from.replace(/<.*>/, "").trim() || from;
      const lines = msgs.slice(0, 4).map((m) => `From ${nameOf(m.from)}: ${m.subject || "(no subject)"}.`);
      const spoken = `You have ${msgs.length} unread. ${lines.join(" ")}`;
      await sayAndClose(spoken, token, 16000);
    } catch (e) { await sayAndClose(`Couldn't read Gmail: ${String(e).slice(0, 120)}`, token); }
  }

  // Send an email via Gmail, or Outlook (Microsoft) when Google isn't connected.
  async function sendGmail(parsed: { to: string; subject: string; body: string }, token: string) {
    setStateSafe("responding"); setAiReply(`Sending an email to ${parsed.to}...`);
    const gtoken = localStorage.getItem("keak_google_refresh") ? await ensureGoogleToken() : null;
    if (gtoken) {
      try {
        await invoke("gmail_send", { args: { accessToken: gtoken, to: parsed.to, subject: parsed.subject, body: parsed.body, threadId: "" } });
        await sayAndClose(`Sent your email to ${parsed.to}.`, token);
      } catch (e) { await sayAndClose(`Couldn't send it: ${String(e).slice(0, 120)}`, token); }
      return;
    }
    if (msConnected()) {
      const mtoken = await ensureMsToken();
      if (!mtoken) { await sayAndClose("Connect Microsoft first to send email.", token); return; }
      try {
        await invoke("ms_mail_send", { args: { accessToken: mtoken, to: parsed.to, subject: parsed.subject, body: parsed.body } });
        await sayAndClose(`Sent your email to ${parsed.to}.`, token);
      } catch (e) { await sayAndClose(`Couldn't send it: ${String(e).slice(0, 120)}`, token); }
      return;
    }
    await sayAndClose("Connect Google or Microsoft first to send email.", token);
  }

  // Save the last thing Keak/its agents made to Google Drive, or OneDrive when Google isn't connected.
  async function saveLastToDrive(token: string) {
    setStateSafe("responding"); setAiReply("Saving to your Drive...");
    const useGoogle = !!localStorage.getItem("keak_google_refresh");
    const dtoken = useGoogle ? await ensureGoogleToken() : (msConnected() ? await ensureMsToken() : null);
    if (!dtoken) { await sayAndClose("Connect Google or Microsoft first to save your files.", token); return; }
    try {
      const hist = JSON.parse(localStorage.getItem("keak_agent_history") || "[]");
      const run = Array.isArray(hist) ? hist[0] : null;
      const res = run?.results?.[0];
      if (!res?.output) { await sayAndClose("There's nothing to save yet. Ask the team to make something first.", token); return; }
      const isHtml = /^\s*<!doctype html|^\s*<html[\s>]/i.test(String(res.output).trim());
      const base = (res.title || run.job || "keak").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
      const name = `${base}.${isHtml ? "html" : "txt"}`;
      const mime = isHtml ? "text/html" : "text/plain";
      if (useGoogle) {
        const raw = await invoke<string>("drive_create", { args: { accessToken: dtoken, name, mime, content: res.output } });
        const r = JSON.parse(raw);
        if (r.webViewLink) { try { await invoke("open_url", { url: r.webViewLink }); } catch { /* ignore */ } }
        await sayAndClose(`Saved ${res.title || "it"} to your Google Drive.`, token);
      } else {
        const raw = await invoke<string>("ms_drive_create", { args: { accessToken: dtoken, name, mime, content: res.output } });
        const r = JSON.parse(raw);
        if (r.webUrl) { try { await invoke("open_url", { url: r.webUrl }); } catch { /* ignore */ } }
        await sayAndClose(`Saved ${res.title || "it"} to your OneDrive.`, token);
      }
    } catch (e) { await sayAndClose(`Couldn't save your file: ${String(e).slice(0, 120)}`, token); }
  }

  // Supabase "do anything": the user's own AI turns the request into a PostgREST call, then we run it with
  // the stored service key. Covers query / insert / update / delete on the user's own tables.
  // Run one routine: do its instructions on the user's own AI (with research first if it's allowed Perplexity),
  // log it to Work, and deliver the result to the chosen channel.
  async function runRoutine(r: Routine) {
    const fallback = resolveOwnAI();
    if (!fallback) return; // no AI connected — skip quietly, it'll run next time
    // Run on the specific model the user chose for this routine (e.g. "claude|claude-haiku-4-5"), else default AI.
    const ai = r.modelChoice ? resolveChoice(r.modelChoice, fallback) : fallback;
    const tools = r.tools || [];
    let research = "";
    if (tools.includes("perplexity")) {
      const rr = await askPerplexity(r.instructions);
      if (rr) research = rr;
    }
    const sys = "You are running a scheduled routine for the user. Do exactly what the instructions ask and return ONLY the finished result as clean, useful text ready to read or send. Be well structured and concise. If given live research findings, use them.";
    const msg = research ? `${r.instructions}\n\nLive research findings:\n${research}` : r.instructions;
    let out = "";
    try { out = await askOwnAIRaw(ai, sys, msg); } catch (e) { out = `This routine hit an error: ${String(e).slice(0, 160)}`; }
    out = cleanReply(out || "").trim() || "(no output)";
    setRoutineRun(r.id, Date.now(), out);
    try {
      const prev = JSON.parse(localStorage.getItem("keak_agent_history") || "[]");
      const h = Array.isArray(prev) ? prev : [];
      h.unshift({ ts: Date.now(), job: r.name, results: [{ name: "Routine", title: r.name, output: out, color: "#B8955A" }] });
      localStorage.setItem("keak_agent_history", JSON.stringify(h.slice(0, 20)));
    } catch { /* ignore */ }
    await deliverRoutine(r, out);
  }
  async function deliverRoutine(r: Routine, out: string) {
    const body = `${r.name}\n\n${out}`;
    if (r.output === "telegram") {
      const tk = localStorage.getItem("keak_telegram_token") || "";
      const chatId = localStorage.getItem("keak_telegram_chat") || "";
      if (tk && chatId) { try { await invoke("telegram_send", { args: { token: tk, chatId, text: body.slice(0, 3900) } }); } catch { /* ignore */ } }
    } else if (r.output === "email") {
      const to = (r.outputTarget || "").trim();
      if (to) { await sendViaResend(to, `Keak routine: ${r.name}`, out); }
    } else {
      // "keak": pop the orb with the result (it's also in the Work log).
      setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
      setAgentResults([{ name: "Routine", title: r.name, output: out.slice(0, 4000), color: "#B8955A" }]);
      setAiReply(`${r.name}: ${out}`.slice(0, 400));
      setStateSafe("idle"); scheduleAssistantClose(20000);
    }
  }

  // Send the user a one-off message on Telegram right now. Returns true if it handled the request.
  async function sendMessageMe(question: string, token: string): Promise<boolean> {
    // Work out the message body: use the words after "saying/that says/message …", else have the AI compose one.
    let body = "";
    const m = question.match(/\b(?:saying|that says?|which says?|with the message|message[:]?|:)\s*([\s\S]+)$/i);
    if (m && m[1].trim().length > 1) body = m[1].trim();
    if (!body) {
      const ai = resolveOwnAI();
      if (ai) { try { body = cleanReply(await askOwnAIRaw(ai, "The user wants to send THEMSELVES a short message on a chat app. Reply with ONLY the message text to send — no quotes, no preamble, no explanation. If they specified the wording, use it exactly; otherwise write a short friendly message that matches the request.", question)).trim(); } catch { /* ignore */ } }
    }
    if (!body) body = "Hello from Keak!";

    const tk = localStorage.getItem("keak_telegram_token") || "";
    const chatId = localStorage.getItem("keak_telegram_chat") || "";
    if (!tk || !chatId) { await sayAndClose("Connect Telegram first, then I can message you there.", token); return true; }
    try { await invoke("telegram_send", { args: { token: tk, chatId, text: body.slice(0, 3900) } }); await sayAndClose("Sent it to your Telegram.", token); }
    catch (e) { await sayAndClose(`Telegram didn't accept it. ${String(e).slice(0, 120)}`, token); }
    return true;
  }

  // Answer a YouTube question using the connected Google account's YouTube Data API (read-only). The AI turns
  // the question into an endpoint+params, Keak fetches, then the AI reads the JSON back as a short spoken answer.
  async function youtubeDo(question: string, token: string) {
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first so I can answer about YouTube.", token); return; }
    const gtoken = await ensureGoogleToken();
    if (!gtoken) { await sayAndClose("Connect your Google account first so I can reach YouTube.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose(); setStateSafe("responding");
    const sys = `Turn the user's YouTube question into ONE YouTube Data API v3 GET call as strict minified JSON: {"path":"<endpoint>","query":"<url-encoded query string>"}. Endpoints: channels, search, videos, playlists, playlistItems, commentThreads. For the user's OWN channel use channels with mine=true. URL-encode values (spaces as %20). Examples: my channel stats -> {"path":"channels","query":"part=snippet,statistics&mine=true"}; my latest videos -> {"path":"search","query":"part=snippet&forMine=true&type=video&order=date&maxResults=5"}; search youtube for cats -> {"path":"search","query":"part=snippet&type=video&maxResults=5&q=cats"}. Return ONLY the JSON.`;
    let spec: { path?: string; query?: string } | null = null;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) spec = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!spec || !spec.path) { await sayAndClose("I couldn't work out that YouTube request.", token); return; }
    let data = "";
    try { data = await invoke<string>("youtube_get", { args: { accessToken: gtoken, path: String(spec.path), query: String(spec.query || "") } }); }
    catch (e) { await sayAndClose(`YouTube said: ${String(e).slice(0, 150)}`, token); return; }
    let answer = "";
    try { answer = cleanReply(await askOwnAIRaw(ai, "You are Keak, answering a YouTube question ALOUD. Given the raw YouTube API JSON, answer the user's question in 1 to 3 short spoken sentences with the real numbers/titles. Plain text, no markdown.", `Question: ${question}\n\nYouTube API result:\n${data.slice(0, 4500)}`)).trim(); } catch { /* ignore */ }
    if (!answer) answer = "I got the YouTube data but couldn't summarize it.";
    await sayAndClose(answer, token);
  }

  async function supabaseDo(question: string, token: string) {
    const url = localStorage.getItem("keak_supabase_url") || "";
    const key = localStorage.getItem("keak_supabase_key") || "";
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first so I can build the query.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Working with your Supabase...");
    let schema = "{}";
    try { schema = await invoke<string>("supabase_schema", { args: { url, key } }); } catch { /* ignore */ }
    const sys = `You turn a request into ONE Supabase PostgREST REST call. Tables and columns (JSON): ${schema}. Reply ONLY JSON {"method":"GET|POST|PATCH|DELETE","path":"relative to /rest/v1/, e.g. users?select=*&status=eq.active","body":"JSON string for POST/PATCH else empty","summary":"one short sentence of what it does"}. Use PostgREST syntax: filters like id=eq.3, name=ilike.*bob*, order=created_at.desc, limit=5. For insert use POST with path=table name and body a JSON object. No prose, no code fences.`;
    let action: any;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!action || !action.method || !action.path) { await sayAndClose("I couldn't turn that into a database action.", token); return; }
    // Destructive ops (delete / update) always ask first — the service key bypasses row-level security.
    const method = String(action.method).toUpperCase();
    if (method === "DELETE" || method === "PATCH") {
      const label = action.summary || `${method} on ${action.path}`;
      const ok = await askCuStart(`Confirm this change to your database: ${label}`);
      if (!ok) { await sayAndClose("Okay, I left your database untouched.", token); return; }
    }
    try {
      const res = await invoke<string>("supabase_rest", { args: { url, key, method: action.method, path: action.path, body: action.body || "" } });
      let note = action.summary || "Done.";
      try { const parsed = JSON.parse(res); if (Array.isArray(parsed)) note = `${action.summary || "Done"}. ${parsed.length} row${parsed.length === 1 ? "" : "s"}.`; } catch { /* ignore */ }
      setAgentResults([{ name: "Supabase", title: action.summary || "Query", output: res.slice(0, 4000), color: "#8FA47D" }]);
      await sayAndClose(cleanReply(note), token, 14000);
    } catch (e) { await sayAndClose(`Supabase error: ${String(e).slice(0, 140)}`, token); }
  }

  // Second Brain OS "do anything": the user's own AI turns the request into ONE filesystem action inside the
  // connected folder (list, read, write, mkdir, delete, search). Permission level is enforced in Rust too, and
  // any write/delete asks first. This is what lets Keak read all your folders, create skills/files, edit, etc.
  async function brainDo(question: string, token: string) {
    const root = localStorage.getItem("keak_brain_path") || "";
    const perm = localStorage.getItem("keak_brain_perm") || "full";
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first so I can work with your Second Brain.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Working in your Second Brain...");
    let tree = "[]";
    try { tree = await invoke<string>("sb_tree", { args: { root, maxDepth: 2, maxEntries: 400 } }); } catch { /* ignore */ }
    const sys = `You turn a request into ONE action on the user's Second Brain folder (a local files/folders "operating system"). Its structure, relative paths (folders end with /): ${tree}. Reply ONLY JSON {"op":"list|read|write|mkdir|delete|search","path":"relative path from the root","content":"full file content for write, else empty","query":"for search, else empty","summary":"one short sentence of what it does"}. Rules: to CREATE A SKILL, write to AI/skills/<kebab-name>/SKILL.md. Put new projects under PROJECTS/, automations under AUTOMATIONS/. For write, "content" must be the COMPLETE file. Use "read" to look at a file, "list" to see a folder (path = folder or "" for the root), "search" to find things by keyword. No prose, no code fences.`;
    let action: any;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!action || !action.op) { await sayAndClose("I couldn't turn that into a Second Brain action.", token); return; }
    const op = String(action.op).toLowerCase();
    const path = String(action.path || "");
    const label = action.summary || `${op} ${path}`;
    try {
      if (op === "list") {
        const res = await invoke<string>("sb_tree", { args: { root, maxDepth: path ? 3 : 2, maxEntries: 500 } });
        const items = JSON.parse(res) as string[];
        const shown = path ? items.filter((x) => x.startsWith(path.replace(/^\/+|\/+$/g, "") + "/")) : items;
        setAgentResults([{ name: "Second Brain", title: label, output: shown.join("\n").slice(0, 4000), color: "#B8955A" }]);
        await sayAndClose(cleanReply(`${action.summary || "Here's what I found"}. ${shown.length} item${shown.length === 1 ? "" : "s"}.`), token, 14000);
        return;
      }
      if (op === "search") {
        const res = await invoke<string>("sb_search", { args: { root, query: String(action.query || question), maxResults: 25 } });
        const hits = JSON.parse(res) as { path: string; snippet: string }[];
        setAgentResults([{ name: "Second Brain", title: label, output: hits.map((h) => `${h.path}${h.snippet ? `\n  ${h.snippet}` : ""}`).join("\n").slice(0, 4000), color: "#B8955A" }]);
        await sayAndClose(cleanReply(`Found ${hits.length} match${hits.length === 1 ? "" : "es"} in your Second Brain.`), token, 14000);
        return;
      }
      if (op === "read") {
        const res = await invoke<string>("sb_read", { args: { root, path } });
        setAgentResults([{ name: "Second Brain", title: path || label, output: res.slice(0, 6000), color: "#B8955A" }]);
        await sayAndClose(cleanReply(action.summary || `Opened ${path}.`), token, 16000);
        return;
      }
      // Writes / deletes: check permission intent locally, then always confirm before touching the disk.
      if (op === "write" || op === "mkdir" || op === "delete") {
        if (perm === "read") { await sayAndClose("Your Second Brain is set to read-only, so I didn't change anything.", token); return; }
        const verb = op === "delete" ? "delete" : op === "mkdir" ? "create the folder" : "write";
        const ok = await askCuStart(`Confirm: ${verb} ${path} in your Second Brain? (${label})`);
        if (!ok) { await sayAndClose("Okay, I left your Second Brain untouched.", token); return; }
        if (op === "write") {
          const full = await invoke<string>("sb_write", { args: { root, path, content: String(action.content || ""), perm } });
          setAgentResults([{ name: "Second Brain", title: label, output: `Saved:\n${full}`, color: "#B8955A" }]);
          await sayAndClose(cleanReply(action.summary || `Saved ${path}.`), token, 12000);
        } else if (op === "mkdir") {
          await invoke<string>("sb_mkdir", { args: { root, path, perm } });
          await sayAndClose(cleanReply(action.summary || `Created the folder ${path}.`), token, 10000);
        } else {
          const res = await invoke<string>("sb_delete", { args: { root, path, perm } });
          await sayAndClose(cleanReply(res), token, 10000);
        }
        return;
      }
      await sayAndClose("I couldn't tell what to do in your Second Brain.", token);
    } catch (e) { await sayAndClose(`Second Brain error: ${String(e).slice(0, 160)}`, token); }
  }

  // Figma "do anything the API allows": the user's own AI turns the request into a Figma REST call (read files,
  // export frames, read/post comments). Editing designs isn't possible via Figma's public REST API.
  async function figmaDo(question: string, token: string) {
    const ftoken = localStorage.getItem("keak_figma_token") || "";
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Working with your Figma...");
    const sys = `You turn a request into ONE Figma REST API call. Base https://api.figma.com. Useful: GET /v1/me; GET /v1/files/:key; GET /v1/files/:key/nodes?ids=1:2; GET /v1/images/:key?ids=1:2&format=png; GET /v1/files/:key/comments; POST /v1/files/:key/comments with body {"message":"..."}. A file key is the token in a Figma URL after /file/ or /design/. The API is mostly read-only, you cannot edit designs. Reply ONLY JSON {"method":"GET|POST","path":"/v1/...","body":"JSON string or empty","summary":"one short sentence"}. No prose, no code fences.`;
    let action: any;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!action || !action.path) { await sayAndClose("I couldn't turn that into a Figma action.", token); return; }
    try {
      const res = await invoke<string>("figma_api", { args: { token: ftoken, method: action.method || "GET", path: action.path, body: action.body || "" } });
      let opened = false;
      try {
        const p: any = JSON.parse(res);
        if (p.images && typeof p.images === "object") {
          const first = Object.values(p.images).find((u) => typeof u === "string" && (u as string).startsWith("http"));
          if (first) { await invoke("open_url", { url: first as string }); opened = true; }
        }
      } catch { /* ignore */ }
      setAgentResults([{ name: "Figma", title: action.summary || "Figma", output: res.slice(0, 4000), color: "#C68B7E" }]);
      await sayAndClose(cleanReply((action.summary || "Done") + (opened ? ", I opened the export." : ".")), token, 14000);
    } catch (e) { await sayAndClose(`Figma error: ${String(e).slice(0, 140)}`, token); }
  }

  // GitHub "do anything": the user's own AI turns the request into a GitHub REST call, Keak runs it.
  async function githubDo(question: string, token: string) {
    const ghtoken = localStorage.getItem("keak_github_token") || "";
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Working with your GitHub...");
    const sys = `You turn a request into ONE GitHub REST API call. Base https://api.github.com. Examples: GET /user/repos?sort=updated&per_page=5; GET /repos/:owner/:repo/issues; POST /repos/:owner/:repo/issues with body {"title":"...","body":"..."}; GET /search/issues?q=...; POST /gists with body {"files":{"note.txt":{"content":"..."}},"public":false}. Reply ONLY JSON {"method":"GET|POST|PATCH|PUT|DELETE","path":"/...","body":"JSON string or empty","summary":"one short sentence"}. No prose, no code fences.`;
    let action: any;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!action || !action.path) { await sayAndClose("I couldn't turn that into a GitHub action.", token); return; }
    const method = String(action.method || "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method) && actionMode() !== "off") {
      const ok = await askCuStart(`Confirm on GitHub: ${action.summary || `${method} ${action.path}`}`);
      if (!ok) { await sayAndClose("Okay, I didn't touch GitHub.", token); return; }
    }
    try {
      const res = await invoke<string>("github_api", { args: { token: ghtoken, method, path: action.path, body: action.body || "" } });
      setAgentResults([{ name: "GitHub", title: action.summary || "GitHub", output: res.slice(0, 4000), color: "#6E8FA0" }]);
      await sayAndClose(cleanReply(action.summary || "Done."), token, 14000);
    } catch (e) { await sayAndClose(`GitHub error: ${String(e).slice(0, 140)}`, token); }
  }

  // Shopify "do anything": AI turns the request into an Admin API call, Keak runs it.
  async function shopifyDo(question: string, token: string) {
    const shop = localStorage.getItem("keak_shopify_shop") || "";
    const stoken = localStorage.getItem("keak_shopify_token") || "";
    const ai = resolveOwnAI();
    if (!ai) { await sayAndClose("Connect your own AI first.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Working with your Shopify store...");
    const sys = `You turn a request into ONE Shopify Admin REST API call (version 2024-10). path is relative, e.g. "products.json?limit=5", "orders.json?status=any&limit=5", "customers/search.json?query=email:x@y.com". For create/update use POST/PUT with the documented JSON body (e.g. POST products.json with {"product":{"title":"..."}}). Reply ONLY JSON {"method":"GET|POST|PUT|DELETE","path":"...","body":"JSON string or empty","summary":"one short sentence"}. No prose, no code fences.`;
    let action: any;
    try { const raw = await askOwnAIRaw(ai, sys, question); const m = raw.match(/\{[\s\S]*\}/); if (m) action = JSON.parse(m[0]); } catch { /* ignore */ }
    if (!action || !action.path) { await sayAndClose("I couldn't turn that into a Shopify action.", token); return; }
    const method = String(action.method || "GET").toUpperCase();
    if (["POST", "PUT", "DELETE"].includes(method) && actionMode() !== "off") {
      const ok = await askCuStart(`Confirm on your store: ${action.summary || `${method} ${action.path}`}`);
      if (!ok) { await sayAndClose("Okay, I left your store as it was.", token); return; }
    }
    try {
      const res = await invoke<string>("shopify_api", { args: { shop, token: stoken, method, path: action.path, body: action.body || "" } });
      setAgentResults([{ name: "Shopify", title: action.summary || "Shopify", output: res.slice(0, 4000), color: "#5E8C4A" }]);
      await sayAndClose(cleanReply(action.summary || "Done."), token, 14000);
    } catch (e) { await sayAndClose(`Shopify error: ${String(e).slice(0, 140)}`, token); }
  }

  // Gumloop: trigger the user's saved flow.
  async function runGumloop(question: string, token: string) {
    const key = localStorage.getItem("keak_gumloop_key") || "";
    const userId = localStorage.getItem("keak_gumloop_user") || "";
    const flow = localStorage.getItem("keak_gumloop_flow") || "";
    if (!flow || !userId) { await sayAndClose("Add your Gumloop user ID and flow ID in settings first.", token); return; }
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Starting your Gumloop flow...");
    try {
      await invoke("gumloop_start", { args: { apiKey: key, userId, savedItemId: flow, inputs: JSON.stringify({ request: question }) } });
      await sayAndClose("Started your Gumloop flow.", token);
    } catch (e) { await sayAndClose(`Gumloop error: ${String(e).slice(0, 140)}`, token); }
  }

  // Answer a Telegram message from the phone. Uses the API tools (which return URLs/text) when named, else
  // answers with the connected AI. Returns the text to send back. (Screen control + agents stay desktop-only.)
  // A small tool-using agent so Telegram Keak can DO things like the orb: search, read and create files in the
  // connected Second Brain, and search the web. The model replies with ONLY a JSON tool call to act, or plain
  // text when it's done. Runs a few steps, then answers.
  async function runTelegramAgent(task: string, ai: OwnAI, notify?: (m: string) => void): Promise<string> {
    const say = (m: string) => { try { notify?.(m); } catch { /* ignore */ } };
    const root = localStorage.getItem("keak_brain_path") || "";
    const userName = localStorage.getItem("keak_user_name") || "the user";
    const hasWeb = !!toolKey("perplexity");
    const toolDocs: string[] = [];
    if (root) {
      toolDocs.push('{"tool":"search_brain","query":"..."} search their Second Brain files');
      toolDocs.push('{"tool":"read_brain","path":"relative/path"} read one file');
      toolDocs.push('{"tool":"write_brain","path":"relative/path.md","content":"..."} create or overwrite a file');
    }
    if (hasWeb) toolDocs.push('{"tool":"web","query":"..."} search the live web');
    const sys = `You are Keak, helping ${userName} over Telegram from their computer. You can use tools to actually get things done. ${root ? "Their Second Brain folder IS connected, so you CAN search, read and create files in it. Never say it is not connected." : "No Second Brain folder is connected."} To use a tool, reply with ONLY a single JSON object and nothing else. Available tools: ${toolDocs.join(" ; ") || "(none)"}. When you have what you need, reply with the final answer as plain text, no JSON, no markdown, no ** or ##. Keep it short.${memoryBlock()}`;
    let convo = `User: ${task}`;
    for (let step = 0; step < 6; step++) {
      let raw = "";
      try { raw = await askOwnAIRaw(ai, sys, convo); } catch (e) { return `Error: ${String(e).slice(0, 140)}`; }
      const j = extractJsonObject(raw) as { tool?: string; query?: string; path?: string; content?: string } | null;
      if (!j || !j.tool) return raw; // plain text = final answer
      let result = "";
      try {
        if (j.tool === "search_brain" && root) {
          say(`Searching your Second Brain for "${String(j.query || "").slice(0, 60)}"...`);
          const hits = JSON.parse(await invoke<string>("sb_search", { args: { root, query: String(j.query || ""), maxResults: 8 } })) as Array<{ path?: string; snippet?: string }>;
          result = Array.isArray(hits) && hits.length ? hits.map((h) => `${h.path || ""}: ${h.snippet || ""}`).join("\n").slice(0, 3000) : "No matches in the Second Brain.";
        } else if (j.tool === "read_brain" && root) {
          say(`Reading ${String(j.path || "").slice(0, 80)}...`);
          result = (await invoke<string>("sb_read", { args: { root, path: String(j.path || "") } })).slice(0, 4000);
        } else if (j.tool === "write_brain" && root) {
          say(`Saving ${String(j.path || "").slice(0, 80)}...`);
          const perm = localStorage.getItem("keak_brain_perm") || "full";
          await invoke("sb_write", { args: { root, path: String(j.path || ""), content: String(j.content || ""), perm } });
          result = `Saved ${j.path}.`;
        } else if (j.tool === "web" && hasWeb) {
          say(`Searching the web for "${String(j.query || "").slice(0, 60)}"...`);
          result = (await askPerplexity(String(j.query || ""))) || "No web result.";
        } else {
          result = "That tool is not available.";
        }
      } catch (e) { result = "Tool failed: " + String(e).slice(0, 120); }
      convo += `\nKeak(tool): ${raw}\nTool result: ${result}`;
    }
    return "I looked into it but could not finish in a few steps. Try asking more specifically.";
  }

  async function answerForTelegram(text: string, notify?: (m: string) => void): Promise<string> {
    const ai = resolveOwnAI();
    const say = (m: string) => { try { notify?.(m); } catch { /* ignore */ } };
    // Actually DO things from your phone, exactly like the voice assistant does: create a routine (persists +
    // shows in the desktop), or change a setting / a dial / an agent. cleanReply strips markdown for Telegram.
    try { const r = await parseRoutineCommand(text); if (r) return cleanReply(r); } catch { /* fall through */ }
    try { const s = await parseAndApplySettings(text); if (s) return cleanReply(s); } catch { /* fall through */ }
    if (toolKey("perplexity") && (/^\s*(research|look up|investiga|busca)/i.test(text) || /\bperplexity\b/i.test(text))) {
      say("On it, researching that now...");
      const r = await askPerplexity(text); return r || "Couldn't reach Perplexity.";
    }
    if (toolKey("gamma") && /\b(deck|slides?|presentation|gamma)\b/i.test(text)) {
      say("On it, building the deck. This takes a minute...");
      const u = await makeDeck(text.slice(0, 1500)); return looksLikeUrl(u) ? `Deck ready: ${u}` : `Couldn't build the deck. ${u || ""}`;
    }
    if (toolKey("heygen") && (/\bhey ?gen\b/i.test(text) || /\bvideo\b/i.test(text))) {
      say("On it, making the video. This takes a few minutes...");
      let s = text; if (ai) { try { s = await askOwnAIRaw(ai, "Write a 40-70 word spoken video script. Topic follows.", text) || text; } catch { /* keep */ } }
      const u = await makeVideo(s.slice(0, 1200)); return looksLikeUrl(u) ? `Video ready: ${u}` : `Couldn't make the video. ${u || ""}`;
    }
    if (toolKey("higgsfield") && /\b(higgsfield|cinematic)\b/i.test(text)) {
      say("On it, generating that now...");
      const u = await runHiggsfield(text.slice(0, 1000)); return looksLikeUrl(u) ? u! : `Couldn't generate. ${u || ""}`;
    }
    if (toolKey("manus") && /\bmanus\b/i.test(text)) {
      say("On it, handing this to Manus...");
      const u = await runManus(text.replace(/\bmanus\b/i, "").trim() || text); return looksLikeUrl(u) ? `Manus is on it: ${u}` : `Couldn't start Manus. ${u || ""}`;
    }
    if ((toolKey("n8n") || toolKey("make")) && /\b(automation|workflow|scenario|webhook)\b/i.test(text)) {
      const ok = await fireAutomation(text); return ok ? "Triggered your automation." : "Couldn't reach the webhook.";
    }
    if (ai) return cleanReply(await runTelegramAgent(text, ai, notify));
    return "Connect your own AI in Keak first so I can answer from your phone.";
  }

  // Calendar via the Google API when connected. Tries the quick regex, then asks the AI to extract the event
  // (title + start/end) so vague phrasing still works — and it NEVER falls through to screen control.
  async function tryGoogleCalendar(question: string, token: string): Promise<boolean> {
    if (!localStorage.getItem("keak_google_refresh") && !msConnected()) return false;
    if (!isCalendarIntent(question)) return false;
    let ev = parseCalendarEvent(question);
    if (!ev) {
      const ai = resolveOwnAI();
      if (ai) {
        const now = new Date();
        const sys = `Extract a calendar event from the user's request. "Now" is ${now.toString()}. Reply ONLY with JSON: {"title":"short title","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS"} in the user's local time. If no end is given, make it one hour after start. If no time is given, use 09:00. No prose, no code fences.`;
        try {
          const raw = await askOwnAIRaw(ai, sys, question);
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const j = JSON.parse(m[0]);
            const start = new Date(j.start);
            if (!isNaN(start.getTime())) {
              let end = j.end ? new Date(j.end) : new Date(start.getTime() + 3600000);
              if (isNaN(end.getTime())) end = new Date(start.getTime() + 3600000);
              ev = { title: String(j.title || "Event"), start, end };
            }
          }
        } catch { /* ignore */ }
      }
    }
    if (!ev) return false;
    setAssistant(true); assistantVisibleRef.current = true; cancelAssistantClose();
    setStateSafe("responding"); setAiReply("Adding it to your calendar...");
    const link = await createEventAnyProvider(ev);
    const when = ev.start.toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (link) await sayAndClose(`Done, I added ${ev.title} to your calendar for ${when}.`, token);
    else await sayAndClose("I couldn't add it to your calendar. Try reconnecting it in settings.", token);
    return true;
  }

  // Delegate a big job to named star agents running on the user's own AI: plan → parallel work → synthesize.
  async function runAgents(job: string, token: string, single?: { name: string; description: string; color: string; choice?: string; personality?: string; tools?: string[] }) {
    const ai = resolveOwnAI();
    if (!ai) { setAiReply("Connect your own AI first to use agents."); setStateSafe("idle"); scheduleAssistantClose(10000); return; }
    setAssistant(true); assistantVisibleRef.current = true;
    setShowAgentPanel(false); setAgentResults([]);
    cancelAssistantClose();
    setStateSafe("responding");
    setAiReply(single ? `${single.name} is on it...` : "Planning it with the team...");
    console.log("[KEAK] runAgents start:", JSON.stringify(job), single ? `(single: ${single.name})` : "");

    try {
      const teamDefault = localStorage.getItem("keak_agents_model_choice") || "";
      let named: { name: string; color: string; desc: string; personality: string; choice: string; title: string; task: string; tools: string[] }[];
      if (single) {
        // The user called ONE agent by name — no decomposition, that agent does the whole job.
        named = [{ name: single.name, color: single.color, desc: single.description, personality: single.personality || "", choice: single.choice || teamDefault, title: single.description || "Task", task: job, tools: single.tools || [] }];
      } else {
        // 1) Decompose the goal into 2 to 5 independent sub-tasks.
        let subtasks: { title: string; task: string }[] = [];
        try {
          const planRaw = await askOwnAIRaw(ai,
            "You are a project planner. Break the user's goal into 2 to 5 concrete, independent sub-tasks different specialists can each do alone. Reply with ONLY a JSON array like [{\"title\":\"short label\",\"task\":\"what to do\"}]. No prose, no code fences.",
            job);
          console.log("[KEAK] plan raw:", planRaw.slice(0, 300));
          const m = planRaw.match(/\[[\s\S]*\]/);
          if (m) subtasks = JSON.parse(m[0]);
        } catch (e) { console.log("[KEAK] plan failed:", String(e)); }
        if (!Array.isArray(subtasks) || subtasks.length === 0) subtasks = [{ title: "The task", task: job }];
        // Use the user's own agent roster if they made one (their names, colours, specialities); otherwise
        // the default star agents. Cap the number of sub-tasks to the team size so names stay unique.
        const roster = readAgentRoster();
        const defs = effectiveDefaults();
        const cap = roster.length ? Math.min(roster.length, 6) : 4;
        named = subtasks.slice(0, cap).map((s, i) => {
          const custom = roster.length ? roster[i % roster.length] : null;
          const def = defs[i % defs.length];
          return {
            name: custom ? custom.name : def.name,
            color: custom ? custom.color : def.color,
            desc: custom ? custom.description : def.description,
            personality: (custom ? custom.personality : def.personality) || "",
            // Which model this agent runs on: a custom agent's own pick, else this default agent's own pick,
            // else the team default, else the main Keak AI.
            choice: (custom && custom.choice) ? custom.choice : (def.choice || teamDefault),
            title: String(s.title || `Part ${i + 1}`),
            task: String(s.task || job),
            tools: (custom ? custom.tools : def.tools) || [],
          };
        });
      }

      // 2) Light up the constellation (the fullscreen click-through orb window).
      writeAgentState(named.map((n) => ({ name: n.name, status: "working", color: n.color })));
      try { await invoke("show_agents"); } catch (e) { console.log("[KEAK] show_agents failed:", String(e)); }
      setAiReply(named.length > 1 ? `${named.length} agents on it...` : "On it...");

      // 3) Each agent does its sub-task on the user's own AI, ONE AT A TIME with a small gap. Subscription
      // tokens rate-limit hard on bursts, so serial + backoff is far more reliable than firing all at once.
      const results: { name: string; title: string; output: string; color: string }[] = [];
      for (let i = 0; i < named.length; i++) {
        const n = named[i];
        const persona = (n.desc
          ? `You are ${n.name}. Your speciality: ${n.desc}.`
          : `You are ${n.name}, an expert agent on a team.`)
          + (n.personality ? ` Personality and tone: ${n.personality}.` : "");
        // Each agent runs on its own chosen model (possibly a different company), falling back to Keak AI's.
        const workerAI = resolveChoice(n.choice, ai);
        const workerPrompt = `${persona} Do your assigned sub-task fully and return only the finished result as clean, usable text. If it is something to build (a web page, a document), return the actual content ready to use. Be high quality and concise.`;
        // If this agent is allowed to use Perplexity AND the request calls for research, pull live web
        // research first and hand it the findings. (Only when asked, not on every run.)
        let research = "";
        if ((n.tools || []).includes("perplexity") && /\b(research|find|compare|best|latest|current|sources?|investiga|busca|compara|mejores|perplexity)\b/i.test(`${job} ${n.task}`)) {
          setAiReply(`${n.name} is researching...`);
          const r = await askPerplexity(`${job}\n\nSpecifically: ${n.task}`);
          if (r) research = r;
        }
        const workerMsg = research
          ? `Overall goal: ${job}\n\nYour sub-task (${n.title}): ${n.task}\n\nLive web research (from Perplexity — use it and keep the facts/links):\n${research}`
          : `Overall goal: ${job}\n\nYour sub-task (${n.title}): ${n.task}`;
        try {
          let out = "";
          try {
            out = await askOwnAIRaw(workerAI, workerPrompt, workerMsg);
          } catch (e) {
            const em = String(e);
            if (/\b429\b|rate.?limit/i.test(em) && workerAI.provider === "claude" && !workerAI.model.includes("haiku")) {
              out = await askOwnAIRaw({ ...workerAI, model: "claude-haiku-4-5" }, workerPrompt, workerMsg);
            } else throw e;
          }
          // An agent MAY use its assigned tools, but only when the request actually asks for that kind of
          // output (not on every run). We gate each tool on a keyword in the overall job + this sub-task.
          let produced = (out || "").trim();
          const at = n.tools || [];
          const ask = `${job} ${n.task}`.toLowerCase();
          try {
            if (at.includes("gamma") && /\b(deck|slides?|presentation|pitch|diapositiv|presentaci|gamma)\b/.test(ask)) { const u = await makeDeck(produced.slice(0, 1500)); if (looksLikeUrl(u)) produced += `\n\nDeck: ${u}`; }
            else if (at.includes("heygen") && /\b(video|v[ií]deo|avatar|hey ?gen)\b/.test(ask)) { const u = await makeVideo(produced.slice(0, 1200)); if (looksLikeUrl(u)) produced += `\n\nVideo: ${u}`; }
            else if (at.includes("higgsfield") && /\b(higgsfield|cinematic|image|imagen|visual|photo|foto)\b/.test(ask)) { const u = await runHiggsfield(produced.slice(0, 1000)); if (looksLikeUrl(u)) produced += `\n\nVisual: ${u}`; }
            else if (at.includes("elevenlabs") && /\b(voice ?over|voiceover|narrat|voz|audio|read (?:it|this) aloud)\b/.test(ask)) { const p = await makeVoiceover(produced.slice(0, 2000)); if (looksLikePath(p)) produced += `\n\nVoiceover: ${p}`; }
            else if (at.includes("manus") && /\bmanus\b/.test(ask)) { const u = await runManus(n.task); if (looksLikeUrl(u)) produced += `\n\nManus task: ${u}`; }
            if (at.includes("slack") && /\bslack\b/.test(ask)) await postToSlack("#general", produced.slice(0, 1500));
            if ((at.includes("n8n") || at.includes("make")) && /\b(automation|workflow|scenario|webhook|n8n|make|automatizaci)\b/.test(ask)) await fireAutomation(produced.slice(0, 1500));
          } catch { /* tools are best-effort */ }
          results.push({ name: n.name, title: n.title, output: produced, color: n.color });
        } catch (e) {
          results.push({ name: n.name, title: n.title, output: `(couldn't finish: ${String(e).slice(0, 100)})`, color: n.color });
        }
        updateAgentStatus(n.name, "done");
        setAgentResults([...results]);
        if (i < named.length - 1) await new Promise((r) => setTimeout(r, 300)); // small breathe between calls
      }

      // Save this run to the persistent work log (shown in the Connect window's Work section).
      try {
        const prev = JSON.parse(localStorage.getItem("keak_agent_history") || "[]");
        const hist = Array.isArray(prev) ? prev : [];
        hist.unshift({ ts: Date.now(), job, results });
        localStorage.setItem("keak_agent_history", JSON.stringify(hist.slice(0, 20)));
      } catch { /* ignore */ }

      // 4) Summary. Single agent → use its output directly (one less Claude call = fewer 429s). If every
      // agent got rate-limited, say so plainly instead of a hollow "all done".
      const anyOk = results.some((r) => !r.output.startsWith("(couldn't finish"));
      let summary = "";
      if (!anyOk) {
        summary = "Your Claude is rate-limiting right now. Give it a minute, or switch to Haiku or a Gemini key, then try again.";
      } else if (results.length === 1) {
        // One agent: speak a short taste, the full result lives in the See it panel (keeps the good voice).
        summary = shortSpoken(results[0].output);
      } else {
        // Multiple agents: Keak AI gives a real spoken summary of the team's work (Pep likes this). Keep it
        // FAST — run the synthesis on a light model (Haiku / GPT-4o / Flash) at low effort, and no pre-pause,
        // so it talks back quickly once the result is ready.
        const fastAI: OwnAI = {
          ...ai,
          model: ai.provider === "claude" ? "claude-haiku-4-5" : ai.provider === "openai" ? "gpt-4o" : ai.model,
          effort: "low",
        };
        // A local one-liner ready to speak instantly if the summary call fails or comes back empty.
        const names = results.map((r) => r.name);
        const uniq = names.filter((v, i) => names.indexOf(v) === i);
        const who = uniq.length > 1 ? `${uniq.slice(0, -1).join(", ")} and ${uniq[uniq.length - 1]}` : uniq[0];
        const fallback = `Done. ${who} finished. Tap See it to read everything they made.`;
        try {
          const s = await askOwnAIRaw(fastAI,
            "You are the team lead. Given the sub-results, give the user a very short spoken summary: 2 to 3 sentences, under 50 words, plain text, no markdown. End by saying they can tap See it to read it all.",
            results.map((r) => `${r.name} — ${r.title}:\n${r.output}`).join("\n\n"));
          summary = shortSpoken(s) || fallback;
        } catch { summary = fallback; }
      }
      summary = cleanReply(summary || "The team finished. Tap See it to read what they produced.");
      historyRef.current.push({ role: "user", text: job }, { role: "assistant", text: summary });

      // 5) Let the orbs shine a moment, then clear the constellation.
      window.setTimeout(() => { try { invoke("hide_agents"); } catch { /* ignore */ } writeAgentState([]); }, 4200);

      let shown = false;
      const show = () => { if (shown) return; shown = true; setAiReply(summary); setStateSafe("idle"); };
      const safety = window.setTimeout(show, 16000);
      try { await speakReply(summary, token, () => { clearTimeout(safety); show(); }); }
      finally { clearTimeout(safety); show(); scheduleAssistantClose(22000); }
    } catch (e) {
      console.log("[KEAK] runAgents error:", String(e));
      try { await invoke("hide_agents"); } catch { /* ignore */ }
      writeAgentState([]);
      setAiReply(`The agents hit a snag: ${String(e).slice(0, 140)}`);
      setStateSafe("idle"); scheduleAssistantClose(14000);
    }
  }

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
    if (liveActiveRef.current) { liveRef.current?.close(); liveActiveRef.current = false; } // tear down any live session
    readyToStop.current = false;
    if (mrRef.current && mrRef.current.state !== "inactive") {
      mrRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    // Dismissing Keak AI also clears any agent orbs still on screen (don't leave them floating).
    try { await invoke("hide_agents"); } catch { /* ignore */ }
    writeAgentState([]);
    await invoke("hide_overlay");
    reset();
  }

  function reset() {
    cancelAssistantClose();
    stopLivePreview();
    setLiveText("");
    setStateSafe("idle");
    setResult("");
    setErrorMsg("");
    setAiReply("");
    setPendingAction(null);
    assistantVisibleRef.current = false;
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
      {localStorage.getItem("keak_live_experiment") === "1" && (
        <div
          style={{
            position: "absolute", bottom: 8, right: 8, zIndex: 999999,
            background: "#2C1508", color: "#F5EDD8", padding: "10px 12px", borderRadius: 10,
            fontSize: 12, fontFamily: "monospace", maxWidth: 340,
            border: "1px solid #D4A49A", boxShadow: "0 6px 20px rgba(44,21,8,0.35)",
          }}
        >
          <button
            onClick={testKeakLive}
            disabled={liveTestRunning}
            style={{
              background: "#D4A49A", color: "#2C1508", border: "none", borderRadius: 6,
              padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: liveTestRunning ? "default" : "pointer",
              marginBottom: 6,
            }}
          >
            {liveTestRunning ? "Recording 6s / listening..." : "Test Keak Live (Gemini)"}
          </button>
          <div style={{ maxHeight: 140, overflowY: "auto" }}>
            {liveTestLog.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
      {cuActive && (
        <div
          onClick={() => { cuAbortRef.current = true; }}
          title="Click or press Esc to stop"
          style={{
            position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
            background: "#2C1508", color: "#F5EDD8", padding: "8px 14px", borderRadius: 10,
            fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", zIndex: 99999, cursor: "pointer",
            border: "1px solid #D4A49A", boxShadow: "0 6px 20px rgba(44,21,8,0.35)",
          }}
        >
          Keak is controlling your screen · press Esc or click to stop
        </div>
      )}
      {assistant && (
        <div
          className={`assistant-orb-wrap${fromCorner ? ` fly-${fromCorner}` : ""}`}
          onClick={() => { if (state === "recording") stopRecording(); else doClose(); }}
          title={state === "recording" ? "Click to send" : "Click to dismiss"}
        >
          <div className="orb-duo">
            {/* Keak orb hides only when an agent was woken while Standby is on (that agent orb flew in from the
                corner as the single orb). Otherwise it shows — including "agent + Standby off" = Keak + agent. */}
            {(!activeAgent || localStorage.getItem("keak_standby") !== "1") && <div className={`orb orb--${state}`} />}
            {activeAgent && <div className={`orb orb--${state} orb--agent`} style={{ background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.6), ${activeAgent.color} 58%, ${activeAgent.color} 100%)` }} />}
          </div>
          {activeAgent && <span className="agent-name-chip" style={{ color: activeAgent.color }}>{activeAgent.name}</span>}
          {state === "error" ? (
            <p className="ai-reply">{errorMsg}</p>
          ) : aiReply && localStorage.getItem("keak_show_captions") !== "0" ? (
            // Captions can be turned off in settings; when off Keak still speaks, it just doesn't print
            // the words. Errors above always show regardless (they aren't captions).
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
          {cuConfirmGoal && (
            <div className="action-confirm" onClick={(e) => e.stopPropagation()}>
              <p className="action-summary">Let Keak control your screen to: {cuConfirmGoal}?</p>
              <div className="action-buttons">
                <button className="btn-confirm" onClick={(e) => { e.stopPropagation(); resolveCuStart(true); }}>Start</button>
                <button className="btn-cancel" onClick={(e) => { e.stopPropagation(); resolveCuStart(false); }}>Cancel</button>
              </div>
            </div>
          )}
          {state === "idle" && aiReply && !pendingAction && !showAgentPanel && agentResults.length === 0 && (
            <span className="ai-hint">Hold Ctrl + Alt to reply</span>
          )}
          {agentResults.length > 0 && !showAgentPanel && (
            <button className="see-it-btn" onClick={(e) => { e.stopPropagation(); cancelAssistantClose(); setShowAgentPanel(true); }}>
              See it
            </button>
          )}
          {showAgentPanel && (
            <div className="agent-panel" onClick={(e) => e.stopPropagation()}>
              <div className="agent-panel-head">
                <span>What the team made</span>
                <button className="agent-panel-close" onClick={() => { setShowAgentPanel(false); scheduleAssistantClose(12000); }}>Close</button>
              </div>
              <div className="agent-panel-body">
                {agentResults.map((r, idx) => {
                  const built = isHtmlArtifact(r.output);
                  return (
                    <div className="agent-result" key={r.name + idx}>
                      <div className="agent-result-head">
                        <span className="agent-result-name" style={r.color ? { color: "#3a2a12", background: hexToSoft(r.color) } : undefined}>{r.name}</span>
                        <span className="agent-result-title">{r.title}</span>
                        <span className="agent-result-done">✓ done</span>
                      </div>
                      <div className="agent-result-out"><RichText text={r.output} /></div>
                      <button
                        className={`agent-result-open${built ? " agent-result-open--go" : ""}`}
                        onClick={() => openArtifact(`${r.name}-${r.title}`, r.output)}
                      >
                        {built ? "Open the result" : "Save & open as a file"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
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
              {/* Keak Streaming: show the words forming live (tail of the transcript) while you talk. The
                  accurate, styled final text still lands at your cursor on release. */}
              <span className="pill-label" style={liveText ? { maxWidth: 360, overflow: "hidden", whiteSpace: "nowrap", opacity: 0.85, fontWeight: 500 } : undefined}>
                {liveText ? (liveText.length > 70 ? "…" + liveText.slice(-69) : liveText) : (rewriting ? t("Rewrite") : thoughtDump ? t("Thought Dump") : t("Listening"))}
              </span>
            </div>
          ) : state === "processing" ? (
            <div className="pill-live">
              <span className="thinking-dots"><i /><i /><i /></span>
              <span className="pill-label">{rewriting ? t("Rewriting") : t("Thinking")}</span>
            </div>
          ) : (
            <span className="pill-hint">{thoughtDump ? "Thought Dump on · click mic" : "Click mic to speak"}</span>
          )}

          {liveTranslate && state !== "processing" && (
            <span
              className="pill-xlate"
              title={`Writing in ${TRANSLATE_LANG_NAMES[liveTranslate] || liveTranslate}`}
              style={{
                fontSize: 11, fontWeight: 700, color: "#2C1508", background: "#D4A49A",
                borderRadius: 6, padding: "2px 7px", marginLeft: 2, letterSpacing: 0.3,
              }}
            >
              → {liveTranslate.toUpperCase()}
            </span>
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
