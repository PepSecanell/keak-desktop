// Routines: scheduled tasks that run on the user's own AI and deliver output somewhere. Pure data + timing
// helpers, shared by the Overlay engine (which runs them) and the Connect window (which manages them). All
// state lives in localStorage under "keak_routines" so both windows see the same list.

export type RoutineFreq = "once" | "daily" | "weekly";
export type RoutineOutput = "keak" | "telegram" | "email";

export type Routine = {
  id: string;
  name: string;
  freq: RoutineFreq;
  day?: number;        // 0-6 (Sun-Sat), only for weekly
  hour: number;        // 0-23
  minute: number;      // 0-59
  onceDate?: string;   // ISO datetime, only for "once"
  instructions: string;
  output: RoutineOutput;
  outputTarget?: string; // email address (email) or number (whatsapp); blank = the saved default
  modelChoice?: string; // "provider|model" this routine runs on (e.g. "claude|claude-haiku-4-5"); blank = default AI
  tools: string[];     // integration ids this routine may use (e.g. "perplexity")
  enabled: boolean;
  lastRun?: number;    // epoch ms of the last time it fired
  lastResult?: string; // the last output text (for the Work log / preview)
};

export function readRoutines(): Routine[] {
  try {
    const raw = localStorage.getItem("keak_routines");
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
export function writeRoutines(list: Routine[]) {
  localStorage.setItem("keak_routines", JSON.stringify(list));
}
export function upsertRoutine(r: Routine) {
  const list = readRoutines();
  const i = list.findIndex((x) => x.id === r.id);
  if (i >= 0) list[i] = r; else list.push(r);
  writeRoutines(list);
}
export function removeRoutine(id: string) {
  writeRoutines(readRoutines().filter((r) => r.id !== id));
}
export function setRoutineRun(id: string, ts: number, result?: string, enabled?: boolean) {
  const list = readRoutines();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], lastRun: ts, ...(result !== undefined ? { lastResult: result } : {}), ...(enabled !== undefined ? { enabled } : {}) };
  writeRoutines(list);
}
export function newRoutineId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Is this routine due to run right now? Called every ~30s by the scheduler.
export function isRoutineDue(r: Routine, now: Date): boolean {
  if (!r.enabled) return false;
  if (r.freq === "once") {
    if (r.lastRun) return false;
    if (!r.onceDate) return false;
    return now.getTime() >= new Date(r.onceDate).getTime();
  }
  // daily / weekly: the clock has to be at the routine's hour:minute (the 30s tick lands within the minute),
  // it must not have already run today, and for weekly the weekday has to match.
  if (now.getHours() !== r.hour || now.getMinutes() !== (r.minute || 0)) return false;
  if (r.freq === "weekly" && now.getDay() !== (r.day ?? 1)) return false;
  if (r.lastRun && new Date(r.lastRun).toDateString() === now.toDateString()) return false;
  return true;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function hhmm(h: number, m: number): string {
  const mm = String(m ?? 0).padStart(2, "0");
  return `${h}:${mm}`;
}
export function nextRunLabel(r: Routine): string {
  if (r.freq === "once") {
    if (!r.onceDate) return "One time";
    try {
      const d = new Date(r.onceDate);
      return `Once on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    } catch { return "One time"; }
  }
  if (r.freq === "weekly") return `${WEEKDAYS[r.day ?? 1]}s at ${hhmm(r.hour, r.minute)}`;
  return `Every day at ${hhmm(r.hour, r.minute)}`;
}
