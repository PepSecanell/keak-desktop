// Integrations registry — the tools a user can plug into Keak so Keak AI and the agents can DO more.
//
// Two kinds:
//  1. OAuth "connections" (Google, Microsoft, Notion) — a real sign-in, tokens stored under their own keys.
//     Slack is here too but connects by pasting a bot/user token, because Slack refuses the http://localhost
//     redirect a desktop loopback flow needs (would require our own hosted https redirect).
//  2. API-key "tools" (Perplexity, HeyGen, ElevenLabs, Gamma, Higgsfield, Make, n8n, Manus) — these only
//     ever issue API keys (no consumer-subscription OAuth for programmatic use), so the user pastes a key.
//
// Per-agent access: an agent's `tools` array lists the tool ids it's allowed to use, so a research agent can
// be pointed at Perplexity, a video agent at HeyGen, etc.

export type ToolAuth = "apikey" | "token";

export type ToolDef = {
  id: string;
  name: string;
  category: string;      // Research · Video · Voice · Decks · Automation · Messaging
  auth: ToolAuth;
  keyLabel: string;      // input placeholder
  getUrl?: string;       // where to grab the key/token
  hint: string;          // one-line description
  icon?: string;         // Simple Icons slug for the brand logo (falls back to a monogram)
  brand?: string;        // brand colour for the monogram fallback
};

// API-key tools. Keys live in localStorage under `keak_tool_<id>`.
export const AI_TOOLS: ToolDef[] = [
  { id: "perplexity", name: "Perplexity", category: "Research", auth: "apikey",
    keyLabel: "Perplexity API key (pplx-…)", getUrl: "https://www.perplexity.ai/settings/api",
    hint: "Live web research with citations. Great for a research agent.", icon: "perplexity", brand: "#20808D" },
  { id: "heygen", name: "HeyGen", category: "Video", auth: "apikey",
    keyLabel: "HeyGen API key", getUrl: "https://app.heygen.com/settings?nav=API",
    hint: "AI avatar / talking-head videos from a script.", icon: "heygen", brand: "#4E46DC" },
  { id: "elevenlabs", name: "ElevenLabs", category: "Voice", auth: "apikey",
    keyLabel: "ElevenLabs API key", getUrl: "https://elevenlabs.io/app/settings/api-keys",
    hint: "Realistic voiceover and text-to-speech.", icon: "elevenlabs", brand: "#000000" },
  { id: "gamma", name: "Gamma", category: "Decks", auth: "apikey",
    keyLabel: "Gamma API key", getUrl: "https://gamma.app/settings",
    hint: "Auto-build slide decks and docs.", icon: "gamma", brand: "#9C6BFF" },
  { id: "higgsfield", name: "Higgsfield", category: "Video", auth: "apikey",
    keyLabel: "Higgsfield API key", getUrl: "https://platform.higgsfield.ai",
    hint: "Cinematic AI image and video from a prompt.", icon: "", brand: "#111111" },
  { id: "n8n", name: "n8n", category: "Automation", auth: "token",
    keyLabel: "n8n webhook URL", getUrl: "https://n8n.io",
    hint: "Trigger your own n8n workflows by URL.", icon: "n8n", brand: "#EA4B71" },
  { id: "make", name: "Make", category: "Automation", auth: "token",
    keyLabel: "Make webhook URL", getUrl: "https://www.make.com",
    hint: "In Make add a 'Custom webhook' trigger to a scenario and paste its URL here to fire it (2,000+ apps). For full two-way access, add your Make MCP URL under MCP instead.", icon: "", brand: "#6D00CC" },
  { id: "manus", name: "Manus", category: "Research", auth: "apikey",
    keyLabel: "Manus API key", getUrl: "https://open.manus.ai",
    hint: "Hand a whole task to an autonomous agent.", icon: "", brand: "#111111" },
  { id: "resend", name: "Resend", category: "Messaging", auth: "apikey",
    keyLabel: "Resend API key (re_…)", getUrl: "https://resend.com/api-keys",
    hint: "Send emails. Verify a domain in Resend to send to anyone.", icon: "resend", brand: "#000000" },
  { id: "gumloop", name: "Gumloop", category: "Automation", auth: "apikey",
    keyLabel: "Gumloop API key", getUrl: "https://www.gumloop.com/settings",
    hint: "Trigger your saved Gumloop flow.", icon: "", brand: "#6E56CF" },
  { id: "tavily", name: "Tavily", category: "Research", auth: "apikey",
    keyLabel: "Tavily API key (tvly-…)", getUrl: "https://app.tavily.com",
    hint: "Fast AI web search built for agents.", icon: "", brand: "#1F6FEB" },
  { id: "firecrawl", name: "Firecrawl", category: "Research", auth: "apikey",
    keyLabel: "Firecrawl API key (fc-…)", getUrl: "https://www.firecrawl.dev/app/api-keys",
    hint: "Scrape and crawl any website into clean markdown.", icon: "", brand: "#F97316" },
  { id: "fireflies", name: "Fireflies", category: "Meetings", auth: "apikey",
    keyLabel: "Fireflies API key", getUrl: "https://app.fireflies.ai/settings",
    hint: "Transcribe and search your meeting calls.", icon: "", brand: "#7C4DFF" },
  { id: "granola", name: "Granola", category: "Meetings", auth: "apikey",
    keyLabel: "Granola API key", getUrl: "https://www.granola.ai",
    hint: "AI notes from your meetings.", icon: "", brand: "#111111" },
  { id: "vercel", name: "Vercel", category: "Dev", auth: "token",
    keyLabel: "Vercel API token", getUrl: "https://vercel.com/account/tokens",
    hint: "Deploy and manage your Vercel projects.", icon: "", brand: "#000000" },
  { id: "pinecone", name: "Pinecone", category: "Data", auth: "apikey",
    keyLabel: "Pinecone API key", getUrl: "https://app.pinecone.io",
    hint: "Vector database for AI memory and search.", icon: "", brand: "#1C17FF" },
  { id: "railway", name: "Railway", category: "Dev", auth: "token",
    keyLabel: "Railway API token", getUrl: "https://railway.app/account/tokens",
    hint: "Deploy and manage your Railway services.", icon: "", brand: "#0B0D0E" },
];

