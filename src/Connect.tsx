import { useState, useEffect, useRef, type ReactNode, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import keakLogo from "./assets/icon_keak_2.png";
import { effectiveDefaults, saveDefaultOverride, resetDefaultOverride, readDefaultOverrides, type EffectiveAgent } from "./agents-defaults";
import { AI_TOOLS, getToolKey, setToolKey, toolConnected, assignableForAgents, CONN_ICON } from "./integrations";
import { readRoutines, upsertRoutine, removeRoutine, newRoutineId, nextRunLabel, type Routine } from "./routines";
import { readMcpServers, writeMcpServers, newMcpId, mcpListTools, mcpCallTool, type McpServer } from "./mcp";
import { useUiLang, UI_LANGS, UI_LANG_AI_NAME, getUiLang, tr, wakePhrase } from "./i18n";
import BrainGraph from "./BrainGraph";
import "./App.css";
import "./Connect.css";

// Keak's ONE shared Google OAuth client (Desktop app type). Fill these once and every user just clicks
// "Sign in with Google" — no per-user setup. Create it in Pep's Google Cloud project, publish the consent
// screen, add Calendar/Gmail/Drive scopes. The client secret for a Desktop-app client is NOT confidential
// per Google, so it's safe to ship. Until these are filled, the window falls back to manual (paste-your-own).
// Values come from build-time env vars (VITE_*), so no secret lives in the repo. Set them in a local .env for
// dev and as GitHub Actions secrets for release builds. See .env.example.
// The built-in "system" voice runs on the browser Speech API (window.speechSynthesis), which is
// cross-platform — on a Mac it uses the Mac's own voices. Only the LABEL needs to be OS-aware.
const IS_MAC = typeof navigator !== "undefined" && (/Mac/i.test(navigator.platform || "") || /Macintosh|Mac OS X/i.test(navigator.userAgent || ""));

const KEAK_GOOGLE_CLIENT_ID = import.meta.env.VITE_KEAK_GOOGLE_CLIENT_ID || "";
const KEAK_GOOGLE_CLIENT_SECRET = import.meta.env.VITE_KEAK_GOOGLE_CLIENT_SECRET || "";
const HAS_SHARED_GOOGLE = KEAK_GOOGLE_CLIENT_ID.trim().length > 0;

// Keak's shared Microsoft (Azure) app for one-click "Sign in with Microsoft" (Outlook Calendar / Mail /
// OneDrive). Desktop = a public client with PKCE, so there is NO secret to ship. Fill the application
// (client) ID once Pep registers the Azure app; until then the window falls back to manual paste.
const KEAK_MS_CLIENT_ID = import.meta.env.VITE_KEAK_MS_CLIENT_ID || "";
const HAS_SHARED_MS = KEAK_MS_CLIENT_ID.trim().length > 0;

// Keak's shared Notion integration (one-click "Sign in with Notion"). Register ONE public integration in
// Pep's Notion, redirect URI http://localhost:53682, then fill these. Notion needs a secret; fine to ship.
const KEAK_NOTION_CLIENT_ID = import.meta.env.VITE_KEAK_NOTION_CLIENT_ID || "";
const KEAK_NOTION_CLIENT_SECRET = import.meta.env.VITE_KEAK_NOTION_CLIENT_SECRET || "";
const HAS_SHARED_NOTION = KEAK_NOTION_CLIENT_ID.trim().length > 0;

// Keak's shared Slack app (one-click "Sign in with Slack"). Needs the https relay page at keak.app/oauth/slack
// registered as the redirect. Fill these once the Slack app + relay exist.
const KEAK_SLACK_CLIENT_ID = import.meta.env.VITE_KEAK_SLACK_CLIENT_ID || "";
const KEAK_SLACK_CLIENT_SECRET = import.meta.env.VITE_KEAK_SLACK_CLIENT_SECRET || "";
const HAS_SHARED_SLACK = KEAK_SLACK_CLIENT_ID.trim().length > 0;

// Keak's shared GitHub OAuth app (device flow — sign in with a code, no redirect). Register a GitHub OAuth
// app with "device flow" enabled, put its client ID here. Empty → falls back to pasting a Personal Access Token.
const KEAK_GITHUB_CLIENT_ID = import.meta.env.VITE_KEAK_GITHUB_CLIENT_ID || "";
const HAS_SHARED_GITHUB = KEAK_GITHUB_CLIENT_ID.trim().length > 0;

// A brand logo. Tries a local file first (public/logos/<id>.png — where Pep drops the exact brand logos),
// then the Simple Icons CDN by slug, then a colour monogram. So dropping a PNG overrides everything.
function LogoBadge({ id, slug, name, brand }: { id: string; slug?: string; name: string; brand?: string }) {
  const candidates = [`/logos/${id}.png`, slug ? `https://cdn.simpleicons.org/${slug}` : ""].filter(Boolean) as string[];
  const [i, setI] = useState(0);
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  if (i >= candidates.length) {
    return <span className="cx-ilogo cx-ilogo--mono" style={{ background: brand || "#2C1508" }}>{initial}</span>;
  }
  return (
    <img
      className="cx-ilogo"
      src={candidates[i]}
      alt=""
      loading="lazy"
      onError={() => setI((n) => n + 1)}
    />
  );
}

// ------------------------------------------------------------------ *
//  Logo celebrations — purely presentational. The moment a connector
//  or AI tool becomes connected its logo comes alive for a second with
//  a brand-appropriate move (the Octocat waves, the Telegram plane
//  flies off and swoops back, the Google G scatters into its four
//  colour arcs and recomposes…). Connected
//  logos replay on hover/click so you can enjoy them anytime.
//  Every play is a ONE-SHOT that self-cleans (classes, particle nodes,
//  timers), particles are capped, transforms/opacity only, and
//  prefers-reduced-motion reduces everything to a gentle pulse.
// ------------------------------------------------------------------ *
type FxPartSpec = { kind: "burst" | "rise" | "firefly" | "ring" | "line" | "drop" | "dart" | "bolt" | "trail" | "drip"; n?: number; colors?: string[] };
// `pieces` spawns N brand-drawn overlay shapes (.cx-fxq--<cls> .cx-fxq--i<N>) whose
// geometry/colours/choreography live entirely in Connect.css — used for effects that
// need the logo's COLOURED PARTS (Google G arcs, Microsoft squares, Figma shapes…).
type FxSpec = { cls: string; dur: number; parts?: FxPartSpec[]; pieces?: number };

const FX_WARM = ["#D4A49A", "#C68B7E", "#E8C9A0"]; // Keak rose/cream — default particle palette

const LOGO_FX: Record<string, FxSpec> = {
  // Bespoke signature moves
  github:     { cls: "wave", dur: 1350 },                                                       // Octocat waves hello (little arm overlay), cat bobs
  telegram:   { cls: "fly", dur: 1500, parts: [{ kind: "trail", n: 3, colors: ["#26A5E4"] }] },  // plane launches off, swoops back
  elevenlabs: { cls: "playmorph", dur: 1450 },                                                   // pause bars → play triangle → back to pause
  manus:      { cls: "fingers", dur: 1150 },                                                     // the hand's fingers wiggle, grip, release
  granola:    { cls: "drawspin", dur: 1200 },                                                    // the spiral draws itself in
  bluesky:    { cls: "flutter", dur: 1300 },                                                     // butterfly wing-flap + bob
  railway:    { cls: "zip", dur: 1200, parts: [{ kind: "line", n: 3, colors: ["#C68B7E"] }] },   // train zips through, speed lines
  supabase:   { cls: "crackle", dur: 1000, parts: [{ kind: "bolt", n: 4, colors: ["#3FCF8E", "#E8C9A0"] }] }, // bolt crackles with sparks
  shopify:    { cls: "bagfill", dur: 1500, parts: [{ kind: "drop", n: 3, colors: ["#7AB55C", "#E8C9A0", "#5E8E3E"] }] }, // items drop in one by one, bag plumps
  stripe:     { cls: "swipe", dur: 1000 },                                                       // quick card-swipe shine
  x:          { cls: "spinfast", dur: 900 },                                                     // fast spin
  slack:      { cls: "slackspin", dur: 1350 },                                                   // spins so fast it blurs into its 4 colours (conic swirl overlay), settles
  // Everyone else gets a tasteful signature move too — nobody stays static
  google:     { cls: "gparts", dur: 1600, pieces: 4 },                                           // the 4 brand-colour arcs of the G scatter apart, then recompose
  microsoft:  { cls: "mswin", dur: 1750, pieces: 4 },                                            // red/green/blue/yellow squares pop up ONE AT A TIME to build the window
  notion:     { cls: "scribble", dur: 1000 },                                                    // pencil-write wiggle
  figma:      { cls: "figparts", dur: 1650, pieces: 5 },                                         // its 5 coloured shapes fly in and assemble into the Figma mark
  perplexity: { cls: "breath", dur: 1200 },                                                      // springy shrink-then-grow breath
  heygen:     { cls: "throw", dur: 1250 },                                                       // winds up and hurls a projectile from its centre
  gamma:      { cls: "space", dur: 1800, parts: [{ kind: "rise", n: 2, colors: ["#9C6BFF", "#E8C9A0"] }] }, // zero-gravity float + slow tumble
  higgsfield: { cls: "slither", dur: 1300 },                                                     // the mark slithers like a snake (undulating wave)
  n8n:        { cls: "branch", dur: 1700, pieces: 5 },                                           // node dots + branch lines grow and connect into the mark
  make:       { cls: "mfall", dur: 1650, pieces: 3 },                                            // its three bolts fall away, then reassemble in formation
  gumloop:    { cls: "orbit", dur: 1300 },                                                      // a little loop-de-loop
  resend:     { cls: "tiltsend", dur: 1000, parts: [{ kind: "dart", n: 1, colors: ["#2C1508"] }] }, // letter whooshes off
  clickup:    { cls: "hophop", dur: 1100 },                                                     // cheerful double hop (it's an up-arrow)
  tavily:     { cls: "pulse", dur: 1100, parts: [{ kind: "ring", n: 2, colors: ["#1F6FEB"] }] }, // search sonar
  firecrawl:  { cls: "flare", dur: 1350, parts: [{ kind: "rise", n: 4, colors: ["#F97316", "#FDBA74"] }] }, // flame flares outward, embers rise, settles
  fireflies:  { cls: "riseup", dur: 1500, parts: [{ kind: "firefly", n: 3, colors: ["#FFE9A8"] }] }, // rises up, hovers, floats back to its spot
  vercel:     { cls: "launch", dur: 1100, parts: [{ kind: "burst", n: 3 }] },                    // the triangle lifts off
  pinecone:   { cls: "pendulum", dur: 1400 },                                                   // hangs and swings like a pinecone
  clay:       { cls: "melt", dur: 1450, parts: [{ kind: "drip", n: 2, colors: ["#C68B7E", "#D4A49A"] }] }, // melts/drips down, then reforms
  semrush:    { cls: "fireball", dur: 1550 },                                                   // rolls while its fireball keeps orbiting a beat
  blotato:    { cls: "pop", dur: 1100, parts: [{ kind: "burst", n: 4, colors: ["#6C4CF1", "#D4A49A"] }] }, // posts everywhere at once
  brain:      { cls: "pulse", dur: 1300, parts: [{ kind: "rise", n: 3 }] },                     // a warm think-pulse
  zapier:     { cls: "crackle", dur: 900, parts: [{ kind: "bolt", n: 3, colors: ["#FF4A00"] }] }, // zap!
  mcp:        { cls: "plug", dur: 1000 },                                                       // plugs in with a click
};

const FX_ELS = new Map<string, HTMLElement>();
const FX_BUSY = new Set<string>();

function fxSpawnParts(host: HTMLElement, spec: FxPartSpec): HTMLElement[] {
  const made: HTMLElement[] = [];
  const n = Math.min(spec.n ?? 3, 6); // hard cap per pattern
  const colors = spec.colors && spec.colors.length ? spec.colors : FX_WARM;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    s.className = `cx-fxp cx-fxp--${spec.kind}`;
    s.style.setProperty("--c", colors[i % colors.length]);
    let dx = 0, dy = 0, delay = 0;
    if (spec.kind === "burst") {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2 + (Math.random() - 0.5) * 0.7;
      const r = 14 + Math.random() * 9;
      dx = Math.cos(a) * r; dy = Math.sin(a) * r;
    } else if (spec.kind === "rise" || spec.kind === "firefly") {
      dx = (i - (n - 1) / 2) * 7 + (Math.random() - 0.5) * 5;
      delay = i * (spec.kind === "firefly" ? 160 : 100);
    } else if (spec.kind === "bolt") {
      dx = -11 + Math.random() * 22; dy = -11 + Math.random() * 22; delay = i * 90;
    } else if (spec.kind === "drop") {
      dx = (i - (n - 1) / 2) * 5; delay = i * 260;
    } else if (spec.kind === "drip") {
      dx = (i - (n - 1) / 2) * 8; delay = 220 + i * 190;
    } else if (spec.kind === "line") {
      dy = (i - (n - 1) / 2) * 7; delay = i * 70;
    } else if (spec.kind === "trail") {
      delay = i * 110;
    } else if (spec.kind === "ring") {
      delay = i * 180;
    }
    s.style.setProperty("--dx", `${dx.toFixed(1)}px`);
    s.style.setProperty("--dy", `${dy.toFixed(1)}px`);
    s.style.setProperty("--fd", `${delay}ms`);
    host.appendChild(s);
    made.push(s);
  }
  return made;
}

// One-shot play; guards against overlapping plays, self-cleans everything.
// Third-party brand-logo animations (the AI-provider "attacks" + the connector logo moves).
// OFF until Keak has permission/partnership to animate those marks. The full animation code
// below is intact and never runs while this is false (users never see it, so no trademark use).
// To restore EXACTLY as built: flip this to true and rebuild. Nothing else changes.
const LOGO_FX_ENABLED = false;

function playLogoFx(id: string) {
  if (!LOGO_FX_ENABLED) return;
  const el = FX_ELS.get(id);
  if (!el || FX_BUSY.has(id)) return;
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spec = LOGO_FX[id] || { cls: "pop", dur: 1000 };
  const cls = reduced ? "pulse" : spec.cls; // reduced motion → gentle pop, no projectiles
  const dur = reduced ? 600 : spec.dur;
  FX_BUSY.add(id);
  el.classList.add("cx-fx--play", `cx-fx--${cls}`);
  let made: HTMLElement[] = [];
  if (!reduced && spec.parts) for (const p of spec.parts) made = made.concat(fxSpawnParts(el, p));
  if (!reduced && spec.pieces) {
    // Brand-drawn overlay shapes (coloured logo parts); all styling lives in CSS.
    for (let i = 0; i < Math.min(spec.pieces, 6); i++) {
      const s = document.createElement("span");
      s.className = `cx-fxq cx-fxq--${spec.cls} cx-fxq--i${i + 1}`;
      el.appendChild(s);
      made.push(s);
    }
  }
  window.setTimeout(() => {
    el.classList.remove("cx-fx--play", `cx-fx--${cls}`);
    made.forEach((nd) => nd.remove());
    FX_BUSY.delete(id);
  }, dur + 80);
}

// Presentational wrapper around LogoBadge: registers the element so a fresh
// connect can celebrate it, and lets an already-CONNECTED logo replay its
// animation on hover or click (debounced; the play itself is guarded too).
function FxLogo({ id, slug, name, brand, on }: { id: string; slug?: string; name: string; brand?: string; on?: boolean }) {
  const lastHover = useRef(0);
  return (
    <span
      className={`cx-fx${on && LOGO_FX_ENABLED ? " cx-fx--on" : ""}`}
      ref={(el) => { if (el) FX_ELS.set(id, el); else FX_ELS.delete(id); }}
      onMouseEnter={() => { const now = Date.now(); if (now - lastHover.current < 450) return; lastHover.current = now; playLogoFx(id); }}
      onClick={() => { playLogoFx(id); }}
    >
      <LogoBadge id={id} slug={slug} name={name} brand={brand} />
    </span>
  );
}

const SECTIONS = [
  { id: "ai", label: "Your AI" },
  { id: "agents", label: "Agents" },
  { id: "brain", label: "Second Brain" },
  { id: "routines", label: "Routines" },
  { id: "connections", label: "Connections" },
  { id: "recap", label: "Recap" },
  { id: "team", label: "Team" },
  { id: "work", label: "Work" },
  { id: "personality", label: "Personality" },
  { id: "settings", label: "Settings" },
  { id: "help", label: "Help" },
];

type ChatArtifact = { label: string; path: string };
type ChatMsg = { role: "user" | "assistant"; text: string; ts: number; artifacts?: ChatArtifact[] };
type ChatTool = { tool: string; path?: string; query?: string; content?: string; filename?: string; message?: string; server?: string; name?: string; args?: any };
type AgentRun = { ts: number; job: string; results: { name: string; title: string; output: string; color?: string }[]; messages?: ChatMsg[]; model?: string; agent?: string; goal?: string; skill?: string };

// Resolve the connected AI (optionally a specific "provider|model" choice) into the args cu_chat needs.
function resolveChatAI(choice: string): { provider: string; credential: string; accountId: string; isSub: boolean; model: string; effort: string } | null {
  const prov = choice ? choice.split("|")[0] : (localStorage.getItem("keak_cu_provider") || "");
  if (!prov) return null;
  let credential = "", accountId = "", isSub = false;
  if (prov === "openai") {
    const sub = localStorage.getItem("keak_cu_openai_token") || "";
    if (sub) { credential = sub; accountId = localStorage.getItem("keak_cu_openai_account") || ""; isSub = true; }
    else credential = localStorage.getItem("keak_cu_openai_key") || "";
  } else if (prov === "gemini") credential = localStorage.getItem("keak_cu_gemini_key") || "";
  else if (prov === "claude") credential = localStorage.getItem("keak_cu_claude_token") || "";
  else if (prov === "ollama") credential = "local";
  else if (prov === "copilot") credential = localStorage.getItem("keak_cu_copilot_token") || "";
  else credential = localStorage.getItem(`keak_cu_${prov}_key`) || "";
  if (!credential) return null;
  const model = choice ? (choice.split("|")[1] || "") : (localStorage.getItem(`keak_cu_${prov}_model`) || "");
  // Default Claude to LOW effort in chat — heavier effort on a subscription token rate-limits fast.
  const effort = prov === "claude" ? (localStorage.getItem("keak_cu_claude_effort") || "low") : "";
  return { provider: prov, credential, accountId, isSub, model, effort };
}
// Keak Recap: the transcribe endpoint (same backend the overlay uses) + a base64->Blob helper for the WAV
// chunks Rust hands back.
const RECAP_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "https://c--8d6c4aab-d6cd-4281-ad41-da14196d68fc-prod.lovable.cloud") as string;
function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
// System prompt for the text chat, honouring the interface language. If an agent is chosen, take on its persona.
function chatSystem(agent?: { name: string; description?: string; personality?: string }): string {
  const uiCode = localStorage.getItem("keak_ui_lang") || "en";
  const LN: Record<string, string> = { es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian" };
  const lang = uiCode !== "en" && LN[uiCode] ? ` Reply in ${LN[uiCode]} unless the user writes to you in another language.` : "";
  if (agent && agent.name) {
    return `You are ${agent.name}${agent.description ? `, ${agent.description}` : ""}.${agent.personality ? ` ${agent.personality}` : ""} You are chatting with the user by text inside the Keak app. Be clear, direct and genuinely helpful, and stay in character. You can use light markdown.${lang}`;
  }
  const name = localStorage.getItem("keak_assistant_name") || "Keak";
  return `You are ${name}, a helpful AI assistant chatting with the user by text inside the Keak app. Be clear, direct and genuinely helpful. You can use light markdown.${lang}`;
}
// ---- Agentic chat ----
// The plain chat used to call the model once and hand back text, so the model correctly said "I can't create
// files." Now the chat is a real agent: it can read/search/edit the connected Second Brain folder AND create
// artifacts (HTML pages, documents, notes, CSV/JSON/SVG…), on ANY connected model. The model replies with ONE
// small JSON tool call, Keak runs it against the sandboxed folder tools, feeds the result back, and loops until
// the model says it's done. That is what makes "make me a doc / website / PDF about X" actually produce a file.
function chatToolSystem(base: string, root: string, perm: string, tree: string, webOn: boolean, mcpOn: boolean): string {
  const canWrite = !!root && perm !== "read";
  const folder = root
    ? `You have the user's connected Second Brain folder (a local files-and-folders workspace). Its structure (relative paths, folders end with /):\n${tree}\nFolder permission: ${perm}. `
    : `No Second Brain folder is connected right now, but you can still create standalone artifact files for the user. `;
  return `${base}

You are an agent with tools, and you CAN read files, search, create files, edit files${webOn ? ", search the live web" : ""}, and produce artifacts (HTML pages, documents, reports, notes, CSV/JSON data, SVG, etc.). NEVER tell the user you are unable to create a file, a document, a PDF, or a website. You create them with the tools below. When the user names a skill (like /watch, or any skill saved in their Second Brain), FIRST use search + read to find that skill's SKILL.md in the connected folder, read it, and follow its steps with your tools. You can use ANYTHING in the connected folder: skills, notes, projects, files. If one step needs something you genuinely cannot do (download or watch a video, run code, control another app), do every part you CAN${webOn ? ", use web search where it helps," : ","} and clearly say the single part you couldn't, then still deliver a useful result. Never refuse and never dead-end.

${folder}To use a tool, reply with ONLY a single JSON object and nothing else (no prose, no code fences):
{"tool":"list","path":"folder or empty for the root"}
{"tool":"read","path":"relative/path.ext"}
{"tool":"search","query":"keyword"}
${webOn ? `{"tool":"web","query":"what to look up online"}
` : ""}${mcpOn ? `{"tool":"mcp","server":"<server name>","name":"<tool name>","args":{ }}
` : ""}${canWrite ? `{"tool":"write","path":"relative/path.ext","content":"the COMPLETE file content"}
{"tool":"mkdir","path":"relative/folder"}
` : ""}{"tool":"artifact","filename":"name.html","content":"the COMPLETE file content"}
{"tool":"done","message":"your final answer to the user, in plain language"}

Rules: emit ONE tool per reply. You have only a few steps, so be efficient: gather just what you truly need (usually 1 to 3 reads/searches), NEVER repeat the same search or read, then create the file and finish. For a document or report, make an .html or .md artifact; for a website, an .html artifact; for a PDF, make a clean print-ready .html artifact (the user opens it and saves as PDF with Ctrl+P). "write" saves inside the Second Brain folder; "artifact" hands the user a standalone file. Content must always be the full file, never a placeholder. Finish with "done" and tell the user what you made. If the request is just a normal question that needs no files, answer it directly in prose (no JSON).`;
}
const CHAT_TOOLS = ["list", "read", "search", "write", "mkdir", "artifact", "web", "mcp", "done"];
// Pull out every {...} object in a string, respecting quoted strings so file content with braces doesn't break it.
function scanJsonObjects(s: string): any[] {
  const out: any[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    try { out.push(JSON.parse(s.slice(i, j))); } catch { /* not valid JSON, keep scanning */ }
    i = j - 1;
  }
  return out;
}
// A reply is a tool call if it contains a JSON object whose "tool" is one of our known tools — even if the model
// (esp. weaker ones like Haiku) prefaced it with prose. The known-tool whitelist stops normal answers that
// happen to include braces from being misread as a tool call.
function parseChatTool(reply: string): ChatTool | null {
  const s = (reply || "").trim();
  for (const o of scanJsonObjects(s)) {
    if (o && typeof o.tool === "string" && CHAT_TOOLS.includes(o.tool)) return o as ChatTool;
  }
  return null;
}
// A short human label for the live "what is it doing" status line while the agent works.
function chatToolLabel(tool: ChatTool): string {
  const p = tool.path || "";
  switch (tool.tool) {
    case "read": return `Reading ${p}…`;
    case "list": return `Opening ${p || "your Second Brain"}…`;
    case "search": return `Searching “${tool.query || ""}”…`;
    case "web": return `Searching the web for “${tool.query || ""}”…`;
    case "mcp": return `Using ${tool.server || "an MCP tool"} · ${tool.name || ""}…`;
    case "write": return `Writing ${p}…`;
    case "mkdir": return `Creating ${p}…`;
    case "artifact": return `Creating ${tool.filename || "file"}…`;
    default: return "Working…";
  }
}
// Run one tool against the sandboxed Rust commands. Returns text to feed back to the model (+ any artifact).
async function execChatTool(tool: ChatTool, root: string, perm: string): Promise<{ result: string; artifact?: ChatArtifact }> {
  const path = String(tool.path || "");
  try {
    switch (tool.tool) {
      case "list": {
        const raw = await invoke<string>("sb_tree", { args: { root, maxDepth: path ? 3 : 2, maxEntries: 500 } });
        const items = JSON.parse(raw) as string[];
        const shown = path ? items.filter((x) => x.startsWith(path.replace(/^\/+|\/+$/g, "") + "/")) : items;
        return { result: shown.join("\n").slice(0, 6000) || "(empty)" };
      }
      case "search": {
        const raw = await invoke<string>("sb_search", { args: { root, query: String(tool.query || ""), maxResults: 25 } });
        const hits = JSON.parse(raw) as { path: string; snippet: string }[];
        return { result: hits.map((h) => `${h.path}${h.snippet ? `\n  ${h.snippet}` : ""}`).join("\n").slice(0, 6000) || "(no matches)" };
      }
      case "read": {
        const res = await invoke<string>("sb_read", { args: { root, path } });
        return { result: res.slice(0, 8000) };
      }
      case "write": {
        const full = await invoke<string>("sb_write", { args: { root, path, content: String(tool.content || ""), perm } });
        return { result: `Saved ${path}`, artifact: { label: path, path: full } };
      }
      case "mkdir": {
        await invoke<string>("sb_mkdir", { args: { root, path, perm } });
        return { result: `Created folder ${path}` };
      }
      case "artifact": {
        const fname = String(tool.filename || "artifact.txt");
        const full = await invoke<string>("save_artifact", { name: fname, content: String(tool.content || "") });
        return { result: `Created ${fname}`, artifact: { label: fname, path: full } };
      }
      case "web": {
        const key = localStorage.getItem("keak_tool_perplexity") || "";
        if (!key) return { result: "No web-search connection. The user can connect Perplexity in Connections to enable live web search." };
        const res = await invoke<string>("perplexity_ask", { args: { apiKey: key, query: String(tool.query || ""), model: "" } });
        return { result: (res || "").slice(0, 6000) };
      }
      case "mcp": {
        const servers = readMcpServers().filter((x) => x.enabled);
        const srv = servers.find((x) => x.name === tool.server) || servers.find((x) => (x.tools || []).some((tt) => tt.name === tool.name));
        if (!srv) return { result: `No connected MCP server named "${tool.server}".` };
        const out = await mcpCallTool(srv, String(tool.name || ""), tool.args || {});
        return { result: (out || "").slice(0, 6000) };
      }
      default:
        return { result: `Unknown tool "${tool.tool}"` };
    }
  } catch (e) {
    return { result: `ERROR: ${String(e).slice(0, 200)}` };
  }
}

// The message thread for a run: its stored chat, or one synthesised from the legacy job + answer.
function runMessages(run: AgentRun): ChatMsg[] {
  if (run.messages && run.messages.length) return run.messages;
  const out: ChatMsg[] = [{ role: "user", text: run.job, ts: run.ts }];
  const ans = (run.results || []).map((r) => r.output).filter(Boolean).join("\n\n");
  if (ans) out.push({ role: "assistant", text: ans, ts: run.ts });
  return out;
}

// Strip markdown markers so agent output reads cleanly in the work log.
function cleanAgentText(s: string): string {
  return (s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`(.+?)`/g, "$1").replace(/^\s*#{1,6}\s+/gm, "");
}
function isHtmlOutput(s: string): boolean {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test((s || "").trim());
}
// Render the recap as proper formatted text (headings, bullets, bold) instead of raw "###" and "**".
function inlineMd(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { if (m.index > last) out.push(s.slice(last, m.index)); out.push(<strong key={m.index}>{m[1]}</strong>); last = m.index + m[0].length; }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function RecapText({ text }: { text: string }) {
  return (
    <div style={{ lineHeight: 1.55, color: "#3a2a12" }}>
      {(text || "").split("\n").map((line, i) => {
        const h = line.match(/^\s*#{1,6}\s+(.*)$/);
        if (h) return <div key={i} style={{ fontWeight: 800, fontSize: 15, marginTop: 14, marginBottom: 4, color: "#2C1508" }}>{inlineMd(h[1])}</div>;
        const b = line.match(/^\s*[-*]\s+(.*)$/);
        if (b) return <div key={i} style={{ margin: "3px 0 3px 4px", display: "flex", gap: 8 }}><span style={{ color: "#C68B7E" }}>•</span><span>{inlineMd(b[1])}</span></div>;
        const num = line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (num) return <div key={i} style={{ margin: "3px 0 3px 4px" }}>{num[1]}. {inlineMd(num[2])}</div>;
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        return <div key={i} style={{ marginBottom: 4 }}>{inlineMd(line)}</div>;
      })}
    </div>
  );
}

// Group runs into day buckets ("Today", "Yesterday", or a date) — like the chat list in Claude/ChatGPT.
const DATE_LOCALE: Record<string, string> = { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-PT", it: "it-IT" };
function dayLabel(ts: number): string {
  const lang = getUiLang();
  const loc = DATE_LOCALE[lang] || undefined;
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days <= 0) return tr(lang, "Today");
  if (days === 1) return tr(lang, "Yesterday");
  if (days < 7) return d.toLocaleDateString(loc, { weekday: "long" });
  return d.toLocaleDateString(loc, { month: "short", day: "numeric" });
}
function clockLabel(ts: number): string {
  try { return new Date(ts).toLocaleTimeString(DATE_LOCALE[getUiLang()] || undefined, { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}
// Split a recent-first run list into ordered day sections for the chat sidebar.
function groupByDay(runs: AgentRun[]): { label: string; runs: { run: AgentRun; idx: number }[] }[] {
  const out: { label: string; runs: { run: AgentRun; idx: number }[] }[] = [];
  runs.forEach((run, idx) => {
    const label = dayLabel(run.ts);
    let bucket = out[out.length - 1];
    if (!bucket || bucket.label !== label) { bucket = { label, runs: [] }; out.push(bucket); }
    bucket.runs.push({ run, idx });
  });
  return out;
}

// Model choices for agents, stored as "provider|model" (or "" = team default / main Keak AI). Lets each
// agent run on a different model, even a different company, as long as that provider is connected.
const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "Team default" },
  { value: "claude|claude-opus-4-8", label: "Claude · Opus 4.8" },
  { value: "claude|claude-sonnet-5", label: "Claude · Sonnet 5" },
  { value: "claude|claude-sonnet-4-6", label: "Claude · Sonnet 4.6 (cheaper)" },
  { value: "claude|claude-haiku-4-5", label: "Claude · Haiku 4.5 (cheapest)" },
  { value: "claude|claude-fable-5", label: "Claude · Fable 5" },
  { value: "openai|gpt-5", label: "ChatGPT · GPT-5" },
  { value: "openai|gpt-4o", label: "ChatGPT · GPT-4o" },
  { value: "gemini|gemini-3.5-flash", label: "Gemini · 3.5 Flash" },
  { value: "copilot|", label: "Copilot" },
  { value: "xai|grok-4", label: "Grok · 4" },
  { value: "xai|grok-3", label: "Grok · 3" },
  { value: "deepseek|deepseek-chat", label: "DeepSeek · Chat" },
  { value: "deepseek|deepseek-reasoner", label: "DeepSeek · Reasoner" },
  { value: "kimi|kimi-k3", label: "Kimi · K3" },
  { value: "kimi|kimi-k2-0711-preview", label: "Kimi · K2" },
  { value: "mistral|mistral-large-latest", label: "Mistral · Large" },
  { value: "ollama|", label: "Local (Ollama)" },
];
function choiceLabel(value: string): string {
  return MODEL_CHOICES.find((c) => c.value === value)?.label || "Team default";
}

// A model's real context window (tokens), used for the per-chat "how full is this chat" meter.
function modelContextLimit(choice: string): number {
  const [prov, model = ""] = (choice || "").split("|");
  const m = model.toLowerCase();
  if (prov === "claude") return m.includes("haiku") ? 200000 : 1000000;
  if (prov === "openai") return 128000;
  if (prov === "gemini") return 1000000;
  if (prov === "xai") return 131072;
  if (prov === "deepseek") return 65536;
  if (prov === "kimi") return 131072;
  if (prov === "mistral") return 128000;
  if (prov === "ollama") return 8192;
  if (prov === "copilot") return 128000;
  return 128000;
}
// Rough token estimate (~4 chars/token) — good enough for a fill meter.
function estimateTokens(msgs: ChatMsg[]): number {
  return Math.round(msgs.reduce((a, m) => a + (m.text || "").length, 0) / 4);
}
function fmtTokens(n: number): string { return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`; }

// Caps on how many the user can create. Not shown anywhere; a message only appears when they hit the limit.
const MAX_AGENTS = 10;
const MAX_ROUTINES = 10;

// Slash commands available in the Work chat. `arg` = the command expects text after it (agent/skill/goal/model).
const SLASH_COMMANDS: { cmd: string; desc: string; arg?: boolean }[] = [
  { cmd: "/new", desc: "Start a new chat" },
  { cmd: "/clear", desc: "Clear this chat" },
  { cmd: "/agent", desc: "Talk to one of your agents", arg: true },
  { cmd: "/skill", desc: "Use a skill from your Second Brain", arg: true },
  { cmd: "/goal", desc: "Set a goal for this chat", arg: true },
  { cmd: "/model", desc: "Switch the model", arg: true },
  { cmd: "/compact", desc: "Summarise to save context" },
];

// The models the user has actually connected, as "provider|model" choices — used by the routine "Run it with"
// picker so they can send a routine to a specific model (Claude Haiku, GPT-4o, a local model, …).
function connectedModelChoices(): { value: string; label: string }[] {
  const has = (k: string) => !!localStorage.getItem(k);
  const connected: Record<string, boolean> = {
    claude: has("keak_cu_claude_token"),
    openai: has("keak_cu_openai_token") || has("keak_cu_openai_key"),
    gemini: has("keak_cu_gemini_key"),
    copilot: has("keak_cu_copilot_token"),
    xai: has("keak_cu_xai_key"),
    deepseek: has("keak_cu_deepseek_key"),
    kimi: has("keak_cu_kimi_key"),
    mistral: has("keak_cu_mistral_key"),
  };
  const out: { value: string; label: string }[] = [{ value: "", label: "Default AI" }];
  for (const c of MODEL_CHOICES) {
    if (!c.value) continue;
    const provider = c.value.split("|")[0];
    if (provider === "ollama") continue; // local models are dynamic, added below
    if (connected[provider]) out.push(c);
  }
  try {
    const raw = localStorage.getItem("keak_cu_ollama_models");
    let list: string[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list) || !list.length) { const single = localStorage.getItem("keak_cu_ollama_model"); list = single ? [single] : []; }
    for (const m of list) out.push({ value: `ollama|${m}`, label: `Local · ${m}` });
  } catch { /* ignore */ }
  return out;
}

// A 0-100 personality dial (Humor, Warmth, etc.). Writes to localStorage; the overlay reads it into the
// Keak AI system prompt via personaLines().
function Dial({ label, value, onChange, bands }: { label: string; value: number; onChange: (v: number) => void; bands: [string, string, string, string] }) {
  const desc = value < 16 ? bands[0] : value < 41 ? bands[1] : value < 71 ? bands[2] : bands[3];
  return (
    // --kx-dial (0..1) drives the little mood orb: its size + glow grow with the value.
    <div className="cx-dial" style={{ "--kx-dial": value / 100 } as CSSProperties}>
      <div className="cx-dial-head">
        <span className="cx-dial-name"><i className="cx-dial-orb" aria-hidden="true" />{label}</span>
        <span className="cx-dial-val">{value}</span>
      </div>
      <input
        className="cx-range"
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={{ background: `linear-gradient(to right, #CE968A 0%, #D8A093 ${value}%, rgba(44,21,8,0.12) ${value}%, rgba(44,21,8,0.12) 100%)` }}
      />
      {/* keyed by the band text so crossing into a new band replays the shimmer-in */}
      <span className="cx-dial-desc" key={desc}>{desc}</span>
    </div>
  );
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/* ------------------------------------------------------------------ *
   Visual system — inline SVG icon sets (nav, providers, settings) and
   the section hero / medallion shells. Pure presentation: no state, no
   handlers, no i18n of its own — every t() call stays where it was.
 * ------------------------------------------------------------------ */

// One crisp hairline icon per sidebar section, keyed by SECTIONS id.
const NAV_ICONS: Record<string, ReactNode> = {
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v4.2M12 16.8V21M3 12h4.2M16.8 12H21" />
      <path d="M12 8.9c.55 1.5 1.55 2.5 3.1 3.1-1.55.6-2.55 1.6-3.1 3.1-.55-1.5-1.55-2.5-3.1-3.1 1.55-.6 2.55-1.6 3.1-3.1z" fill="currentColor" stroke="none" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M7.6 15L10.9 8.2M14 7.6l3.5 4.9M8.3 17.1h8" opacity="0.55" />
      <circle cx="6.2" cy="17.2" r="2.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="5.8" r="2.3" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="14.4" r="2.3" fill="currentColor" stroke="none" />
    </svg>
  ),
  brain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.3c0-1.1.9-2 2-2h3.9l2 2.4h7.1c1.1 0 2 .9 2 2v7.9c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.3z" />
      <path d="M3.5 11h17" opacity="0.45" />
    </svg>
  ),
  routines: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3.2 2.1" />
    </svg>
  ),
  connections: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.2 6.8V3.4M14.8 6.8V3.4" />
      <path d="M7.4 6.8h9.2v3.6a4.6 4.6 0 01-9.2 0V6.8z" />
      <path d="M12 15v2.6a3.1 3.1 0 01-3.1 3.1" />
    </svg>
  ),
  recap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 7.2v9.6M12 4.4v15.2M16 7.2v9.6M20 10v4" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8.6" r="3.1" />
      <path d="M3.6 19.2c.7-3 2.9-4.7 5.4-4.7s4.7 1.7 5.4 4.7" />
      <circle cx="16.6" cy="9.4" r="2.4" opacity="0.6" />
      <path d="M15.6 14.7c2.2.1 4 1.6 4.7 4.1" opacity="0.6" />
    </svg>
  ),
  work: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7.2c0-1.4 1.1-2.5 2.5-2.5h11c1.4 0 2.5 1.1 2.5 2.5v7c0 1.4-1.1 2.5-2.5 2.5H10l-4.2 3.4v-3.4H6.5C5.1 16.7 4 15.6 4 14.2v-7z" />
      <path d="M8.4 9.6h7.2M8.4 12.6h4.6" opacity="0.5" />
    </svg>
  ),
  personality: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7.4h16M4 12h16M4 16.6h16" opacity="0.4" />
      <circle cx="9.4" cy="7.4" r="2" fill="currentColor" stroke="none" />
      <circle cx="15.2" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="7.2" cy="16.6" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.9v2.5M12 18.6v2.5M2.9 12h2.5M18.6 12h2.5M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
    </svg>
  ),
  help: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.6 9.4c.2-1.3 1.2-2.2 2.5-2.2 1.4 0 2.5 1 2.5 2.3 0 1.9-2.6 2-2.6 3.9" />
      <circle cx="12" cy="16.7" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  ),
};

