import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import keakLogo from "./assets/icon_keak_2.png";
import { effectiveDefaults, saveDefaultOverride, resetDefaultOverride, readDefaultOverrides, type EffectiveAgent } from "./agents-defaults";
import { AI_TOOLS, getToolKey, setToolKey, toolConnected, assignableForAgents, CONN_ICON } from "./integrations";
import { readRoutines, upsertRoutine, removeRoutine, newRoutineId, nextRunLabel, type Routine } from "./routines";
import { readMcpServers, writeMcpServers, newMcpId, mcpListTools, mcpCallTool, type McpServer } from "./mcp";
import { useUiLang, UI_LANGS, UI_LANG_AI_NAME, getUiLang, tr } from "./i18n";
import "./App.css";
import "./Connect.css";

// Keak's ONE shared Google OAuth client (Desktop app type). Fill these once and every user just clicks
// "Sign in with Google" — no per-user setup. Create it in Pep's Google Cloud project, publish the consent
// screen, add Calendar/Gmail/Drive scopes. The client secret for a Desktop-app client is NOT confidential
// per Google, so it's safe to ship. Until these are filled, the window falls back to manual (paste-your-own).
// Values come from build-time env vars (VITE_*), so no secret lives in the repo. Set them in a local .env for
// dev and as GitHub Actions secrets for release builds. See .env.example.
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