// Brand logo slug + colour for the OAuth/token connections (Google, Microsoft, Notion, …).
export const CONN_ICON: Record<string, { icon: string; brand: string }> = {
  google: { icon: "google", brand: "#4285F4" },
  microsoft: { icon: "", brand: "#0067B8" },
  notion: { icon: "notion", brand: "#000000" },
  slack: { icon: "slack", brand: "#4A154B" },
  figma: { icon: "figma", brand: "#F24E1E" },
  supabase: { icon: "supabase", brand: "#3FCF8E" },
  github: { icon: "github", brand: "#181717" },
  shopify: { icon: "shopify", brand: "#7AB55C" },
  telegram: { icon: "telegram", brand: "#26A5E4" },
  brain: { icon: "", brand: "#2C1508" },
};

export function toolById(id: string): ToolDef | undefined { return AI_TOOLS.find((t) => t.id === id); }
export function getToolKey(id: string): string { return localStorage.getItem(`keak_tool_${id}`) || ""; }
export function setToolKey(id: string, v: string) {
  const k = `keak_tool_${id}`;
  if (v.trim()) localStorage.setItem(k, v.trim()); else localStorage.removeItem(k);
}
export function toolConnected(id: string): boolean { return !!getToolKey(id); }
export function connectedToolIds(): string[] { return AI_TOOLS.filter((t) => toolConnected(t.id)).map((t) => t.id); }

// OAuth/token connections shown alongside the AI tools — used for the per-agent "can use" picker so an agent
// can also be pointed at Notion / Slack / Google / Microsoft. Connected-state is read from their own keys.
export type ConnDef = { id: string; name: string; connectedKey: string };
export const CONNECTIONS: ConnDef[] = [
  { id: "google", name: "Google", connectedKey: "keak_google_refresh" },
  { id: "microsoft", name: "Microsoft", connectedKey: "keak_ms_refresh" },
  { id: "notion", name: "Notion", connectedKey: "keak_notion_token" },
  { id: "slack", name: "Slack", connectedKey: "keak_slack_token" },
  { id: "figma", name: "Figma", connectedKey: "keak_figma_token" },
  { id: "supabase", name: "Supabase", connectedKey: "keak_supabase_url" },
  { id: "github", name: "GitHub", connectedKey: "keak_github_token" },
  { id: "shopify", name: "Shopify", connectedKey: "keak_shopify_token" },
  { id: "telegram", name: "Telegram", connectedKey: "keak_telegram_token" },
  { id: "brain", name: "Second Brain OS", connectedKey: "keak_brain_path" },
];
export function connConnected(id: string): boolean {
  const c = CONNECTIONS.find((x) => x.id === id);
  return !!(c && localStorage.getItem(c.connectedKey));
}
// Everything an agent could be granted: connected AI tools + connected OAuth/token connections.
export function assignableForAgents(): { id: string; name: string }[] {
  const tools = AI_TOOLS.filter((t) => toolConnected(t.id)).map((t) => ({ id: t.id, name: t.name }));
  const conns = CONNECTIONS.filter((c) => connConnected(c.id)).map((c) => ({ id: c.id, name: c.name }));
  return [...conns, ...tools];
}
