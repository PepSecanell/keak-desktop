import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./Agents.css";

// Fullscreen, click-through overlay of named "star" sub-agents. It reads the live agent list straight from
// localStorage (shared across the app's native windows), so the overlay just writes "keak_agents" and this
// window animates. Motion mode (drift/still/circle/plane/gather/follow) comes from keak_agents_viz, which
// Keak AI can set by voice. Names are shown as labels unless turned off in keak_agent_labels.
type Agent = { name: string; status: "working" | "done"; color?: string };
type Viz = { mode: string; target?: string };

// Derive an orb gradient from a single user-chosen hex colour.
function lighten(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#F3E0D6";
  const n = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `#${((1 << 24) + (mix((n >> 16) & 255) << 16) + (mix((n >> 8) & 255) << 8) + mix(n & 255)).toString(16).slice(1)}`;
}
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(212,164,154,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const STAR: Record<string, { c1: string; c2: string; glow: string }> = {
  Sirius: { c1: "#F3E0D6", c2: "#D4A49A", glow: "rgba(212,164,154,0.72)" },
  Polaris: { c1: "#F1DEA6", c2: "#C9A24A", glow: "rgba(201,162,74,0.72)" },
  Rigel: { c1: "#F1D9CE", c2: "#C68B7E", glow: "rgba(198,139,126,0.72)" },
  Canopus: { c1: "#DBE5C6", c2: "#8FA47D", glow: "rgba(143,164,125,0.66)" },
  Deneb: { c1: "#F5EAC4", c2: "#D8B86A", glow: "rgba(216,184,106,0.66)" },
  Naos: { c1: "#EAD6C6", c2: "#B08A72", glow: "rgba(176,138,114,0.66)" },
};
const FALLBACK = { c1: "#F0DAD1", c2: "#D4A49A", glow: "rgba(212,164,154,0.72)" };

// Spread-out anchors + sizes so the constellation fills the whole screen with depth.
const ANCHOR = [
  { left: "18%", top: "26%", size: 42 },
  { left: "73%", top: "20%", size: 30 },
  { left: "41%", top: "60%", size: 38 },
  { left: "84%", top: "56%", size: 28 },
  { left: "12%", top: "68%", size: 34 },
  { left: "58%", top: "38%", size: 32 },
];

export default function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [viz, setViz] = useState<Viz>({ mode: "drift" });
  const [showLabels, setShowLabels] = useState<boolean>(localStorage.getItem("keak_agent_labels") !== "0");
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const read = () => {
      try {
        const raw = localStorage.getItem("keak_agents");
        const data = raw ? JSON.parse(raw) : null;
        setAgents(Array.isArray(data?.agents) ? data.agents : []);
      } catch { setAgents([]); }
      try {
        const rv = localStorage.getItem("keak_agents_viz");
        const v = rv ? JSON.parse(rv) : null;
        setViz(v && v.mode ? v : { mode: "drift" });
      } catch { setViz({ mode: "drift" }); }
      setShowLabels(localStorage.getItem("keak_agent_labels") !== "0");
    };
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === "keak_agents" || e.key === "keak_agents_viz" || e.key === "keak_agent_labels") read(); };
    window.addEventListener("storage", onStorage);
    // PRIMARY channel: localStorage is NOT shared across Tauri webview windows, so the overlay pushes agent
    // state to this window via a Tauri event. This is what actually makes the orbs appear.
    const unlistenP = listen<{ agents?: Agent[]; viz?: Viz; labels?: boolean }>("agents-update", (e) => {
      const p = e.payload || {};
      if (Array.isArray(p.agents)) setAgents(p.agents);
      if (p.viz && p.viz.mode) setViz(p.viz);
      if (typeof p.labels === "boolean") setShowLabels(p.labels);
    });
    // Poll localStorage too as a same-window fallback (harmless if empty).
    const t = window.setInterval(read, 500);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(t);
      unlistenP.then((un) => un()).catch(() => { /* ignore */ });
    };
  }, []);

  // "follow my mouse" mode: poll the real OS cursor position and move the target orb(s) to it.
  useEffect(() => {
    if (viz.mode !== "follow") { setMouse(null); return; }
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try { const p = await invoke<[number, number]>("cursor_pos"); if (alive) setMouse({ x: p[0], y: p[1] }); } catch { /* ignore */ }
      if (alive) window.setTimeout(tick, 55);
    };
    tick();
    return () => { alive = false; };
  }, [viz.mode]);

  const mode = viz.mode || "drift";
  const doneNames = agents.filter((a) => a.status === "done").map((a) => a.name);
  const isTargeted = (name: string) => !viz.target || viz.target === "all" || viz.target.toLowerCase() === name.toLowerCase();

  return (
    <div className={`agents-stage viz-${mode}`}>
      {agents.map((a, i) => {
        const hue = a.color && /^#?[0-9a-f]{6}$/i.test(a.color.trim())
          ? { c1: lighten(a.color, 0.5), c2: a.color, glow: hexToRgba(a.color, 0.72) }
          : STAR[a.name] || FALLBACK;
        const anch = ANCHOR[i % ANCHOR.length];
        const isDone = a.status === "done";
        let left: string = anch.left, top: string = anch.top;
        const style: React.CSSProperties = {
          ["--size" as string]: `${anch.size}px`,
          ["--c1" as string]: hue.c1,
          ["--c2" as string]: hue.c2,
          ["--glow" as string]: hue.glow,
          animationDelay: `${-i * 4.3}s`,
        };
        let motionCls = "";

        if (mode === "follow" && isTargeted(a.name) && mouse) {
          // ride the cursor (window covers the primary monitor from its origin)
          left = `${mouse.x}px`; top = `${mouse.y}px`;
          motionCls = "agent-orb--follow";
        } else if (mode === "gather" || (mode === "drift" && isDone)) {
          // cluster in a ring near the Keak orb (top-centre)
          const list = mode === "gather" ? agents.map((x) => x.name) : doneNames;
          const k = Math.max(list.indexOf(a.name), 0);
          const n = Math.max(list.length, 1);
          const ang = n > 1 ? (k / n) * Math.PI * 2 : 0;
          const r = n > 1 ? 5.5 : 0;
          left = `${(50 + Math.cos(ang) * r).toFixed(2)}%`;
          top = `${(15 + Math.sin(ang) * r).toFixed(2)}%`;
          motionCls = "agent-orb--converge";
        } else if (mode === "still") {
          motionCls = "viz-still-orb";
        } else if (mode === "circle") {
          left = "50%"; top = "50%";
          motionCls = "viz-circle-orb";
          style.animationDelay = `${(-(i % 6) / 6) * 6}s`;
        } else if (mode === "plane") {
          motionCls = "viz-plane-orb";
          style.animationDelay = `${-i * 0.7}s`;
        } else {
          motionCls = `drift-${i % 6}`;
        }

        style.left = left; style.top = top;
        return (
          <div
            key={a.name + i}
            className={`agent-orb ${isDone ? "agent-orb--done" : "agent-orb--working"} ${motionCls}`}
            style={style}
          >
            <span className="agent-core" />
            {showLabels && <span className="agent-label">{a.name}</span>}
          </div>
        );
      })}
    </div>
  );
}