const SECTIONS = [
  { id: "ai", label: "Your AI" },
  { id: "agents", label: "Agents" },
  { id: "brain", label: "Second Brain" },
  { id: "routines", label: "Routines" },
  { id: "connections", label: "Connections" },
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

You are an agent with tools, and you CAN read files, search, create files, edit files${webOn ? ", search the live web" : ""}, and produce artifacts (HTML pages, documents, reports, notes, CSV/JSON data, SVG, etc.). NEVER tell the user you are unable to create a file, a document, a PDF, or a website. You create them with the tools below.

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
    <div className="cx-dial">
      <div className="cx-dial-head">
        <span className="cx-dial-name">{label}</span>
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
      <span className="cx-dial-desc">{desc}</span>
    </div>
  );
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

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
  const [agentLabels, setAgentLabels] = useState<boolean>(localStorage.getItem("keak_agent_labels") !== "0");
  function toggleAgentLabels(v: boolean) { setAgentLabels(v); localStorage.setItem("keak_agent_labels", v ? "1" : "0"); }
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
  const chatReqRef = useRef(0); // bumping this invalidates an in-flight reply (Stop button)
  function stopChat() { chatReqRef.current++; setChatBusy(false); setChatStatus(""); setQuotePop(null); }
  // Discover the skills inside the connected Second Brain (AI/skills/<name>/SKILL.md) for the /skill command.
  async function loadBrainSkills() {
    const root = localStorage.getItem("keak_brain_path") || "";
    if (!root) { setBrainSkills([]); return; }
    try {
      const raw = await invoke<string>("sb_tree", { args: { root, maxDepth: 3, maxEntries: 900 } });
      const items = JSON.parse(raw) as string[];
      const names = items.filter((p) => /^AI\/skills\/[^/]+\/SKILL\.md$/i.test(p)).map((p) => p.split("/")[2]);
      setBrainSkills(Array.from(new Set(names)));
    } catch { setBrainSkills([]); }
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
      if (run.skill && root) {
        try { const sk = await invoke<string>("sb_read", { args: { root, path: `AI/skills/${run.skill}/SKILL.md` } }); if (sk) base += `\n\nYou are using the "${run.skill}" skill from the user's Second Brain. Follow it:\n${sk.slice(0, 6000)}`; } catch { /* skill missing */ }
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
      const MAX = 8;
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
        if (step === MAX - 1 && !finalText) finalText = artifacts.length ? `${t("Done.")} ${artifacts.map((a) => a.label).join(", ")}` : t("I gathered what I could, but ran out of steps. Ask me to continue.");
      }
      if (reqId !== chatReqRef.current) return;
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
  const [useOwnAi, setUseOwnAi] = useState<boolean>(() => localStorage.getItem("keak_ai_use_own") !== "0");
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
      setUseOwnAi(localStorage.getItem("keak_ai_use_own") !== "0");
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

  // Telegram bridge: talk to Keak from your phone. Paste a bot token from @BotFather; the desktop polls it.
  const [telegramToken, setTelegramToken] = useState<string>(() => localStorage.getItem("keak_telegram_token") || "");
  const [telegramConnected, setTelegramConnected] = useState<boolean>(() => !!localStorage.getItem("keak_telegram_token"));
  function saveTelegram() {
    const tok = telegramToken.trim();
    if (!tok) { setConnectMsg(t("Paste your Telegram bot token first.")); return; }
    localStorage.setItem("keak_telegram_token", tok);
    localStorage.removeItem("keak_telegram_chat"); // re-bind to whoever messages the bot first (that's you)
    setTelegramConnected(true); setConnectMsg(t("Telegram connected. Message your bot from your phone to link it."));
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
  // Work section: which run (chat) is open in the right pane.
  const [selectedRun, setSelectedRun] = useState<number>(0);

  function toggleUseOwnAi(v: boolean) { setUseOwnAi(v); localStorage.setItem("keak_ai_use_own", v ? "1" : "0"); }
  function setDial(key: string, set: (v: number) => void, v: number) { set(v); localStorage.setItem(key, String(v)); }

  function chooseCuProvider(p: string) { setCuProvider(p); localStorage.setItem("keak_cu_provider", p); setConnectMsg(""); }
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

  const cuConnected =
    cuProvider === "claude" ? !!claudeToken.trim()
    : cuProvider === "openai" ? !!(openaiKey.trim() || openaiToken.trim())
    : cuProvider === "ollama" ? !!ollamaModel.trim()
    : cuProvider === "gemini" ? !!geminiKey.trim()
    : cuProvider === "copilot" ? !!copilotToken.trim()
    : cuProvider === "deepseek" ? !!deepseekKey.trim()
    : cuProvider === "mistral" ? !!mistralKey.trim()
    : cuProvider === "xai" ? !!xaiKey.trim()
    : false;

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

  return (
    <div className="connect-scroll">
      <div className="connect-view connect-view--full">
        <header className="cx-topbar">
          <img src={keakLogo} alt="Keak" className="cx-logo" />
          <div className="cx-headtext">
            <h1 className="cx-title">{t("Connect your AI")}</h1>
            <span className="cx-sub">{t("You talk, we write.")}</span>
          </div>
          {cuConnected && <span className="cx-status"><i className="cx-dot" />{t("Connected")}</span>}
        </header>

        <div className="connect-layout">
          <nav className="connect-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`cx-nav-item${activeSection === s.id ? " cx-nav-item--on" : ""}`} onClick={() => setActiveSection(s.id)}>
                {t(s.label)}
              </button>
            ))}
          </nav>

          <div className="connect-main connect-main--wide">
            {activeSection === "ai" && (
            <section className="cx-card cx-hero">
          <p className="cx-eyebrow">{t("Your AI")}</p>
          <h2 className="cx-h">{t("Bring your own intelligence")}</h2>
          <p className="cx-lead">{t("Keak runs on your own Claude, ChatGPT, Gemini, or a local model. It powers both Keak AI and screen control, so there's no extra cost per action.")}</p>

          <div className="cx-seg cx-seg--providers">
            <button className={`cx-seg-btn${cuProvider === "claude" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("claude")}>Claude</button>
            <button className={`cx-seg-btn${cuProvider === "openai" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("openai")}>ChatGPT</button>
            <button className={`cx-seg-btn${cuProvider === "gemini" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("gemini")}>Gemini</button>
            <button className={`cx-seg-btn${cuProvider === "copilot" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("copilot")}>Copilot</button>
            <button className={`cx-seg-btn${cuProvider === "xai" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("xai")}>Grok</button>
            <button className={`cx-seg-btn${cuProvider === "deepseek" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("deepseek")}>DeepSeek</button>
            <button className={`cx-seg-btn${cuProvider === "mistral" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("mistral")}>Mistral</button>
            <button className={`cx-seg-btn${cuProvider === "ollama" ? " cx-seg-btn--on" : ""}`} onClick={() => chooseCuProvider("ollama")}>Local</button>
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

          {connectMsg && <p className="cx-msg">{connectMsg}</p>}
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <p className="cx-eyebrow">{t("Language")}</p>
          <h2 className="cx-h">{t("Interface language")}</h2>
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
          <p className="cx-eyebrow">{t("Agents")}</p>
          <h2 className="cx-h">{t("Agent names")}</h2>
          <label className="cx-check-row">
            <input type="checkbox" checked={agentLabels} onChange={(e) => toggleAgentLabels(e.target.checked)} />
            <span>{t("Show each agent's name under its orb on screen")}</span>
          </label>
          <p className="cx-help" style={{ marginTop: 10 }}>{t("You can also tell Keak AI \"show the names\" or \"hide the names\".")}</p>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <p className="cx-eyebrow">{t("Control")}</p>
          <h2 className="cx-h">{t("When Keak does an action")}</h2>
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
          <p className="cx-eyebrow">{t("Keak AI")}</p>
          <h2 className="cx-h">{t("Where answers come from")}</h2>
          <div className="cx-seg cx-seg--2">
            <button className={`cx-seg-btn${useOwnAi ? " cx-seg-btn--on" : ""}`} onClick={() => toggleUseOwnAi(true)}>{t("My AI")}</button>
            <button className={`cx-seg-btn${!useOwnAi ? " cx-seg-btn--on" : ""}`} onClick={() => toggleUseOwnAi(false)}>{t("Keak's AI")}</button>
          </div>
          <p className="cx-help" style={{ marginTop: 12 }}>
            {useOwnAi
              ? t("Keak AI answers run on your connected AI. Unlimited, no extra cost.")
              : t("Keak AI answers use Keak's built-in AI. Counts against your plan.")}
          </p>
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <p className="cx-eyebrow">{t("Voice")}</p>
          <h2 className="cx-h">{t("How Keak sounds out loud")}</h2>
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
              <option value="system">{t("A Windows voice")}</option>
              <option value="keak">{t("Keak's own voice")}</option>
            </select>
          </div>

          {voiceEngine === "auto" && (
            <p className="cx-help" style={{ marginTop: 6 }}>{t("Uses your own Gemini voice, then your own OpenAI voice, then a Windows voice, whichever you have. Free, and works with Claude too. Just add a Gemini or OpenAI key under Your AI (a free Gemini key from Google AI Studio is enough).")}</p>
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
              <label className="cx-field-label">{t("Windows voice")} <span className="cx-field-tag">{t("free, works offline")}</span></label>
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
          <p className="cx-eyebrow">{t("Background")}</p>
          <h2 className="cx-h">{t("Keep Keak running for routines")}</h2>
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
          <p className="cx-eyebrow">{t("Agents")}</p>
          <h2 className="cx-h">{t("Your team")}</h2>
          <p className="cx-lead" style={{ marginBottom: 12 }}>
            {t("Say \"use your team to…\" and Keak splits the work across these agents, each on its own model and personality. Call one by name (\"Sirius, research the best video apps\") to run just that one. Click any agent to see what it has done.")} {t("You have")} {defaults.length} {t("default agents")}{roster.length > 0 ? ` ${t("plus")} ${roster.length} ${t("of your own")}` : ""}{editedCount > 0 ? ` (${editedCount} ${t("edited")})` : ""}.
          </p>

          <p className="cx-field-label" style={{ marginBottom: 8 }}>{t("Default agents")} <span className="cx-field-tag">{t("tap Edit to rename, re-tone, or recolour")}</span></p>
          <div className="cx-agent-list" style={{ marginBottom: 14 }}>
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
              <div className="cx-agent-list" style={{ marginTop: 6 }}>
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
              <p className="cx-eyebrow">Second Brain OS</p>
              <h2 className="cx-h">{t("Connect Keak to your Second Brain")}</h2>
              <p className="cx-lead" style={{ marginBottom: 14 }}>
                {t("Point Keak at a folder on your computer, the same one you use with Claude Code or VS Code. Keak can then read all of it, know your projects, and (with your permission) create skills, files and folders, edit them, or clean things up. It runs on your own AI, so it costs nothing extra.")}
              </p>

              {brainConnected ? (
                <>
                  <div className="cx-connected" style={{ textAlign: "left", alignItems: "flex-start" }}>
                    <div className="cx-connected-name">{t("Connected to your Second Brain")}</div>
                    <div className="cx-connected-hint" style={{ wordBreak: "break-all" }}>{brainPath}</div>
                    <button className="cx-btn cx-btn--ghost cx-btn--sm" onClick={disconnectBrain} style={{ marginTop: 10 }}>{t("Disconnect")}</button>
                  </div>

                  <div className="cx-field">
                    <label className="cx-field-label">{t("What Keak may do in this folder")}</label>
                    <select className="cx-select" value={brainPerm} onChange={(e) => saveBrainPerm(e.target.value)}>
                      <option value="read">{t("Read only — look, never change")}</option>
                      <option value="create">{t("Create only — make new files/folders, never overwrite or delete")}</option>
                      <option value="edit">{t("Edit only — change existing files, never create or delete")}</option>
                      <option value="full">{t("Create, edit and delete — full access")}</option>
                    </select>
                    <p className="cx-help">{t("Keak always asks before it writes or deletes. Reads are free.")}</p>
                  </div>

                  <label className="cx-check-row" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                    <input type="checkbox" checked={brainAutoContext} onChange={(e) => toggleBrainAutoContext(e.target.checked)} />
                    <span className="cx-field-label" style={{ margin: 0 }}>{t("Load a summary of my brain into every answer")} <span className="cx-field-tag">{t("knows you better, uses a few more tokens")}</span></span>
                  </label>
                  <p className="cx-help" style={{ marginTop: 2 }}>{t("Off means Keak only reads what it needs, when you ask. On means it always has your README, CLAUDE.md and folder map for context.")}</p>

                  <div className="cx-field">
                    <label className="cx-field-label">{t("Top of your Second Brain")} <button className="cx-linkbtn" onClick={refreshBrainTree}>{t("Refresh")}</button></label>
                    {brainTree.length > 0 ? (
                      <div className="cx-tree">{brainTree.slice(0, 40).map((t) => <div key={t} className="cx-tree-row">{t}</div>)}</div>
                    ) : (
                      <p className="cx-help">{t("Hit Refresh to preview your folders and files.")}</p>
                    )}
                  </div>

                  <p className="cx-help" style={{ marginTop: 8 }}>{t("Try saying: \"what's in my projects folder\", \"read my README\", \"create a skill that summarizes PDFs\", or \"make a new folder in PROJECTS called LAUNCH\".")}</p>
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
              <p className="cx-eyebrow">{t("Routines")}</p>
              <h2 className="cx-h">{t("Schedule tasks that run on their own")}</h2>
              <p className="cx-lead" style={{ marginBottom: 14 }}>
                {t("Give Keak a job and a time. It runs on your own AI and sends you the result. Great for a daily competitor check, watching for new AI models, or a weekly market summary. You can also just say \"schedule a routine every day at 5am to…\" and Keak sets it up.")}
              </p>

              {routines.length > 0 && (
                <div className="cx-agent-list" style={{ marginBottom: 12 }}>
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
            <section className="cx-card">
              <p className="cx-eyebrow">{t("Connections")}</p>
              <h2 className="cx-h">{t("Connect your apps")}</h2>
              <p className="cx-lead" style={{ marginBottom: 14 }}>
                {t("Link your own accounts so Keak acts directly through them, no clicking on screen. It runs on your accounts, so it costs nothing extra.")}
              </p>

              <div className="cx-conn">
                <div className="cx-conn-head">
                  <span className="cx-conn-name"><LogoBadge id="mcp" name="MCP" brand="#6E56CF" />{t("MCP servers")} <span className="cx-field-tag">{t("Plugins")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="google" slug={CONN_ICON.google.icon} name="Google" brand={CONN_ICON.google.brand} />Google <span className="cx-field-tag">{t("Calendar, Gmail, Drive")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="microsoft" slug={CONN_ICON.microsoft.icon} name="Microsoft" brand={CONN_ICON.microsoft.brand} />Microsoft <span className="cx-field-tag">{t("Outlook Calendar, Mail, OneDrive")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="notion" slug={CONN_ICON.notion.icon} name="Notion" brand={CONN_ICON.notion.brand} />Notion <span className="cx-field-tag">{t("Pages, notes")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="slack" slug={CONN_ICON.slack.icon} name="Slack" brand={CONN_ICON.slack.brand} />Slack <span className="cx-field-tag">{t("Post messages")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="figma" slug={CONN_ICON.figma.icon} name="Figma" brand={CONN_ICON.figma.brand} />Figma <span className="cx-field-tag">{t("Design files")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="supabase" slug={CONN_ICON.supabase.icon} name="Supabase" brand={CONN_ICON.supabase.brand} />Supabase <span className="cx-field-tag">{t("Your database")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="github" slug={CONN_ICON.github.icon} name="GitHub" brand={CONN_ICON.github.brand} />GitHub <span className="cx-field-tag">{t("Repos, issues, PRs")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="shopify" slug={CONN_ICON.shopify.icon} name="Shopify" brand={CONN_ICON.shopify.brand} />Shopify <span className="cx-field-tag">{t("Products, orders")}</span></span>
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
                  <span className="cx-conn-name"><LogoBadge id="telegram" slug={CONN_ICON.telegram.icon} name="Telegram" brand={CONN_ICON.telegram.brand} />Telegram <span className="cx-field-tag">{t("Talk to Keak from your phone")}</span></span>
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
                      <span className="cx-conn-name"><LogoBadge id={tool.id} slug={tool.icon} name={tool.name} brand={tool.brand} />{tool.name} <span className="cx-field-tag">{t(tool.category)}</span></span>
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
              <p className="cx-eyebrow">{t("Work")}</p>
              <h2 className="cx-h">{t("What Keak and your agents made")}</h2>
              <p className="cx-lead" style={{ marginBottom: 12 }}>
                {t("Your chats and your team's jobs live here. Click one to keep chatting by text on your own AI, or start a new chat.")}
              </p>
              {history.length === 0 ? (
                <>
                  <button className="cx-btn" onClick={newChat}>{t("New chat")}</button>
                  <p className="cx-help" style={{ marginTop: 10 }}>{t("Nothing yet. Ask Keak AI something, or say \"use your team to…\" and it lands here.")}</p>
                </>
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
          <p className="cx-eyebrow">{t("Personality")}</p>
          <h2 className="cx-h">{t("How Keak sounds")}</h2>
          <p className="cx-lead" style={{ marginBottom: 8 }}>{t("Tune it here, or just tell Keak out loud, like \"be funnier\" or \"less formal.\"")}</p>
          <Dial label={t("Humor")} value={humor} onChange={(v) => setDial("keak_humor", setHumor, v)}
            bands={[t("Professional, no jokes"), t("A light touch of humor"), t("Playful and witty"), t("Very funny, jokes a lot")]} />
          <Dial label={t("Warmth")} value={warmth} onChange={(v) => setDial("keak_warmth", setWarmth, v)}
            bands={[t("Matter-of-fact"), t("Friendly"), t("Warm and encouraging"), t("Very warm and caring")]} />
          <Dial label={t("Formality")} value={formality} onChange={(v) => setDial("keak_formality", setFormality, v)}
            bands={[t("Very casual"), t("Relaxed"), t("Fairly polished"), t("Formal")]} />
          <Dial label={t("Directness")} value={directness} onChange={(v) => setDial("keak_directness", setDirectness, v)}
            bands={[t("Gentle and diplomatic"), t("Clear and straightforward"), t("Direct"), t("Blunt, no sugar-coating")]} />
            </section>
            )}

            {activeSection === "settings" && (
            <section className="cx-card">
          <p className="cx-eyebrow">{t("Display")}</p>
          <h2 className="cx-h">{t("Show captions")}</h2>
          <div className="cx-seg cx-seg--2">
            <button className={`cx-seg-btn${showCaptions ? " cx-seg-btn--on" : ""}`} onClick={() => toggleCaptions(true)}>{t("On")}</button>
            <button className={`cx-seg-btn${!showCaptions ? " cx-seg-btn--on" : ""}`} onClick={() => toggleCaptions(false)}>{t("Off")}</button>
          </div>
          <p className="cx-help" style={{ marginTop: 12 }}>
            {showCaptions ? t("When Keak talks, the words show under the orb.") : t("Keak talks out loud but won't print the words.")}
          </p>
            </section>
            )}

            {activeSection === "help" && (
            <section className="cx-card cx-howto">
          <p className="cx-eyebrow">{t("Getting started")}</p>
          <h2 className="cx-h">{t("How to use it")}</h2>
          <p className="cx-help" style={{ marginTop: 8 }}>
            {t("Hold")} <span className="cx-kbd">Ctrl</span> + <span className="cx-kbd">Alt</span> {t("anywhere and say \"take over and...\" then what you want, like \"take over and open YouTube and search for lofi.\" Keak asks first, then does it. Press")} <span className="cx-kbd">Esc</span> {t("to stop it any time.")}
          </p>
            </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
