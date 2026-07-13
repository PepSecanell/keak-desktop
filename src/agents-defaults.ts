// The built-in "star" agents. Shared by the overlay (delegation) and the Connect window (display) so both
// always agree on names, roles, personalities, and colours. Users add their own on top of these in Connect,
// and can now EDIT the defaults too (name, description, personality, colour) — edits are stored as overrides.
// `tools` = ids of integrations this agent is allowed to use (e.g. "perplexity", "notion"). See integrations.ts.
export type AgentDef = { name: string; description: string; color: string; personality?: string; tools?: string[]; choice?: string };

// The original stars. Never mutated — user edits live in the overrides map, so a "Reset" can always restore.
export const DEFAULT_AGENTS_BASE: AgentDef[] = [
  { name: "Sirius", description: "Research and finding the best options", color: "#D4A49A" },
  { name: "Polaris", description: "Planning and structure", color: "#C9A24A" },
  { name: "Rigel", description: "Writing and copy", color: "#C68B7E" },
  { name: "Canopus", description: "Analysis and comparison", color: "#8FA47D" },
  { name: "Deneb", description: "Design and layout ideas", color: "#D8B86A" },
  { name: "Naos", description: "Summaries and putting it together", color: "#B08A72" },
];

// User edits to the default agents, keyed by the ORIGINAL base name → the fields they changed. Keying by the
// base name (not the edited name) means a "Reset" always finds and clears the right override.
export function readDefaultOverrides(): Record<string, Partial<AgentDef>> {
  try {
    const raw = localStorage.getItem("keak_agents_default_overrides");
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
export function saveDefaultOverride(baseName: string, patch: Partial<AgentDef>) {
  const o = readDefaultOverrides();
  o[baseName] = { ...(o[baseName] || {}), ...patch };
  localStorage.setItem("keak_agents_default_overrides", JSON.stringify(o));
}
export function resetDefaultOverride(baseName: string) {
  const o = readDefaultOverrides();
  delete o[baseName];
  localStorage.setItem("keak_agents_default_overrides", JSON.stringify(o));
}

// Each effective default carries its base name so edits (which may rename it) can still be saved/reset.
export type EffectiveAgent = AgentDef & { base: string };

// The default agents as they actually are right now: base merged with the user's edits.
export function effectiveDefaults(): EffectiveAgent[] {
  const ov = readDefaultOverrides();
  return DEFAULT_AGENTS_BASE.map((a) => ({ ...a, ...(ov[a.name] || {}), base: a.name }));
}

// Back-compat alias: existing imports of DEFAULT_AGENTS get the effective (edited) list. It's a getter-like
// snapshot; call effectiveDefaults() when you need it fresh after an edit.
export const DEFAULT_AGENTS: AgentDef[] = effectiveDefaults();