// Simple, recognizable brand marks for the "Your AI" picker — drawn in-house,
// monochrome (currentColor) so they always sit in the Keak palette.
const PROVIDER_MARKS: Record<string, ReactNode> = {
  // Real brand logos from Pep's files, shown in white app-icon tiles (see .cx-provider-logo).
  claude: <img className="cx-provider-logo" src="/logos/claude.png" alt="" />,
  openai: <img className="cx-provider-logo" src="/logos/openai.png" alt="" />,
  gemini: ( // four-point spark — kept as SVG (Pep confirmed this one is good)
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.4c.85 5.1 4.5 8.75 9.6 9.6-5.1.85-8.75 4.5-9.6 9.6-.85-5.1-4.5-8.75-9.6-9.6 5.1-.85 8.75-4.5 9.6-9.6z" />
    </svg>
  ),
  copilot: <img className="cx-provider-logo" src="/logos/copilot.png" alt="" />,
  xai: <img className="cx-provider-logo" src="/logos/xai.png" alt="" />,
  deepseek: <img className="cx-provider-logo" src="/logos/deepseek.png" alt="" />,
  kimi: ( // crescent moon — Moonshot AI / Kimi mark
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9 7 7 0 1 1-9-9z" />
    </svg>
  ),
  mistral: <img className="cx-provider-logo" src="/logos/mistral.png" alt="" />,
  ollama: <img className="cx-provider-logo" src="/logos/ollama.png" alt="" />,
};

// The provider cards in "Your AI" — same ids the pickProvider handler expects.
const PROVIDER_CARDS: { id: string; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "openai", name: "ChatGPT" },
  { id: "gemini", name: "Gemini" },
  { id: "copilot", name: "Copilot" },
  { id: "xai", name: "Grok" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "kimi", name: "Kimi" },
  { id: "mistral", name: "Mistral" },
  { id: "ollama", name: "Local" },
];

// ================= PROVIDER ATTACK SHOW (presentational only) ================
// When the chosen provider changes, its card plays a playful signature move and
// brand-matched cartoon projectiles fly to the other cards, which react. This
// never touches pickProvider / provider state — it only *watches* the change.
// Every node and class self-cleans in ~2s; the whole show is skippable (calm
// glow only) under prefers-reduced-motion.
const ATK_FX_CLASSES = [
  "cx-atk-win", "cx-atk-calm",
  "cx-atk-win--lunge", "cx-atk-win--burst", "cx-atk-win--spin", "cx-atk-win--shoot",
  "cx-atk-win--slam", "cx-atk-win--jab", "cx-atk-win--fling", "cx-atk-win--wave",
  "cx-hit-splat", "cx-hit-crush", "cx-hit-bonk", "cx-hit-recoil",
  "cx-hit-jab", "cx-hit-weight", "cx-hit-flood",
];
const ATK_WIND_UP: Record<string, string> = {
  ollama: "lunge", claude: "burst", openai: "spin", gemini: "shoot",
  copilot: "slam", xai: "jab", mistral: "fling", deepseek: "wave", kimi: "sweep",
};

function playProviderAttack(grid: HTMLElement | null, id: string): () => void {
  const noop = () => {};
  if (!LOGO_FX_ENABLED || !grid) return noop;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>(".cx-provider-card"));
  const idx = PROVIDER_CARDS.findIndex((p) => p.id === id);
  const winner = cards[idx];
  if (!winner || cards.length < 2) return noop;

  const timers: number[] = [];
  const anims: Animation[] = [];
  const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };

  // Calm mode: no projectiles — just a gentle glow on the chosen card.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    winner.classList.add("cx-atk-calm");
    later(() => winner.classList.remove("cx-atk-calm"), 900);
    return () => { timers.forEach(clearTimeout); winner.classList.remove("cx-atk-calm"); };
  }

  // Overlay over the grid: projectiles live here, never inside the buttons.
  const layer = document.createElement("div");
  layer.className = "cx-attack-layer";
  grid.appendChild(layer);

  const gr = grid.getBoundingClientRect();
  const spot = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - gr.left + r.width / 2, y: r.top - gr.top + r.height / 2, w: r.width, h: r.height, left: r.left - gr.left, top: r.top - gr.top };
  };
  const from = spot(winner);
  const targets = cards
    .map((card, i) => ({ card, i }))
    .filter((e) => e.i !== idx)
    .slice(0, 7) // hard cap on victims → capped projectile count
    .map((e) => ({ card: e.card, at: spot(e.card) }));

  const hit = (card: HTMLElement, cls: string, ms: number) => {
    card.classList.add(cls);
    later(() => card.classList.remove(cls), ms);
  };
  // Park a short-lived aftermath element at a spot; look + exit is pure CSS.
  const leave = (cls: string, x: number, y: number, life: number, rot = 0) => {
    const el = document.createElement("i");
    el.className = `cx-proj ${cls}`;
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    if (rot) el.style.setProperty("--proj-rot", `${rot}deg`);
    layer.appendChild(el);
    later(() => el.remove(), life);
  };
  // Fly a projectile from the winner to (x, y) with the Web Animations API.
  const fly = (
    cls: string,
    to: { x: number; y: number },
    o: { delay?: number; dur?: number; rot?: number; spin?: number; arc?: number },
    onHit?: () => void,
  ) => {
    const el = document.createElement("i");
    el.className = `cx-proj ${cls}`;
    el.style.left = `${from.x}px`; el.style.top = `${from.y}px`;
    layer.appendChild(el);
    const dx = to.x - from.x, dy = to.y - from.y;
    const rot = o.rot ?? 0, spin = o.spin ?? 0, arc = o.arc ?? 0;
    const a = el.animate([
      { transform: `translate(-50%, -50%) rotate(${rot}deg) scale(0.5)`, opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { transform: `translate(-50%, -50%) translate(${(dx * 0.5).toFixed(1)}px, ${(dy * 0.5 - arc).toFixed(1)}px) rotate(${rot + spin * 0.5}deg) scale(1)`, offset: 0.5 },
      { transform: `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot + spin}deg) scale(1)`, opacity: 1 },
    ], { duration: o.dur ?? 420, delay: o.delay ?? 0, easing: "cubic-bezier(0.35, 0, 0.75, 1)", fill: "backwards" });
    anims.push(a);
    a.onfinish = () => { el.remove(); onHit?.(); };
  };

  winner.classList.add("cx-atk-win", `cx-atk-win--${ATK_WIND_UP[id] || "burst"}`);

  switch (id) {
    case "ollama": // the llama juts forward and SPITS — droplets dribble down the rivals
      targets.forEach(({ card, at }, i) => {
        fly("cx-proj--spit", { x: at.x, y: at.y - 12 }, { delay: 240 + i * 50, dur: 380, arc: 30 }, () => {
          hit(card, "cx-hit-splat", 520);
          leave("cx-proj--dribble", at.x + (i % 2 ? 5 : -4), at.y - 10, 1150);
        });
      });
      break;
    case "claude": // rose sun-ray shards burst out and gently CRUSH the rivals
      targets.forEach(({ card, at }, i) => {
        const ang = Math.round((Math.atan2(at.y - from.y, at.x - from.x) * 180) / Math.PI);
        fly("cx-proj--shard", at, { delay: 170 + i * 40, dur: 340, rot: ang }, () => hit(card, "cx-hit-crush", 620));
      });
      break;
    case "openai": // spins up fast and flings knot-loops that BONK the rivals
      targets.forEach(({ card, at }, i) => {
        fly("cx-proj--ring", at, { delay: 260 + i * 45, dur: 400, spin: 540, arc: 18 }, () => hit(card, "cx-hit-bonk", 560));
      });
      break;
    case "gemini": // twirls, then quick-draws its 4-point star — pew pew pew
      targets.forEach(({ card, at }, i) => {
        fly("cx-proj--star", at, { delay: 330 + i * 85, dur: 240, spin: 360 }, () => {
          hit(card, "cx-hit-recoil", 420);
          leave("cx-proj--pop", at.x, at.y - 8, 400);
        });
      });
      break;
    case "copilot": // strikes DOWN — the slam quakes every other card
      later(() => {
        grid.classList.add("cx-quake");
        later(() => grid.classList.remove("cx-quake"), 720);
      }, 430);
      break;
    case "xai": // jabs its two slashes out; they stick upright as warning marks, then fade
      targets.forEach(({ card, at }, i) => {
        ([-1, 1] as const).forEach((s, k) => {
          fly("cx-proj--slash", { x: at.x + s * 17, y: at.y - 8 }, { delay: 180 + i * 40 + k * 60, dur: 300, rot: s * 9 }, () => {
            if (k === 0) hit(card, "cx-hit-jab", 380);
            leave("cx-proj--slashmark", at.x + s * 17, at.y - 8, 950, s * 9);
          });
        });
      });
      break;
    case "mistral": // flings little orange squares that stack on everyone's head, then drop off
      targets.forEach(({ card, at }, i) => {
        const headY = at.top + 10;
        ([-1, 1] as const).forEach((s, k) => {
          fly("cx-proj--brick", { x: at.x + s * 5, y: headY - (k ? 8 : 0) }, { delay: 220 + i * 45 + k * 90, dur: 360, arc: 34, spin: 180 }, () => {
            if (k === 0) hit(card, "cx-hit-weight", 520);
            leave("cx-proj--brickrest", at.x + s * 5, headY - (k ? 8 : 0), 1000);
          });
        });
      });
      break;
    case "deepseek": { // a wave rolls out — rivals get gently flooded and their logos bob
      const sorted = [...targets].sort((a, b) =>
        (Math.abs(a.at.x - from.x) + Math.abs(a.at.y - from.y)) - (Math.abs(b.at.x - from.x) + Math.abs(b.at.y - from.y)));
      sorted.forEach(({ card, at }, i) => {
        later(() => {
          const fl = document.createElement("i");
          fl.className = "cx-flood";
          fl.style.left = `${at.left}px`; fl.style.top = `${at.top}px`;
          fl.style.width = `${at.w}px`; fl.style.height = `${at.h}px`;
          layer.appendChild(fl);
          hit(card, "cx-hit-flood", 1350);
          later(() => fl.remove(), 1400);
        }, 260 + i * 110);
      });
      break;
    }
    default:
      break;
  }

  const cleanup = () => {
    timers.forEach(clearTimeout); timers.length = 0;
    anims.forEach((a) => { try { a.cancel(); } catch { /* already done */ } });
    layer.remove();
    grid.classList.remove("cx-quake");
    cards.forEach((c) => c.classList.remove(...ATK_FX_CLASSES));
  };
  later(cleanup, 2600); // the whole show self-cleans even if nothing interrupts it
  return cleanup;
}

// Small duotone icons for the Settings cards, so each group reads at a glance.
const SET_ICONS: Record<string, ReactNode> = {
  globe: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8M12 3.6c2.3 2.2 3.5 5.1 3.5 8.4s-1.2 6.2-3.5 8.4c-2.3-2.2-3.5-5.1-3.5-8.4s1.2-6.2 3.5-8.4z" opacity="0.6" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9.2" y="3.4" width="5.6" height="10.2" rx="2.8" />
      <path d="M5.8 11.4a6.2 6.2 0 0012.4 0M12 17.6v3" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.4l7 2.6v5.3c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6z" />
      <path d="M9.2 12l2 2 3.6-3.8" opacity="0.7" />
    </svg>
  ),
  speaker: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9.4v5.2h3.4L12.4 19V5L7.4 9.4H4z" />
      <path d="M15.4 9.2a4 4 0 010 5.6M18 6.8a7.4 7.4 0 010 10.4" opacity="0.6" />
    </svg>
  ),
  captions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="3" />
      <path d="M10.4 10.6c-.5-.6-1.2-.9-2-.9-1.5 0-2.6 1-2.6 2.3s1.1 2.3 2.6 2.3c.8 0 1.5-.3 2-.9M18.2 10.6c-.5-.6-1.2-.9-2-.9-1.5 0-2.6 1-2.6 2.3s1.1 2.3 2.6 2.3c.8 0 1.5-.3 2-.9" opacity="0.7" />
    </svg>
  ),
  power: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3.6v7.4" />
      <path d="M7.2 6.6a7.6 7.6 0 109.6 0" />
    </svg>
  ),
};

// A section's opening spread: rose medallion + the (unchanged) eyebrow/title/lead.
function SectionHero({ id, children }: { id: string; children: ReactNode }) {
  return (
    <header className={`cx-secthero cx-secthero--${id}`}>
      <span className="cx-medallion" aria-hidden="true">{NAV_ICONS[id] || NAV_ICONS.ai}</span>
      <div className="cx-secthero-text">{children}</div>
    </header>
  );
}

// Compact header row for the Settings cards — small medallion, same type.
function MiniHead({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <header className="cx-secthero cx-secthero--row">
      <span className="cx-medallion cx-medallion--sm" aria-hidden="true">{icon}</span>
      <div className="cx-secthero-text">{children}</div>
    </header>
  );
}

