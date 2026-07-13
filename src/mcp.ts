import { invoke } from "@tauri-apps/api/core";

// An MCP (Model Context Protocol) server the user connected. `local` = a program Keak launches on this machine
// (e.g. `npx -y @modelcontextprotocol/server-filesystem <path>`); `remote` = an HTTP endpoint URL. Its tools are
// discovered via tools/list and become callable by the chat agent. Stored in localStorage under keak_mcp_servers.
export type McpTool = { name: string; description?: string; inputSchema?: any };
export type McpServer = {
  id: string;
  name: string;
  transport: "local" | "remote";
  command?: string;   // local: the program, e.g. "npx"
  args?: string;      // local: args as one space-separated string (we split on spaces)
  url?: string;       // remote: endpoint URL
  headers?: Record<string, string>; // remote: auth headers (e.g. Authorization)
  enabled: boolean;
  tools?: McpTool[];  // cached after a successful tools/list
};

export function readMcpServers(): McpServer[] {
  try { return JSON.parse(localStorage.getItem("keak_mcp_servers") || "[]") as McpServer[]; } catch { return []; }
}
export function writeMcpServers(list: McpServer[]) { localStorage.setItem("keak_mcp_servers", JSON.stringify(list)); }
export function newMcpId(): string { return "mcp_" + Math.random().toString(36).slice(2, 9); }

// The shape the Rust `mcp_rpc` command expects (args split into an array, headers as a map).
function serverPayload(s: McpServer) {
  return {
    transport: s.transport,
    command: s.command || "",
    args: (s.args || "").trim() ? (s.args as string).trim().split(/\s+/) : [],
    url: s.url || "",
    headers: s.headers || {},
  };
}

export async function mcpListTools(s: McpServer): Promise<McpTool[]> {
  const raw = await invoke<string>("mcp_rpc", { args: { server: serverPayload(s), method: "tools/list", params: {} } });
  const res = JSON.parse(raw);
  return (res.tools || []) as McpTool[];
}

export async function mcpCallTool(s: McpServer, name: string, args: any): Promise<string> {
  const raw = await invoke<string>("mcp_rpc", { args: { server: serverPayload(s), method: "tools/call", params: { name, arguments: args || {} } } });
  const res = JSON.parse(raw);
  // A tool result is { content: [{type:"text", text}, ...], isError? } — flatten the text parts for the model.
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content.map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).filter(Boolean).join("\n");
  return text || JSON.stringify(res);
}