// Native "Connect your AI" window (opened from the Keak tray). It lives at the same origin as the
// overlay, so everything it writes to localStorage (provider, tokens, action mode, captions) is read
// straight back by the screen agent in the overlay. The keak.app dashboard can't do this because a
// website can't reach the native ChatGPT login or move the mouse.
export default function Connect() {
  const [cuProvider, setCuProvider] = useState<string>(() => localStorage.getItem("keak_cu_provider") || "claude");
  const [claudeToken, setClaudeToken] = useState<string>(() => localStorage.getItem("keak_cu_claude_token") || "");
  const [openaiKey, setOpenaiKey] = useState<string>(() => localStorage.getItem("keak_cu_openai_key") || "");
  const [openaiToken, setOpenaiToken] = useState<string>(() => localStorage.getItem("keak_cu_openai_token") || "");
  const [openaiUserCode, setOpenaiUserCode] = useState<string>("");
  const [geminiKey, setGeminiKey] = useState<string>(() => localStorage.getItem("keak_cu_gemini_key") || "");
  const [ollamaModel, setOllamaModel] = useState<string>(() => localStorage.getItem("keak_cu_ollama_model") || "");
  // Extra providers. DeepSeek / Mistral / xAI Grok are OpenAI-compatible (API key). Copilot signs in via its
  // own CLI (`copilot /login`) and Keak reads the token — a subscription sign-in, no API key.
  const [deepseekKey, setDeepseekKey] = useState<string>(() => localStorage.getItem("keak_cu_deepseek_key") || "");
  const [mistralKey, setMistralKey] = useState<string>(() => localStorage.getItem("keak_cu_mistral_key") || "");
  const [xaiKey, setXaiKey] = useState<string>(() => localStorage.getItem("keak_cu_xai_key") || "");
  const [kimiKey, setKimiKey] = useState<string>(() => localStorage.getItem("keak_cu_kimi_key") || "");
  const [copilotToken, setCopilotToken] = useState<string>(() => localStorage.getItem("keak_cu_copilot_token") || "");
  const [copilotBusy, setCopilotBusy] = useState<boolean>(false);
  // "Saved" flags decide whether to show the connected card. They must be separate from the input state
  // above — if the card keyed off the live input, typing the first character would flip to "connected" and
  // unmount the input before you could finish typing or hit Save.
  const [claudeSaved, setClaudeSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_claude_token"));
  const [openaiSaved, setOpenaiSaved] = useState<boolean>(() => !!(localStorage.getItem("keak_cu_openai_token") || localStorage.getItem("keak_cu_openai_key")));
  const [geminiSaved, setGeminiSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_gemini_key"));
  const [ollamaSaved, setOllamaSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_ollama_model"));
  const [deepseekSaved, setDeepseekSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_deepseek_key"));
  const [mistralSaved, setMistralSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_mistral_key"));
  const [xaiSaved, setXaiSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_xai_key"));
  const [kimiSaved, setKimiSaved] = useState<boolean>(() => !!localStorage.getItem("keak_cu_kimi_key"));
  // Local models the user has actually pulled (from `ollama list`), so we only offer those.
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState<boolean>(false);
  // The local models the user has CONNECTED (can be several). The active one is keak_cu_ollama_model; the
  // full connected list is keak_cu_ollama_models. Like Claude/Gemini, once connected you switch between them.
  const [ollamaConnected, setOllamaConnected] = useState<string[]>(() => {
    try { const r = localStorage.getItem("keak_cu_ollama_models"); const a = r ? JSON.parse(r) : []; if (Array.isArray(a) && a.length) return a; } catch { /* ignore */ }
    const single = localStorage.getItem("keak_cu_ollama_model"); return single ? [single] : [];
  });
  const [ollamaEditing, setOllamaEditing] = useState<boolean>(false); // show the picker again to add/remove
  function toggleOllamaPick(m: string) {
    setOllamaConnected((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]);
  }
  function connectOllama() {
    if (ollamaConnected.length === 0) { setConnectMsg(t("Pick at least one model.")); return; }
    localStorage.setItem("keak_cu_ollama_models", JSON.stringify(ollamaConnected));
    const active = ollamaConnected.includes(ollamaModel) ? ollamaModel : ollamaConnected[0];
    localStorage.setItem("keak_cu_ollama_model", active); setOllamaModel(active);
    setOllamaSaved(true); setOllamaEditing(false);
    setConnectMsg(`${t("Connected")} ${ollamaConnected.length} ${ollamaConnected.length === 1 ? t("local model.") : t("local models.")}`);
  }
  function switchOllamaModel(m: string) {
    localStorage.setItem("keak_cu_ollama_model", m); setOllamaModel(m); setConnectMsg(`${t("Now using")} ${m}.`);
  }
  function editOllamaModels() { setOllamaEditing(true); loadOllamaModels(); }
  async function loadOllamaModels() {
    setOllamaLoading(true); setConnectMsg(t("Looking for your local models…"));
    try {
      const raw = await invoke<string>("ollama_list_models");
      const list = JSON.parse(raw) as string[];
      setOllamaModels(list);
      setConnectMsg(list.length ? `${t("Found")} ${list.length} ${list.length === 1 ? t("local model.") : t("local models.")}` : t("No local models yet. Pull one, e.g. `ollama pull hermes3`, then Refresh."));
    } catch (e) { setOllamaModels([]); setConnectMsg(String(e).slice(0, 160)); }
    finally { setOllamaLoading(false); }
  }
  // When the user opens Local and hasn't connected a model yet, detect what they've pulled.
  useEffect(() => {
    if (cuProvider === "ollama" && (!ollamaSaved || ollamaEditing) && ollamaModels.length === 0) { loadOllamaModels(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuProvider]);
  const [claudeModel, setClaudeModel] = useState<string>(() => localStorage.getItem("keak_cu_claude_model") || "");
  const [claudeEffort, setClaudeEffort] = useState<string>(() => localStorage.getItem("keak_cu_claude_effort") || "");
  const [openaiModel, setOpenaiModel] = useState<string>(() => localStorage.getItem("keak_cu_openai_model") || "");
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    const m = localStorage.getItem("keak_cu_gemini_model") || "";
    if (/gemini-2\.5-flash|gemini-2\.0-flash|gemini-2\.5-pro|gemini-1\.5|^gemini-pro$/i.test(m)) { localStorage.removeItem("keak_cu_gemini_model"); return ""; }
    return m;
  });
  const [connectMsg, setConnectMsg] = useState<string>("");
  const [activeSection, setActiveSection] = useState<string>("ai");
  // When the keak.app dashboard's "Keak AI" button opens this window (via the desktop bridge), land on the chat.
  useEffect(() => {
    const un = listen("keak-open-work", () => setActiveSection("work"));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);
  const [uiLang, setUiLangState, t] = useUiLang();
  const wp = wakePhrase(uiLang); // the wake phrase in the user's language: "Hey Keak" / "Hola Keak" / "Ei Keak"…
  const [agentLabels, setAgentLabels] = useState<boolean>(localStorage.getItem("keak_agent_labels") !== "0");
  function toggleAgentLabels(v: boolean) { setAgentLabels(v); localStorage.setItem("keak_agent_labels", v ? "1" : "0"); }
  // Translate-while-dictating: speak one language, Keak writes another. "off" = normal dictation. Read by the overlay.
  const [translateTo, setTranslateTo] = useState<string>(() => {
    const v = localStorage.getItem("keak_translate_to");
    return v && v !== "off" ? v : "en"; // the language Ctrl+Win+Shift translates into (English by default)
  });
  function chooseTranslateTo(code: string) {
    setTranslateTo(code);
    localStorage.setItem("keak_translate_to", code);
    localStorage.setItem("keak_translate_shift", code);
  }
  // Standby: the always-on Keak orb in a screen corner. Click it to talk to Keak AI without a hotkey.
  const [standby, setStandby] = useState<boolean>(localStorage.getItem("keak_standby") === "1");
  const [orbCorner, setOrbCorner] = useState<string>(localStorage.getItem("keak_orb_corner") || "br");
  function toggleStandby(v: boolean) {
    setStandby(v);
    localStorage.setItem("keak_standby", v ? "1" : "0");
    invoke("set_standby", { on: v, corner: orbCorner }).catch(() => { /* ignore */ });
  }
  function chooseOrbCorner(c: string) {
    setOrbCorner(c);
    localStorage.setItem("keak_orb_corner", c);
    if (standby) invoke("set_standby", { on: true, corner: c }).catch(() => { /* ignore */ });
  }
  // Dictation language: locks the transcriber to one language for much better accuracy (Auto can mishear).
  const [dictLang, setDictLang] = useState<string>(localStorage.getItem("keak_language") || "auto");
  function chooseDictLang(code: string) {
    setDictLang(code);
    localStorage.setItem("keak_language", code);
  }
  // Hey Keak wake word: train a personal on-device model from a few voice samples, then toggle listening.
  const [wakeTrained, setWakeTrained] = useState<boolean>(false);
  const [wakeOn, setWakeOn] = useState<boolean>(localStorage.getItem("keak_wake") === "1");
  const [wakeStatus, setWakeStatus] = useState<string>("");
  useEffect(() => { invoke<number>("wake_has_samples").then((n) => setWakeTrained((n || 0) > 0)).catch(() => { /* ignore */ }); }, []);
  function wavBase64(samples: Float32Array, rate: number): string {
    const n = samples.length; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, n * 2, true);
    let o = 44; for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    const bytes = new Uint8Array(buf); let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  async function recordWakeWav(ms: number): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const parts: Float32Array[] = [];
    proc.onaudioprocess = (e) => { parts.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(proc); proc.connect(ctx.destination);
    await new Promise((r) => setTimeout(r, ms));
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach((tr) => tr.stop());
    const rate = ctx.sampleRate; await ctx.close();
    let len = 0; for (const p of parts) len += p.length;
    const pcm = new Float32Array(len); let off = 0; for (const p of parts) { pcm.set(p, off); off += p.length; }
    return wavBase64(pcm, rate);
  }
  async function trainWake() {
    try {
      await invoke("wake_clear").catch(() => { /* ignore */ });
      for (let i = 0; i < 3; i++) {
        setWakeStatus(t("Get ready…"));
        await new Promise((r) => setTimeout(r, 800));
        setWakeStatus(`${t("Say")} "${wp}"  (${i + 1}/3)`);
        const wav = await recordWakeWav(1500);
        await invoke("wake_save_sample", { index: i, wavBase64: wav });
      }
      setWakeTrained(true);
      setWakeStatus(t("Wake word ready."));
      if (wakeOn) { await invoke("wake_stop").catch(() => {}); await invoke("wake_start").catch(() => {}); }
    } catch {
      setWakeStatus(t("Training failed. Check the microphone."));
    }
  }
  function toggleWake(v: boolean) {
    setWakeOn(v);
    localStorage.setItem("keak_wake", v ? "1" : "0");
    if (v) {
      invoke("wake_start").then(() => setWakeStatus(t("Listening for \"{phrase}\".").replace("{phrase}", wp)))
        .catch((e) => { setWakeStatus(String(e)); setWakeOn(false); localStorage.setItem("keak_wake", "0"); });
    } else {
      invoke("wake_stop").catch(() => {});
      setWakeStatus("");
    }
  }
  const [history, setHistory] = useState<AgentRun[]>([]);
  useEffect(() => {
    const read = () => {
      try { const r = localStorage.getItem("keak_agent_history"); const a = r ? JSON.parse(r) : []; setHistory(Array.isArray(a) ? a : []); } catch { setHistory([]); }
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === "keak_agent_history") read(); };
    window.addEventListener("storage", onStorage);
    const t = window.setInterval(read, 1500);
    return () => { window.removeEventListener("storage", onStorage); window.clearInterval(t); };
  }, []);
  function clearHistory() { localStorage.setItem("keak_agent_history", "[]"); setHistory([]); }
  function persistHistory(next: AgentRun[]) { localStorage.setItem("keak_agent_history", JSON.stringify(next)); setHistory(next); }
  // Per-chat actions from the three-dots menu.
  const [menuIdx, setMenuIdx] = useState<number | null>(null);
  const [renameIdx, setRenameIdx] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  function deleteRun(idx: number) {
    const next = history.filter((_, i) => i !== idx);
    persistHistory(next); setMenuIdx(null);
    if (selectedRun >= next.length) setSelectedRun(Math.max(0, next.length - 1));
  }
  function startRename(idx: number) { setRenameIdx(idx); setRenameText(history[idx]?.job || ""); setMenuIdx(null); }
  function commitRename() {
    if (renameIdx === null) return;
    const job = renameText.trim();
    if (job) persistHistory(history.map((r, i) => i === renameIdx ? { ...r, job } : r));
    setRenameIdx(null);
  }
  // Text chat inside the Work section: continue any chat by typing, or start a new one, on your connected AI.
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStatus, setChatStatus] = useState(""); // live "Reading X… / Writing Y…" while the agent works
  const [chatsHidden, setChatsHidden] = useState(false); // collapse the left list to read the chat full-width
  const [brainSkills, setBrainSkills] = useState<string[]>([]); // skill names found in the connected folder (AI/skills/*)
  // MCP (Model Context Protocol) servers — local (stdio) or remote (URL). Their tools plug into the chat.
  const [mcpServers, setMcpServers] = useState<McpServer[]>(() => readMcpServers());
  const [mcpBusy, setMcpBusy] = useState("");
  const [mcpForm, setMcpForm] = useState<{ open: boolean; name: string; transport: "local" | "remote"; command: string; args: string; url: string; auth: string }>({ open: false, name: "", transport: "local", command: "npx", args: "", url: "", auth: "" });
  function persistMcp(list: McpServer[]) { setMcpServers(list); writeMcpServers(list); }
  function toggleMcp(id: string, on: boolean) { persistMcp(mcpServers.map((x) => x.id === id ? { ...x, enabled: on } : x)); }
  function removeMcpServer(id: string) { persistMcp(mcpServers.filter((x) => x.id !== id)); }
  async function testMcpServer(s: McpServer) {
    setMcpBusy(s.id);
    try {
      const tools = await mcpListTools(s);
      persistMcp(readMcpServers().map((x) => x.id === s.id ? { ...x, tools } : x));
      setConnectMsg(`${s.name}: ${tools.length} ${t("tools")}`);
    } catch (e) { setConnectMsg(`${s.name}: ${String(e).slice(0, 150)}`); }
    finally { setMcpBusy(""); }
  }
  function addMcpServer() {
    const f = mcpForm;
    if (!f.name.trim()) { setConnectMsg(t("Give the MCP server a name.")); return; }
    if (f.transport === "local" && !f.command.trim()) { setConnectMsg(t("A local server needs a command.")); return; }
    if (f.transport === "remote" && !f.url.trim()) { setConnectMsg(t("A remote server needs a URL.")); return; }
    const s: McpServer = {
      id: newMcpId(), name: f.name.trim(), transport: f.transport, enabled: true,
      command: f.transport === "local" ? f.command.trim() : undefined,
      args: f.transport === "local" ? f.args.trim() : undefined,
      url: f.transport === "remote" ? f.url.trim() : undefined,
      headers: f.transport === "remote" && f.auth.trim() ? { Authorization: f.auth.trim() } : undefined,
    };
    persistMcp([...mcpServers, s]);
    setMcpForm({ open: false, name: "", transport: "local", command: "npx", args: "", url: "", auth: "" });
    testMcpServer(s);
  }

  // Canva + Clay (API-key tools) and Zapier (connected as a remote MCP server, which reaches 9000+ apps).
  const [zapierUrl, setZapierUrl] = useState<string>(() => localStorage.getItem("keak_zapier_mcp_url") || "");
  // Canva connects by sign-in (OAuth), not an API key. The one-click flow needs a registered Canva app (like
  // Google/Microsoft); until that's wired this opens Canva to approve.
  function connectCanva() {
    invoke("open_url", { url: "https://www.canva.com/" }).catch(() => { /* ignore */ });
    setConnectMsg(t("Canva uses sign-in, not an API key. One-click Canva sign-in is being set up like Google — for now this opens Canva."));
  }
  function connectZapier() {
    const url = zapierUrl.trim();
    if (!url) { setConnectMsg(t("Paste your Zapier MCP URL first.")); return; }
    localStorage.setItem("keak_zapier_mcp_url", url);
    const rest = mcpServers.filter((s) => s.name.toLowerCase() !== "zapier");
    const s: McpServer = { id: newMcpId(), name: "Zapier", transport: "remote", enabled: true, url };
    persistMcp([...rest, s]);
    testMcpServer(s);
    setConnectMsg(t("Zapier connected. Loading your actions…"));
  }
  const chatReqRef = useRef(0); // bumping this invalidates an in-flight reply (Stop button)
  function stopChat() { chatReqRef.current++; setChatBusy(false); setChatStatus(""); setQuotePop(null); }
  // Discover the skills inside the connected Second Brain (AI/skills/<name>/SKILL.md) for the /skill command.
  async function loadBrainSkills() {
    const root = localStorage.getItem("keak_brain_path") || brainPath || "";
    if (!root) { setBrainSkills([]); return; }
    try {
      const raw = await invoke<string>("sb_tree", { args: { root, maxDepth: 3, maxEntries: 900 } });
      const items = JSON.parse(raw) as string[];
      const names = items.filter((p) => /^AI\/skills\/[^/]+\/SKILL\.md$/i.test(p)).map((p) => p.split("/")[2]);
      const mpSkills = JSON.parse(localStorage.getItem("keak_activated_skills") || "[]") as string[];
      setBrainSkills(Array.from(new Set([...names, ...mpSkills])));
    } catch {
      const mpSkills = JSON.parse(localStorage.getItem("keak_activated_skills") || "[]") as string[];
      setBrainSkills(mpSkills);
    }
  }
  function newChat() {
    const now = Date.now();
    const run: AgentRun = { ts: now, job: t("New chat"), results: [], messages: [] };
    persistHistory([run, ...history]); setSelectedRun(0); setChatInput("");
  }
  function setRunModel(idx: number, choice: string) {
    persistHistory(history.map((r, i) => i === idx ? { ...r, model: choice || undefined } : r));
  }
  // Who this chat talks to: "Keak AI" (default) or one of your agents (its persona + colour + model).
  function chatAgentList(): { name: string; color: string; description?: string; personality?: string; choice?: string }[] {
    return [
      { name: "Keak AI", color: "#D4A49A" },
      ...defaults.map((d) => ({ name: d.name, color: d.color, description: d.description, personality: d.personality, choice: d.choice })),
      ...roster.map((r) => ({ name: r.name, color: r.color, description: r.description, personality: r.personality, choice: r.choice })),
    ];
  }
  function findChatAgent(name?: string) {
    if (!name || name === "Keak AI") return null;
    return chatAgentList().find((a) => a.name === name) || null;
  }
  function setRunAgent(idx: number, name: string) {
    persistHistory(history.map((r, i) => i === idx ? { ...r, agent: name && name !== "Keak AI" ? name : undefined } : r));
  }
  function runOrbColor(run: AgentRun): string {
    const a = findChatAgent(run.agent);
    return a ? a.color : "#D4A49A";
  }
  const [quotePop, setQuotePop] = useState<{ text: string; x: number; y: number } | null>(null);
  function currentSelectionText(): string {
    try { const s = window.getSelection(); return s && !s.isCollapsed ? s.toString().trim() : ""; } catch { return ""; }
  }
  // Quote the SELECTED part of a message if the user highlighted some, else the whole message.
  function quoteIntoChat(fallback: string) {
    const text = currentSelectionText() || fallback;
    if (!text) return;
    const q = text.split("\n").map((l) => `> ${l}`).join("\n");
    setChatInput((prev) => (prev.trim() ? `${prev}\n\n${q}\n` : `${q}\n`));
    setQuotePop(null);
  }
  // When the user highlights text inside the chat, float a "Quote" chip above the selection.
  function onChatMouseUp() {
    try {
      const s = window.getSelection();
      if (s && !s.isCollapsed) {
        const text = s.toString().trim();
        if (text) { const r = s.getRangeAt(0).getBoundingClientRect(); setQuotePop({ text, x: r.left + r.width / 2, y: r.top }); return; }
      }
    } catch { /* ignore */ }
    setQuotePop(null);
  }
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setConnectMsg(t("Copied.")); } catch { /* ignore */ }
  }
  // ---- Slash commands in the chat ----
  function setRunGoal(idx: number, goal: string) { persistHistory(history.map((r, i) => i === idx ? { ...r, goal: goal || undefined } : r)); }
  function setRunSkill(idx: number, skill: string) { persistHistory(history.map((r, i) => i === idx ? { ...r, skill: skill || undefined } : r)); }
  // The command palette that pops up while the message starts with "/". Context-aware: after "/agent " it lists
  // your agents, after "/skill " it lists the skills in your connected folder, otherwise it lists the commands.
  function slashMenu(idx: number): { label: string; hint: string; run: () => void }[] {
    const v = chatInput;
    if (!v.startsWith("/")) return [];
    const mAgent = v.match(/^\/agent\s+(.*)$/i);
    if (mAgent) {
      const q = mAgent[1].toLowerCase();
      return chatAgentList().filter((a) => a.name.toLowerCase().includes(q)).slice(0, 6)
        .map((a) => ({ label: a.name, hint: t("Talk to this agent"), run: () => { setRunAgent(idx, a.name); setChatInput(""); } }));
    }
    const mSkill = v.match(/^\/skill\s+(.*)$/i);
    if (mSkill) {
      const q = mSkill[1].toLowerCase();
      const list = brainSkills.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
      if (!list.length) return [{ label: t("No skills found"), hint: t("Skills live in AI/skills in your folder"), run: () => setChatInput("") }];
      return list.map((s) => ({ label: s, hint: t("Use this skill"), run: () => { setRunSkill(idx, s); setChatInput(""); } }));
    }
    const token = v.slice(1).split(/\s/)[0].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(token))
      .map((c) => ({ label: c.cmd, hint: t(c.desc), run: () => { if (c.arg) setChatInput(c.cmd + " "); else runSlash(idx, c.cmd); } }));
  }
  // Execute a full slash command (also called when the user just presses Enter on a "/…" line).
  async function runSlash(idx: number, raw: string): Promise<boolean> {
    const trimmed = raw.trim();
    const cmd = trimmed.split(/\s+/)[0].toLowerCase();
    const arg = trimmed.slice(cmd.length).trim();
    const lc = (s: string) => s.toLowerCase();
    if (cmd === "/new" || cmd === "/clear") { newChat(); return true; }
    if (cmd === "/compact") { setChatInput(""); await compactChat(idx); return true; }
    if (cmd === "/goal") { setRunGoal(idx, arg); setChatInput(""); setConnectMsg(arg ? t("Goal set for this chat.") : t("Goal cleared.")); return true; }
    if (cmd === "/agent") {
      const list = chatAgentList();
      const a = list.find((x) => lc(x.name) === lc(arg)) || list.find((x) => lc(x.name).includes(lc(arg)));
      if (a) { setRunAgent(idx, a.name); setConnectMsg(`${t("Now chatting with")} ${a.name}`); }
      setChatInput(""); return true;
    }
    if (cmd === "/model") {
      const c = connectedModelChoices().find((x) => lc(x.label).includes(lc(arg)));
      if (c) setRunModel(idx, c.value);
      setChatInput(""); return true;
    }
    if (cmd === "/skill") {
      const s = brainSkills.find((x) => lc(x) === lc(arg)) || brainSkills.find((x) => lc(x).includes(lc(arg)));
      if (s) { setRunSkill(idx, s); setConnectMsg(`${t("Using skill")} ${s}`); }
      setChatInput(""); return true;
    }
    // shorthand: "/AgentName" talks to that agent directly
    const agent = chatAgentList().find((x) => "/" + lc(x.name).replace(/\s+/g, "") === cmd);
    if (agent) { setRunAgent(idx, agent.name); setChatInput(""); return true; }
    return false; // unknown slash -> let it send as a normal message
  }
  // Summarise the chat so far into one compact brief and replace the thread with it, to keep context small.
  async function compactChat(idx: number) {
    const run = history[idx]; if (!run) return;
    const msgs = runMessages(run); if (msgs.length < 2) { setConnectMsg(t("Nothing to compact yet.")); return; }
    const ai = resolveChatAI(run.model || (findChatAgent(run.agent)?.choice) || ""); if (!ai) { setConnectMsg(t("Connect your AI first.")); return; }
    const reqId = ++chatReqRef.current;
    setChatBusy(true); setChatStatus(t("Summarising…"));
    try {
      const convo = msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
      const summary = await invoke<string>("cu_chat", { args: { provider: ai.provider, credential: ai.credential, accountId: ai.accountId, isSubscription: ai.isSub, model: ai.model, effort: ai.effort, system: "Summarise this chat into a compact brief that preserves the key facts, decisions, names, files and the current goal, so the conversation can continue with far less context. Be concise.", history: [], message: convo } });
      if (reqId !== chatReqRef.current) return;
      const compacted: ChatMsg[] = [{ role: "assistant", text: `${t("Summary of earlier:")} ${(summary || "").trim()}`, ts: Date.now() }];
      persistHistory(history.map((r, i) => i === idx ? { ...r, messages: compacted } : r));
    } catch { setConnectMsg(t("Couldn't compact this chat.")); }
    finally { if (reqId === chatReqRef.current) { setChatBusy(false); setChatStatus(""); } }
  }

  async function sendChat(idx: number) {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    if (text.startsWith("/") && await runSlash(idx, text)) return; // a slash command, not a message
    const run = history[idx];
    if (!run) return;
    const base = (run.messages && run.messages.length) ? run.messages.slice() : runMessages(run);
    const now = Date.now();
    const firstEver = (run.results.length === 0 && (!run.messages || run.messages.length === 0));
    const withUser: AgentRun = { ...run, messages: [...base, { role: "user", text, ts: now }], job: firstEver ? text.slice(0, 60) : run.job, ts: now };
    const rest = history.filter((_, i) => i !== idx);
    persistHistory([withUser, ...rest]); setSelectedRun(0); setChatInput(""); setChatBusy(true); setChatStatus("");
    const reqId = ++chatReqRef.current;
    try {
      const agent = findChatAgent(run.agent);
      const ai = resolveChatAI(run.model || (agent && agent.choice) || "");
      if (!ai) throw new Error(t("Connect your AI first."));
      // Give the chat the connected Second Brain (if any) + the ability to make artifacts, then run a tool loop.
      const root = localStorage.getItem("keak_brain_path") || "";
      const perm = localStorage.getItem("keak_brain_perm") || "full";
      let tree = "[]";
      if (root) { try { tree = await invoke<string>("sb_tree", { args: { root, maxDepth: 2, maxEntries: 300 } }); } catch { /* ignore */ } }
      let base = chatSystem(agent || undefined);
      if (run.goal) base += `\n\nThe user's goal for this whole chat: ${run.goal}`;
      if (run.skill) {
        let skillContent = "";
        if (root) {
          try { skillContent = await invoke<string>("sb_read", { args: { root, path: `AI/skills/${run.skill}/SKILL.md` } }); } catch { /* missing from brain */ }
        }
        if (!skillContent) {
          skillContent = localStorage.getItem(`keak_marketplace_skill_${run.skill}`) || "";
        }
        if (skillContent) base += `\n\nYou are using the "${run.skill}" skill. Follow it:\n${skillContent.slice(0, 6000)}`;
      }
      const webOn = !!localStorage.getItem("keak_tool_perplexity");
      // Connected MCP servers: discover each one's tools (cached after first use) and advertise them to the model.
      let mcpOn = false;
      const mcpServers = readMcpServers().filter((s) => s.enabled);
      if (mcpServers.length) {
        const lines: string[] = [];
        for (const s of mcpServers) {
          if (reqId !== chatReqRef.current) return;
          let tools = s.tools;
          if (!tools || !tools.length) {
            setChatStatus(`${t("Connecting")} ${s.name}…`);
            try { tools = await mcpListTools(s); writeMcpServers(readMcpServers().map((x) => x.id === s.id ? { ...x, tools } : x)); }
            catch { tools = []; }
          }
          (tools || []).forEach((tl) => lines.push(`- [${s.name}] ${tl.name}${tl.description ? ": " + tl.description.slice(0, 120) : ""}`));
        }
        if (lines.length) { mcpOn = true; base += `\n\nConnected MCP tools (call with {"tool":"mcp","server":"<server>","name":"<tool>","args":{...}}):\n${lines.join("\n")}`; }
        setChatStatus("");
      }
      const system = chatToolSystem(base, root, perm, tree, webOn, mcpOn);
      const convo = withUser.messages!.slice(-9).map((m) => ({ role: m.role, content: m.text }));
      let finalText = "";
      const artifacts: ChatArtifact[] = [];
      const seen = new Set<string>(); // stop the model looping on the same read/search forever
      const MAX = 18;
      for (let step = 0; step < MAX; step++) {
        if (reqId !== chatReqRef.current) return; // the user hit Stop
        const message = convo[convo.length - 1].content;
        const history = convo.slice(0, -1);
        const reply = await invoke<string>("cu_chat", { args: { provider: ai.provider, credential: ai.credential, accountId: ai.accountId, isSubscription: ai.isSub, model: ai.model, effort: ai.effort, system, history, message } });
        if (reqId !== chatReqRef.current) return;
        const tool = parseChatTool(reply);
        if (!tool) {
          // A truncated/partial tool call (e.g. a long artifact that got cut off) won't parse. Don't leak the raw
          // JSON to the user — nudge the model to resend it complete, and retry within the step budget.
          const looksLikePartialTool = /\{\s*"tool"\s*:/.test(reply);
          if (looksLikePartialTool && step < MAX - 1) {
            convo.push({ role: "assistant", content: reply.slice(0, 300) });
            convo.push({ role: "user", content: "Your last tool call was cut off before the JSON finished. Resend it as ONE complete, valid JSON object. If the file is long, keep it more concise so it fits in a single reply." });
            setChatStatus(t("Retrying…"));
            continue;
          }
          finalText = (reply || "").trim();
          break;
        }
        if (tool.tool === "done") { finalText = (tool.message || "").trim(); break; }
        convo.push({ role: "assistant", content: reply });
        const sig = `${tool.tool}:${tool.path || tool.query || tool.filename || ""}`;
        if (seen.has(sig) && tool.tool !== "write" && tool.tool !== "artifact") {
          // already ran this exact read/search — nudge it to finish instead of looping
          convo.push({ role: "user", content: "You already ran that exact tool and have the result above. Do not repeat it. Use what you have and reply with a done tool now, or create the artifact." });
          continue;
        }
        seen.add(sig);
        setChatStatus(chatToolLabel(tool));
        const { result, artifact } = await execChatTool(tool, root, perm);
        if (reqId !== chatReqRef.current) return;
        if (artifact) artifacts.push(artifact);
        convo.push({ role: "user", content: `TOOL RESULT (${tool.tool}): ${result}` });
      }
      if (reqId !== chatReqRef.current) return;
      // Out of tool steps and no answer yet: force ONE final call that answers directly (no tools) using
      // everything gathered, so the chat never dead-ends with "ran out of steps".
      if (!finalText) {
        try {
          const synthSys = system + "\n\nYou are OUT of tool steps now. Do NOT output a tool call or JSON. Answer the user directly and fully using everything above. If you could not fully do one part (e.g. watch a video or run code), do every part you CAN and briefly note the single part you couldn't, then give the best result you can.";
          const synth = await invoke<string>("cu_chat", { args: { provider: ai.provider, credential: ai.credential, accountId: ai.accountId, isSubscription: ai.isSub, model: ai.model, effort: ai.effort, system: synthSys, history: convo.slice(0, -1), message: convo[convo.length - 1].content } });
          if (reqId !== chatReqRef.current) return;
          finalText = (synth || "").trim();
        } catch { /* fall through to a minimal message */ }
        if (!finalText) finalText = artifacts.length ? `${t("Done.")} ${artifacts.map((a) => a.label).join(", ")}` : t("I gathered what I could. Ask me to continue.");
      }
      const asst: ChatMsg = { role: "assistant", text: finalText || "…", ts: Date.now(), artifacts: artifacts.length ? artifacts : undefined };
      persistHistory([{ ...withUser, messages: [...withUser.messages!, asst], ts: Date.now() }, ...rest]); setSelectedRun(0);
    } catch (e) {
      if (reqId !== chatReqRef.current) return; // stopped — ignore the error too
      const asst: ChatMsg = { role: "assistant", text: `⚠ ${String(e).slice(0, 180)}`, ts: Date.now() };
      persistHistory([{ ...withUser, messages: [...withUser.messages!, asst] }, ...rest]); setSelectedRun(0);
    } finally { if (reqId === chatReqRef.current) { setChatBusy(false); setChatStatus(""); } }
  }
  async function openArtifactPath(path: string) {
    try { await invoke("open_url", { url: path }); } catch { setConnectMsg(path); }
  }
  async function openArtifact(name: string, content: string) {
    try {
      const fname = (name || "artifact").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) + (isHtmlOutput(content) ? ".html" : ".txt");
      const path = await invoke<string>("save_artifact", { name: fname, content });
      await invoke("open_url", { url: path });
    } catch { /* ignore */ }
  }

  function saveModel(provider: string, value: string, set: (v: string) => void) {
    set(value);
    localStorage.setItem(`keak_cu_${provider}_model`, value);
  }
  const [actionMode, setActionMode] = useState<string>(() => localStorage.getItem("keak_action_mode") || "ask");
  const [showCaptions, setShowCaptions] = useState<boolean>(() => localStorage.getItem("keak_show_captions") !== "0");
  // The assistant always runs on the user's own AI; this flag just makes answer-routing explicit.
  const [humor, setHumor] = useState<number>(() => parseInt(localStorage.getItem("keak_humor") || "20", 10));
  const [warmth, setWarmth] = useState<number>(() => parseInt(localStorage.getItem("keak_warmth") || "50", 10));
  const [formality, setFormality] = useState<number>(() => parseInt(localStorage.getItem("keak_formality") || "30", 10));
  const [directness, setDirectness] = useState<number>(() => parseInt(localStorage.getItem("keak_directness") || "50", 10));

  // Voice: which engine reads answers aloud, and which specific voice. Default "auto" = the user's OWN key
  // (free to Pep), never the paid backend.
  const [voiceEngine, setVoiceEngine] = useState<string>(() => localStorage.getItem("keak_voice_engine") || "auto");
  const [voiceUri, setVoiceUri] = useState<string>(() => localStorage.getItem("keak_voice_uri") || "");
  const [openaiVoice, setOpenaiVoice] = useState<string>(() => localStorage.getItem("keak_openai_voice") || "nova");
  const [geminiVoice, setGeminiVoice] = useState<string>(() => localStorage.getItem("keak_gemini_voice") || "Kore");
  const [elevenVoice, setElevenVoice] = useState<string>(() => localStorage.getItem("keak_tool_elevenlabs_voice") || "");
  function saveElevenVoice(v: string) { setElevenVoice(v); if (v.trim()) localStorage.setItem("keak_tool_elevenlabs_voice", v.trim()); else localStorage.removeItem("keak_tool_elevenlabs_voice"); }
  const [sysVoices, setSysVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => { try { setSysVoices(window.speechSynthesis?.getVoices?.() || []); } catch { /* ignore */ } };
    load();
    try { window.speechSynthesis?.addEventListener?.("voiceschanged", load); } catch { /* ignore */ }
    return () => { try { window.speechSynthesis?.removeEventListener?.("voiceschanged", load); } catch { /* ignore */ } };
  }, []);

  // Keep this window in sync with changes made by VOICE in the overlay (a different window). Voice commands
  // like "set humor to 80" or "switch to Sonnet" write localStorage; without this, the picker here would show
  // the OLD value because React state was only read once on mount. Storage events fire cross-window; we also
  // re-read on focus so it's always current when the user looks.
  useEffect(() => {
    const sync = () => {
      setHumor(parseInt(localStorage.getItem("keak_humor") || "20", 10));
      setWarmth(parseInt(localStorage.getItem("keak_warmth") || "50", 10));
      setFormality(parseInt(localStorage.getItem("keak_formality") || "30", 10));
      setDirectness(parseInt(localStorage.getItem("keak_directness") || "50", 10));
      setCuProvider(localStorage.getItem("keak_cu_provider") || "claude");
      setClaudeModel(localStorage.getItem("keak_cu_claude_model") || "");
      setOpenaiModel(localStorage.getItem("keak_cu_openai_model") || "");
      setClaudeEffort(localStorage.getItem("keak_cu_claude_effort") || "");
      const gm = localStorage.getItem("keak_cu_gemini_model") || "";
      setGeminiModel(/gemini-2\.5-flash|gemini-2\.0-flash|gemini-2\.5-pro|gemini-1\.5|^gemini-pro$/i.test(gm) ? "" : gm);
      setActionMode(localStorage.getItem("keak_action_mode") || "ask");
      setShowCaptions(localStorage.getItem("keak_show_captions") !== "0");
      setVoiceEngine(localStorage.getItem("keak_voice_engine") || "auto");
    };
    const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith("keak_")) sync(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("focus", sync); };
  }, []);
  // A voice command like "be funnier" changes the dials from the overlay window. Switching to the Personality
  // section in an already-open Connect window wouldn't re-read them (no focus/storage event fires), so it looked
  // like nothing changed. Refresh the dials whenever this section opens.
  useEffect(() => {
    if (activeSection !== "personality") return;
    setHumor(parseInt(localStorage.getItem("keak_humor") || "20", 10));
    setWarmth(parseInt(localStorage.getItem("keak_warmth") || "50", 10));
    setFormality(parseInt(localStorage.getItem("keak_formality") || "30", 10));
    setDirectness(parseInt(localStorage.getItem("keak_directness") || "50", 10));
  }, [activeSection]);
  function saveVoiceEngine(v: string) { setVoiceEngine(v); localStorage.setItem("keak_voice_engine", v); }
  function saveVoiceUri(v: string) { setVoiceUri(v); localStorage.setItem("keak_voice_uri", v); }
  function saveOpenaiVoice(v: string) { setOpenaiVoice(v); localStorage.setItem("keak_openai_voice", v); }
  function saveGeminiVoice(v: string) { setGeminiVoice(v); localStorage.setItem("keak_gemini_voice", v); }
  function speakSystemSample(sample: string) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(sample);
      const v = sysVoices.find((x) => x.voiceURI === voiceUri);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1.0; u.pitch = 1.03;
      window.speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }
  // Play a base64 clip and actually wait on the play() promise, so autoplay blocks or decode errors surface
  // instead of failing silently (the settings window may not have "unlocked" audio yet).
  async function playPreviewB64(b64: string, mime: string) {
    const audio = new Audio(`data:${mime};base64,${b64}`);
    audio.volume = 1;
    try { await audio.play(); }
    catch (e) {
      // Some webviews drop the user-gesture across the await. Nudge once more on the next tick.
      try { await new Promise((r) => setTimeout(r, 0)); await audio.play(); }
      catch { throw e; }
    }
  }
  async function previewVoice() {
    const sample = "Hi, I'm Keak. This is how I'll sound when I talk to you.";
    const gKey = (localStorage.getItem("keak_cu_gemini_key") || "").trim();
    const oKey = (localStorage.getItem("keak_cu_openai_key") || "").trim();
    // Auto previews whatever it would actually use: own Gemini → own OpenAI → Windows voice.
    const eng = voiceEngine === "auto" ? (gKey ? "gemini" : oKey.startsWith("sk-") ? "openai" : "system") : voiceEngine;
    if (eng === "gemini") {
      if (!gKey) { setConnectMsg(t("Add a Gemini key in Your AI to use the Gemini voice (a free one from Google AI Studio works).")); return; }
      setConnectMsg(t("Playing a Gemini voice sample…"));
      try {
        const b64 = await invoke<string>("gemini_tts", { args: { credential: gKey, voice: geminiVoice, model: "", text: sample } });
        if (!b64) { setConnectMsg(t("Gemini returned no audio. Try another voice.")); return; }
        await playPreviewB64(b64, "audio/wav");
        setConnectMsg("");
      } catch (e) { setConnectMsg(`${t("Gemini voice preview failed:")} ${String(e).slice(0, 150)}`); }
    } else if (eng === "openai") {
      if (!oKey.startsWith("sk-")) { setConnectMsg(t("Add an OpenAI API key (starts with sk-) in Your AI to use that voice.")); return; }
      setConnectMsg(t("Playing an OpenAI voice sample…"));
      try {
        const b64 = await invoke<string>("openai_tts", { args: { credential: oKey, voice: openaiVoice, model: "", text: sample } });
        if (!b64) { setConnectMsg(t("OpenAI returned no audio.")); return; }
        await playPreviewB64(b64, "audio/mp3");
        setConnectMsg("");
      } catch (e) { setConnectMsg(`${t("Voice preview failed:")} ${String(e).slice(0, 150)}`); }
    } else if (eng === "elevenlabs") {
      const elKey = (localStorage.getItem("keak_tool_elevenlabs") || "").trim();
      if (!elKey) { setConnectMsg(t("Add your ElevenLabs key under AI tools to use that voice.")); return; }
      setConnectMsg(t("Playing an ElevenLabs voice sample…"));
      try {
        const b64 = await invoke<string>("elevenlabs_speak", { args: { apiKey: elKey, text: sample, voiceId: elevenVoice.trim() } });
        if (!b64) { setConnectMsg(t("ElevenLabs returned no audio.")); return; }
        await playPreviewB64(b64, "audio/mp3");
        setConnectMsg("");
      } catch (e) { setConnectMsg(`${t("ElevenLabs voice preview failed:")} ${String(e).slice(0, 150)}`); }
    } else {
      speakSystemSample(sample);
      setConnectMsg("");
    }
  }
  // Natural-sounding voices first so the good ones are easy to find.
  const sortedVoices = sysVoices.slice().sort((a, b) => {
    const sc = (n: string) => (/natural|neural/i.test(n) ? 3 : 0) + (/online/i.test(n) ? 2 : 0) + (/google/i.test(n) ? 1 : 0) - (/desktop/i.test(n) ? 2 : 0);
    return sc(b.name) - sc(a.name);
  });
  const OPENAI_VOICES = ["nova", "shimmer", "alloy", "echo", "fable", "onyx"];
  const GEMINI_VOICES = ["Kore", "Aoede", "Leda", "Puck", "Charon", "Fenrir", "Orus", "Zephyr"];

  // The user's own agent roster: named agents with a speciality, personality + colour. Empty → default stars.
  type Agent = { name: string; description: string; color: string; choice?: string; personality?: string; tools?: string[] };
  const [roster, setRoster] = useState<Agent[]>(() => {
    try { const r = localStorage.getItem("keak_agents_roster"); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; }
  });
  // The default stars as they currently are (base + the user's edits). Re-read after every edit.
  const [defaults, setDefaults] = useState<EffectiveAgent[]>(() => effectiveDefaults());
  function refreshDefaults() { setDefaults(effectiveDefaults()); }
  const editedCount = Object.keys(readDefaultOverrides()).length;

  const [agName, setAgName] = useState("");
  const [agDesc, setAgDesc] = useState("");
  const [agPersona, setAgPersona] = useState("");
  const [agColor, setAgColor] = useState("#D4A49A");
  const [agChoice, setAgChoice] = useState("");
  function saveRoster(next: Agent[]) {
    setRoster(next); localStorage.setItem("keak_agents_roster", JSON.stringify(next));
  }
  function addAgent() {
    const name = agName.trim(); if (!name) return;
    if (roster.length >= MAX_AGENTS) { setConnectMsg(t("You've reached the limit of agents. Delete one to create a new one.")); return; }
    saveRoster([...roster, { name, description: agDesc.trim(), personality: agPersona.trim(), color: agColor, choice: agChoice }]);
    setAgName(""); setAgDesc(""); setAgPersona(""); setAgColor("#D4A49A"); setAgChoice("");
  }
  function removeAgent(i: number) { saveRoster(roster.filter((_, idx) => idx !== i)); }

  // Inline editor: one at a time. key is "default:<baseName>" or "custom:<index>".
  const [editKey, setEditKey] = useState<string | null>(null);
  const [edName, setEdName] = useState("");
  const [edDesc, setEdDesc] = useState("");
  const [edPersona, setEdPersona] = useState("");
  const [edColor, setEdColor] = useState("#D4A49A");
  const [edChoice, setEdChoice] = useState("");
  const [edTools, setEdTools] = useState<string[]>([]);
  function toggleEdTool(id: string) { setEdTools((t) => t.includes(id) ? t.filter((x) => x !== id) : [...t, id]); }
  function startEditDefault(a: EffectiveAgent) {
    setEditKey(`default:${a.base}`); setEdName(a.name); setEdDesc(a.description); setEdPersona(a.personality || ""); setEdColor(a.color); setEdChoice(a.choice || ""); setEdTools(a.tools || []);
  }
  function startEditCustom(i: number, a: Agent) {
    setEditKey(`custom:${i}`); setEdName(a.name); setEdDesc(a.description); setEdPersona(a.personality || ""); setEdColor(a.color); setEdChoice(a.choice || ""); setEdTools(a.tools || []);
  }
  function cancelEdit() { setEditKey(null); }
  function saveEdit() {
    if (!editKey) return;
    const [kind, ref] = editKey.split(":");
    if (kind === "default") {
      saveDefaultOverride(ref, { name: edName.trim() || ref, description: edDesc.trim(), personality: edPersona.trim(), color: edColor, tools: edTools, choice: edChoice });
      refreshDefaults();
    } else {
      const i = parseInt(ref, 10);
      saveRoster(roster.map((a, idx) => idx === i ? { ...a, name: edName.trim() || a.name, description: edDesc.trim(), personality: edPersona.trim(), color: edColor, choice: edChoice, tools: edTools } : a));
    }
    setEditKey(null);
  }
  function resetDefault(baseName: string) { resetDefaultOverride(baseName); refreshDefaults(); if (editKey === `default:${baseName}`) setEditKey(null); }

  // Google connection (Calendar / Gmail / Drive) via the user's own Google OAuth "Desktop app" client.
  const [gClientId, setGClientId] = useState<string>(() => localStorage.getItem("keak_google_client_id") || "");
  const [gClientSecret, setGClientSecret] = useState<string>(() => localStorage.getItem("keak_google_client_secret") || "");
  const [gConnected, setGConnected] = useState<boolean>(() => !!localStorage.getItem("keak_google_refresh"));
  const [gBusy, setGBusy] = useState<boolean>(false);
  const [gAdvanced, setGAdvanced] = useState<boolean>(false);
  async function connectGoogle() {
    // Prefer Keak's shared app (one-click). Fall back to a user-provided client if the shared one isn't set.
    const id = (HAS_SHARED_GOOGLE ? KEAK_GOOGLE_CLIENT_ID : gClientId).trim();
    const secret = (HAS_SHARED_GOOGLE ? KEAK_GOOGLE_CLIENT_SECRET : gClientSecret).trim();
    if (!id || !secret) { setConnectMsg(t("Paste your Google client ID and secret first.")); return; }
    localStorage.setItem("keak_google_client_id", id);
    localStorage.setItem("keak_google_client_secret", secret);
    setGBusy(true); setConnectMsg(t("Opening Google sign-in… approve it in your browser."));
    try {
      const raw = await invoke<string>("google_connect", { args: { clientId: id, clientSecret: secret } });
      const tok = JSON.parse(raw);
      if (!tok.access_token) throw new Error("no token returned");
      localStorage.setItem("keak_google_token", tok.access_token);
      if (tok.refresh_token) localStorage.setItem("keak_google_refresh", tok.refresh_token);
      localStorage.setItem("keak_google_expiry", String(Date.now() + (tok.expires_in || 3600) * 1000));
      setGConnected(true);
      setConnectMsg(t("Google connected. Keak can now manage your Calendar, Gmail and Drive."));
    } catch (e) {
      setConnectMsg(`${t("Google connection failed:")} ${String(e).slice(0, 160)}`);
    } finally { setGBusy(false); }
  }
  function disconnectGoogle() {
    ["keak_google_token", "keak_google_refresh", "keak_google_expiry"].forEach((k) => localStorage.removeItem(k));
    setGConnected(false); setConnectMsg(t("Google disconnected."));
  }

  // Microsoft connection (Outlook Calendar / Mail / OneDrive) via the user's own Microsoft account.
  const [msClientId, setMsClientId] = useState<string>(() => localStorage.getItem("keak_ms_client_id") || "");
  const [msClientSecret, setMsClientSecret] = useState<string>(() => localStorage.getItem("keak_ms_client_secret") || "");
  const [msConnected, setMsConnected] = useState<boolean>(() => !!localStorage.getItem("keak_ms_refresh"));
  const [msBusy, setMsBusy] = useState<boolean>(false);
  const [msAdvanced, setMsAdvanced] = useState<boolean>(false);
  async function connectMicrosoft() {
    const id = (HAS_SHARED_MS ? KEAK_MS_CLIENT_ID : msClientId).trim();
    const secret = msClientSecret.trim(); // optional (only for confidential/web app registrations)
    if (!id) { setConnectMsg(t("Paste your Microsoft application (client) ID first.")); return; }
    localStorage.setItem("keak_ms_client_id", id);
    localStorage.setItem("keak_ms_client_secret", secret);
    setMsBusy(true); setConnectMsg(t("Opening Microsoft sign-in… approve it in your browser."));
    try {
      const raw = await invoke<string>("ms_connect", { args: { clientId: id, clientSecret: secret } });
      const tok = JSON.parse(raw);
      if (!tok.access_token) throw new Error("no token returned");
      localStorage.setItem("keak_ms_token", tok.access_token);
      if (tok.refresh_token) localStorage.setItem("keak_ms_refresh", tok.refresh_token);
      localStorage.setItem("keak_ms_expiry", String(Date.now() + (tok.expires_in || 3600) * 1000));
      setMsConnected(true);
      setConnectMsg(t("Microsoft connected. Keak can now manage your Outlook Calendar, Mail and OneDrive."));
    } catch (e) {
      setConnectMsg(`${t("Microsoft connection failed:")} ${String(e).slice(0, 160)}`);
    } finally { setMsBusy(false); }
  }
  function disconnectMicrosoft() {
    ["keak_ms_token", "keak_ms_refresh", "keak_ms_expiry"].forEach((k) => localStorage.removeItem(k));
    setMsConnected(false); setConnectMsg(t("Microsoft disconnected."));
  }

  // Notion connection (OAuth sign-in). Tokens don't expire, so we just store the access token.
  const [notionClientId, setNotionClientId] = useState<string>(() => localStorage.getItem("keak_notion_client_id") || "");
  const [notionClientSecret, setNotionClientSecret] = useState<string>(() => localStorage.getItem("keak_notion_client_secret") || "");
  const [notionConnected, setNotionConnected] = useState<boolean>(() => !!localStorage.getItem("keak_notion_token"));
  const [notionBusy, setNotionBusy] = useState<boolean>(false);
  const [notionAdvanced, setNotionAdvanced] = useState<boolean>(false);
  async function connectNotion() {
    const id = (HAS_SHARED_NOTION ? KEAK_NOTION_CLIENT_ID : notionClientId).trim();
    const secret = (HAS_SHARED_NOTION ? KEAK_NOTION_CLIENT_SECRET : notionClientSecret).trim();
    if (!id || !secret) { setConnectMsg(t("Paste your Notion integration's client ID and secret first.")); return; }
    localStorage.setItem("keak_notion_client_id", id); localStorage.setItem("keak_notion_client_secret", secret);
    setNotionBusy(true); setConnectMsg(t("Opening Notion sign-in… approve it in your browser."));
    try {
      const raw = await invoke<string>("notion_connect", { args: { clientId: id, clientSecret: secret } });
      const tok = JSON.parse(raw);
      if (!tok.access_token) throw new Error("no token returned");
      localStorage.setItem("keak_notion_token", tok.access_token);
      if (tok.workspace_name) localStorage.setItem("keak_notion_workspace", tok.workspace_name);
      setNotionConnected(true);
      setConnectMsg(`${t("Notion connected")}${tok.workspace_name ? ` (${tok.workspace_name})` : ""}.`);
    } catch (e) { setConnectMsg(`${t("Notion connection failed:")} ${String(e).slice(0, 160)}`); }
    finally { setNotionBusy(false); }
  }
  function disconnectNotion() {
    ["keak_notion_token", "keak_notion_workspace"].forEach((k) => localStorage.removeItem(k));
    setNotionConnected(false); setConnectMsg(t("Notion disconnected."));
  }

  // Slack connection (paste a Bot/User OAuth token — Slack blocks the http://localhost loopback redirect).
  const [slackToken, setSlackToken] = useState<string>(() => localStorage.getItem("keak_slack_token") || "");
  const [slackConnected, setSlackConnected] = useState<boolean>(() => !!localStorage.getItem("keak_slack_token"));
  const [slackBusy, setSlackBusy] = useState<boolean>(false);
  async function connectSlack() {
    const tok = slackToken.trim();
    if (!tok) { setConnectMsg(t("Paste your Slack token (starts with xoxb- or xoxp-) first.")); return; }
    setSlackBusy(true); setConnectMsg(t("Checking your Slack token…"));
    try {
      const raw = await invoke<string>("slack_test", { args: { token: tok } });
      const r = JSON.parse(raw);
      localStorage.setItem("keak_slack_token", tok);
      if (r.team) localStorage.setItem("keak_slack_team", r.team);
      setSlackConnected(true);
      setConnectMsg(`${t("Slack connected")}${r.team ? ` (${r.team})` : ""}.`);
    } catch (e) { setConnectMsg(`${t("Slack connection failed:")} ${String(e).slice(0, 160)}`); }
    finally { setSlackBusy(false); }
  }
  // One-click Slack sign-in via the shared app (uses the keak.app relay for the https redirect Slack requires).
  async function connectSlackOauth() {
    setSlackBusy(true); setConnectMsg(t("Opening Slack sign-in… approve it in your browser."));
    try {
      const raw = await invoke<string>("slack_connect", { args: { clientId: KEAK_SLACK_CLIENT_ID, clientSecret: KEAK_SLACK_CLIENT_SECRET } });
      const r = JSON.parse(raw);
      if (!r.token) throw new Error("no token returned");
      localStorage.setItem("keak_slack_token", r.token);
      if (r.team) localStorage.setItem("keak_slack_team", r.team);
      setSlackToken(r.token); setSlackConnected(true);
      setConnectMsg(`${t("Slack connected")}${r.team ? ` (${r.team})` : ""}.`);
    } catch (e) { setConnectMsg(`${t("Slack connection failed:")} ${String(e).slice(0, 160)}`); }
    finally { setSlackBusy(false); }
  }
  function disconnectSlack() {
    ["keak_slack_token", "keak_slack_team"].forEach((k) => localStorage.removeItem(k));
    setSlackToken(""); setSlackConnected(false); setConnectMsg(t("Slack disconnected."));
  }

  // Figma connection (OAuth sign-in). Needs a Figma OAuth app; register redirect http://localhost:53684/callback.
  const [figmaClientId, setFigmaClientId] = useState<string>(() => localStorage.getItem("keak_figma_client_id") || "");
  const [figmaClientSecret, setFigmaClientSecret] = useState<string>(() => localStorage.getItem("keak_figma_client_secret") || "");
  const [figmaConnected, setFigmaConnected] = useState<boolean>(() => !!localStorage.getItem("keak_figma_token"));
  const [figmaBusy, setFigmaBusy] = useState<boolean>(false);
  const [figmaAdvanced, setFigmaAdvanced] = useState<boolean>(false);
  async function connectFigma() {
    const id = figmaClientId.trim(); const secret = figmaClientSecret.trim();
    if (!id || !secret) { setConnectMsg(t("Paste your Figma client ID and secret first.")); return; }
    localStorage.setItem("keak_figma_client_id", id); localStorage.setItem("keak_figma_client_secret", secret);
    setFigmaBusy(true); setConnectMsg(t("Opening Figma sign-in… approve it in your browser."));
    try {
      const raw = await invoke<string>("figma_connect", { args: { clientId: id, clientSecret: secret } });
      const tok = JSON.parse(raw);
      if (!tok.access_token) throw new Error("no token returned");
      localStorage.setItem("keak_figma_token", tok.access_token);
      setFigmaConnected(true); setConnectMsg(t("Figma connected."));
    } catch (e) { setConnectMsg(`${t("Figma connection failed:")} ${String(e).slice(0, 160)}`); }
    finally { setFigmaBusy(false); }
  }
  function disconnectFigma() { localStorage.removeItem("keak_figma_token"); setFigmaConnected(false); setConnectMsg(t("Figma disconnected.")); }

  // Supabase connection (project URL + service key — Supabase has no OAuth for data access).
  const [supabaseUrl, setSupabaseUrl] = useState<string>(() => localStorage.getItem("keak_supabase_url") || "");
  const [supabaseKey, setSupabaseKey] = useState<string>(() => localStorage.getItem("keak_supabase_key") || "");
  const [supabaseConnected, setSupabaseConnected] = useState<boolean>(() => !!localStorage.getItem("keak_supabase_url"));
  function saveSupabase() {
    const u = supabaseUrl.trim(); const k = supabaseKey.trim();
    if (!u || !k) { setConnectMsg(t("Paste your Supabase project URL and service key.")); return; }
    localStorage.setItem("keak_supabase_url", u); localStorage.setItem("keak_supabase_key", k);
    setSupabaseConnected(true); setConnectMsg(t("Supabase connected."));
  }
  function disconnectSupabase() {
    ["keak_supabase_url", "keak_supabase_key"].forEach((k) => localStorage.removeItem(k));
    setSupabaseUrl(""); setSupabaseKey(""); setSupabaseConnected(false); setConnectMsg(t("Supabase disconnected."));
  }

  // GitHub connection: device flow sign-in (shared app) with a Personal Access Token fallback.
  const [githubConnected, setGithubConnected] = useState<boolean>(() => !!localStorage.getItem("keak_github_token"));
  const [githubBusy, setGithubBusy] = useState<boolean>(false);
  const [githubAdvanced, setGithubAdvanced] = useState<boolean>(false);
  const [githubPat, setGithubPat] = useState<string>("");
  const [githubCode, setGithubCode] = useState<string>("");
  async function connectGithubDevice() {
    if (!HAS_SHARED_GITHUB) { setConnectMsg(t("GitHub one-click isn't switched on in this build yet. Paste a token below.")); setGithubAdvanced(true); return; }
    setGithubBusy(true); setGithubCode(""); setConnectMsg(t("Starting GitHub sign-in…"));
    try {
      const raw = await invoke<string>("github_device_start", { args: { clientId: KEAK_GITHUB_CLIENT_ID } });
      const d = JSON.parse(raw);
      if (!d.device_code) throw new Error(d.error || "no device code");
      setGithubCode(d.user_code || "");
      setConnectMsg(`${t("Enter the code")} ${d.user_code} ${t("in the page that just opened, then wait here.")}`);
      try { await invoke("open_url", { url: d.verification_uri || "https://github.com/login/device" }); } catch { /* ignore */ }
      const interval = Math.max(5, (d.interval || 5)) * 1000;
      const deadline = Date.now() + (d.expires_in || 900) * 1000;
      // Poll until GitHub returns a token or the code expires.
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        const praw = await invoke<string>("github_device_poll", { args: { clientId: KEAK_GITHUB_CLIENT_ID, deviceCode: d.device_code } });
        const p = JSON.parse(praw);
        if (p.access_token) {
          localStorage.setItem("keak_github_token", p.access_token);
          setGithubConnected(true); setGithubCode(""); setConnectMsg(t("GitHub connected."));
          setGithubBusy(false); return;
        }
        if (p.error && p.error !== "authorization_pending" && p.error !== "slow_down") throw new Error(p.error);
      }
      setConnectMsg(t("GitHub sign-in expired. Try again."));
    } catch (e) { setConnectMsg(`${t("GitHub sign-in failed:")} ${String(e).slice(0, 140)}`); }
    finally { setGithubBusy(false); }
  }
  function saveGithubPat() {
    const tok = githubPat.trim();
    if (!tok) { setConnectMsg(t("Paste your GitHub token first.")); return; }
    localStorage.setItem("keak_github_token", tok); setGithubConnected(true); setConnectMsg(t("GitHub connected."));
  }
  function disconnectGithub() { localStorage.removeItem("keak_github_token"); setGithubConnected(false); setConnectMsg(t("GitHub disconnected.")); }

  // Second Brain OS: connect a local folder so Keak can read/list all of it and (per your permission) create,
  // edit or delete files, folders and skills inside it. Each user sets their own folder + permission level.
  const [brainPath, setBrainPath] = useState<string>(() => localStorage.getItem("keak_brain_path") || "C:\\Users\\inforkraft.es\\Downloads\\PEP'S SECOND BRAIN");
  const [brainConnected, setBrainConnected] = useState<boolean>(() => !!localStorage.getItem("keak_brain_path"));
  const [brainPerm, setBrainPerm] = useState<string>(() => localStorage.getItem("keak_brain_perm") || "full");
  const [brainAutoContext, setBrainAutoContext] = useState<boolean>(() => localStorage.getItem("keak_brain_autocontext") === "1");
  const [brainTree, setBrainTree] = useState<string[]>([]);
  const [brainBusy, setBrainBusy] = useState<boolean>(false);
  const [showGraph, setShowGraph] = useState<boolean>(false); // the visual 2D/3D map of the connected folder
  async function connectBrain() {
    const p = brainPath.trim();
    if (!p) { setConnectMsg(t("Paste the folder path of your Second Brain first.")); return; }
    setBrainBusy(true); setConnectMsg(t("Opening your Second Brain…"));
    try {
      const raw = await invoke<string>("sb_tree", { args: { root: p, maxDepth: 1, maxEntries: 80 } });
      const items = JSON.parse(raw) as string[];
      localStorage.setItem("keak_brain_path", p);
      localStorage.setItem("keak_brain_perm", brainPerm);
      localStorage.setItem("keak_brain_autocontext", brainAutoContext ? "1" : "0");
      setBrainTree(items); setBrainConnected(true);
      setConnectMsg(`${t("Second Brain connected.")} ${items.length} ${t("items at the top level.")}`);
    } catch (e) { setConnectMsg(`${t("Couldn't open that folder:")} ${String(e).slice(0, 160)}`); }
    finally { setBrainBusy(false); }
  }
  function disconnectBrain() {
    localStorage.removeItem("keak_brain_path");
    setBrainConnected(false); setBrainTree([]); setConnectMsg(t("Second Brain disconnected."));
  }
  async function pickBrainFolder() {
    try {
      const p = await invoke<string>("pick_folder");
      if (p) { setBrainPath(p); setConnectMsg(t("Folder selected. Pick what Keak may do, then Connect.")); }
    } catch { /* the user cancelled the picker */ }
  }
  function saveBrainPerm(v: string) { setBrainPerm(v); localStorage.setItem("keak_brain_perm", v); }
  function toggleBrainAutoContext(v: boolean) { setBrainAutoContext(v); localStorage.setItem("keak_brain_autocontext", v ? "1" : "0"); }
  async function refreshBrainTree() {
    try { const raw = await invoke<string>("sb_tree", { args: { root: brainPath.trim(), maxDepth: 1, maxEntries: 80 } }); setBrainTree(JSON.parse(raw) as string[]); }
    catch (e) { setConnectMsg(`${t("Couldn't read the folder:")} ${String(e).slice(0, 140)}`); }
  }

  // Routines: scheduled tasks. The list + editor live here; the Overlay window actually runs them.
  const [routines, setRoutines] = useState<Routine[]>(() => readRoutines());
  const [rtEditing, setRtEditing] = useState<Routine | null>(null);
  function refreshRoutines() { setRoutines(readRoutines()); }
  // Refresh the list when a routine is created elsewhere (by voice or from Telegram), so it shows up here.
  useEffect(() => { const un = listen("routines-updated", refreshRoutines); return () => { un.then((f) => f()); }; }, []);
  function blankRoutine(): Routine { return { id: newRoutineId(), name: "", freq: "daily", hour: 9, minute: 0, instructions: "", output: "telegram", tools: [], enabled: true }; }
  function startAddRoutine() {
    if (routines.length >= MAX_ROUTINES) { setConnectMsg(t("You've reached the limit of routines. Delete one to create a new one.")); return; }
    setRtEditing(blankRoutine());
  }
  function startEditRoutine(r: Routine) { setRtEditing({ ...r }); }
  function cancelRoutineEdit() { setRtEditing(null); }
  function patchEditing(patch: Partial<Routine>) { setRtEditing((r) => r ? { ...r, ...patch } : r); }
  function toggleEditingTool(id: string) { setRtEditing((r) => r ? { ...r, tools: r.tools.includes(id) ? r.tools.filter((x) => x !== id) : [...r.tools, id] } : r); }
  function saveRoutineEdit() {
    if (!rtEditing) return;
    const isNew = !routines.some((x) => x.id === rtEditing.id);
    if (isNew && routines.length >= MAX_ROUTINES) { setConnectMsg(t("You've reached the limit of routines. Delete one to create a new one.")); return; }
    const r: Routine = { ...rtEditing, name: rtEditing.name.trim() || "Routine", instructions: rtEditing.instructions.trim() };
    if (!r.instructions) { setConnectMsg(t("Tell the routine what to do (the instructions).")); return; }
    upsertRoutine(r); refreshRoutines(); setRtEditing(null); setConnectMsg(`${t("Saved")} "${r.name}".`);
  }
  function deleteRoutine(id: string) { removeRoutine(id); refreshRoutines(); if (rtEditing?.id === id) setRtEditing(null); }
  function toggleRoutineEnabled(r: Routine) { upsertRoutine({ ...r, enabled: !r.enabled }); refreshRoutines(); }
  function runRoutineNow(r: Routine) { localStorage.setItem("keak_routine_run_now", r.id); setConnectMsg(`${t("Running")} "${r.name}" ${t("now…")}`); }

  // Autostart: keep Keak running (tray) + launch at login so routines fire even when the window is closed.
  const [autostart, setAutostart] = useState<boolean>(false);
  useEffect(() => { invoke<boolean>("get_autostart").then(setAutostart).catch(() => {}); }, []);
  async function toggleAutostart(v: boolean) {
    try { const now = await invoke<boolean>("set_autostart", { enabled: v }); setAutostart(now); }
    catch (e) { setConnectMsg(`${t("Couldn't change startup setting:")} ${String(e).slice(0, 120)}`); }
  }

  // Shopify connection: store domain + Admin API access token (custom app).
  const [shopifyShop, setShopifyShop] = useState<string>(() => localStorage.getItem("keak_shopify_shop") || "");
  const [shopifyToken, setShopifyToken] = useState<string>(() => localStorage.getItem("keak_shopify_token") || "");
  const [shopifyConnected, setShopifyConnected] = useState<boolean>(() => !!localStorage.getItem("keak_shopify_token"));
  function saveShopify() {
    const s = shopifyShop.trim(); const tok = shopifyToken.trim();
    if (!s || !tok) { setConnectMsg(t("Paste your store domain and Admin API token.")); return; }
    localStorage.setItem("keak_shopify_shop", s); localStorage.setItem("keak_shopify_token", tok);
    setShopifyConnected(true); setConnectMsg(t("Shopify connected."));
  }
  function disconnectShopify() {
    ["keak_shopify_shop", "keak_shopify_token"].forEach((k) => localStorage.removeItem(k));
    setShopifyShop(""); setShopifyToken(""); setShopifyConnected(false); setConnectMsg(t("Shopify disconnected."));
  }

  // Gumloop connection: API key + your user id + a saved flow id to trigger.
  const [gumloopKey, setGumloopKey] = useState<string>(() => localStorage.getItem("keak_gumloop_key") || "");
  const [gumloopUser, setGumloopUser] = useState<string>(() => localStorage.getItem("keak_gumloop_user") || "");
  const [gumloopFlow, setGumloopFlow] = useState<string>(() => localStorage.getItem("keak_gumloop_flow") || "");
  const [gumloopConnected, setGumloopConnected] = useState<boolean>(() => !!localStorage.getItem("keak_gumloop_key"));
  function saveGumloop() {
    const k = gumloopKey.trim();
    if (!k) { setConnectMsg(t("Paste your Gumloop API key first.")); return; }
    localStorage.setItem("keak_gumloop_key", k);
    localStorage.setItem("keak_gumloop_user", gumloopUser.trim());
    localStorage.setItem("keak_gumloop_flow", gumloopFlow.trim());
    localStorage.setItem("keak_tool_gumloop", k); // mirror so it counts as a connected AI tool for agents
    setGumloopConnected(true); setToolTick((n) => n + 1); setConnectMsg(t("Gumloop connected."));
  }
  function disconnectGumloop() {
    ["keak_gumloop_key", "keak_gumloop_user", "keak_gumloop_flow", "keak_tool_gumloop"].forEach((k) => localStorage.removeItem(k));
    setGumloopKey(""); setGumloopUser(""); setGumloopFlow(""); setGumloopConnected(false); setToolTick((n) => n + 1); setConnectMsg(t("Gumloop disconnected."));
  }

  // Make (make.com): API token + region, then pick which scenario Keak runs. Fires via the Make API.
  const [makeToken, setMakeToken] = useState<string>(() => localStorage.getItem("keak_make_token") || "");
  const [makeRegion, setMakeRegion] = useState<string>(() => localStorage.getItem("keak_make_region") || "eu2");
  const [makeScenario, setMakeScenario] = useState<string>(() => localStorage.getItem("keak_make_scenario") || "");
  const [makeConnected, setMakeConnected] = useState<boolean>(() => !!localStorage.getItem("keak_make_token"));
  const [makeScenarios, setMakeScenarios] = useState<{ id: string; name: string }[] | null>(null);
  const [makeLoading, setMakeLoading] = useState<boolean>(false);
  function saveMake() {
    const tok = makeToken.trim();
    if (!tok) { setConnectMsg(t("Paste your Make API token first.")); return; }
    localStorage.setItem("keak_make_token", tok);
    localStorage.setItem("keak_make_region", makeRegion.trim() || "eu2");
    localStorage.setItem("keak_tool_make", tok); // mirror so it counts as a connected tool for agents
    setMakeConnected(true); setToolTick((n) => n + 1); setConnectMsg(t("Make connected. Load your scenarios and pick one."));
  }
  function disconnectMake() {
    ["keak_make_token", "keak_make_region", "keak_make_scenario", "keak_tool_make"].forEach((k) => localStorage.removeItem(k));
    setMakeToken(""); setMakeScenario(""); setMakeScenarios(null); setMakeConnected(false); setToolTick((n) => n + 1); setConnectMsg(t("Make disconnected."));
  }
  function saveMakeScenario(v: string) {
    setMakeScenario(v);
    if (v) localStorage.setItem("keak_make_scenario", v); else localStorage.removeItem("keak_make_scenario");
  }
  async function loadMakeScenarios() {
    const tok = makeToken.trim(); const region = makeRegion.trim() || "eu2";
    if (!tok) { setConnectMsg(t("Paste your Make API token first.")); return; }
    setMakeLoading(true); setConnectMsg(t("Loading your Make scenarios…"));
    try {
      const raw = await invoke<string>("make_scenarios", { args: { token: tok, region } });
      const parsed = JSON.parse(raw) as { scenarios: { id: string; name: string }[] };
      setMakeScenarios(parsed.scenarios);
      setConnectMsg(t("Loaded. Pick the scenario Keak should run."));
    } catch (e) { setConnectMsg(`${t("Couldn't load Make scenarios:")} ${String(e).slice(0, 140)}`); }
    finally { setMakeLoading(false); }
  }

  // Telegram bridge: talk to Keak from your phone. Paste a bot token from @BotFather; the desktop polls it.
  const [telegramToken, setTelegramToken] = useState<string>(() => localStorage.getItem("keak_telegram_token") || "");
  const [telegramConnected, setTelegramConnected] = useState<boolean>(() => !!localStorage.getItem("keak_telegram_token"));
  function saveTelegram() {
    const tok = telegramToken.trim();
    if (!tok) { setConnectMsg(t("Paste your Telegram bot token first.")); return; }
    localStorage.setItem("keak_telegram_token", tok);
    localStorage.removeItem("keak_telegram_chat"); // re-bind to whoever messages the bot first (that's you)
    setTelegramConnected(true); setConnectMsg(t("Telegram connected. Message your bot from your phone to link it."));
    // Give the fresh bot the Keak logo as its profile picture (best-effort; ignored if Telegram declines).
    invoke("telegram_set_photo", { token: tok }).catch(() => { /* user can still set it via BotFather */ });
  }
  function disconnectTelegram() {
    ["keak_telegram_token", "keak_telegram_chat"].forEach((k) => localStorage.removeItem(k));
    setTelegramToken(""); setTelegramConnected(false); setConnectMsg(t("Telegram disconnected."));
  }

  // API-key tools (Perplexity, HeyGen, ElevenLabs, Gamma, Higgsfield, Make, n8n, Manus).
  const [toolKeys, setToolKeys] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}; AI_TOOLS.forEach((t) => { o[t.id] = getToolKey(t.id); }); return o;
  });
  const [toolTick, setToolTick] = useState(0); // bump to re-read connected state for the agent picker
  function saveTool(id: string) {
    setToolKey(id, toolKeys[id] || "");
    setToolTick((n) => n + 1);
    setConnectMsg((toolKeys[id] || "").trim() ? `${AI_TOOLS.find((x) => x.id === id)?.name} ${t("connected.")}` : t("Cleared."));
  }

  // HeyGen avatar + voice picker (video generation needs an avatar_id and voice_id from the user's account).
  const [heygenAvatar, setHeygenAvatar] = useState<string>(() => localStorage.getItem("keak_tool_heygen_avatar") || "");
  const [heygenVoice, setHeygenVoice] = useState<string>(() => localStorage.getItem("keak_tool_heygen_voice") || "");
  const [heygenAssets, setHeygenAssets] = useState<{ avatars: { id: string; name: string }[]; voices: { id: string; name: string; language: string }[] } | null>(null);
  const [heygenLoading, setHeygenLoading] = useState<boolean>(false);
  async function loadHeygenAssets() {
    const key = getToolKey("heygen");
    if (!key) { setConnectMsg(t("Save your HeyGen key first, then load your avatars.")); return; }
    setHeygenLoading(true); setConnectMsg(t("Loading your HeyGen avatars and voices…"));
    try {
      const raw = await invoke<string>("heygen_assets", { args: { apiKey: key } });
      setHeygenAssets(JSON.parse(raw));
      setConnectMsg(t("Loaded. Pick an avatar and a voice below."));
    } catch (e) { setConnectMsg(`${t("Couldn't load HeyGen assets:")} ${String(e).slice(0, 140)}`); }
    finally { setHeygenLoading(false); }
  }
  function saveHeygenAvatar(v: string) { setHeygenAvatar(v); if (v) localStorage.setItem("keak_tool_heygen_avatar", v); else localStorage.removeItem("keak_tool_heygen_avatar"); }
  function saveHeygenVoice(v: string) { setHeygenVoice(v); if (v) localStorage.setItem("keak_tool_heygen_voice", v); else localStorage.removeItem("keak_tool_heygen_voice"); }

  // Clicking an agent opens its history: every run where it did something. detailAgent = the agent's name.
  const [detailAgent, setDetailAgent] = useState<string | null>(null);
  // Keak Recap: capture the computer's audio (a call/meeting), transcribe it in chunks, then summarise.
  const [recapOn, setRecapOn] = useState(false);
  const [recapSecs, setRecapSecs] = useState(0);
  const [recapBusy, setRecapBusy] = useState(false);
  const [recapStatus, setRecapStatus] = useState("");
  const [recapOut, setRecapOut] = useState("");
  // Keak Streaming: how live dictation shows up. "pill" (default) shows words in the Keak pill; "cursor" types
  // them live where you're writing and swaps for the clean version on release; "off" disables it.
  const [streamMode, setStreamMode] = useState<string>(() => { const v = localStorage.getItem("keak_streaming"); return (v === "0" || v === "off") ? "off" : "pill"; });
  function chooseStreamMode(v: string) { setStreamMode(v); localStorage.setItem("keak_streaming", v); }
  // At-cursor live typing is deferred to the proper streaming engine; normalise any old "cursor" setting.
  useEffect(() => { const v = localStorage.getItem("keak_streaming"); if (v && v !== "off" && v !== "pill") localStorage.setItem("keak_streaming", "pill"); }, []);
  useEffect(() => { if (activeSection === "work" && localStorage.getItem("keak_brain_path")) loadBrainSkills(); }, [activeSection]);
  // Team-to-team (Telegram group): your name in the group + what an incoming task can use + a live log.
  const [teamName, setTeamName] = useState<string>(() => localStorage.getItem("keak_team_name") || localStorage.getItem("keak_user_name") || "");
  const [teamAccess, setTeamAccess] = useState<string>(() => localStorage.getItem("keak_team_access") || "ai");
  const [teamGroup, setTeamGroup] = useState<string>(() => localStorage.getItem("keak_team_group") || "");
  const [teamLog, setTeamLog] = useState<Array<{ ts: number; dir: string; who: string; body: string; result?: string }>>([]);
  function saveTeamName(v: string) { setTeamName(v); if (v.trim()) localStorage.setItem("keak_team_name", v.trim()); else localStorage.removeItem("keak_team_name"); }
  function chooseTeamAccess(v: string) { setTeamAccess(v); localStorage.setItem("keak_team_access", v); }
  function forgetTeamGroup() { localStorage.removeItem("keak_team_group"); setTeamGroup(""); }
  useEffect(() => {
    const read = () => { try { const l = JSON.parse(localStorage.getItem("keak_team_log") || "[]"); setTeamLog(Array.isArray(l) ? l : []); } catch { /* ignore */ } setTeamGroup(localStorage.getItem("keak_team_group") || ""); };
    read(); const id = window.setInterval(read, 3000); return () => clearInterval(id);
  }, []);
  // Keak Memory: the opt-in facts Keak remembers about you. Stored locally (keak_memories), auto-captured
  // after Keak AI turns (see Overlay), shown + editable here so you always see and control what it knows.
  type MemFact = { id: string; text: string; ts: number };
  const [memoryOn, setMemoryOn] = useState<boolean>(() => localStorage.getItem("keak_memory_on") === "1");
  const [memories, setMemories] = useState<MemFact[]>([]);
  const [newMemory, setNewMemory] = useState<string>("");
  function readMemories() { try { const l = JSON.parse(localStorage.getItem("keak_memories") || "[]"); setMemories(Array.isArray(l) ? l : []); } catch { setMemories([]); } }
  function toggleMemory(v: boolean) { setMemoryOn(v); localStorage.setItem("keak_memory_on", v ? "1" : "0"); }
  function saveMemoriesList(list: MemFact[]) { localStorage.setItem("keak_memories", JSON.stringify(list.slice(0, 200))); setMemories(list); }
  function addMemory() { const v = newMemory.trim(); if (!v) return; saveMemoriesList([{ id: `${Date.now()}`, text: v.slice(0, 120), ts: Date.now() }, ...memories]); setNewMemory(""); }
  function deleteMemory(id: string) { saveMemoriesList(memories.filter((m) => m.id !== id)); }
  function clearMemories() { saveMemoriesList([]); }
  useEffect(() => { readMemories(); const un = listen("memory-updated", readMemories); const id = window.setInterval(readMemories, 4000); return () => { un.then((f) => f()); clearInterval(id); }; }, []);
  // Live voice: default ON. When on, a Keak AI turn opens a realtime session on your connected AI.
  const [liveMode, setLiveMode] = useState<boolean>(() => localStorage.getItem("keak_live_mode") !== "0");
  function toggleLiveMode(v: boolean) { setLiveMode(v); localStorage.setItem("keak_live_mode", v ? "1" : "0"); }
  // X (Twitter) posting needs OAuth 1.0a user context: 4 credentials from a read+write developer app.
  const [xApiKey, setXApiKey] = useState<string>(() => localStorage.getItem("keak_x_api_key") || "");
  const [xApiSecret, setXApiSecret] = useState<string>(() => localStorage.getItem("keak_x_api_secret") || "");
  const [xAccessToken, setXAccessToken] = useState<string>(() => localStorage.getItem("keak_x_access_token") || "");
  const [xAccessSecret, setXAccessSecret] = useState<string>(() => localStorage.getItem("keak_x_access_secret") || "");
  const [xConnected, setXConnected] = useState<boolean>(() => !!localStorage.getItem("keak_tool_x"));
  function saveX() {
    const k = xApiKey.trim(), s = xApiSecret.trim(), at = xAccessToken.trim(), asec = xAccessSecret.trim();
    if (!k || !s || !at || !asec) { setConnectMsg(t("Fill in all four X credentials.")); return; }
    localStorage.setItem("keak_x_api_key", k);
    localStorage.setItem("keak_x_api_secret", s);
    localStorage.setItem("keak_x_access_token", at);
    localStorage.setItem("keak_x_access_secret", asec);
    localStorage.setItem("keak_tool_x", "1"); // marks the X tool connected + assignable to agents
    setXConnected(true); setConnectMsg(t("X connected."));
  }
  function disconnectX() {
    ["keak_x_api_key", "keak_x_api_secret", "keak_x_access_token", "keak_x_access_secret", "keak_tool_x"].forEach((k) => localStorage.removeItem(k));
    setXApiKey(""); setXApiSecret(""); setXAccessToken(""); setXAccessSecret(""); setXConnected(false); setConnectMsg(t("X disconnected."));
  }
  // Bluesky posts via the AT Protocol: just a handle + an app password (never the real login password).
  const [bskyHandle, setBskyHandle] = useState<string>(() => localStorage.getItem("keak_bsky_handle") || "");
  const [bskyAppPw, setBskyAppPw] = useState<string>(() => localStorage.getItem("keak_bsky_app_password") || "");
  const [bskyConnected, setBskyConnected] = useState<boolean>(() => !!localStorage.getItem("keak_tool_bluesky"));
  function saveBluesky() {
    const h = bskyHandle.trim().replace(/^@/, ""), p = bskyAppPw.trim();
    if (!h || !p) { setConnectMsg(t("Enter your Bluesky handle and app password.")); return; }
    localStorage.setItem("keak_bsky_handle", h);
    localStorage.setItem("keak_bsky_app_password", p);
    localStorage.setItem("keak_tool_bluesky", "1"); // marks Bluesky connected + assignable to agents
    setBskyConnected(true); setConnectMsg(t("Bluesky connected."));
  }
  function disconnectBluesky() {
    ["keak_bsky_handle", "keak_bsky_app_password", "keak_tool_bluesky"].forEach((k) => localStorage.removeItem(k));
    setBskyHandle(""); setBskyAppPw(""); setBskyConnected(false); setConnectMsg(t("Bluesky disconnected."));
  }
  // Connections: each connector is collapsed to just its name + status. Click the head to reveal its config
  // (API key / sign-in), one open at a time. Delegated so we don't have to wire every card by hand.
  const [openConn, setOpenConn] = useState<number>(-1);
  const connSecRef = useRef<HTMLElement | null>(null);
  function onConnHeadClick(e: { target: EventTarget | null }) {
    const head = (e.target as HTMLElement)?.closest?.(".cx-conn-head");
    const root = connSecRef.current;
    if (!head || !root) return;
    const card = head.closest(".cx-conn");
    if (!card) return;
    const idx = Array.from(root.querySelectorAll(".cx-conn")).indexOf(card as Element);
    setOpenConn((cur) => (cur === idx ? -1 : idx));
  }
  useEffect(() => {
    const root = connSecRef.current;
    if (!root) return;
    Array.from(root.querySelectorAll(".cx-conn")).forEach((el, i) => (el as HTMLElement).classList.toggle("cx-conn--open", i === openConn));
  });
  // Logo animations now play on hover / select of any tool or connection (see FxLogo),
  // not on connect — so you can browse and enjoy them without connecting anything.
  const recapBusyRef = useRef(false);
  useEffect(() => { recapBusyRef.current = recapBusy; }, [recapBusy]);
  // Reflect the REAL capture state. A recap can be started/stopped BY VOICE from the overlay (not just this
  // button), so the tab polls Rust and always shows whether a recording is running, with the live timer.
  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const st = await invoke<[boolean, number]>("recap_status");
        if (recapBusyRef.current) return; // don't fight the stop + transcribe flow
        setRecapSecs(st[1] || 0);
        setRecapOn(st[0]);
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, []);
  // When a recap is finished by voice, the overlay pushes it here (with the text in the payload, so it works
  // even if windows don't share storage). Also load the last saved recap when the app opens.
  useEffect(() => {
    try { const h = JSON.parse(localStorage.getItem("keak_recap_history") || "[]"); if (Array.isArray(h) && h[0]?.recap) setRecapOut((cur) => cur || h[0].recap); } catch { /* ignore */ }
    const un = listen<{ recap?: string }>("recap-done", (e) => { const r = e.payload?.recap; if (r) { setRecapOut(r); setRecapStatus(""); setRecapBusy(false); } });
    return () => { un.then((f) => f()); };
  }, []);
  const [recapMic, setRecapMic] = useState<boolean>(() => localStorage.getItem("keak_recap_mic") !== "0");
  function toggleRecapMic(v: boolean) { setRecapMic(v); localStorage.setItem("keak_recap_mic", v ? "1" : "0"); }
  async function startRecap() {
    setRecapOut(""); setRecapStatus(""); setRecapSecs(0);
    try { await invoke("recap_start", { mic: localStorage.getItem("keak_recap_mic") !== "0" }); setRecapOn(true); }
    catch (e) { setRecapStatus(String(e)); }
  }
  // Throw away a running capture (a mistake / nothing recorded) without transcribing it.
  async function cancelRecap() {
    try { await invoke("recap_cancel"); } catch { /* ignore */ }
    setRecapOn(false); setRecapSecs(0); setRecapBusy(false); setRecapStatus(t("Discarded, nothing was saved."));
  }
  async function stopRecap() {
    setRecapOn(false); setRecapBusy(true);
    try {
      const res = await invoke<[string, number]>("recap_stop");
      const secs = res[1] || 0;
      if (secs < 1.5) { setRecapStatus(t("Nothing was captured. Make sure the meeting audio plays out loud (speakers), then try again.")); setRecapBusy(false); return; }
      const CHUNK = 120;
      const count = await invoke<number>("recap_chunk_count", { chunkSecs: CHUNK });
      const session = JSON.parse(localStorage.getItem("keak_session") || "null");
      const lang = localStorage.getItem("keak_language");
      let transcript = "";
      for (let i = 0; i < count; i++) {
        setRecapStatus(`${t("Transcribing…")} ${i + 1}/${count}`);
        const b64 = await invoke<string>("recap_chunk_b64", { index: i, chunkSecs: CHUNK });
        if (!b64) continue;
        const form = new FormData();
        form.append("file", b64ToBlob(b64, "audio/wav"), "chunk.wav");
        if (lang && lang !== "auto") form.append("language", lang);
        try {
          const r = await fetch(`${RECAP_SUPABASE_URL}/functions/v1/transcribe`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token || ""}` }, body: form });
          const d = await r.json().catch(() => ({} as { text?: string }));
          if (d.text) transcript += (transcript ? " " : "") + String(d.text).trim();
        } catch { /* skip a bad chunk, keep going */ }
      }
      transcript = transcript.trim();
      if (!transcript) { setRecapStatus(t("I captured audio but heard no speech to transcribe. Check the output device and try again.")); setRecapBusy(false); return; }
      setRecapStatus(t("Writing the recap…"));
      const ai = resolveChatAI("");
      if (!ai) { setRecapOut(transcript); setRecapStatus(t("Connect your AI to summarise. Here's the raw transcript for now.")); setRecapBusy(false); return; }
      const uiCode = localStorage.getItem("keak_ui_lang") || "en";
      const LN: Record<string, string> = { es: "Spanish", ca: "Catalan", fr: "French", de: "German", pt: "Portuguese", it: "Italian", en: "English" };
      const system = `You are given a raw transcript of a call or meeting captured from the user's computer audio. Write a clean recap in ${LN[uiCode] || "English"} using these markdown sections: a one-paragraph Summary, Key points (bullets), Decisions, and Action items (with the owner if a name is mentioned). Be faithful to the transcript and never invent anything. If the transcript is thin or unclear, keep the recap short and say so.`;
      try {
        const recap = await invoke<string>("cu_chat", { args: { provider: ai.provider, credential: ai.credential, accountId: ai.accountId, isSubscription: ai.isSub, model: ai.model, effort: ai.effort, system, history: [], message: transcript.slice(0, 24000) } });
        setRecapOut(recap || transcript); setRecapStatus("");
        try { const prev = JSON.parse(localStorage.getItem("keak_recap_history") || "[]"); const h = Array.isArray(prev) ? prev : []; h.unshift({ ts: Date.now(), secs, recap: recap || "", transcript }); localStorage.setItem("keak_recap_history", JSON.stringify(h.slice(0, 20))); } catch { /* ignore */ }
      } catch (e) { setRecapOut(transcript); setRecapStatus(`${t("Couldn't summarise")}: ${String(e).slice(0, 120)}`); }
    } catch (e) { setRecapStatus(String(e)); }
    setRecapBusy(false);
  }
  // Send the recap into a Work chat so you can tell Keak to turn it into a PDF, a Google Doc, an email, etc.
  function openRecapInChat() {
    if (!recapOut.trim()) return;
    const now = Date.now();
    const run: AgentRun = { ts: now, job: t("Meeting recap"), results: [], messages: [{ role: "assistant", text: recapOut, ts: now }] };
    persistHistory([run, ...history]); setSelectedRun(0);
    setChatInput(t("Turn this recap into a PDF I can share."));
    setActiveSection("work");
  }
  // Work section: which run (chat) is open in the right pane.
  const [selectedRun, setSelectedRun] = useState<number>(0);

  function toggleUseOwnAi(v: boolean) { localStorage.setItem("keak_ai_use_own", v ? "1" : "0"); }
  function setDial(key: string, set: (v: number) => void, v: number) { set(v); localStorage.setItem(key, String(v)); }

  function chooseCuProvider(p: string) { setCuProvider(p); localStorage.setItem("keak_cu_provider", p); setConnectMsg(""); }
  // Keak's assistant always runs on the user's OWN AI. Picking a provider ensures answers route to it.
  function pickProvider(p: string) { toggleUseOwnAi(true); chooseCuProvider(p); }
  const [claudeBusy, setClaudeBusy] = useState(false);
  async function saveClaudeToken() {
    const v = claudeToken.trim();
    if (!v) { localStorage.setItem("keak_cu_claude_token", ""); setClaudeSaved(false); setConnectMsg(t("Cleared.")); return; }
    setClaudeBusy(true); setConnectMsg(t("Checking your Claude connection…"));
    try {
      await invoke<string>("claude_verify", { args: { credential: v } });
      localStorage.setItem("keak_cu_claude_token", v);
      localStorage.setItem("keak_cu_provider", "claude");
      setClaudeSaved(true); setConnectMsg(t("Claude connected."));
    } catch (e) {
      // Do not mark connected if it failed, and show the real reason.
      setClaudeSaved(false);
      setConnectMsg(String(e).slice(0, 220));
    } finally { setClaudeBusy(false); }
  }
  // Read the Claude Code login from disk (after `claude setup-token`) and connect, no copy-paste.
  async function connectClaudeFromCli() {
    setClaudeBusy(true); setConnectMsg(t("Reading your Claude login…"));
    try {
      const tok = await invoke<string>("claude_read_cli_token");
      await invoke<string>("claude_verify", { args: { credential: tok } });
      localStorage.setItem("keak_cu_claude_token", tok);
      localStorage.setItem("keak_cu_provider", "claude");
      setClaudeToken(tok); setClaudeSaved(true); setConnectMsg(t("Claude connected."));
    } catch (e) { setClaudeSaved(false); setConnectMsg(String(e).slice(0, 220)); }
    finally { setClaudeBusy(false); }
  }
  function disconnectClaude() { localStorage.setItem("keak_cu_claude_token", ""); setClaudeToken(""); setClaudeSaved(false); setConnectMsg(t("Claude disconnected.")); }
  function saveOpenaiKey() { const v = openaiKey.trim(); localStorage.setItem("keak_cu_openai_key", v); setOpenaiSaved(!!(v || openaiToken.trim())); setConnectMsg(v ? t("ChatGPT connected.") : t("Cleared.")); }
  function disconnectOpenai() {
    ["keak_cu_openai_key", "keak_cu_openai_token", "keak_cu_openai_refresh", "keak_cu_openai_account"].forEach((k) => localStorage.setItem(k, ""));
    setOpenaiKey(""); setOpenaiToken(""); setOpenaiUserCode(""); setOpenaiSaved(false); setConnectMsg(t("ChatGPT disconnected."));
  }
  function saveGeminiKey() { const v = geminiKey.trim(); localStorage.setItem("keak_cu_gemini_key", v); setGeminiSaved(!!v); setConnectMsg(v ? t("Gemini connected.") : t("Cleared.")); }
  function disconnectGemini() { localStorage.setItem("keak_cu_gemini_key", ""); setGeminiKey(""); setGeminiSaved(false); setConnectMsg(t("Gemini disconnected.")); }
  function disconnectOllama() { localStorage.removeItem("keak_cu_ollama_models"); localStorage.setItem("keak_cu_ollama_model", ""); setOllamaConnected([]); setOllamaModel(""); setOllamaSaved(false); setOllamaEditing(false); setConnectMsg(t("Local models removed.")); }

  function saveDeepseekKey() { const v = deepseekKey.trim(); localStorage.setItem("keak_cu_deepseek_key", v); setDeepseekSaved(!!v); setConnectMsg(v ? t("DeepSeek connected.") : t("Cleared.")); }
  function disconnectDeepseek() { localStorage.setItem("keak_cu_deepseek_key", ""); setDeepseekKey(""); setDeepseekSaved(false); setConnectMsg(t("DeepSeek disconnected.")); }
  function saveMistralKey() { const v = mistralKey.trim(); localStorage.setItem("keak_cu_mistral_key", v); setMistralSaved(!!v); setConnectMsg(v ? t("Mistral connected.") : t("Cleared.")); }
  function disconnectMistral() { localStorage.setItem("keak_cu_mistral_key", ""); setMistralKey(""); setMistralSaved(false); setConnectMsg(t("Mistral disconnected.")); }
  function saveXaiKey() { const v = xaiKey.trim(); localStorage.setItem("keak_cu_xai_key", v); setXaiSaved(!!v); setConnectMsg(v ? t("Grok connected.") : t("Cleared.")); }
  function disconnectXai() { localStorage.setItem("keak_cu_xai_key", ""); setXaiKey(""); setXaiSaved(false); setConnectMsg(t("Grok disconnected.")); }
  function saveKimiKey() { const v = kimiKey.trim(); localStorage.setItem("keak_cu_kimi_key", v); setKimiSaved(!!v); setConnectMsg(v ? t("Kimi connected.") : t("Cleared.")); }
  function disconnectKimi() { localStorage.setItem("keak_cu_kimi_key", ""); setKimiKey(""); setKimiSaved(false); setConnectMsg(t("Kimi disconnected.")); }

  // Copilot: the user runs `copilot /login` in a terminal, then we read the token its CLI stored.
  async function connectCopilot() {
    setCopilotBusy(true); setConnectMsg(t("Looking for your Copilot login…"));
    try {
      const tok = await invoke<string>("copilot_read_cli_token");
      localStorage.setItem("keak_cu_copilot_token", tok);
      localStorage.setItem("keak_cu_provider", "copilot");
      setCopilotToken(tok); setCuProvider("copilot");
      setConnectMsg(t("Copilot connected. Your subscription now powers Keak."));
    } catch (e) {
      setConnectMsg(String(e).slice(0, 200));
    } finally { setCopilotBusy(false); }
  }
  function disconnectCopilot() { localStorage.setItem("keak_cu_copilot_token", ""); setCopilotToken(""); setConnectMsg(t("Copilot disconnected.")); }
  async function copyCopilotCmd() {
    try { await navigator.clipboard.writeText("copilot /login"); setConnectMsg(t("Copied. Run it in a terminal, sign in, then click “I've signed in”.")); }
    catch { setConnectMsg(t("Run this in a terminal:") + " copilot /login"); }
  }
  async function copySetupCmd() {
    try { await navigator.clipboard.writeText("claude setup-token"); setConnectMsg(t("Copied. Paste it in a terminal, then paste the token back here.")); }
    catch { setConnectMsg(t("Run this in a terminal:") + " claude setup-token"); }
  }
  async function openUrl(url: string) { try { await invoke("open_url", { url }); } catch { setConnectMsg(`${t("Open:")} ${url}`); } }
  function chooseActionMode(m: string) { setActionMode(m); localStorage.setItem("keak_action_mode", m); }
  function toggleCaptions(v: boolean) { setShowCaptions(v); localStorage.setItem("keak_show_captions", v ? "1" : "0"); }

  // "Sign in with ChatGPT" — device-authorization flow, driven by the native Rust commands.
  async function startOpenAiLogin() {
    setOpenaiUserCode("");
    setConnectMsg(t("Opening ChatGPT sign-in..."));
    let d: { user_code?: string; device_auth_id?: string; verification_url?: string; interval?: number };
    try {
      d = JSON.parse(await invoke<string>("openai_login_start"));
    } catch (e) {
      setConnectMsg(`${t("Couldn't start ChatGPT sign-in")} (${e}). ${t("You can paste an OpenAI API key instead.")}`);
      return;
    }
    const deviceAuthId = d.device_auth_id || "";
    const code = d.user_code || "";
    const uri = d.verification_url || "";
    if (!deviceAuthId) { setConnectMsg(t("ChatGPT sign-in didn't return a code. Try again.")); return; }
    setOpenaiUserCode(code);
    if (uri) { try { await invoke("open_url", { url: uri }); } catch { /* user can still type the code */ } }
    setConnectMsg(t("Waiting for you to authorize in the browser..."));
    const intervalMs = Math.max(2, d.interval || 5) * 1000;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        window.clearInterval(timer); setOpenaiUserCode(""); setConnectMsg(t("Sign-in timed out. Try again."));
        return;
      }
      let r: { ok?: boolean; pending?: boolean; access_token?: string; refresh_token?: string; account_id?: string };
      try {
        r = JSON.parse(await invoke<string>("openai_login_poll", { deviceAuthId, userCode: code }));
      } catch (e) {
        window.clearInterval(timer); setOpenaiUserCode(""); setConnectMsg(`${t("Sign-in failed:")} ${e}`);
        return;
      }
      if (r.ok && r.access_token) {
        window.clearInterval(timer);
        localStorage.setItem("keak_cu_openai_token", r.access_token);
        localStorage.setItem("keak_cu_openai_refresh", r.refresh_token || "");
        localStorage.setItem("keak_cu_openai_account", r.account_id || "");
        localStorage.setItem("keak_cu_provider", "openai");
        setOpenaiToken(r.access_token);
        setOpenaiSaved(true);
        setCuProvider("openai");
        setOpenaiUserCode("");
        setConnectMsg(t("ChatGPT connected. Your subscription now powers Keak."));
      }
    }, intervalMs);
  }

  const SWATCHES = ["#D4A49A", "#C9A24A", "#8FA47D", "#B08A72", "#9A7060", "#C68B7E", "#D8B86A", "#6E8FA0"];
  // The shared edit form for an agent (default or custom). `showModel` adds the per-agent model picker.
  function editForm(showModel: boolean, onReset?: () => void) {
    return (
      <div className="cx-agent-edit">
        <input className="cx-input" placeholder={t("Name")} value={edName} onChange={(e) => setEdName(e.target.value)} />
        <input className="cx-input" placeholder={t("What it's good at")} value={edDesc} onChange={(e) => setEdDesc(e.target.value)} />
        <textarea className="cx-input cx-textarea" placeholder={t("Personality and tone (e.g. warm, blunt, playful, writes like a poet)")} value={edPersona} onChange={(e) => setEdPersona(e.target.value)} />
        {showModel && (
          <select className="cx-select" value={edChoice} onChange={(e) => setEdChoice(e.target.value)}>
            {MODEL_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.value === "" ? t("Team default model") : c.label}</option>)}
          </select>
        )}
        <div className="cx-swatches">
          {SWATCHES.map((c) => (
            <button key={c} className={`cx-swatch${edColor === c ? " cx-swatch--on" : ""}`} style={{ background: c }} onClick={() => setEdColor(c)} aria-label={`colour ${c}`} />
          ))}
          <input type="color" className="cx-color" value={edColor} onChange={(e) => setEdColor(e.target.value)} />
        </div>
        {(() => {
          const options = assignableForAgents();
          if (options.length === 0) {
            return <p className="cx-help" style={{ marginTop: 2 }}>{t("Connect a tool below (Perplexity, Notion, Slack…) to let this agent use it.")}</p>;
          }
          return (
            <div className="cx-toolpick">
              <span className="cx-toolpick-label">{t("Tools this agent can use")}</span>
              <div className="cx-toolpick-chips">
                {options.map((o) => (
                  <button
                    key={o.id}
                    className={`cx-toolchip${edTools.includes(o.id) ? " cx-toolchip--on" : ""}`}
                    onClick={() => toggleEdTool(o.id)}
                    type="button"
                  >{o.name}</button>
                ))}
              </div>
            </div>
          );
        })()}
        <div className="cx-edit-actions">
          <button className="cx-btn cx-btn--sm" onClick={saveEdit}>{t("Save")}</button>
          <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={cancelEdit}>{t("Cancel")}</button>
          {onReset && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={onReset}>{t("Reset to original")}</button>}
        </div>
      </div>
    );
  }

  // The runs a given agent took part in (for the per-agent history panel).
  function runsForAgent(name: string): { run: AgentRun; result: AgentRun["results"][number] }[] {
    const out: { run: AgentRun; result: AgentRun["results"][number] }[] = [];
    for (const run of history) {
      for (const r of run.results) { if (r.name === name) out.push({ run, result: r }); }
    }
    return out;
  }

  // ==== Keak Planet interactivity (purely presentational) ================
  // One rAF-throttled pointermove listener drives three things:
  //  1. cosmos parallax  — sets --kx-mx / --kx-my (-1..1) on .kx-cosmos;
  //     each dust/nebula layer translates by a different small amount in CSS.
  //  2. planet proximity — sets --kx-near / --kx-tx / --kx-ty on the planet
  //     scene (tilt toward cursor, glow up, moons surge) + .kx-scene--near.
  //  3. stardust trail   — spawns tiny fading motes into .kx-trail; each
  //     removes itself on animationend (finite, hard-capped at 26 nodes).
  // Fully disabled under prefers-reduced-motion. Remove this effect + the
  // kx-trail div + the .kx-mote CSS to drop the trail feature.
  const kxCosmosRef = useRef<HTMLDivElement | null>(null);
  const kxSceneRef = useRef<HTMLDivElement | null>(null);
  const kxTrailRef = useRef<HTMLDivElement | null>(null);
  const kxMoonCursorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let px = 0, py = 0, seen = false;
    let lastMote = 0, lastMx = -1e4, lastMy = -1e4;
    const apply = () => {
      raf = 0;
      if (!seen) return;
      const w = window.innerWidth || 1, h = window.innerHeight || 1;
      const cosmos = kxCosmosRef.current;
      if (cosmos) {
        cosmos.style.setProperty("--kx-mx", ((px / w) * 2 - 1).toFixed(3));
        cosmos.style.setProperty("--kx-my", ((py / h) * 2 - 1).toFixed(3));
      }
      const scene = kxSceneRef.current;
      if (scene) {
        const r = scene.getBoundingClientRect();
        const dx = px - (r.left + r.width / 2);
        const dy = py - (r.top + r.height / 2);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 340);
        scene.style.setProperty("--kx-near", near.toFixed(3));
        scene.style.setProperty("--kx-tx", Math.max(-1, Math.min(1, dx / 340)).toFixed(3));
        scene.style.setProperty("--kx-ty", Math.max(-1, Math.min(1, dy / 340)).toFixed(3));
        scene.classList.toggle("kx-scene--near", near > 0.32);
      }
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX; py = e.clientY; seen = true;
      if (!raf) raf = requestAnimationFrame(apply);
      const trail = kxTrailRef.current;
      const now = performance.now();
      const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
      if (trail && now - lastMote > 46 && dx * dx + dy * dy > 140) {
        lastMote = now; lastMx = e.clientX; lastMy = e.clientY;
        const mote = document.createElement("i");
        mote.className = Math.random() < 0.3 ? "kx-mote kx-mote--rose" : "kx-mote";
        const s = 2.5 + Math.random() * 3;
        mote.style.left = `${e.clientX + (Math.random() - 0.5) * 14}px`;
        mote.style.top = `${e.clientY + (Math.random() - 0.5) * 14}px`;
        mote.style.width = `${s}px`;
        mote.style.height = `${s}px`;
        mote.addEventListener("animationend", () => mote.remove());
        trail.appendChild(mote);
        while (trail.childElementCount > 26) trail.firstElementChild?.remove();
      }
    };
    const onLeave = () => {
      kxCosmosRef.current?.style.setProperty("--kx-mx", "0");
      kxCosmosRef.current?.style.setProperty("--kx-my", "0");
      const scene = kxSceneRef.current;
      if (scene) { scene.style.setProperty("--kx-near", "0"); scene.classList.remove("kx-scene--near"); }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
      onLeave();
    };
  }, []);

  // The cursor IS a moon (Sirius-coloured, like the agent moons). It eases toward the pointer, and when it
  // drifts near the Keak planet it locks into ORBIT and circles the planet on its own — like being one of
  // its moons — until the pointer pulls away again. Purely presentational; pointer-events:none so it never
  // blocks a click. Off under prefers-reduced-motion (the native cursor stays). Remove this effect + the
  // .kx-cursor-moon div + CSS to drop the feature.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const moon = kxMoonCursorRef.current;
    if (!moon) return;
    let px = window.innerWidth / 2, py = window.innerHeight / 2; // pointer target
    let mx = px, my = py;                                        // rendered moon position (eased)
    let orbiting = false, angle = 0, over = false, seen = false, raf = 0;
    const ENTER = 148, EXIT = 250, ORB = 116, SPEED = 0.036;      // orbit geometry
    const onMove = (e: PointerEvent) => {
      px = e.clientX; py = e.clientY; seen = true;
      moon.style.opacity = "1";
      const el = e.target as Element | null;
      over = !!(el && el.closest && el.closest("button, a, [role=button], input, select, textarea, .cx-card, .cx-provider, .cx-conn, .cx-nav-item, label, .kx-moon"));
    };
    const onLeaveWin = () => { moon.style.opacity = "0"; };
    const loop = () => {
      if (seen) {
        const scene = kxSceneRef.current;
        let cx = -1e5, cy = -1e5;
        if (scene) { const r = scene.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
        const dist = Math.hypot(px - cx, py - cy);
        if (over) orbiting = false; // hovering something clickable (e.g. an agent moon) → drop orbit so you can aim + see its name
        else if (!orbiting && dist < ENTER) { orbiting = true; angle = Math.atan2(my - cy, mx - cx); }
        else if (orbiting && dist > EXIT) orbiting = false;
        if (orbiting) {
          angle += SPEED;
          const tx = cx + Math.cos(angle) * ORB, ty = cy + Math.sin(angle) * ORB;
          mx += (tx - mx) * 0.26; my += (ty - my) * 0.26;
        } else {
          mx += (px - mx) * 0.30; my += (py - my) * 0.30;
        }
        const scale = orbiting ? 0.8 : over ? 1.35 : 1;
        moon.style.transform = `translate(${mx.toFixed(2)}px, ${my.toFixed(2)}px) translate(-50%, -50%) scale(${scale})`;
        moon.classList.toggle("kx-cursor-moon--orbit", orbiting);
        moon.classList.toggle("kx-cursor-moon--over", over && !orbiting);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeaveWin);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeaveWin);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Provider attack show — purely presentational. We only WATCH cuProvider
  // change (pickProvider and its logic are untouched); the newly chosen card
  // then plays its signature move over the grid. Debounced; self-cleaning.
  const cxGridRef = useRef<HTMLDivElement | null>(null);
  const atkPrevRef = useRef<string | null>(null);
  const atkStopRef = useRef<(() => void) | null>(null);
  const atkLastRef = useRef<number>(0);
  useEffect(() => {
    const prev = atkPrevRef.current;
    atkPrevRef.current = cuProvider;
    if (prev === null || prev === cuProvider) return; // initial mount / no change
    const now = Date.now();
    if (now - atkLastRef.current < 350) return; // debounce rapid re-picks
    atkLastRef.current = now;
    atkStopRef.current?.();
    atkStopRef.current = playProviderAttack(cxGridRef.current, cuProvider);
    return () => { atkStopRef.current?.(); atkStopRef.current = null; };
  }, [cuProvider]);

  // Reasoning effort → moon orbit speed (presentational, read-only on state):
  // higher effort spins the agent moons faster around the Keak planet. The
  // multiplier lands on .kx-planet-scene as --kx-orbit-mult; the moons' CSS
  // divides their animation-duration by it. "" / other providers → 1 (as now).
  const kxOrbitMult = cuProvider === "claude"
    ? (({ low: 0.65, medium: 1, high: 1.6, max: 2.4 } as Record<string, number>)[claudeEffort] ?? 1)
    : 1;

  return (
    <div className="connect-scroll">
      {/* Keak Planet cosmos — purely presentational, sits behind everything.
          Warm edition: whisper-faint rose/gold dust drifting over the cream. */}
      <div className="kx-cosmos" aria-hidden="true" ref={kxCosmosRef}>
        <i className="kx-nebula kx-nebula--a" />
        <i className="kx-nebula kx-nebula--b" />
        <i className="kx-nebula kx-nebula--c" />
        <i className="kx-stars kx-stars--far" />
        <i className="kx-stars kx-stars--mid" />
        <i className="kx-stars kx-stars--near" />
        <i className="kx-stars kx-stars--rose" />
        <i className="kx-aurora" />
        <i className="kx-shoot" />
        <i className="kx-shoot kx-shoot--b" />
        <i className="kx-vignette" />
      </div>
      {/* cursor stardust trail — motes are spawned by the pointer effect and
          remove themselves on animationend; delete this div + the effect +
          the .kx-mote CSS to drop the feature entirely */}
      <div className="kx-trail" aria-hidden="true" ref={kxTrailRef} />
      {/* The cursor, as a Sirius-coloured moon that orbits the Keak planet when it gets close. */}
      <div className="kx-cursor-moon" aria-hidden="true" ref={kxMoonCursorRef} />
      <div className="connect-view connect-view--full">
        <div className="connect-layout">
          <aside className="cx-sidebar">
            <div className="cx-lockup">
              <img src={keakLogo} alt="Keak" className="cx-logo" />
              <div className="cx-headtext">
                <span className="cx-wordmark">Keak</span>
                <span className="cx-sub">{t("You talk, we write.")}</span>
              </div>
            </div>

            {/* The Keak planet — a glowing rose world on the cream sky.
                The user's agents orbit it as small coloured moons: hover a
                moon to see the agent's name, click it to open that agent.
                Purely presentational — data mirrors the Agents section. */}
            <div className="kx-planet-scene" ref={kxSceneRef} style={{ "--kx-orbit-mult": kxOrbitMult } as CSSProperties}>
              <i className="kx-planet-glow" aria-hidden="true" />
              <i className="kx-planet-halo" aria-hidden="true" />
              <div className="kx-planet" aria-hidden="true" />
              {(() => {
                // LIVE mirror of the Agents section: same [...defaults, ...roster]
                // state arrays, so colour edits, new agents and deletions all
                // re-render the moons automatically. Capped at 12; radii, sizes,
                // phases and periods spread by index + count so the whole set
                // fits the sidebar without crowding.
                const moons = [
                  ...defaults.map((d) => ({ name: d.name, color: d.color })),
                  ...roster.map((r) => ({ name: r.name, color: r.color })),
                ].slice(0, 12);
                const n = Math.max(1, moons.length);
                const bands = n <= 4 ? 2 : n <= 8 ? 3 : 4;
                return moons.map((m, i) => {
                  const band = i % bands;
                  const radius = 48 + band * (n > 8 ? 12 : 15);
                  const size = Math.max(5, (n > 8 ? 8 : 9) - band);
                  const phase = Math.round((i * 360) / n + band * 19) % 360;
                  const dur = 26 + band * 9 + (i % 3) * 4;
                  return (
                    <button
                      key={`${m.name}-${i}`}
                      type="button"
                      className="kx-moon"
                      title={m.name}
                      aria-label={m.name}
                      style={{
                        "--moon-color": m.color,
                        "--moon-r": `${radius}px`,
                        "--moon-dur": `${dur}s`,
                        "--moon-delay": `${-((phase / 360) * dur).toFixed(2)}s`,
                        "--moon-size": `${size}px`,
                        "--moon-phase": `${phase}deg`,
                      } as CSSProperties}
                      onClick={() => { setActiveSection("agents"); setDetailAgent(m.name); }}
                    >
                      <span className="kx-moon-hold">
                        <span className="kx-moon-dot" />
                        <span className="kx-moon-tip">{m.name}</span>
                      </span>
                    </button>
                  );
                });
              })()}
            </div>

            <h1 className="cx-title">{t("Connect your AI")}</h1>

            <nav className="connect-nav">
              {SECTIONS.map((s) => (
                <button key={s.id} className={`cx-nav-item${activeSection === s.id ? " cx-nav-item--on" : ""}`} onClick={() => setActiveSection(s.id)}>
                  <span className="cx-nav-ico" aria-hidden="true">{NAV_ICONS[s.id]}</span>
                  <span className="cx-nav-label">{t(s.label)}</span>
                </button>
              ))}
            </nav>

          </aside>

          <div className="connect-main connect-main--wide" key={activeSection}>
            {activeSection === "ai" && (
            <section className="cx-card cx-hero">
          <SectionHero id="ai">
            <p className="cx-eyebrow">{t("Your AI")}</p>
            <h2 className="cx-h">{t("Bring your own intelligence")}</h2>
            <p className="cx-lead">{t("Keak runs on your own Claude, ChatGPT, Gemini, or a local model. It powers both Keak AI and screen control, so there's no extra cost per action.")}</p>
          </SectionHero>

          <div className="cx-provider-grid" role="group" aria-label={t("Your AI")} ref={cxGridRef}>
            {PROVIDER_CARDS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`cx-provider-card${cuProvider === p.id ? " cx-provider-card--on" : ""}`}
                onClick={() => pickProvider(p.id)}
              >
                <span className="cx-provider-mark" aria-hidden="true">{PROVIDER_MARKS[p.id]}</span>
                <span className="cx-provider-name">{p.name}</span>
                {cuProvider === p.id && <span className="cx-provider-check" aria-hidden="true"><CheckIcon /></span>}
              </button>
            ))}
          </div>

          {cuProvider === "claude" && (
            <div className="cx-body">
              {claudeSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Claude connected")}</div>
                  <div className="cx-connected-hint">{t("Your subscription is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectClaude}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <div className="cx-note"><b>{t("Use your Claude subscription.")}</b> {t("Open a terminal, run the command below, and sign in. Then click \"Connect with my Claude login\". No copy-paste needed.")}</div>
                  <div className="cx-cmd">
                    <code>claude setup-token</code>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={copySetupCmd}>{t("Copy")}</button>
                  </div>
                  <button className="cx-btn" onClick={connectClaudeFromCli} disabled={claudeBusy}>{claudeBusy ? t("Checking…") : t("Connect with my Claude login")}</button>
                  <p className="cx-help">{t("Needs the Claude CLI (")}<code>npm i -g @anthropic-ai/claude-code</code>{t("). Or paste an Anthropic API key instead.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://console.anthropic.com/settings/keys")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("Paste your Claude token or API key")} value={claudeToken} onChange={(e) => setClaudeToken(e.target.value)} />
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={saveClaudeToken} disabled={claudeBusy}>{claudeBusy ? t("Checking…") : t("Save & connect")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")} <span className="cx-field-tag">{t("or say \"switch to Haiku\"")}</span></label>
                <select className="cx-select" value={claudeModel} onChange={(e) => saveModel("claude", e.target.value, setClaudeModel)}>
                  <option value="">{t("Default (recommended)")}</option>
                  <option value="claude-opus-4-8">{t("Opus 4.8 — most capable")}</option>
                  <option value="claude-sonnet-5">{t("Sonnet 5 — balanced")}</option>
                  <option value="claude-sonnet-4-6">{t("Sonnet 4.6 — cheaper, fewer limits")}</option>
                  <option value="claude-haiku-4-5">{t("Haiku 4.5 — fastest, fewer limits")}</option>
                  <option value="claude-fable-5">{t("Fable 5 — top tier")}</option>
                </select>
                <p className="cx-help">{t("A lighter model hits fewer rate limits.")}</p>
              </div>

              <div className="cx-field">
                <label className="cx-field-label">{t("Effort")}</label>
                <select className="cx-select" value={claudeEffort} onChange={(e) => { setClaudeEffort(e.target.value); localStorage.setItem("keak_cu_claude_effort", e.target.value); }}>
                  <option value="">{t("Default")}</option>
                  <option value="low">{t("Low")}</option>
                  <option value="medium">{t("Medium")}</option>
                  <option value="high">{t("High")}</option>
                  <option value="max">{t("Max")}</option>
                </select>
                <p className="cx-help">{t("Lower is faster and cheaper, and uses fewer limits.")}</p>
              </div>
            </div>
          )}

          {cuProvider === "openai" && (
            <div className="cx-body">
              {openaiSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("ChatGPT connected")}</div>
                  <div className="cx-connected-hint">{openaiToken.trim() ? t("Your subscription is powering Keak.") : t("Your OpenAI key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectOpenai}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <button className="cx-btn cx-btn--block" onClick={startOpenAiLogin}>{t("Sign in with ChatGPT")}</button>
                  {openaiUserCode && (
                    <div className="cx-code">
                      <span className="cx-code-label">{t("Enter this code at ChatGPT")}</span>
                      <div className="cx-code-row">
                        <span className="cx-code-value">{openaiUserCode}</span>
                        <button
                          className="cx-btn cx-btn--ghost cx-btn--sm"
                          onClick={async () => {
                            try { await navigator.clipboard.writeText(openaiUserCode); setConnectMsg(t("Code copied. Paste it at the ChatGPT page.")); }
                            catch { setConnectMsg(`${t("Code is")} ${openaiUserCode} ${t("— type it at the ChatGPT page.")}`); }
                          }}
                        >
                          {t("Copy")}
                        </button>
                      </div>
                    </div>
                  )}
                  <p className="cx-help"><b>{t("Easiest:")}</b> {t("click \"Sign in with ChatGPT\" and enter the code at the page that opens. Or paste an OpenAI API key.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://platform.openai.com/api-keys")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("OpenAI API key (optional)")} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveOpenaiKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")} <span className="cx-field-tag">{t("or say \"switch to GPT\"")}</span></label>
                <select className="cx-select" value={openaiModel} onChange={(e) => saveModel("openai", e.target.value, setOpenaiModel)}>
                  <option value="">{t("Default")}</option>
                  <option value="gpt-5.6">GPT-5.6</option>
                  <option value="gpt-4o">GPT-4o</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "gemini" && (
            <div className="cx-body">
              {geminiSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Gemini connected")}</div>
                  <div className="cx-connected-hint">{t("Your Gemini key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectGemini}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <p className="cx-help">{t("Get a free Google AI Studio key, then paste it below.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://aistudio.google.com/apikey")}>{t("Get a free key")}</button>
                  <input className="cx-input" type="password" placeholder={t("Gemini API key")} value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveGeminiKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")} <span className="cx-field-tag">{t("or say \"switch to Flash\"")}</span></label>
                <select className="cx-select" value={geminiModel} onChange={(e) => saveModel("gemini", e.target.value, setGeminiModel)}>
                  <option value="">{t("Default (3.5 Flash)")}</option>
                  <option value="gemini-3.5-flash">3.5 Flash</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "ollama" && (
            <div className="cx-body">
              {ollamaSaved && !ollamaEditing ? (
                <>
                  <div className="cx-connected">
                    <div className="cx-check"><CheckIcon /></div>
                    <div className="cx-connected-name">{t("Local model ready")}</div>
                    <div className="cx-connected-hint">{ollamaConnected.length} {ollamaConnected.length === 1 ? t("model connected, running on your own computer.") : t("models connected, running on your own computer.")}</div>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectOllama}>{t("Disconnect")}</button>
                  </div>

                  <div className="cx-field">
                    <label className="cx-field-label">{t("Model")} <span className="cx-field-tag">{t("or say \"switch to …\"")}</span></label>
                    <select className="cx-select" value={ollamaModel} onChange={(e) => switchOllamaModel(e.target.value)}>
                      {ollamaConnected.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" style={{ marginTop: 8 }} onClick={editOllamaModels}>{t("Add or remove models")}</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="cx-help">{t("Free and private, runs on your own computer. Install Ollama, pull models (e.g.")} <code>ollama pull hermes3</code>{t("), then connect as many as you like and switch between them.")}</p>
                  <p className="cx-help">{t("Screen control needs a")} <b>{t("vision")}</b> {t("model like")} <code>llama3.2-vision</code> {t("or")} <code>qwen2-vl</code>{t(". Text-only models (Hermes, Gemma, Qwen) are fine for Keak AI answers.")}</p>
                  <p className="cx-help" style={{ opacity: 0.8 }}>{t("Best pick for Keak AI:")} <b>Hermes 3</b> {t("or")} <b>Llama 3.1 8B</b> (<code>ollama pull hermes3</code>).</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://ollama.com/download")}>{t("Get Ollama")}</button>

                  <div className="cx-field">
                    <label className="cx-field-label">{t("Your installed models")} <button className="cx-linkbtn" onClick={loadOllamaModels}>{ollamaLoading ? t("Looking…") : t("Refresh")}</button></label>
                    {ollamaModels.length > 0 ? (
                      <>
                        <div className="cx-toolpick-chips">
                          {ollamaModels.map((m) => (
                            <button key={m} type="button" className={`cx-toolchip${ollamaConnected.includes(m) ? " cx-toolchip--on" : ""}`} onClick={() => toggleOllamaPick(m)}>{m}</button>
                          ))}
                        </div>
                        <p className="cx-help">{t("Tap the models you want to connect (pick more than one to switch between them later).")}</p>
                        <button className="cx-btn" onClick={connectOllama} disabled={ollamaConnected.length === 0} style={{ marginTop: 8 }}>{t("Connect")} {ollamaConnected.length > 0 ? `${ollamaConnected.length} ${ollamaConnected.length === 1 ? t("model") : t("models")}` : t("models")}</button>
                      </>
                    ) : (
                      <p className="cx-help">{ollamaLoading ? t("Looking for your local models…") : t("No models found yet. Make sure Ollama is running, pull one (e.g. ")}{!ollamaLoading && <code>ollama pull hermes3</code>}{!ollamaLoading && t("), then hit Refresh.")}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {cuProvider === "copilot" && (
            <div className="cx-body">
              {copilotToken.trim() ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Copilot connected")}</div>
                  <div className="cx-connected-hint">{t("Your GitHub Copilot subscription is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectCopilot}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <div className="cx-note"><b>{t("Use your Copilot subscription.")}</b> {t("Open a terminal, run the command below, sign in, then come back and click “I've signed in”.")}</div>
                  <div className="cx-cmd">
                    <code>copilot /login</code>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={copyCopilotCmd}>{t("Copy")}</button>
                  </div>
                  <p className="cx-help">{t("Needs the Copilot CLI (")}<code>npm i -g @github/copilot</code>{t("). No API key, it uses your subscription.")}</p>
                  <button className="cx-btn cx-btn--block" onClick={connectCopilot} disabled={copilotBusy}>{copilotBusy ? t("Looking for your login…") : t("I've signed in")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")}</label>
                <select className="cx-select" defaultValue={localStorage.getItem("keak_cu_copilot_model") || ""} onChange={(e) => saveModel("copilot", e.target.value, () => {})}>
                  <option value="">{t("Default (GPT-4o)")}</option>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                  <option value="o1">o1</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "xai" && (
            <div className="cx-body">
              {xaiSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Grok connected")}</div>
                  <div className="cx-connected-hint">{t("Your xAI key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectXai}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <p className="cx-help">{t("Grok runs on your own xAI key. Grab one from the xAI console, then paste it below.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://console.x.ai")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("xAI API key")} value={xaiKey} onChange={(e) => setXaiKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveXaiKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")}</label>
                <select className="cx-select" defaultValue={localStorage.getItem("keak_cu_xai_model") || ""} onChange={(e) => saveModel("xai", e.target.value, () => {})}>
                  <option value="">{t("Default (Grok 4)")}</option>
                  <option value="grok-4">Grok 4</option>
                  <option value="grok-3">Grok 3</option>
                  <option value="grok-3-mini">{t("Grok 3 mini — faster")}</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "deepseek" && (
            <div className="cx-body">
              {deepseekSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("DeepSeek connected")}</div>
                  <div className="cx-connected-hint">{t("Your DeepSeek key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectDeepseek}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <p className="cx-help">{t("DeepSeek is cheap and strong. Get a key from the DeepSeek platform, then paste it below.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://platform.deepseek.com/api_keys")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("DeepSeek API key")} value={deepseekKey} onChange={(e) => setDeepseekKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveDeepseekKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")}</label>
                <select className="cx-select" defaultValue={localStorage.getItem("keak_cu_deepseek_model") || ""} onChange={(e) => saveModel("deepseek", e.target.value, () => {})}>
                  <option value="">{t("Default (deepseek-chat)")}</option>
                  <option value="deepseek-chat">deepseek-chat</option>
                  <option value="deepseek-reasoner">deepseek-reasoner</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "mistral" && (
            <div className="cx-body">
              {mistralSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Mistral connected")}</div>
                  <div className="cx-connected-hint">{t("Your Mistral key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectMistral}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <p className="cx-help">{t("Mistral runs on your own key. Get one from La Plateforme, then paste it below.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://console.mistral.ai/api-keys")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("Mistral API key")} value={mistralKey} onChange={(e) => setMistralKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveMistralKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")}</label>
                <select className="cx-select" defaultValue={localStorage.getItem("keak_cu_mistral_model") || ""} onChange={(e) => saveModel("mistral", e.target.value, () => {})}>
                  <option value="">{t("Default (Mistral Large)")}</option>
                  <option value="mistral-large-latest">Mistral Large</option>
                  <option value="mistral-small-latest">{t("Mistral Small — faster")}</option>
                </select>
              </div>
            </div>
          )}

          {cuProvider === "kimi" && (
            <div className="cx-body">
              {kimiSaved ? (
                <div className="cx-connected">
                  <div className="cx-check"><CheckIcon /></div>
                  <div className="cx-connected-name">{t("Kimi connected")}</div>
                  <div className="cx-connected-hint">{t("Your Moonshot AI key is powering Keak.")}</div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectKimi}>{t("Disconnect")}</button>
                </div>
              ) : (
                <>
                  <p className="cx-help">{t("Kimi K2 is one of the best cost-performance models available. Get a key from the Moonshot AI platform, then paste it below.")}</p>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://platform.moonshot.cn/console/api-keys")}>{t("Get an API key")}</button>
                  <input className="cx-input" type="password" placeholder={t("Moonshot AI API key")} value={kimiKey} onChange={(e) => setKimiKey(e.target.value)} />
                  <button className="cx-btn" onClick={saveKimiKey}>{t("Save key")}</button>
                </>
              )}

              <div className="cx-field">
                <label className="cx-field-label">{t("Model")}</label>
                <select className="cx-select" defaultValue={localStorage.getItem("keak_cu_kimi_model") || ""} onChange={(e) => saveModel("kimi", e.target.value, () => {})}>
                  <option value="">{t("Default (Kimi K3)")}</option>
                  <option value="kimi-k3">Kimi K3</option>
                  <option value="kimi-k2-0711-preview">Kimi K2</option>
                  <option value="kimi-1.5">{t("Kimi 1.5 — faster")}</option>
                </select>
              </div>
            </div>
          )}

          {connectMsg && <p className="cx-msg">{connectMsg}</p>}
            </section>
            )}

            {activeSection === "team" && (
            <section className="cx-card">
          <SectionHero id="team">
            <p className="cx-eyebrow">{t("Keak AI")}</p>
            <h2 className="cx-h">{t("Team")}</h2>
            <p className="cx-lead" style={{ marginBottom: 12 }}>{t("Put your Keak in a Telegram group with your teammates. Write \"<name>, do X\" in the group and that person's Keak does it and posts the result back for everyone to see. Each Keak runs on that person's own AI.")}</p>
          </SectionHero>
          {!localStorage.getItem("keak_telegram_token") ? (
            <>
              <p className="cx-help" style={{ marginBottom: 8 }}>{t("First you need your own Telegram bot. It takes a minute:")}</p>
              <ol className="cx-help cx-steps">
                <li>{t("In Telegram, open a chat with @BotFather.")}</li>
                <li>{t("Send /newbot, give it a name and a username, and copy the token it gives you (a long code).")}</li>
                <li>{t("In Keak, go to Connections, open Telegram, and paste that token.")}</li>
                <li>{t("Come back to this Team tab to set up the group.")}</li>
              </ol>
              <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://t.me/BotFather")}>{t("Open BotFather")}</button>
            </>
          ) : (
            <>
              <ol className="cx-help cx-steps">
                <li>{t("Make sure you created your bot with @BotFather and pasted its token in Connections → Telegram.")}</li>
                <li>{t("In @BotFather, send /setprivacy, pick your bot, and choose Disable so it can read group messages.")}</li>
                <li>{t("Create a Telegram group with your teammates and add your Keak bot to it.")}</li>
                <li>{t("Each teammate does the same with their own bot (their own @BotFather bot, privacy Disabled, added to the group).")}</li>
                <li>{t("Send any message in the group so Keak learns it. Then write \"<your name>, …\" to give your Keak a task in front of everyone.")}</li>
              </ol>
              <div className="cx-field">
                <label className="cx-field-label">{t("Your name in the group")}</label>
                <input className="cx-input" placeholder={t("e.g. Pep")} value={teamName} onChange={(e) => saveTeamName(e.target.value)} />
                <p className="cx-help" style={{ marginTop: 6 }}>{t("Your Keak answers when a group message starts with this, like \"Pep, draft the reply\".")}</p>
              </div>
              <div className="cx-field" style={{ marginTop: 12 }}>
                <label className="cx-field-label">{t("What a teammate's task can use")}</label>
                <select className="cx-select" value={teamAccess} onChange={(e) => chooseTeamAccess(e.target.value)}>
                  <option value="ai">{t("Just my AI")}</option>
                  <option value="brain">{t("My AI + read my Second Brain")}</option>
                </select>
              </div>
              <p className="cx-help" style={{ marginTop: 12 }}>
                {teamGroup ? t("Team group linked.") : t("No group linked yet — send a message in your group so Keak learns it.")}
                {teamGroup && <button className="cx-btn cx-btn--ghost cx-btn--sm" style={{ marginLeft: 8 }} onClick={forgetTeamGroup}>{t("Forget group")}</button>}
              </p>
              {teamLog.length > 0 && (
                <div style={{ marginTop: 16, borderTop: "1px solid #DECFB0", paddingTop: 14 }}>
                  <label className="cx-field-label">{t("Recent team activity")}</label>
                  {teamLog.slice(0, 12).map((e, i) => (
                    <div key={i} className="cx-run" style={{ marginTop: 8 }}>
                      <div className="cx-run-job">{e.who} <span className="cx-run-time">{clockLabel(e.ts)}</span></div>
                      <div className="cx-run-out" style={{ whiteSpace: "pre-wrap" }}>{e.body}{e.result ? `\n→ ${e.result}` : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
            </section>
            )}

            {activeSection === "recap" && (
            <section className="cx-card">
          <SectionHero id="recap">
            <p className="cx-eyebrow">{t("Keak AI")}</p>
            <h2 className="cx-h">{t("Recap a meeting")}</h2>
          </SectionHero>
          <div className={`cx-wave${recapOn ? " cx-wave--live" : ""}`} aria-hidden="true">
            {Array.from({ length: 28 }).map((_, i) => <i key={i} style={{ "--kxi": i } as CSSProperties} />)}
          </div>
          <p className="cx-help" style={{ marginTop: 4 }}>{t("Keak records the audio playing on your computer (a call, a meeting, a video) and writes you a clean recap: summary, key points, decisions and action items. It captures what you hear and transcribes on your own setup.")}</p>
          <p className="cx-help" style={{ marginTop: 6 }}>{t("You can also just say \"Hey Keak, start a recap\" and later \"finish the recap\".")}</p>
          {!recapOn && (
            <label className="cx-check-row" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={recapMic} onChange={(e) => toggleRecapMic(e.target.checked)} />
              <span>{t("Include my microphone, so your own voice is in the recap too (not just the other people).")}</span>
            </label>
          )}
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 14 }}>
            {!recapOn ? (
              <button className="cx-recbtn" onClick={startRecap} disabled={recapBusy} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: recapBusy ? "#E7D9C2" : "#D4A49A", color: "#2C1508", fontWeight: 700, cursor: recapBusy ? "default" : "pointer" }}>{recapBusy ? t("Working…") : t("Start recap")}</button>
            ) : (
              <>
                <button className="cx-recbtn cx-recbtn--stop" onClick={stopRecap} style={{ padding: "10px 20px", borderRadius: 10, border: "none", background: "#C68B7E", color: "#fff", fontWeight: 700, cursor: "pointer" }}>{t("Stop & recap")}</button>
                <button onClick={cancelRecap} className="cx-btn cx-btn--ghost cx-btn--sm" title={t("Throw this recording away")}>{t("Discard")}</button>
              </>
            )}
            {recapOn && <span className="cx-help cx-reclive" style={{ color: "#C68B7E", fontWeight: 700 }}>● {t("Recording")} {Math.floor(recapSecs / 60)}:{String(Math.floor(recapSecs % 60)).padStart(2, "0")}</span>}
          </div>
          {recapStatus && <p className="cx-help" style={{ marginTop: 8, color: "#C68B7E", fontWeight: 600 }}>{recapStatus}</p>}
          {recapOut && (
            <div className="cx-recap-out" style={{ marginTop: 14, borderTop: "1px solid #DECFB0", paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <label className="cx-field-label">{t("Recap")}</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={openRecapInChat}>{t("Open in chat")}</button>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => { navigator.clipboard.writeText(recapOut).catch(() => {}); }}>{t("Copy")}</button>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => { setRecapOut(""); setRecapStatus(""); }} title={t("Remove this recap")}>{t("Delete")}</button>
                </div>
              </div>
              <div style={{ maxHeight: 340, overflowY: "auto", paddingRight: 6 }}><RecapText text={recapOut} /></div>
            </div>
          )}
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.globe}>
            <p className="cx-eyebrow">{t("Language")}</p>
            <h2 className="cx-h">{t("Interface language")}</h2>
          </MiniHead>
          <div className="cx-field">
            <select className="cx-select" value={uiLang} onChange={(e) => { const l = e.target.value as typeof uiLang; setUiLangState(l); localStorage.setItem("keak_ui_lang_ai", UI_LANG_AI_NAME[l]); }}>
              {UI_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <p className="cx-help" style={{ marginTop: 12 }}>{t("Keak will show its buttons and menus in this language, and Keak AI will reply in it.")}</p>
          </div>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.mic}>
            <p className="cx-eyebrow">{t("Dictation")}</p>
            <h2 className="cx-h">{t("Dictation language")}</h2>
          </MiniHead>
          <div className="cx-field">
            <select className="cx-select" value={dictLang} onChange={(e) => chooseDictLang(e.target.value)}>
              <option value="auto">{t("Auto-detect")}</option>
              {UI_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <p className="cx-help" style={{ marginTop: 12 }}>{t("Pick the language you dictate in for much better accuracy. Auto-detect can mishear you.")}</p>
          </div>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.mic}>
            <p className="cx-eyebrow">{t("Dictation")}</p>
            <h2 className="cx-h">{t("Live dictation")}</h2>
          </MiniHead>
          <div className="cx-field">
            <select className="cx-select" value={streamMode} onChange={(e) => chooseStreamMode(e.target.value)}>
              <option value="pill">{t("Show my words live in the Keak pill")}</option>
              <option value="off">{t("Off")}</option>
            </select>
            <p className="cx-help" style={{ marginTop: 12 }}>{t("See your words in the Keak pill as you talk. The final, well-written text lands at your cursor when you release.")}</p>
          </div>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.globe}>
            <p className="cx-eyebrow">{t("Dictation")}</p>
            <h2 className="cx-h">{t("Translate my speech into")}</h2>
          </MiniHead>
          <div className="cx-field">
            <select className="cx-select" value={translateTo} onChange={(e) => chooseTranslateTo(e.target.value)}>
              {UI_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <p className="cx-help" style={{ marginTop: 12 }}>
              {t("Hold Ctrl + Win to write exactly what you say. Hold Ctrl + Space to translate what you say into this language.")}
            </p>
          </div>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={NAV_ICONS.ai}>
            <p className="cx-eyebrow">{t("Keak AI")}</p>
            <h2 className="cx-h">{t("Hey Keak (Standby)")}</h2>
          </MiniHead>
          <label className="cx-check-row">
            <input type="checkbox" checked={standby} onChange={(e) => toggleStandby(e.target.checked)} />
            <span>{t("Show the Keak orb in the corner so you can talk to Keak AI without a hotkey")}</span>
          </label>
          {standby && (
            <div className="cx-field" style={{ marginTop: 12 }}>
              <label className="cx-field-label">{t("Orb position")}</label>
              <select className="cx-select" value={orbCorner} onChange={(e) => chooseOrbCorner(e.target.value)}>
                <option value="br">{t("Bottom right")}</option>
                <option value="bl">{t("Bottom left")}</option>
                <option value="tr">{t("Top right")}</option>
                <option value="tl">{t("Top left")}</option>
              </select>
            </div>
          )}
          <p className="cx-help" style={{ marginTop: 10 }}>{t("Click the orb to talk to Keak AI hands-free.")}</p>

          <div style={{ marginTop: 16, borderTop: "1px solid #DECFB0", paddingTop: 16 }}>
            <label className="cx-field-label">{t("Say \"{phrase}\" instead of clicking").replace("{phrase}", wp)}</label>
            <p className="cx-help" style={{ marginTop: 4, marginBottom: 12 }}>{t("Train it on your own voice once. It listens on your machine only, nothing is sent anywhere.")}</p>
            <button
              onClick={trainWake}
              style={{ padding: "9px 18px", borderRadius: 10, border: "none", background: "#D4A49A", color: "#2C1508", fontWeight: 700, cursor: "pointer" }}
            >
              {(wakeTrained ? t("Re-train \"{phrase}\"") : t("Train \"{phrase}\"")).replace("{phrase}", wp)}
            </button>
            <label className="cx-check-row" style={{ marginTop: 26 }}>
              <input type="checkbox" checked={wakeOn} onChange={(e) => toggleWake(e.target.checked)} />
              <span>{t("Wake when I say \"{phrase}\"").replace("{phrase}", wp)}</span>
            </label>
            {wakeStatus && <p className="cx-help" style={{ marginTop: 8, color: "#C68B7E", fontWeight: 600 }}>{wakeStatus}</p>}
          </div>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={NAV_ICONS.agents}>
            <p className="cx-eyebrow">{t("Agents")}</p>
            <h2 className="cx-h">{t("Agent names")}</h2>
          </MiniHead>
          <label className="cx-check-row">
            <input type="checkbox" checked={agentLabels} onChange={(e) => toggleAgentLabels(e.target.checked)} />
            <span>{t("Show each agent's name under its orb on screen")}</span>
          </label>
          <p className="cx-help" style={{ marginTop: 10 }}>{t("You can also tell Keak AI \"show the names\" or \"hide the names\".")}</p>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.shield}>
            <p className="cx-eyebrow">{t("Control")}</p>
            <h2 className="cx-h">{t("When Keak does an action")}</h2>
          </MiniHead>
          <div className="cx-seg cx-seg--3">
            <button className={`cx-seg-btn${actionMode === "full" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseActionMode("full")}>{t("Full access")}</button>
            <button className={`cx-seg-btn${actionMode === "ask" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseActionMode("ask")}>{t("Ask first")}</button>
            <button className={`cx-seg-btn${actionMode === "off" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseActionMode("off")}>{t("Off")}</button>
          </div>
          <p className="cx-help" style={{ marginTop: 12 }}>
            {actionMode === "full"
              ? t("Keak finishes the job on its own, including controlling your screen.")
              : actionMode === "ask"
              ? t("Keak asks before it takes over your screen. Recommended.")
              : t("Keak won't take screen actions.")}
          </p>
            </section>
            )}


            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.speaker}>
            <p className="cx-eyebrow">{t("Voice")}</p>
            <h2 className="cx-h">{t("How Keak sounds out loud")}</h2>
          </MiniHead>
          <p className="cx-lead" style={{ marginBottom: 12 }}>
            {t("The voice is separate from the AI. Claude has no voice of its own, so the voice runs on your own Gemini or OpenAI key (a free Gemini key works), which means it costs nothing extra.")}
          </p>
          <div className="cx-field">
            <label className="cx-field-label">{t("Voice source")}</label>
            <select className="cx-select" value={voiceEngine} onChange={(e) => saveVoiceEngine(e.target.value)}>
              <option value="auto">{t("Automatic — best free voice on your own AI (recommended)")}</option>
              <option value="gemini">{t("My Gemini voice")}</option>
              <option value="openai">{t("My OpenAI voice")}</option>
              <option value="elevenlabs">{t("My ElevenLabs voice")}</option>
              <option value="system">{t(IS_MAC ? "A Mac voice" : "A Windows voice")}</option>
              <option value="keak">{t("Keak's own voice")}</option>
            </select>
          </div>

          {voiceEngine === "auto" && (
            <p className="cx-help" style={{ marginTop: 6 }}>{t("Uses your own Gemini voice, then your own OpenAI voice, then a Windows voice, whichever you have. Free, and works with Claude too. Just add a Gemini or OpenAI key under Your AI (a free Gemini key from Google AI Studio is enough).").replace(/Windows/g, IS_MAC ? "Mac" : "Windows")}</p>
          )}

          {voiceEngine === "gemini" && (
            <div className="cx-field" style={{ marginTop: 14 }}>
              <label className="cx-field-label">{t("Gemini voice")} <span className="cx-field-tag">{t("runs on your own key, free tier works")}</span></label>
              <select className="cx-select" value={geminiVoice} onChange={(e) => saveGeminiVoice(e.target.value)}>
                {GEMINI_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <p className="cx-help">{t("Needs a Gemini API key under Your AI. Google AI Studio gives a free one, so even with Claude you get a premium voice at no cost.")} <button className="cx-linkbtn" onClick={() => openUrl("https://aistudio.google.com/apikey")}>{t("Get a free key")}</button></p>
              <button className="cx-btn cx-btn--sm" onClick={previewVoice} style={{ marginTop: 8 }}>{t("Preview voice")}</button>
            </div>
          )}

          {voiceEngine === "openai" && (
            <div className="cx-field" style={{ marginTop: 14 }}>
              <label className="cx-field-label">{t("OpenAI voice")} <span className="cx-field-tag">{t("runs on your own key")}</span></label>
              <select className="cx-select" value={openaiVoice} onChange={(e) => saveOpenaiVoice(e.target.value)}>
                {OPENAI_VOICES.map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
              </select>
              <p className="cx-help">{t("Needs an OpenAI API key (starts with sk-) saved under Your AI. It's a few cents of your own OpenAI credit per answer.")}</p>
              <button className="cx-btn cx-btn--sm" onClick={previewVoice} style={{ marginTop: 8 }}>{t("Preview voice")}</button>
            </div>
          )}

          {voiceEngine === "elevenlabs" && (
            <div className="cx-field" style={{ marginTop: 14 }}>
              <label className="cx-field-label">{t("ElevenLabs voice")} <span className="cx-field-tag">{t("the most realistic, uses your ElevenLabs credits")}</span></label>
              <input className="cx-input" placeholder={t("Voice ID (optional — leave blank for the default)")} value={elevenVoice} onChange={(e) => saveElevenVoice(e.target.value)} />
              <p className="cx-help">{t("Needs your ElevenLabs key under AI tools. Paste a Voice ID from your ElevenLabs voice library, or leave it blank for the default voice.")} <button className="cx-linkbtn" onClick={() => openUrl("https://elevenlabs.io/app/voice-library")}>{t("Open voice library")}</button></p>
              <button className="cx-btn cx-btn--sm" onClick={previewVoice} style={{ marginTop: 8 }}>{t("Preview voice")}</button>
            </div>
          )}

          {voiceEngine === "system" && (
            <div className="cx-field" style={{ marginTop: 14 }}>
              <label className="cx-field-label">{t(IS_MAC ? "Mac voice" : "Windows voice")} <span className="cx-field-tag">{t("free, works offline")}</span></label>
              <select className="cx-select" value={voiceUri} onChange={(e) => saveVoiceUri(e.target.value)}>
                <option value="">{t("Best available (automatic)")}</option>
                {sortedVoices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
              </select>
              <p className="cx-help">{t("Look for voices with \"Natural\" or \"Online\" in the name, they sound the best. Add more in Windows Settings, Time and language, Speech.")}</p>
              <button className="cx-btn cx-btn--sm" onClick={previewVoice} style={{ marginTop: 8 }}>{t("Preview voice")}</button>
            </div>
          )}

          {voiceEngine === "keak" && (
            <p className="cx-help" style={{ marginTop: 12 }}>{t("Keak's own natural voice (powered by Gemini on Keak's side). Uses your Keak plan rather than your own key. If you'd rather it cost nothing, use Automatic above.")}</p>
          )}
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.speaker}>
            <p className="cx-eyebrow">{t("Voice")}</p>
            <h2 className="cx-h">{t("Live voice")}</h2>
          </MiniHead>
          <p className="cx-lead" style={{ marginBottom: 10 }}>{t("Keak AI talks back the instant you stop, instead of the record-then-answer wait. When it's on, holding Ctrl and Alt (or saying Hey Keak) starts a live conversation that knows your Second Brain and Memory. It runs on the AI you connected under Your AI, with Gemini or OpenAI.")}</p>
          <label className="cx-check-row">
            <input type="checkbox" checked={liveMode} onChange={(e) => toggleLiveMode(e.target.checked)} />
            <span>{t("Use live voice for Keak AI (recommended). Turn off to use the classic record-then-answer flow.")}</span>
          </label>
          <p className="cx-help" style={{ marginTop: 10 }}>{t("Gemini is free with a Gemini key. OpenAI needs a real sk- key with a little credit. Other AIs use the classic flow automatically.")}</p>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.captions}>
            <p className="cx-eyebrow">{t("Display")}</p>
            <h2 className="cx-h">{t("Show captions")}</h2>
          </MiniHead>
          <div className="cx-seg cx-seg--2">
            <button className={`cx-seg-btn${showCaptions ? " cx-seg-btn--on" : ""}`} onClick={() => toggleCaptions(true)}>{t("On")}</button>
            <button className={`cx-seg-btn${!showCaptions ? " cx-seg-btn--on" : ""}`} onClick={() => toggleCaptions(false)}>{t("Off")}</button>
          </div>
          <p className="cx-help" style={{ marginTop: 12 }}>
            {showCaptions ? t("When Keak talks, the words show under the orb.") : t("Keak talks out loud but won't print the words.")}
          </p>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <MiniHead icon={SET_ICONS.power}>
            <p className="cx-eyebrow">{t("Background")}</p>
            <h2 className="cx-h">{t("Keep Keak running for routines")}</h2>
          </MiniHead>
          <p className="cx-lead" style={{ marginBottom: 12 }}>
            {t("Closing the window keeps Keak in the tray, so your routines still run. Turn this on to also start Keak automatically when you log in, so routines fire even after a restart.")}
          </p>
          <label className="cx-check-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input type="checkbox" checked={autostart} onChange={(e) => toggleAutostart(e.target.checked)} />
            <span className="cx-field-label" style={{ margin: 0 }}>{t("Start Keak when I log in")}</span>
          </label>
            </section>
            )}

            {activeSection === "agents" && detailAgent && (() => {
              const runs = runsForAgent(detailAgent);
              const all = [...defaults.map((d) => ({ name: d.name, color: d.color, description: d.description, personality: d.personality })), ...roster];
              const meta = all.find((a) => a.name === detailAgent);
              return (
                <section className="cx-card">
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setDetailAgent(null)} style={{ marginBottom: 10 }}>{t("← All agents")}</button>
                  <div className="cx-agent-hero">
                    <span className="cx-agent-dot cx-agent-dot--lg" style={{ background: meta?.color || "#D4A49A" }} />
                    <div className="cx-agent-meta">
                      <span className="cx-agent-name" style={{ fontSize: 22 }}>{detailAgent}</span>
                      <span className="cx-agent-desc">{t(meta?.description || "Agent")}{meta?.personality ? ` · ${t(meta.personality)}` : ""}</span>
                    </div>
                  </div>
                  <p className="cx-help" style={{ marginTop: 12 }}>{t("To use this agent by voice, say \"Hey Keak\" and ask Keak to use it, like \"use {name} to…\".").replace("{name}", detailAgent || "")}</p>
                  <h2 className="cx-h" style={{ marginTop: 16 }}>{t("What")} {detailAgent} {t("has done")}</h2>
                  {runs.length === 0 ? (
                    <p className="cx-help">{t("Nothing yet. When")} {detailAgent} {t("works on a job, it shows up here.")}</p>
                  ) : (
                    runs.map(({ run, result }, i) => (
                      <div className="cx-run" key={i}>
                        <div className="cx-run-job">“{run.job}” <span className="cx-run-time">{dayLabel(run.ts)} · {clockLabel(run.ts)}</span></div>
                        <div className="cx-run-result">
                          <div className="cx-run-head">
                            <span className="cx-run-title">{result.title}</span>
                            <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openArtifact(`${result.name}-${result.title}`, result.output)}>
                              {isHtmlOutput(result.output) ? t("Open site") : t("Open")}
                            </button>
                          </div>
                          <div className="cx-run-out">{cleanAgentText(result.output)}</div>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              );
            })()}

            {activeSection === "agents" && !detailAgent && (
            <section className="cx-card">
          <SectionHero id="agents">
            <p className="cx-eyebrow">{t("Agents")}</p>
            <h2 className="cx-h">{t("Your team")}</h2>
            <p className="cx-lead" style={{ marginBottom: 12 }}>
              {t("Say \"use your team to…\" and Keak splits the work across these agents, each on its own model and personality. Call one by name (\"Sirius, research the best video apps\") to run just that one. Click any agent to see what it has done.")} {t("You have")} {defaults.length} {t("default agents")}{roster.length > 0 ? ` ${t("plus")} ${roster.length} ${t("of your own")}` : ""}{editedCount > 0 ? ` (${editedCount} ${t("edited")})` : ""}.
            </p>
          </SectionHero>

          <p className="cx-field-label" style={{ marginBottom: 8 }}>{t("Default agents")} <span className="cx-field-tag">{t("tap Edit to rename, re-tone, or recolour")}</span></p>
          <div className="cx-agent-list cx-agent-gallery" style={{ marginBottom: 14 }}>
            {defaults.map((a) => (
              <div key={a.base}>
                <div className="cx-agent-row cx-agent-row--click">
                  <span className="cx-agent-dot" style={{ background: a.color }} onClick={() => setDetailAgent(a.name)} />
                  <div className="cx-agent-meta" onClick={() => setDetailAgent(a.name)}>
                    <span className="cx-agent-name">{a.name}</span>
                    <span className="cx-agent-desc">{t(a.description)}{a.personality ? ` · ${t(a.personality)}` : ""}</span>
                  </div>
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => editKey === `default:${a.base}` ? cancelEdit() : startEditDefault(a)}>{editKey === `default:${a.base}` ? t("Close") : t("Edit")}</button>
                </div>
                {editKey === `default:${a.base}` && editForm(true, () => resetDefault(a.base))}
              </div>
            ))}
          </div>

          {roster.length > 0 && (
            <>
              <p className="cx-field-label" style={{ marginBottom: 8 }}>{t("Your agents")}</p>
              <div className="cx-agent-list cx-agent-gallery" style={{ marginTop: 6 }}>
                {roster.map((a, i) => (
                  <div key={i}>
                    <div className="cx-agent-row cx-agent-row--click">
                      <span className="cx-agent-dot" style={{ background: a.color }} onClick={() => setDetailAgent(a.name)} />
                      <div className="cx-agent-meta" onClick={() => setDetailAgent(a.name)}>
                        <span className="cx-agent-name">{a.name}</span>
                        <span className="cx-agent-desc">{t(choiceLabel(a.choice || ""))}{a.description ? ` · ${t(a.description)}` : ""}{a.personality ? ` · ${t(a.personality)}` : ""}</span>
                      </div>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => editKey === `custom:${i}` ? cancelEdit() : startEditCustom(i, a)}>{editKey === `custom:${i}` ? t("Close") : t("Edit")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => removeAgent(i)}>{t("Remove")}</button>
                    </div>
                    {editKey === `custom:${i}` && editForm(true)}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="cx-field" style={{ marginTop: 14 }}>
            <label className="cx-field-label">{t("Add an agent")}</label>
            <input className="cx-input" placeholder={t("Name (e.g. Designer)")} value={agName} onChange={(e) => setAgName(e.target.value)} />
            <input className="cx-input" placeholder={t("What it's good at (e.g. writes landing page copy)")} value={agDesc} onChange={(e) => setAgDesc(e.target.value)} />
            <textarea className="cx-input cx-textarea" placeholder={t("Personality and tone (e.g. warm and encouraging, or blunt and fast)")} value={agPersona} onChange={(e) => setAgPersona(e.target.value)} />
            <select className="cx-select" value={agChoice} onChange={(e) => setAgChoice(e.target.value)}>
              {MODEL_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.value === "" ? t("Team default model") : c.label}</option>)}
            </select>
            <div className="cx-swatches">
              {SWATCHES.map((c) => (
                <button key={c} className={`cx-swatch${agColor === c ? " cx-swatch--on" : ""}`} style={{ background: c }} onClick={() => setAgColor(c)} aria-label={`colour ${c}`} />
              ))}
              <input type="color" className="cx-color" value={agColor} onChange={(e) => setAgColor(e.target.value)} />
            </div>
            <button className="cx-btn" onClick={addAgent}>{t("Add agent")}</button>
          </div>
            </section>
            )}

            {activeSection === "brain" && (
            <section className="cx-card">
              <SectionHero id="brain">
                <p className="cx-eyebrow">Second Brain OS</p>
                <h2 className="cx-h">{t("Connect Keak to your Second Brain")}</h2>
                <p className="cx-lead" style={{ marginBottom: 14 }}>
                  {t("Point Keak at a folder on your computer, the same one you use with Claude Code or VS Code. Keak can then read all of it, know your projects, and (with your permission) create skills, files and folders, edit them, or clean things up. It runs on your own AI, so it costs nothing extra.")}
                </p>
              </SectionHero>

              {brainConnected ? (
                <>
                  <div className="cx-connected cx-brainbox" style={{ textAlign: "left", alignItems: "flex-start" }}>
                    <span className="cx-brainbox-folder" aria-hidden="true">{NAV_ICONS.brain}</span>
                    <div className="cx-connected-name">{t("Connected to your Second Brain")}</div>
                    <div className="cx-connected-hint" style={{ wordBreak: "break-all" }}>{brainPath}</div>
                    <span className="cx-permchip">
                      {({ read: t("Read only"), create: t("Create only"), edit: t("Edit only"), full: t("Full access") } as Record<string, string>)[brainPerm] || brainPerm}
                    </span>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectBrain} style={{ marginTop: 10 }}>{t("Disconnect")}</button>
                  </div>

                  <div className="cx-field" style={{ marginTop: 26 }}>
                    <label className="cx-field-label">{t("What Keak may do in this folder")}</label>
                    <select className="cx-select" value={brainPerm} onChange={(e) => saveBrainPerm(e.target.value)}>
                      <option value="read">{t("Read only — look, never change")}</option>
                      <option value="create">{t("Create only — make new files/folders, never overwrite or delete")}</option>
                      <option value="edit">{t("Edit only — change existing files, never create or delete")}</option>
                      <option value="full">{t("Create, edit and delete — full access")}</option>
                    </select>
                    <p className="cx-help">{t("Keak always asks before it writes or deletes. Reads are free.")}</p>
                  </div>

                  <label className="cx-check-row" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20 }}>
                    <input type="checkbox" checked={brainAutoContext} onChange={(e) => toggleBrainAutoContext(e.target.checked)} />
                    <span className="cx-field-label" style={{ margin: 0 }}>{t("Load a summary of my brain into every answer")} <span className="cx-field-tag">{t("knows you better, uses a few more tokens")}</span></span>
                  </label>
                  <p className="cx-help" style={{ marginTop: 4 }}>{t("Off means Keak only reads what it needs, when you ask. On means it always has your README, CLAUDE.md and folder map for context.")}</p>

                  <div className="cx-field" style={{ marginTop: 22 }}>
                    <label className="cx-field-label">{t("Top of your Second Brain")} <button className="cx-linkbtn" onClick={refreshBrainTree}>{t("Refresh")}</button></label>
                    {brainTree.length > 0 ? (
                      <div className="cx-tree">{brainTree.slice(0, 40).map((t) => <div key={t} className="cx-tree-row">{t}</div>)}</div>
                    ) : (
                      <p className="cx-help">{t("Hit Refresh to preview your folders and files.")}</p>
                    )}
                  </div>

                  <div className="cx-field" style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
                    <label className="cx-field-label">{t("See your Second Brain as a map")}</label>
                    <p className="cx-help" style={{ marginTop: 2, marginBottom: 12 }}>{t("Turn your whole folder into a living graph. Every note and folder is a dot, and the lines are the links between them. Explore it in 2D or 3D.")}</p>
                    <button className="cx-btn cx-btn--block" onClick={() => setShowGraph(true)}>{t("Make it visual")}</button>
                  </div>

                  <p className="cx-help" style={{ marginTop: 14 }}>{t("Try saying: \"what's in my projects folder\", \"read my README\", \"create a skill that summarizes PDFs\", or \"make a new folder in PROJECTS called LAUNCH\".")}</p>
                </>
              ) : (
                <>
                  <div className="cx-field">
                    <label className="cx-field-label">{t("Your Second Brain folder")}</label>
                    <button className="cx-btn cx-btn--block" onClick={pickBrainFolder}>{t("Choose folder…")}</button>
                    <p className="cx-help">{t("Pick the folder in the window that opens. The path shows up below (you can also paste one).")}</p>
                    <input className="cx-input" placeholder="C:\\Users\\you\\Second Brain" value={brainPath} onChange={(e) => setBrainPath(e.target.value)} />
                  </div>
                  <div className="cx-field">
                    <label className="cx-field-label">{t("What Keak may do in this folder")}</label>
                    <select className="cx-select" value={brainPerm} onChange={(e) => setBrainPerm(e.target.value)}>
                      <option value="read">{t("Read only — look, never change")}</option>
                      <option value="create">{t("Create only — make new files/folders, never overwrite or delete")}</option>
                      <option value="edit">{t("Edit only — change existing files, never create or delete")}</option>
                      <option value="full">{t("Create, edit and delete — full access")}</option>
                    </select>
                  </div>
                  <button className="cx-btn" onClick={connectBrain} disabled={brainBusy}>{brainBusy ? t("Opening…") : t("Connect my Second Brain")}</button>
                </>
              )}

              {connectMsg && <p className="cx-msg">{connectMsg}</p>}
            </section>
            )}

            {activeSection === "routines" && (
            <section className="cx-card">
              <SectionHero id="routines">
                <p className="cx-eyebrow">{t("Routines")}</p>
                <h2 className="cx-h">{t("Schedule tasks that run on their own")}</h2>
                <p className="cx-lead" style={{ marginBottom: 14 }}>
                  {t("Give Keak a job and a time. It runs on your own AI and sends you the result. Great for a daily competitor check, watching for new AI models, or a weekly market summary. You can also just say \"schedule a routine every day at 5am to…\" and Keak sets it up.")}
                </p>
              </SectionHero>

              {routines.length > 0 && (
                <div className="cx-agent-list cx-routines-timeline" style={{ marginBottom: 12 }}>
                  {routines.map((r) => (
                    <div key={r.id} className="cx-agent-row">
                      <div className="cx-agent-meta">
                        <span className="cx-agent-name">{r.name || "Routine"}{!r.enabled && <span className="cx-field-tag" style={{ marginLeft: 8 }}>{t("paused")}</span>}</span>
                        <span className="cx-agent-desc">{nextRunLabel(r)} · {t("sends to")} {r.output === "keak" ? "Keak" : r.output}</span>
                      </div>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => runRoutineNow(r)}>{t("Run now")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => toggleRoutineEnabled(r)}>{r.enabled ? t("Pause") : t("Resume")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => rtEditing?.id === r.id ? cancelRoutineEdit() : startEditRoutine(r)}>{rtEditing?.id === r.id ? t("Close") : t("Edit")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => deleteRoutine(r.id)}>{t("Delete")}</button>
                    </div>
                  ))}
                </div>
              )}

              {rtEditing ? (
                <div className="cx-agent-edit">
                  <input className="cx-input" placeholder={t("Name (e.g. Daily competitor check)")} value={rtEditing.name} onChange={(e) => patchEditing({ name: e.target.value })} />

                  <label className="cx-field-label">{t("When")}</label>
                  <select className="cx-select" value={rtEditing.freq} onChange={(e) => patchEditing({ freq: e.target.value as Routine["freq"] })}>
                    <option value="daily">{t("Every day")}</option>
                    <option value="weekly">{t("Every week (on a day)")}</option>
                    <option value="once">{t("Just once")}</option>
                  </select>
                  {rtEditing.freq === "weekly" && (
                    <select className="cx-select" value={rtEditing.day ?? 1} onChange={(e) => patchEditing({ day: parseInt(e.target.value, 10) })}>
                      {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{t(d)}</option>)}
                    </select>
                  )}
                  {rtEditing.freq === "once" ? (
                    <input className="cx-input" type="datetime-local" value={rtEditing.onceDate ? rtEditing.onceDate.slice(0, 16) : ""} onChange={(e) => patchEditing({ onceDate: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                  ) : (
                    <input className="cx-input" type="time" value={`${String(rtEditing.hour).padStart(2, "0")}:${String(rtEditing.minute).padStart(2, "0")}`} onChange={(e) => { const [h, m] = e.target.value.split(":").map((x) => parseInt(x, 10)); patchEditing({ hour: h || 0, minute: m || 0 }); }} />
                  )}

                  <label className="cx-field-label">{t("What it should do")}</label>
                  <textarea className="cx-input cx-textarea" placeholder={t("e.g. Research what my top 3 competitors shipped this week and give me a short summary.")} value={rtEditing.instructions} onChange={(e) => patchEditing({ instructions: e.target.value })} />

                  <label className="cx-field-label">{t("Run it with")} <span className="cx-field-tag">{t("the model this routine uses")}</span></label>
                  <select className="cx-select" value={rtEditing.modelChoice || ""} onChange={(e) => patchEditing({ modelChoice: e.target.value || undefined })}>
                    {connectedModelChoices().map((c) => (
                      <option key={c.value} value={c.value}>{t(c.label)}</option>
                    ))}
                  </select>

                  <label className="cx-field-label">{t("Send the result to")}</label>
                  <select className="cx-select" value={rtEditing.output} onChange={(e) => patchEditing({ output: e.target.value as Routine["output"] })}>
                    <option value="telegram">Telegram</option>
                    <option value="keak">{t("Show in Keak")}</option>
                    <option value="email">{t("Email")}</option>
                  </select>
                  {rtEditing.output === "email" && (
                    <input className="cx-input" placeholder={t("Email address to send to")} value={rtEditing.outputTarget || ""} onChange={(e) => patchEditing({ outputTarget: e.target.value })} />
                  )}

                  {(() => {
                    const options = assignableForAgents();
                    if (options.length === 0) return null;
                    return (
                      <div className="cx-toolpick">
                        <span className="cx-toolpick-label">{t("Tools it can use (e.g. Perplexity for research)")}</span>
                        <div className="cx-toolpick-chips">
                          {options.map((o) => (
                            <button key={o.id} type="button" className={`cx-toolchip${rtEditing.tools.includes(o.id) ? " cx-toolchip--on" : ""}`} onClick={() => toggleEditingTool(o.id)}>{o.name}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="cx-edit-actions">
                    <button className="cx-btn cx-btn--sm" onClick={saveRoutineEdit}>{t("Save routine")}</button>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={cancelRoutineEdit}>{t("Cancel")}</button>
                  </div>
                </div>
              ) : (
                <button className="cx-btn" onClick={startAddRoutine}>{t("New routine")}</button>
              )}

              <p className="cx-help" style={{ marginTop: 12 }}>{t("Routines run while Keak is open. Turn on \"start at login\" in Settings to keep Keak in the tray so they run even when the window is closed.")}</p>
              {connectMsg && <p className="cx-msg">{connectMsg}</p>}
            </section>
            )}

            {activeSection === "connections" && (
            <section className="cx-card" ref={connSecRef} onClick={onConnHeadClick}>
              <SectionHero id="connections">
                <p className="cx-eyebrow">{t("Connections")}</p>
                <h2 className="cx-h">{t("Connect your apps")}</h2>
                <p className="cx-help" style={{ marginBottom: 4 }}>{t("Click a connector to open its setup.")}</p>
                <p className="cx-lead" style={{ marginBottom: 14 }}>
                  {t("Link your own accounts so Keak acts directly through them, no clicking on screen. It runs on your accounts, so it costs nothing extra.")}
                </p>
              </SectionHero>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="mcp" name="MCP" brand="#6E56CF" on={mcpServers.length > 0} />{t("MCP servers")} <span className="cx-field-tag">{t("Plugins")}</span></span>
                </div>
                <p className="cx-help">{t("Model Context Protocol servers give Keak whole new tool sets. Local servers run on your computer (like npx …, needs Node.js); remote servers connect over a URL. Their tools become usable right in the chat.")}</p>
                {mcpServers.map((s) => (
                  <div className="cx-mcp-row" key={s.id}>
                    <div className="cx-mcp-info">
                      <span className="cx-mcp-name">{s.name}</span>
                      <span className="cx-field-tag">{s.transport === "local" ? t("local") : t("remote")}{s.tools ? ` · ${s.tools.length} ${t("tools")}` : ""}</span>
                    </div>
                    <div className="cx-mcp-actions">
                      <label className="cx-mcp-toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => toggleMcp(s.id, e.target.checked)} />{t("On")}</label>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => testMcpServer(s)} disabled={mcpBusy === s.id}>{mcpBusy === s.id ? t("Connecting…") : t("Load tools")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => removeMcpServer(s.id)}>{t("Remove")}</button>
                    </div>
                  </div>
                ))}
                {mcpForm.open ? (
                  <div className="cx-mcp-form">
                    <input className="cx-input" placeholder={t("Name (e.g. Filesystem, Notion)")} value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} />
                    <div className="cx-seg cx-seg--2" style={{ margin: "8px 0" }}>
                      <button className={`cx-seg-btn${mcpForm.transport === "local" ? " cx-seg-btn--on" : ""}`} onClick={() => setMcpForm({ ...mcpForm, transport: "local" })}>{t("Local (on my computer)")}</button>
                      <button className={`cx-seg-btn${mcpForm.transport === "remote" ? " cx-seg-btn--on" : ""}`} onClick={() => setMcpForm({ ...mcpForm, transport: "remote" })}>{t("Remote (URL)")}</button>
                    </div>
                    {mcpForm.transport === "local" ? (
                      <>
                        <input className="cx-input" placeholder={t("Command (e.g. npx)")} value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
                        <input className="cx-input" placeholder={t("Arguments (e.g. -y @modelcontextprotocol/server-filesystem C:\\path)")} value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
                        <p className="cx-help">{t("The command runs on your machine. Local MCP servers usually need Node.js (npx) installed.")}</p>
                      </>
                    ) : (
                      <>
                        <input className="cx-input" placeholder={t("Server URL (https://…)")} value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
                        <input className="cx-input" type="password" placeholder={t("Authorization header (optional, e.g. Bearer xxx)")} value={mcpForm.auth} onChange={(e) => setMcpForm({ ...mcpForm, auth: e.target.value })} />
                      </>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button className="cx-btn" onClick={addMcpServer}>{t("Add server")}</button>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setMcpForm({ ...mcpForm, open: false })}>{t("Cancel")}</button>
                    </div>
                  </div>
                ) : (
                  <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setMcpForm({ ...mcpForm, open: true })}>+ {t("Add MCP server")}</button>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="zapier" name="Zapier" brand="#FF4A00" on={mcpServers.some((s) => s.name.toLowerCase() === "zapier")} />Zapier <span className="cx-field-tag">{t("9000+ apps via MCP")}</span></span>
                  {mcpServers.some((s) => s.name.toLowerCase() === "zapier") && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                <p className="cx-help">{t("Connect Zapier once and Keak can use any of your Zapier actions across 9000+ apps. How to get your URL:")}</p>
                <ol className="cx-help cx-steps">
                  <li>{t("In Zapier, open MCP (zapier.com/mcp) and click New MCP server.")}</li>
                  <li>{t("Under \"Choose your AI assistant\", click See all, then choose Other.")}</li>
                  <li>{t("Open the Connect tab, Generate a token and copy the Server URL.")}</li>
                  <li>{t("Paste that URL below. Pick the apps and actions you want inside Zapier — even ones Keak has no connector for.")}</li>
                </ol>
                <input className="cx-input" type="password" placeholder={t("Zapier MCP Server URL")} value={zapierUrl} onChange={(e) => setZapierUrl(e.target.value)} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button className="cx-btn" onClick={connectZapier}>{t("Connect Zapier")}</button>
                </div>
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="google" slug={CONN_ICON.google.icon} name="Google" brand={CONN_ICON.google.brand} on={gConnected} />Google <span className="cx-field-tag">{t("Calendar, Gmail, Drive")}</span></span>
                  {gConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {gConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can create calendar events, read and send Gmail, and save files to Drive on your account.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectGoogle}>{t("Disconnect Google")}</button>
                  </>
                ) : HAS_SHARED_GOOGLE ? (
                  <>
                    <p className="cx-help">{t("Sign in with your Google account and approve. That's it, nothing to set up.")}</p>
                    <button className="cx-btn" onClick={connectGoogle} disabled={gBusy}>{gBusy ? t("Waiting for Google…") : t("Sign in with Google")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("Keak's shared Google sign-in isn't switched on in this build yet. For now you can connect your own Google app, or wait for the one-click version.")}
                    </p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setGAdvanced((v) => !v)}>{gAdvanced ? t("Hide advanced") : t("Connect my own Google app")}</button>
                    {gAdvanced && (
                      <>
                        <p className="cx-help" style={{ marginTop: 4 }}>
                          {t("Create a free Google OAuth client (type \"Desktop app\") in the Google Cloud console, then paste its ID and secret.")}
                          <button className="cx-linkbtn" onClick={() => openUrl("https://console.cloud.google.com/apis/credentials")} style={{ marginLeft: 6 }}>{t("Open console")}</button>
                        </p>
                        <input className="cx-input" placeholder={t("Google client ID")} value={gClientId} onChange={(e) => setGClientId(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Google client secret")} value={gClientSecret} onChange={(e) => setGClientSecret(e.target.value)} />
                        <button className="cx-btn" onClick={connectGoogle} disabled={gBusy}>{gBusy ? t("Waiting for Google…") : t("Connect Google")}</button>
                        <p className="cx-help" style={{ marginTop: 6 }}>{t("In the console: APIs and Services, Credentials, Create credentials, OAuth client ID, Desktop app. Enable the Calendar, Gmail and Drive APIs, and add yourself as a test user.")}</p>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="microsoft" slug={CONN_ICON.microsoft.icon} name="Microsoft" brand={CONN_ICON.microsoft.brand} on={msConnected} />Microsoft <span className="cx-field-tag">{t("Outlook Calendar, Mail, OneDrive")}</span></span>
                  {msConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {msConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can create Outlook calendar events, send mail, and save files to OneDrive on your account.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectMicrosoft}>{t("Disconnect Microsoft")}</button>
                  </>
                ) : HAS_SHARED_MS ? (
                  <>
                    <p className="cx-help">{t("Sign in with your Microsoft account and approve. That's it, nothing to set up.")}</p>
                    <button className="cx-btn" onClick={connectMicrosoft} disabled={msBusy}>{msBusy ? t("Waiting for Microsoft…") : t("Sign in with Microsoft")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("Keak's shared Microsoft sign-in isn't switched on in this build yet. For now you can connect your own Microsoft app, or wait for the one-click version.")}
                    </p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setMsAdvanced((v) => !v)}>{msAdvanced ? t("Hide advanced") : t("Connect my own Microsoft app")}</button>
                    {msAdvanced && (
                      <>
                        <p className="cx-help" style={{ marginTop: 4 }}>
                          {t("Register a free app in the Azure portal (Microsoft Entra ID, App registrations). Add a \"Mobile and desktop applications\" platform with redirect URI")} <b>http://localhost</b>{t(", then paste the Application (client) ID.")}
                          <button className="cx-linkbtn" onClick={() => openUrl("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")} style={{ marginLeft: 6 }}>{t("Open Azure")}</button>
                        </p>
                        <input className="cx-input" placeholder={t("Application (client) ID")} value={msClientId} onChange={(e) => setMsClientId(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Client secret (only for web app registrations, optional)")} value={msClientSecret} onChange={(e) => setMsClientSecret(e.target.value)} />
                        <button className="cx-btn" onClick={connectMicrosoft} disabled={msBusy}>{msBusy ? t("Waiting for Microsoft…") : t("Connect Microsoft")}</button>
                        <p className="cx-help" style={{ marginTop: 6 }}>{t("Under API permissions add the delegated Microsoft Graph scopes Calendars.ReadWrite, Mail.Send and Files.ReadWrite. Set \"Supported account types\" to include personal Microsoft accounts if you use Outlook.com.")}</p>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="notion" slug={CONN_ICON.notion.icon} name="Notion" brand={CONN_ICON.notion.brand} on={notionConnected} />Notion <span className="cx-field-tag">{t("Pages, notes")}</span></span>
                  {notionConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {notionConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can create pages and save notes in your Notion workspace.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectNotion}>{t("Disconnect Notion")}</button>
                  </>
                ) : HAS_SHARED_NOTION ? (
                  <>
                    <p className="cx-help">{t("Sign in with your Notion account and approve. That's it, nothing to set up.")}</p>
                    <button className="cx-btn" onClick={connectNotion} disabled={notionBusy}>{notionBusy ? t("Waiting for Notion…") : t("Sign in with Notion")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">{t("Sign in with Notion. You'll create a free integration once, then it's a normal sign-in.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setNotionAdvanced((v) => !v)}>{notionAdvanced ? t("Hide setup") : t("Set up Notion")}</button>
                    {notionAdvanced && (
                      <>
                        <p className="cx-help" style={{ marginTop: 4 }}>
                          {t("Create a")} <b>{t("public")}</b> {t("OAuth integration at Notion, set the redirect URI to")} <b>http://localhost:53682</b>{t(", then paste its client ID and secret.")}
                          <button className="cx-linkbtn" onClick={() => openUrl("https://www.notion.so/my-integrations")} style={{ marginLeft: 6 }}>{t("Open Notion")}</button>
                        </p>
                        <input className="cx-input" placeholder={t("Notion client ID")} value={notionClientId} onChange={(e) => setNotionClientId(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Notion client secret")} value={notionClientSecret} onChange={(e) => setNotionClientSecret(e.target.value)} />
                        <button className="cx-btn" onClick={connectNotion} disabled={notionBusy}>{notionBusy ? t("Waiting for Notion…") : t("Connect Notion")}</button>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="slack" slug={CONN_ICON.slack.icon} name="Slack" brand={CONN_ICON.slack.brand} on={slackConnected} />Slack <span className="cx-field-tag">{t("Post messages")}</span></span>
                  {slackConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {slackConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can post messages to your Slack channels.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectSlack}>{t("Disconnect Slack")}</button>
                  </>
                ) : HAS_SHARED_SLACK ? (
                  <>
                    <p className="cx-help">{t("Sign in with Slack and pick the workspace to allow. That's it.")}</p>
                    <button className="cx-btn" onClick={connectSlackOauth} disabled={slackBusy}>{slackBusy ? t("Waiting for Slack…") : t("Sign in with Slack")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("Paste a Slack token. In a Slack app add the")} <b>chat:write</b> {t("scope, install it to your workspace, and copy the Bot token (xoxb-…).")}
                      <button className="cx-linkbtn" onClick={() => openUrl("https://api.slack.com/apps")} style={{ marginLeft: 6 }}>{t("Open Slack apps")}</button>
                    </p>
                    <input className="cx-input" type="password" placeholder={t("Slack token (xoxb- or xoxp-…)")} value={slackToken} onChange={(e) => setSlackToken(e.target.value)} />
                    <button className="cx-btn" onClick={connectSlack} disabled={slackBusy}>{slackBusy ? t("Checking…") : t("Connect Slack")}</button>
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="figma" slug={CONN_ICON.figma.icon} name="Figma" brand={CONN_ICON.figma.brand} on={figmaConnected} />Figma <span className="cx-field-tag">{t("Design files")}</span></span>
                  {figmaConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {figmaConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can read your Figma files.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectFigma}>{t("Disconnect Figma")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">{t("Sign in with Figma. Create a free OAuth app once, then it's a normal sign-in.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setFigmaAdvanced((v) => !v)}>{figmaAdvanced ? t("Hide setup") : t("Set up Figma")}</button>
                    {figmaAdvanced && (
                      <>
                        <p className="cx-help" style={{ marginTop: 4 }}>
                          {t("Create an OAuth app in Figma settings, set the callback to")} <b>http://localhost:53684/callback</b>{t(", then paste its client ID and secret.")}
                          <button className="cx-linkbtn" onClick={() => openUrl("https://www.figma.com/developers/apps")} style={{ marginLeft: 6 }}>{t("Open Figma apps")}</button>
                        </p>
                        <input className="cx-input" placeholder={t("Figma client ID")} value={figmaClientId} onChange={(e) => setFigmaClientId(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Figma client secret")} value={figmaClientSecret} onChange={(e) => setFigmaClientSecret(e.target.value)} />
                        <button className="cx-btn" onClick={connectFigma} disabled={figmaBusy}>{figmaBusy ? t("Waiting for Figma…") : t("Connect Figma")}</button>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="supabase" slug={CONN_ICON.supabase.icon} name="Supabase" brand={CONN_ICON.supabase.brand} on={supabaseConnected} />Supabase <span className="cx-field-tag">{t("Your database")}</span></span>
                  {supabaseConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {supabaseConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can reach your Supabase project.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectSupabase}>{t("Disconnect Supabase")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("Supabase has no sign-in for data, so paste your project URL and service key (Settings, API Keys).")}
                      <button className="cx-linkbtn" onClick={() => openUrl("https://supabase.com/dashboard/project/_/settings/api")} style={{ marginLeft: 6 }}>{t("Open Supabase")}</button>
                    </p>
                    <input className="cx-input" placeholder={t("Project URL (https://xxxx.supabase.co)")} value={supabaseUrl} onChange={(e) => setSupabaseUrl(e.target.value)} />
                    <input className="cx-input" type="password" placeholder={t("Service role key")} value={supabaseKey} onChange={(e) => setSupabaseKey(e.target.value)} />
                    <button className="cx-btn" onClick={saveSupabase}>{t("Connect Supabase")}</button>
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="github" slug={CONN_ICON.github.icon} name="GitHub" brand={CONN_ICON.github.brand} on={githubConnected} />GitHub <span className="cx-field-tag">{t("Repos, issues, PRs")}</span></span>
                  {githubConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {githubConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can work with your GitHub: repos, issues, pull requests, gists.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectGithub}>{t("Disconnect GitHub")}</button>
                  </>
                ) : (
                  <>
                    {HAS_SHARED_GITHUB ? (
                      <>
                        <p className="cx-help">{t("Sign in with GitHub. It shows a short code, you paste it once in the page that opens.")}</p>
                        {githubCode && <p className="cx-help" style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, fontSize: 18 }}>{githubCode}</p>}
                        <button className="cx-btn" onClick={connectGithubDevice} disabled={githubBusy}>{githubBusy ? t("Waiting for GitHub…") : t("Sign in with GitHub")}</button>
                      </>
                    ) : (
                      <p className="cx-help">{t("Paste a GitHub token (Settings, Developer settings, Personal access tokens). Give it repo + gist access.")}</p>
                    )}
                    {!HAS_SHARED_GITHUB && (
                      <>
                        <input className="cx-input" type="password" placeholder={t("GitHub token (ghp_… or github_pat_…)")} value={githubPat} onChange={(e) => setGithubPat(e.target.value)} />
                        <div className="cx-edit-actions">
                          <button className="cx-btn" onClick={saveGithubPat}>{t("Connect GitHub")}</button>
                          <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl("https://github.com/settings/tokens")}>{t("Get token")}</button>
                        </div>
                      </>
                    )}
                    {HAS_SHARED_GITHUB && (
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => setGithubAdvanced((v) => !v)}>{githubAdvanced ? t("Hide token option") : t("Use a token instead")}</button>
                    )}
                    {HAS_SHARED_GITHUB && githubAdvanced && (
                      <>
                        <input className="cx-input" type="password" placeholder={t("GitHub token (ghp_…)")} value={githubPat} onChange={(e) => setGithubPat(e.target.value)} />
                        <button className="cx-btn cx-btn--sm" onClick={saveGithubPat}>{t("Save token")}</button>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="shopify" slug={CONN_ICON.shopify.icon} name="Shopify" brand={CONN_ICON.shopify.brand} on={shopifyConnected} />Shopify <span className="cx-field-tag">{t("Products, orders")}</span></span>
                  {shopifyConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {shopifyConnected ? (
                  <>
                    <p className="cx-help">{t("Keak can work with your store: products, orders, customers.")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectShopify}>{t("Disconnect Shopify")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("In your store admin create a custom app (Settings, Apps, Develop apps), install it, and copy the Admin API access token.")}
                      <button className="cx-linkbtn" onClick={() => openUrl("https://admin.shopify.com")} style={{ marginLeft: 6 }}>{t("Open Shopify")}</button>
                    </p>
                    <input className="cx-input" placeholder={t("Store domain (your-shop.myshopify.com)")} value={shopifyShop} onChange={(e) => setShopifyShop(e.target.value)} />
                    <input className="cx-input" type="password" placeholder={t("Admin API access token (shpat_…)")} value={shopifyToken} onChange={(e) => setShopifyToken(e.target.value)} />
                    <button className="cx-btn" onClick={saveShopify}>{t("Connect Shopify")}</button>
                  </>
                )}
              </div>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><FxLogo id="telegram" slug={CONN_ICON.telegram.icon} name="Telegram" brand={CONN_ICON.telegram.brand} on={telegramConnected} />Telegram <span className="cx-field-tag">{t("Talk to Keak from your phone")}</span></span>
                  {telegramConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                </div>
                {telegramConnected ? (
                  <>
                    <p className="cx-help">{t("Message your bot from your phone and Keak answers and does things on this computer. First person to message it gets linked (that's you).")}</p>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectTelegram}>{t("Disconnect Telegram")}</button>
                  </>
                ) : (
                  <>
                    <p className="cx-help">
                      {t("In Telegram, message")} <b>@BotFather</b>{t(", send /newbot, and paste the token it gives you. Then text your new bot from your phone.")}
                      <button className="cx-linkbtn" onClick={() => openUrl("https://t.me/BotFather")} style={{ marginLeft: 6 }}>{t("Open BotFather")}</button>
                    </p>
                    <input className="cx-input" type="password" placeholder={t("Telegram bot token (123456:ABC-…)")} value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} />
                    <button className="cx-btn" onClick={saveTelegram}>{t("Connect Telegram")}</button>
                  </>
                )}
              </div>

              <p className="cx-eyebrow" style={{ marginTop: 22 }} data-tick={toolTick}>{t("AI tools")}</p>
              <p className="cx-lead" style={{ marginBottom: 12 }}>
                {t("Add your own key for any of these, then let an agent use it. A research agent can use Perplexity, a video agent HeyGen, and so on. It runs on your key.")}
              </p>
              <div className="cx-tools">
                {AI_TOOLS.map((tool) => (
                  <div className="cx-conn cx-tool" key={tool.id}>
                    <div className="cx-conn-head">
                      <span className="cx-conn-name"><FxLogo id={tool.id} slug={tool.icon} name={tool.name} brand={tool.brand} on={toolConnected(tool.id)} />{tool.name} <span className="cx-field-tag">{t(tool.category)}</span></span>
                      {toolConnected(tool.id) && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
                    </div>
                    <p className="cx-help">{t(tool.hint)}</p>
                    {tool.id === "gumloop" ? (
                      <>
                        <input className="cx-input" type="password" placeholder={t("Gumloop API key")} value={gumloopKey} onChange={(e) => setGumloopKey(e.target.value)} />
                        <input className="cx-input" placeholder={t("User ID")} value={gumloopUser} onChange={(e) => setGumloopUser(e.target.value)} />
                        <input className="cx-input" placeholder={t("Saved flow ID")} value={gumloopFlow} onChange={(e) => setGumloopFlow(e.target.value)} />
                        <div className="cx-edit-actions">
                          <button className="cx-btn cx-btn--sm" onClick={saveGumloop}>{gumloopConnected ? t("Update") : t("Connect")}</button>
                          {gumloopConnected && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectGumloop}>{t("Disconnect")}</button>}
                          {tool.getUrl && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl(tool.getUrl!)}>{t("Get key")}</button>}
                        </div>
                      </>
                    ) : tool.id === "make" ? (
                      <>
                        <input className="cx-input" type="password" placeholder={t("Make API token")} value={makeToken} onChange={(e) => setMakeToken(e.target.value)} />
                        <label className="cx-toolpick-label" style={{ marginTop: 8 }}>{t("Region (see your make.com URL, e.g. eu2)")}</label>
                        <select className="cx-select" value={makeRegion} onChange={(e) => setMakeRegion(e.target.value)}>
                          {["eu1", "eu2", "us1", "us2"].map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <div className="cx-edit-actions">
                          <button className="cx-btn cx-btn--sm" onClick={saveMake}>{makeConnected ? t("Update") : t("Connect")}</button>
                          {makeConnected && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectMake}>{t("Disconnect")}</button>}
                          {tool.getUrl && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl(tool.getUrl!)}>{t("Get token")}</button>}
                        </div>
                        {makeConnected && (
                          <>
                            <button className="cx-btn cx-btn--ghost cx-btn--sm" style={{ marginTop: 8 }} onClick={loadMakeScenarios} disabled={makeLoading}>
                              {makeLoading ? t("Loading…") : t("Load my scenarios")}
                            </button>
                            {makeScenarios && (
                              <>
                                <label className="cx-toolpick-label" style={{ marginTop: 8 }}>{t("Scenario Keak runs")}</label>
                                <select className="cx-select" value={makeScenario} onChange={(e) => saveMakeScenario(e.target.value)}>
                                  <option value="">{t("Pick a scenario")}</option>
                                  {makeScenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                              </>
                            )}
                            {!makeScenarios && makeScenario && (
                              <p className="cx-help" style={{ marginTop: 6 }}>{t("Scenario saved. Load again to change.")}</p>
                            )}
                          </>
                        )}
                      </>
                    ) : tool.id === "bluesky" ? (
                      <>
                        <ol className="cx-help cx-steps">
                          <li>{t("In Bluesky, go to Settings, then Privacy and security, then App passwords.")}</li>
                          <li>{t("Tap Add app password, name it something like Keak, and copy the password it shows (you only see it once).")}</li>
                          <li>{t("Enter your handle and that app password below. Always the app password, never your real login password.")}</li>
                        </ol>
                        <input className="cx-input" placeholder={t("Your handle (like name.bsky.social)")} value={bskyHandle} onChange={(e) => setBskyHandle(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("App password")} value={bskyAppPw} onChange={(e) => setBskyAppPw(e.target.value)} />
                        <div className="cx-edit-actions">
                          <button className="cx-btn cx-btn--sm" onClick={saveBluesky}>{bskyConnected ? t("Update") : t("Connect")}</button>
                          {bskyConnected && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectBluesky}>{t("Disconnect")}</button>}
                          {tool.getUrl && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl(tool.getUrl!)}>{t("Open Bluesky settings")}</button>}
                        </div>
                      </>
                    ) : tool.id === "x" ? (
                      <>
                        <ol className="cx-help cx-steps">
                          <li>{t("Go to developer.x.com and create a Project and an App.")}</li>
                          <li>{t("X asks for a payment method and a small deposit (about $5) to activate the API for posting.")}</li>
                          <li>{t("In the app's User authentication settings, turn on OAuth 1.0a and set App permissions to Read and write.")}</li>
                          <li>{t("Open Keys and tokens. Copy the API Key and API Key Secret.")}</li>
                          <li>{t("Generate the Access Token and Access Token Secret, and copy both. Do this AFTER setting Read and write, or regenerate them, otherwise posting fails.")}</li>
                        </ol>
                        <input className="cx-input" type="password" placeholder={t("X API Key")} value={xApiKey} onChange={(e) => setXApiKey(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("X API Key Secret")} value={xApiSecret} onChange={(e) => setXApiSecret(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Access Token")} value={xAccessToken} onChange={(e) => setXAccessToken(e.target.value)} />
                        <input className="cx-input" type="password" placeholder={t("Access Token Secret")} value={xAccessSecret} onChange={(e) => setXAccessSecret(e.target.value)} />
                        <div className="cx-edit-actions">
                          <button className="cx-btn cx-btn--sm" onClick={saveX}>{xConnected ? t("Update") : t("Connect")}</button>
                          {xConnected && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectX}>{t("Disconnect")}</button>}
                          {tool.getUrl && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl(tool.getUrl!)}>{t("Open X developer portal")}</button>}
                        </div>
                      </>
                    ) : tool.auth === "oauth" ? (
                      <>
                        <button className="cx-btn" onClick={() => tool.id === "canva" ? connectCanva() : openUrl(tool.getUrl || "")}>{t("Sign in with")} {tool.name}</button>
                      </>
                    ) : (
                      <>
                        <input
                          className="cx-input" type="password" placeholder={tool.keyLabel}
                          value={toolKeys[tool.id] || ""}
                          onChange={(e) => setToolKeys((o) => ({ ...o, [tool.id]: e.target.value }))}
                        />
                        <div className="cx-edit-actions">
                          <button className="cx-btn cx-btn--sm" onClick={() => saveTool(tool.id)}>{toolConnected(tool.id) ? t("Update") : t("Connect")}</button>
                          {tool.getUrl && <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => openUrl(tool.getUrl!)}>{t("Get key")}</button>}
                        </div>
                      </>
                    )}
                    {tool.id === "heygen" && toolConnected("heygen") && (
                      <div className="cx-heygen">
                        <p className="cx-help" style={{ marginTop: 8 }}>{t("Pick which avatar and voice your videos use.")}</p>
                        <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={loadHeygenAssets} disabled={heygenLoading}>
                          {heygenLoading ? t("Loading…") : t("Load my avatars & voices")}
                        </button>
                        {heygenAssets && (
                          <>
                            <label className="cx-toolpick-label" style={{ marginTop: 8 }}>{t("Avatar")}</label>
                            <select className="cx-select" value={heygenAvatar} onChange={(e) => saveHeygenAvatar(e.target.value)}>
                              <option value="">{t("Default avatar")}</option>
                              {heygenAssets.avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <label className="cx-toolpick-label" style={{ marginTop: 8 }}>{t("Voice")}</label>
                            <select className="cx-select" value={heygenVoice} onChange={(e) => saveHeygenVoice(e.target.value)}>
                              <option value="">{t("Default voice")}</option>
                              {heygenAssets.voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.language ? ` (${v.language})` : ""}</option>)}
                            </select>
                          </>
                        )}
                        {!heygenAssets && (heygenAvatar || heygenVoice) && (
                          <p className="cx-help" style={{ marginTop: 6 }}>{t("Saved avatar/voice in use. Load again to change.")}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {connectMsg && <p className="cx-msg">{connectMsg}</p>}
            </section>
            )}

            {activeSection === "work" && (
            <section className="cx-card">
              <SectionHero id="work">
                <p className="cx-eyebrow">{t("Work")}</p>
                <h2 className="cx-h">{t("What Keak and your agents made")}</h2>
                <p className="cx-lead" style={{ marginBottom: 12 }}>
                  {t("Your chats and your team's jobs live here. Click one to keep chatting by text on your own AI, or start a new chat.")}
                </p>
              </SectionHero>
              {history.length === 0 ? (
                <div className="cx-empty">
                  <span className="cx-medallion cx-medallion--lg" aria-hidden="true">{NAV_ICONS.work}</span>
                  <button className="cx-btn" onClick={newChat}>{t("New chat")}</button>
                  <p className="cx-help" style={{ marginTop: 10 }}>{t("Nothing yet. Ask Keak AI something, or say \"use your team to…\" and it lands here.")}</p>
                </div>
              ) : (
                <div className={`cx-work${chatsHidden ? " cx-work--full" : ""}`}>
                  {!chatsHidden && (
                  <aside className="cx-chats">
                    <button className="cx-btn cx-newchat" onClick={newChat}>{t("New chat")}</button>
                    {groupByDay(history).map((g) => (
                      <div className="cx-chat-day" key={g.label}>
                        <div className="cx-chat-daylabel">{g.label}</div>
                        {g.runs.map(({ run, idx }) => (
                          <div key={idx} className={`cx-chat-item${selectedRun === idx ? " cx-chat-item--on" : ""}`}>
                            {renameIdx === idx ? (
                              <input
                                className="cx-input cx-rename" autoFocus value={renameText}
                                onChange={(e) => setRenameText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenameIdx(null); }}
                                onBlur={commitRename}
                              />
                            ) : (
                              <div className="cx-chat-main" onClick={() => setSelectedRun(idx)}>
                                <span className="cx-chat-title">{run.job}</span>
                                <span className="cx-chat-sub">{run.results.map((r) => r.name).filter((v, i2, a) => a.indexOf(v) === i2).join(", ")} · {clockLabel(run.ts)}</span>
                              </div>
                            )}
                            <button className="cx-chat-dots" onClick={(e) => { e.stopPropagation(); setMenuIdx(menuIdx === idx ? null : idx); }} aria-label={t("Chat options")}>⋯</button>
                            {menuIdx === idx && (
                              <div className="cx-chat-menu">
                                <button onClick={() => startRename(idx)}>{t("Rename")}</button>
                                <button className="cx-chat-menu-del" onClick={() => deleteRun(idx)}>{t("Delete")}</button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={clearHistory} style={{ marginTop: 8 }}>{t("Clear all")}</button>
                  </aside>
                  )}
                  <div className="cx-chat-detail">
                    {(() => {
                      const idx = history[selectedRun] ? selectedRun : 0;
                      const run = history[idx];
                      if (!run) return null;
                      const msgs = runMessages(run);
                      return (
                        <>
                          <div className="cx-chatview-head">
                            <button className="cx-btn cx-btn--ghost cx-btn--sm cx-chat-expand" onClick={() => setChatsHidden((h) => !h)}>{chatsHidden ? t("Show chats") : t("Full screen")}</button>
                            <span className="cx-run-time">“{run.job}” · {dayLabel(run.ts)} {clockLabel(run.ts)}</span>
                            <select className="cx-select cx-chat-agent" value={run.agent || "Keak AI"} onChange={(e) => setRunAgent(idx, e.target.value)} title={t("Chat with")}>
                              {chatAgentList().map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                            </select>
                            <select className="cx-select cx-chat-model" value={run.model || ""} onChange={(e) => setRunModel(idx, e.target.value)} title={t("Model")}>
                              {connectedModelChoices().map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
                            </select>
                            {(() => {
                              const choice = run.model || findChatAgent(run.agent)?.choice || (localStorage.getItem("keak_cu_provider") ? `${localStorage.getItem("keak_cu_provider")}|${localStorage.getItem(`keak_cu_${localStorage.getItem("keak_cu_provider")}_model`) || ""}` : "");
                              const limit = modelContextLimit(choice);
                              const used = estimateTokens(msgs);
                              const pct = Math.min(100, Math.round((used / limit) * 100));
                              const near = pct >= 70;
                              return (
                                <span className={`cx-ctx${near ? " cx-ctx--near" : ""}`} title={t("How full this chat's context is. Compact to free it up.")}>
                                  <span className="cx-ctx-bar"><span className="cx-ctx-fill" style={{ width: `${pct}%` }} /></span>
                                  <span className="cx-ctx-num">{fmtTokens(used)}/{fmtTokens(limit)}</span>
                                  {msgs.length > 2 && <button className="cx-ctx-compact" onClick={() => compactChat(idx)} disabled={chatBusy}>{t("Compact")}</button>}
                                </span>
                              );
                            })()}
                          </div>
                          <div className="cx-chatview" onMouseUp={onChatMouseUp}>
                            {msgs.map((m, mi) => (
                              <div className={`cx-bubble cx-bubble--${m.role}`} key={mi}>
                                {m.role === "assistant" && (
                                  <span className="cx-bubble-who"><span className="cx-bubble-orb" style={{ background: runOrbColor(run) }} />{run.agent || "Keak AI"}</span>
                                )}
                                <div className="cx-bubble-text">{cleanAgentText(m.text)}</div>
                                <div className="cx-bubble-actions">
                                  <button className="cx-msgbtn" onClick={() => copyText(m.text)}>{t("Copy")}</button>
                                  <button className="cx-msgbtn" onClick={() => quoteIntoChat(m.text)}>{t("Quote")}</button>
                                  {m.role === "assistant" && isHtmlOutput(m.text) && (
                                    <button className="cx-msgbtn" onClick={() => openArtifact(run.job || "chat", m.text)}>{t("Open site")}</button>
                                  )}
                                  {m.role === "assistant" && (m.artifacts || []).map((a, ai2) => (
                                    <button key={ai2} className="cx-msgbtn cx-msgbtn--file" onClick={() => openArtifactPath(a.path)} title={a.path}>{t("Open")} {a.label}</button>
                                  ))}
                                </div>
                              </div>
                            ))}
                            {chatBusy && <div className="cx-bubble cx-bubble--assistant"><span className="cx-bubble-who"><span className="cx-bubble-orb" style={{ background: runOrbColor(run) }} />{run.agent || "Keak AI"}</span><div className="cx-bubble-text cx-bubble-typing">{chatStatus || t("Keaking…")}</div></div>}
                          </div>
                          {(run.goal || run.skill) && (
                            <div className="cx-chat-flags">
                              {run.goal && <span className="cx-flag" title={run.goal}>{t("Goal")}: {run.goal.slice(0, 40)}<button className="cx-flag-x" onClick={() => setRunGoal(idx, "")}>×</button></span>}
                              {run.skill && <span className="cx-flag">{t("Skill")}: {run.skill}<button className="cx-flag-x" onClick={() => setRunSkill(idx, "")}>×</button></span>}
                            </div>
                          )}
                          {chatInput.startsWith("/") && slashMenu(idx).length > 0 && (
                            <div className="cx-slashmenu">
                              {slashMenu(idx).map((it, k) => (
                                <button key={k} className="cx-slashitem" onMouseDown={(e) => { e.preventDefault(); it.run(); }}>
                                  <span className="cx-slashcmd">{it.label}</span>
                                  <span className="cx-slashhint">{it.hint}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="cx-chatbar">
                            <textarea
                              className="cx-input cx-chatinput" rows={1} placeholder={t("Message Keak…  (type / for commands)")}
                              value={chatInput}
                              onChange={(e) => { const val = e.target.value; setChatInput(val); if (val.startsWith("/") && !brainSkills.length) loadBrainSkills(); }}
                              onFocus={() => setQuotePop(null)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  const items = slashMenu(idx);
                                  if (chatInput.startsWith("/") && !chatInput.includes(" ") && items.length) { items[0].run(); return; }
                                  sendChat(idx);
                                }
                              }}
                            />
                            <button className="cx-btn cx-sendbtn" onClick={() => chatBusy ? stopChat() : sendChat(idx)} disabled={!chatBusy && !chatInput.trim()} title={chatBusy ? t("Stop") : t("Send")}>
                              {chatBusy ? (
                                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></svg>
                              ) : (
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20V5" /><path d="M5.5 11.5L12 5l6.5 6.5" /></svg>
                              )}
                            </button>
                          </div>
                          {quotePop && (
                            <button className="cx-quotepop" style={{ left: quotePop.x, top: quotePop.y }} onMouseDown={(e) => { e.preventDefault(); quoteIntoChat(quotePop.text); }}>{t("Quote")}</button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </section>
            )}

            {activeSection === "personality" && (
            <section className="cx-card cx-persona">
          <SectionHero id="personality">
            <p className="cx-eyebrow">{t("Personality")}</p>
            <h2 className="cx-h">{t("How Keak sounds")}</h2>
            <p className="cx-lead" style={{ marginBottom: 8 }}>{t("Tune it here, or just tell Keak out loud, like \"be funnier\" or \"less formal.\"")}</p>
          </SectionHero>
          <Dial label={t("Humor")} value={humor} onChange={(v) => setDial("keak_humor", setHumor, v)}
            bands={[t("Professional, no jokes"), t("A light touch of humor"), t("Playful and witty"), t("Very funny, jokes a lot")]} />
          <Dial label={t("Warmth")} value={warmth} onChange={(v) => setDial("keak_warmth", setWarmth, v)}
            bands={[t("Matter-of-fact"), t("Friendly"), t("Warm and encouraging"), t("Very warm and caring")]} />
          <Dial label={t("Formality")} value={formality} onChange={(v) => setDial("keak_formality", setFormality, v)}
            bands={[t("Very casual"), t("Relaxed"), t("Fairly polished"), t("Formal")]} />
          <Dial label={t("Directness")} value={directness} onChange={(v) => setDial("keak_directness", setDirectness, v)}
            bands={[t("Gentle and diplomatic"), t("Clear and straightforward"), t("Direct"), t("Blunt, no sugar-coating")]} />
          <div style={{ marginTop: 24, borderTop: "1px solid #DECFB0", paddingTop: 18 }}>
            <p className="cx-eyebrow">{t("Memory")}</p>
            <h2 className="cx-h" style={{ fontSize: 22 }}>{t("What Keak remembers about you")}</h2>
            <p className="cx-lead" style={{ marginBottom: 10 }}>{t("With this on, Keak quietly remembers durable facts from your talks (your projects, the people you mention, how you like things) so it gets more personal over time. It all stays on your computer, never on Keak's side, and you can edit or delete anything here.")}</p>
            <div className="cx-seg cx-seg--2" style={{ maxWidth: 260 }}>
              <button className={`cx-seg-btn${memoryOn ? " cx-seg-btn--on" : ""}`} onClick={() => toggleMemory(true)}>{t("On")}</button>
              <button className={`cx-seg-btn${!memoryOn ? " cx-seg-btn--on" : ""}`} onClick={() => toggleMemory(false)}>{t("Off")}</button>
            </div>
            {memoryOn && (
              <>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <input className="cx-input" style={{ flex: 1 }} placeholder={t("Add something you want Keak to remember")} value={newMemory} onChange={(e) => setNewMemory(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }} />
                  <button onClick={addMemory} style={{ padding: "0 18px", borderRadius: 10, border: "none", background: "#D4A49A", color: "#2C1508", fontWeight: 700, cursor: "pointer" }}>{t("Add")}</button>
                </div>
                {memories.length === 0 ? (
                  <p className="cx-help" style={{ marginTop: 12 }}>{t("Nothing yet. Keak starts remembering as you talk to it, or add something above.")}</p>
                ) : (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <label className="cx-field-label">{t("Remembered")} ({memories.length})</label>
                      <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={clearMemories}>{t("Clear all")}</button>
                    </div>
                    {memories.slice(0, 100).map((m) => (
                      <div key={m.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", padding: "7px 0", borderBottom: "1px solid #EDE4CC" }}>
                        <div style={{ color: "#2C1508" }}>{m.text}</div>
                        <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={() => deleteMemory(m.id)} title={t("Forget this")}>{t("Forget")}</button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
            </section>
            )}



            {activeSection === "help" && (
            <section className="cx-card cx-howto">
          <SectionHero id="help">
            <p className="cx-eyebrow">{t("Getting started")}</p>
            <h2 className="cx-h">{t("How to use it")}</h2>
          </SectionHero>
          <p className="cx-help" style={{ marginTop: 8 }}>
            <strong>{t("Dictate")}:</strong> {t("Hold")} <span className="cx-kbd">Ctrl</span> + <span className="cx-kbd">Win</span> {t("anywhere and just talk. Keak drops clean text right where your cursor is, in any app and any language.")}
          </p>
          <p className="cx-help" style={{ marginTop: 12 }}>
            <strong>{t("Translate")}:</strong> {t("Hold")} <span className="cx-kbd">Ctrl</span> + <span className="cx-kbd">Space</span> {t("instead, and Keak writes what you say in the language you picked in Settings.")}
          </p>
          <p className="cx-help" style={{ marginTop: 12 }}>
            <strong>{t("Keak AI")}:</strong> {t("Hold")} <span className="cx-kbd">Ctrl</span> + <span className="cx-kbd">Alt</span> {t("anywhere and say \"take over and...\" then what you want, like \"take over and open YouTube and search for lofi.\" Keak asks first, then does it. Press")} <span className="cx-kbd">Esc</span> {t("to stop it any time.")}
          </p>
            </section>
            )}
          </div>
        </div>
      </div>

      {showGraph && <BrainGraph root={brainPath} onClose={() => setShowGraph(false)} />}
    </div>
  );
}
