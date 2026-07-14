// BrainGraph — a visual (2D / 3D) map of the connected Second Brain folder, Obsidian-style.
// Rust (`sb_graph`) turns the folder into a "Second Brain" hub + one node per file/folder, with links
// (folder containment + [[wikilinks]] and markdown links). Nodes are coloured by their TOP-LEVEL folder
// (auto-detected for whoever connects: Projects, Finances, AI, Video, Automations…). Runs fully local.
// Four ambient themes (Space default, Ocean, Sky, Forest) give it an "in space" backdrop.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ForceGraph from "force-graph";
import ForceGraph3D from "3d-force-graph";

type GNode = { id: string; name: string; type: string; deg: number; depth: number; fx?: number; fy?: number; fz?: number };
type GLink = { source: string; target: string; kind: string };
type GData = { nodes: GNode[]; links: GLink[] };
type Group = { name: string; rank: number; count: number };
type ThemeKey = "space" | "ocean" | "sky" | "forest";

const CREAM = "#F5EDD8";
const HOME_COLOR = "#C9B79A"; // top-level loose files
// Same type system as the desktop "Connect your AI" screen (fonts already loaded by Connect.css).
const FONT_UI = "Inter, system-ui, -apple-system, sans-serif";
const FONT_DISPLAY = "Fraunces, Georgia, serif";

// Each theme = a backdrop gradient + drifting particles + a folder palette + link tint + centre glow.
const THEMES: Record<ThemeKey, {
  label: string; bgFrom: string; bgTo: string; solid: string; accent: string; swatch: string;
  link: string; linkHot: string; particle: "stars" | "bubbles" | "clouds" | "fireflies"; pColor: string; palette: string[];
}> = {
  space: { label: "Space", bgFrom: "#0b1024", bgTo: "#030409", solid: "#050712", accent: "#FFFFFF",
    swatch: "linear-gradient(135deg, #1a1247 0%, #4a2f8f 50%, #1e3a6e 100%)",
    link: "rgba(180,200,255,0.10)", linkHot: "rgba(190,205,255,0.5)", particle: "stars", pColor: "#dfe8ff",
    palette: ["#FFCF6B","#6FE0C6","#E58AB0","#8AB6FF","#C6A0FF","#FF9E7A","#9CE87F","#6FD0FF","#FFB0D0","#B7E36A","#E0C36A","#7FB0F0"] },
  ocean: { label: "Ocean", bgFrom: "#062a3a", bgTo: "#02121c", solid: "#03151f", accent: "#BFF7FF",
    swatch: "linear-gradient(135deg, #06364a 0%, #1f8a9c 55%, #55dccb 100%)",
    link: "rgba(120,220,230,0.10)", linkHot: "rgba(130,225,235,0.5)", particle: "bubbles", pColor: "#9fe8f0",
    palette: ["#5FE0D0","#7FD8FF","#4FB0C0","#9AF0E0","#6FA8FF","#3FD0A8","#B0EAF0","#5FC0E0","#7FE0B0","#A0D8F0","#4FA0D0","#C0F0E0"] },
  sky: { label: "Sky", bgFrom: "#2a4372", bgTo: "#0e1c33", solid: "#152744", accent: "#FFF0D8",
    swatch: "linear-gradient(135deg, #2a4372 0%, #7f9ad6 55%, #c9b6e6 100%)",
    link: "rgba(220,205,255,0.12)", linkHot: "rgba(230,215,255,0.5)", particle: "clouds", pColor: "#e8ecff",
    palette: ["#F0C98A","#E8A0B0","#C0A8E0","#9AB8F0","#F5D0A0","#D0B0E8","#F0B0C0","#A0C0E8","#E0C070","#C8A0D0","#F0A890","#B0C8F0"] },
  forest: { label: "Forest", bgFrom: "#14301f", bgTo: "#050f09", solid: "#0a1a10", accent: "#EAF7C0",
    swatch: "linear-gradient(135deg, #123021 0%, #3f7a4f 55%, #9fcb6b 100%)",
    link: "rgba(170,210,150,0.12)", linkHot: "rgba(185,220,160,0.5)", particle: "fireflies", pColor: "#d8e89a",
    palette: ["#9FCB6B","#6FB08A","#C7B36A","#8FA05E","#C99A5E","#7FC090","#B0C86A","#5FA070","#D8C090","#A0B070","#C0A060","#8FB86A"] },
};

// Which top-level folder (colour group) a node belongs to.
function groupOf(n: GNode): string {
  if (n.type === "root") return "__center__";
  const s = n.id.indexOf("/");
  if (s >= 0) return n.id.slice(0, s);
  return n.type === "dir" ? n.name : "Home";
}
function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---- Brain shape: sample a point cloud in the form of a brain (two hemispheres + cerebellum) ----
function ellipseIn(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry; return dx * dx + dy * dy <= 1;
}
function ellipsoidIn(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz; return dx * dx + dy * dy + dz * dz <= 1;
}
// A side-profile brain (facing left): domed cerebrum with a flatter underside, a rounded cerebellum
// lobe at the lower back, and a short brainstem tail. y+ points down.
function brainInside(x: number, y: number, z: number, is3d: boolean): boolean {
  if (is3d) {
    const cerebrum = ellipsoidIn(x, y, z, -0.02, -0.08, 0, 0.98, 0.72, 0.62) && y < 0.30;
    const cerebellum = ellipsoidIn(x, y, z, 0.58, 0.42, 0, 0.34, 0.30, 0.28);
    const brainstem = x > 0.46 && x < 0.66 && y > 0.40 && y < 0.82 && Math.abs(z) < 0.14;
    return cerebrum || cerebellum || brainstem;
  }
  const cerebrum = ellipseIn(x, y, -0.02, -0.08, 0.98, 0.72) && y < 0.30;
  const cerebellum = ellipseIn(x, y, 0.58, 0.42, 0.34, 0.30);
  const brainstem = x > 0.46 && x < 0.66 && y > 0.40 && y < 0.82;
  return cerebrum || cerebellum || brainstem;
}
function assignBrainTargets(nodes: any[], is3d: boolean) {
  const R = 9 * Math.sqrt(Math.max(30, nodes.length));
  for (const n of nodes) {
    if (n.type === "root") { n._tx = 0; n._ty = 0; n._tz = 0; n.x = 0; n.y = 0; n.z = 0; continue; }
    let x = 0, y = 0, z = 0, tries = 0;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = is3d ? Math.random() * 2 - 1 : 0; tries++; }
    while (!brainInside(x, y, z, is3d) && tries < 60);
    n._tx = x * R; n._ty = y * R; n._tz = is3d ? z * R * 0.8 : 0;
    // PIN every node onto the brain (fx/fy/fz), so the exact shape holds in both 2D and 3D — no forces
    // to lose a tug-of-war, no drift. Set the live position too so it draws there from frame one.
    n.x = n.fx = n._tx; n.y = n.fy = n._ty;
    if (is3d) { n.z = n.fz = n._tz; } else { n.z = 0; }
    n.vx = 0; n.vy = 0; n.vz = 0;
  }
}
// ---- Immersive backdrop: a per-theme video or image ("in space / sky / ocean / forest"). ----
// Drop files in public/brain-bg/<theme>.mp4 (preferred) or <theme>.jpg. If neither exists it silently
// falls back to the gradient + particles, so the map always looks good even before the art is generated.
function Backdrop({ theme, zoomRef }: { theme: ThemeKey; zoomRef: React.MutableRefObject<{ p: number }> }) {
  // Prefer a video if one exists (most immersive); fall back to an image; else nothing (gradient shows).
  const [kind, setKind] = useState<"video" | "image" | "none">("video");
  const vRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => { setKind("video"); }, [theme]);

  // Keep the video PLAYING for smoothness (no per-frame seeking = no stutter); zoom just changes its speed:
  // zooming in speeds it up (fly forward), zooming out slows it toward a gentle drift.
  useEffect(() => {
    if (kind !== "video") return;
    let raf = 0, lastP = zoomRef.current.p, rate = 0.6;
    const loop = () => {
      const v = vRef.current;
      if (v) {
        if (v.paused) { v.play?.().catch(() => {}); }
        const p = zoomRef.current.p;
        const vel = p - lastP; lastP = p;
        const target = Math.max(0.15, Math.min(3, 0.6 + vel * 160)); // baseline drift + zoom boost
        rate += (target - rate) * 0.07; // ease the rate so speed changes are smooth, never abrupt
        try { v.playbackRate = rate; } catch { /* noop */ }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [kind, theme, zoomRef]);

  if (kind === "none") return null;
  const style: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.9 };
  return kind === "video"
    ? <video key={theme + "v"} ref={vRef} src={`/brain-bg/${theme}.mp4`} autoPlay loop muted playsInline preload="auto" onError={() => setKind("image")} style={style} />
    // Still image (sky/forest): a slow Ken-Burns drift makes it feel animated even without a video.
    : <img key={theme + "i"} src={`/brain-bg/${theme}.jpg`} onError={() => setKind("none")} style={{ ...style, transformOrigin: "center", animation: "kbdrift 46s ease-in-out infinite alternate" }} />;
}

// ---- Ambient particle backdrop ----
function ThemeBackground({ theme }: { theme: ThemeKey }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const cfg = THEMES[theme];
    let raf = 0, w = 0, h = 0, tms = 0;
    type P = { x: number; y: number; r: number; vx: number; vy: number; a: number; tw: number; ph: number };
    let ps: P[] = [];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const spawn = (): P => ({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.6, 2.2), vx: rnd(-0.06, 0.06), vy: rnd(-0.06, 0.06), a: rnd(0.3, 1), tw: rnd(0.6, 2.2), ph: rnd(0, 6.28) });
    const init = () => {
      const density = cfg.particle === "clouds" ? 26000 : cfg.particle === "bubbles" ? 16000 : 9000;
      const n = Math.min(200, Math.max(40, Math.floor((w * h) / density)));
      ps = []; for (let i = 0; i < n; i++) {
        const p = spawn();
        if (cfg.particle === "bubbles") { p.vy = rnd(-0.5, -0.15); p.r = rnd(1, 4); }
        if (cfg.particle === "clouds") { p.r = rnd(60, 160); p.a = rnd(0.03, 0.09); p.vx = rnd(-0.15, 0.15); p.vy = rnd(-0.02, 0.02); }
        if (cfg.particle === "fireflies") { p.r = rnd(0.8, 2); }
        if (cfg.particle === "stars") { p.r = rnd(0.5, 1.8); p.vx = rnd(-0.03, 0.03); p.vy = rnd(-0.02, 0.05); }
        ps.push(p);
      }
    };
    const resize = () => { w = cv.clientWidth; h = cv.clientHeight; cv.width = w; cv.height = h; init(); };
    const tick = () => {
      tms += 0.016; ctx.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.x += p.vx; p.y += p.vy;
        if (cfg.particle === "fireflies") { p.vx += rnd(-0.02, 0.02); p.vy += rnd(-0.02, 0.02); p.vx *= 0.96; p.vy *= 0.96; }
        // wrap
        if (p.x < -p.r) p.x = w + p.r; if (p.x > w + p.r) p.x = -p.r;
        if (p.y < -p.r) p.y = h + p.r; if (p.y > h + p.r) p.y = -p.r;
        const twk = cfg.particle === "clouds" ? 1 : 0.55 + 0.45 * Math.sin(tms * p.tw + p.ph);
        const alpha = Math.max(0, Math.min(1, p.a * twk));
        if (cfg.particle === "clouds") {
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          grd.addColorStop(0, hexA(cfg.pColor, alpha)); grd.addColorStop(1, hexA(cfg.pColor, 0));
          ctx.fillStyle = grd;
        } else if (cfg.particle === "fireflies") {
          const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
          grd.addColorStop(0, hexA(cfg.pColor, alpha)); grd.addColorStop(1, hexA(cfg.pColor, 0));
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, 6.2832); ctx.fill(); continue;
        } else {
          ctx.fillStyle = hexA(cfg.pColor, alpha);
        }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    resize(); tick();
    const ro = new ResizeObserver(resize); ro.observe(cv);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [theme]);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />;
}

export default function BrainGraph({ root, onClose }: { root: string; onClose: () => void }) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const bgWrapRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);
  const dataRef = useRef<GData>({ nodes: [], links: [] });
  const groupRankRef = useRef<Map<string, number>>(new Map());
  const pokeRef = useRef<() => void>(() => {});
  const zoomRef = useRef<{ p: number }>({ p: 0.12 }); // 0..1 scrub progress driven by zoom, read by the backdrop
  const zoomBaseRef = useRef<number>(0); // reference zoom/distance captured on first zoom event

  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [shape, setShape] = useState<"free" | "brain">("free");
  const [theme, setTheme] = useState<ThemeKey>(() => (localStorage.getItem("keak_brain_theme") as ThemeKey) || "space");
  const [showLabels, setShowLabels] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [stats, setStats] = useState({ nodes: 0, links: 0 });
  const [selected, setSelected] = useState<GNode | null>(null);
  const [search, setSearch] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [themeMenu, setThemeMenu] = useState(false);
  useEffect(() => {
    if (!themeMenu) return;
    const close = () => setThemeMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [themeMenu]);

  const searchRef = useRef(""); const labelsRef = useRef(false);
  const hiddenRef = useRef<Set<string>>(new Set()); const themeRef = useRef<ThemeKey>(theme);
  useEffect(() => { searchRef.current = search; pokeRef.current(); }, [search]);
  useEffect(() => { labelsRef.current = showLabels; pokeRef.current(); }, [showLabels]);
  useEffect(() => { hiddenRef.current = hidden; pokeRef.current(); }, [hidden]);
  useEffect(() => {
    themeRef.current = theme; localStorage.setItem("keak_brain_theme", theme);
    pokeRef.current(); // node/link colours follow the theme; the backdrop is swapped by React below
  }, [theme, mode]);

  // Colour for a group, from the current theme palette (by folder rank so big folders get strong colours).
  const groupColor = (group: string): string => {
    if (group === "__center__") return THEMES[themeRef.current].accent;
    if (group === "Home") return HOME_COLOR;
    const rank = groupRankRef.current.get(group) ?? 0;
    const pal = THEMES[themeRef.current].palette;
    return pal[rank % pal.length];
  };

  // Load data once; rank the top-level folders by size.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await invoke<string>("sb_graph", { args: { root } });
        if (!alive) return;
        const data = JSON.parse(raw) as GData;
        dataRef.current = data;
        setStats({ nodes: Math.max(0, data.nodes.length - 1), links: data.links.length });
        const counts = new Map<string, number>();
        for (const n of data.nodes) { if (n.type === "root") continue; counts.set(groupOf(n), (counts.get(groupOf(n)) || 0) + 1); }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const rankMap = new Map<string, number>();
        const gs: Group[] = sorted.map(([name, count], i) => { rankMap.set(name, i); return { name, rank: i, count }; });
        groupRankRef.current = rankMap;
        setGroups(gs);
        setLoading(false);
      } catch (e) { if (alive) { setErr(String(e)); setLoading(false); } }
    })();
    return () => { alive = false; };
  }, [root]);

  // (Re)build the graph when data lands or 2D/3D flips.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || loading || err) return;
    holder.innerHTML = "";
    zoomBaseRef.current = 0; // 2D zoom-k and 3D camera-distance are different scales; recapture per build
    const data = dataRef.current;

    const neighbours = new Map<string, Set<string>>();
    for (const n of data.nodes) neighbours.set(n.id, new Set());
    for (const l of data.links) {
      const s = typeof l.source === "string" ? l.source : (l.source as any).id;
      const t = typeof l.target === "string" ? l.target : (l.target as any).id;
      neighbours.get(s)?.add(t); neighbours.get(t)?.add(s);
    }
    let focusId = "";

    const isMain = (n: GNode) => n.type === "dir" && !n.id.includes("/");
    const valOf = (n: GNode) => n.type === "root" ? 60 : isMain(n) ? Math.min(20, 6 + n.deg * 0.4) : 1 + Math.sqrt(n.deg) * 0.8;
    const radiusOf = (n: GNode) => 4 * Math.sqrt(Math.max(0.5, valOf(n)));
    const matches = (n: GNode) => { const q = searchRef.current.trim().toLowerCase(); return q ? n.name.toLowerCase().includes(q) : false; };
    const isHot = (id: string) => !focusId || id === focusId || neighbours.get(focusId)?.has(id) || false;
    const visibleNode = (n: GNode) => n.type === "root" || !hiddenRef.current.has(groupOf(n));
    const baseColor = (n: GNode) => groupColor(groupOf(n));
    const nodeColor = (n: GNode) => {
      if (n.type === "root") return THEMES[themeRef.current].accent;
      if (searchRef.current.trim()) return matches(n) ? "#FFFFFF" : "rgba(245,237,216,0.12)";
      return isHot(n.id) ? baseColor(n) : "rgba(245,237,216,0.14)";
    };
    const idOf = (x: any) => (typeof x === "object" ? x.id : x);
    const byId = new Map(data.nodes.map((n) => [n.id, n] as const));
    const linkVis = (l: any) => { const a = byId.get(idOf(l.source)), b = byId.get(idOf(l.target)); return !!a && !!b && visibleNode(a) && visibleNode(b); };
    const linkColor = (l: any) => {
      const s = idOf(l.source), t = idOf(l.target);
      const hot = !focusId || s === focusId || t === focusId;
      const th = THEMES[themeRef.current];
      return hot ? th.linkHot : th.link;
    };
    const tooltip = (n: GNode) => {
      if (n.type === "root") return `<div style="background:#141019;border:1px solid rgba(245,237,216,0.2);color:#F5EDD8;padding:6px 10px;border-radius:8px;font-size:12px"><b>Second Brain</b></div>`;
      const dir = n.id.includes("/") ? n.id.slice(0, n.id.lastIndexOf("/")) : "top level";
      return `<div style="background:#141019;border:1px solid rgba(245,237,216,0.2);color:#F5EDD8;padding:6px 10px;border-radius:8px;font-size:12px;max-width:340px"><b>${n.name}</b><div style="opacity:.65;margin-top:2px">${dir}</div></div>`;
    };

    const poke = () => {
      const g = graphRef.current; if (!g) return;
      g.nodeColor(nodeColor).nodeVisibility(visibleNode).linkVisibility(linkVis).linkColor(linkColor);
    };
    pokeRef.current = poke;

    const gd = structuredClone(data) as GData;
    const rootNode = gd.nodes.find((n) => n.type === "root");
    if (rootNode) { rootNode.fx = 0; rootNode.fy = 0; if (mode === "3d") rootNode.fz = 0; }
    // Seed brain positions BEFORE the graph ingests the nodes, so the shape is there from frame one
    // (works the same in 2D and 3D — no waiting on a force to win a tug-of-war).
    if (shape === "brain") assignBrainTargets(gd.nodes, mode === "3d");

    let didFit = false;
    const common = (g: any) => {
      g.graphData(gd).nodeId("id").nodeLabel(tooltip).nodeVal(valOf)
        .nodeColor(nodeColor).nodeVisibility(visibleNode).linkVisibility(linkVis).linkColor(linkColor)
        .onNodeClick((n: GNode) => { focusId = n.id; setSelected(n.type === "root" ? null : n); poke(); })
        .onBackgroundClick(() => { focusId = ""; setSelected(null); poke(); })
        // Frame the whole layout once it settles (so the brain shape / graph is never off-screen).
        .onEngineStop(() => { if (!didFit) { didFit = true; try { g.zoomToFit(600, 60); } catch { /* noop */ } } });
      return g;
    };

    let g: any;
    if (mode === "3d") {
      g = new (ForceGraph3D as any)(holder);
      common(g);
      // Transparent so the themed backdrop (space/ocean/sky/forest) shows behind the 3D nodes too.
      g.backgroundColor("rgba(0,0,0,0)").showNavInfo(false).nodeOpacity(0.95).linkOpacity(0.5)
        .width(holder.clientWidth).height(holder.clientHeight);
      // In 3D, "zoom" = camera distance to the centre. Closer = further into the video (forward), out = back.
      try {
        const controls = g.controls?.();
        controls?.addEventListener?.("change", () => {
          const cam = g.camera?.(); if (!cam) return;
          const d = Math.hypot(cam.position.x, cam.position.y, cam.position.z);
          if (!zoomBaseRef.current) zoomBaseRef.current = d;
          zoomRef.current.p = Math.max(0, Math.min(1, 0.12 + Math.log2(zoomBaseRef.current / Math.max(1, d)) * 0.3));
        });
      } catch { /* noop */ }
    } else {
      g = new (ForceGraph as any)(holder);
      common(g);
      g.backgroundColor("rgba(0,0,0,0)").nodeRelSize(4)
        .linkWidth((l: any) => (l.kind === "link" ? 1.2 : 0.6))
        .width(holder.clientWidth).height(holder.clientHeight)
        // Zoom drives BOTH a gentle parallax scale AND the video scrub position (zoom in = play forward).
        .onZoom((z: any) => {
          const k = z.k || 1;
          if (bgWrapRef.current) bgWrapRef.current.style.transform = `scale(${1 + Math.max(0, k - 1) * 0.06})`;
          if (!zoomBaseRef.current) zoomBaseRef.current = k;
          zoomRef.current.p = Math.max(0, Math.min(1, 0.12 + Math.log2(k / zoomBaseRef.current) * 0.3));
        })
        .nodeCanvasObjectMode(() => "after")
        .nodeCanvasObject((n: any, ctx: CanvasRenderingContext2D, scale: number) => {
          // Guard: on the first frames d3 hasn't laid nodes out yet (x/y undefined). Drawing with NaN
          // coords throws and would kill the whole 2D canvas — so skip until positions are real.
          if (!visibleNode(n) || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
          const accent = THEMES[themeRef.current].accent;
          if (n.type === "root") {
            const r = radiusOf(n);
            const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3);
            grd.addColorStop(0, hexA(accent, 0.35)); grd.addColorStop(1, hexA(accent, 0));
            ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3, 0, 6.2832); ctx.fill();
            if (labelsRef.current) { // the "Second Brain" text only shows when labels are on
              const fs = Math.max(7, 20 / scale);
              ctx.font = `600 ${fs}px ${FONT_DISPLAY}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
              ctx.fillStyle = accent; ctx.fillText("Second Brain", n.x, n.y + r + 4);
            }
            return;
          }
          // Labels OFF = nothing but the centre. Labels ON = main folders always, files as you zoom in.
          if (!labelsRef.current) return;
          const main = isMain(n);
          const show = main || scale > 1.5 || n.deg >= 4 || n.id === focusId || matches(n);
          if (!show) return;
          const label = n.name.length > 26 ? n.name.slice(0, 24) + "…" : n.name;
          const fs = Math.max(main ? 4 : 3.2, (main ? 13 : 11) / scale);
          ctx.font = main ? `600 ${fs}px ${FONT_DISPLAY}` : `500 ${fs}px ${FONT_UI}`;
          ctx.textAlign = "center"; ctx.textBaseline = "top";
          const dim = searchRef.current.trim() ? (matches(n) ? 1 : 0.15) : (isHot(n.id) ? 1 : 0.3);
          ctx.fillStyle = main ? hexA(baseColor(n), dim) : `rgba(245,237,216,${0.85 * dim})`;
          ctx.fillText(label, n.x, n.y + radiusOf(n) + 1.5);
        });
    }
    if (shape === "brain") {
      // Nodes are pinned onto the brain (fx/fy/fz set above), so just kick a tick to draw + frame it.
      try { g.d3ReheatSimulation?.(); } catch { /* noop */ }
    } else {
      try { g.d3Force("charge")?.strength(mode === "3d" ? -70 : -110); } catch { /* noop */ }
    }
    graphRef.current = g;

    const onResize = () => { if (graphRef.current && holder) graphRef.current.width(holder.clientWidth).height(holder.clientHeight); };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      try { graphRef.current?._destructor?.(); } catch { /* noop */ }
      graphRef.current = null;
    };
  }, [loading, err, mode, shape]);

  const toggleHidden = (key: string) => setHidden((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const th = THEMES[theme];
  const legendItems = groups.slice(0, 16);

  return (
    <div style={SS.overlay}>
      <style>{`@keyframes kbdrift{0%{transform:scale(1.03) translate(0%,0%)}50%{transform:scale(1.1) translate(-2%,-1.5%)}100%{transform:scale(1.05) translate(1.5%,-2%)}}
      .bg-theme-opt:hover{background:rgba(245,237,216,0.10)!important;color:#F5EDD8!important}`}</style>
      <div style={SS.bar}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span style={SS.title}>Your Second Brain, visual</span>
          <span style={SS.count}>{stats.nodes} notes · {stats.links} links</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" style={SS.search} />
          <div style={{ position: "relative" }}>
            <button style={SS.themeTrigger} onClick={(e) => { e.stopPropagation(); setThemeMenu((v) => !v); }}>
              <span style={{ ...SS.swatch, background: th.swatch }} />
              {th.label}
              <span style={{ opacity: 0.6, fontSize: 10, marginLeft: 2 }}>▾</span>
            </button>
            {themeMenu && (
              <div style={SS.themeMenu} onClick={(e) => e.stopPropagation()}>
                {(Object.keys(THEMES) as ThemeKey[]).map((k) => (
                  <button key={k} className="bg-theme-opt" style={{ ...SS.themeOpt, ...(k === theme ? SS.themeOptOn : {}) }}
                    onClick={() => { setTheme(k); setThemeMenu(false); }}>
                    <span style={{ ...SS.swatch, background: THEMES[k].swatch }} />
                    {THEMES[k].label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setShowLabels((v) => !v)} style={{ ...SS.btn, ...(showLabels ? SS.btnOn : {}) }}>
            {showLabels ? "Labels: on" : "Labels: off"}
          </button>
          <button onClick={() => setShape((s) => (s === "brain" ? "free" : "brain"))} style={{ ...SS.btn, ...(shape === "brain" ? SS.btnOn : {}) }}>
            {shape === "brain" ? "Brain shape: on" : "Brain shape: off"}
          </button>
          <div style={SS.toggle}>
            <button onClick={() => setMode("2d")} style={{ ...SS.tbtn, ...(mode === "2d" ? SS.tbtnOn : {}) }}>2D</button>
            <button onClick={() => setMode("3d")} style={{ ...SS.tbtn, ...(mode === "3d" ? SS.tbtnOn : {}) }}>3D</button>
          </div>
          <button onClick={onClose} style={SS.close}>Close</button>
        </div>
      </div>

      <div style={{ ...SS.canvas }}>
        {/* Layers, back to front: gradient wash → immersive backdrop (parallax) → drifting particles → the graph. */}
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 42%, ${th.bgFrom}, ${th.bgTo})` }} />
        <div ref={bgWrapRef} style={{ position: "absolute", inset: 0, transition: "transform .25s ease-out", willChange: "transform" }}>
          <Backdrop theme={theme} zoomRef={zoomRef} />
        </div>
        <ThemeBackground theme={theme} />
        <div ref={holderRef} style={{ position: "absolute", inset: 0 }} />

        {/* Legend — your main folders. Click one to hide/show it. */}
        <div style={SS.legend}>
          <span style={SS.legendHint}>Your main folders · click to filter</span>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", maxWidth: 720 }}>
            {legendItems.map((gp) => (
              <button key={gp.name} onClick={() => toggleHidden(gp.name)}
                style={{ ...SS.legendItem, opacity: hidden.has(gp.name) ? 0.35 : 1, textDecoration: hidden.has(gp.name) ? "line-through" : "none" }}>
                <span style={{ ...SS.dot, background: groupColor(gp.name) }} /> {gp.name === "Home" ? "Home (loose files)" : gp.name}
              </button>
            ))}
          </div>
        </div>

        {loading && <div style={SS.hint}>Reading your Second Brain…</div>}
        {err && <div style={{ ...SS.hint, color: "#E58AB0" }}>Couldn't build the map: {err}</div>}

        {selected && (
          <div style={SS.footer}>
            <div style={{ minWidth: 0 }}>
              <div style={SS.fname}>{selected.name}</div>
              <div style={SS.fpath}>{selected.id}</div>
            </div>
            {selected.type !== "dir" && (
              <button style={SS.open} onClick={() => {
                const abs = `${root.replace(/\\/g, "/")}/${selected.id}`;
                invoke("open_url", { url: `file:///${abs}` }).catch(() => {});
              }}>Open file</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SS: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, zIndex: 9000, background: "#050712", display: "flex", flexDirection: "column", fontFamily: FONT_UI },
  bar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px",
    background: "rgba(10,8,18,0.85)", borderBottom: "1px solid rgba(245,237,216,0.12)", flex: "0 0 auto" },
  title: { color: CREAM, fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 19, letterSpacing: "-0.015em", whiteSpace: "nowrap" },
  count: { color: "rgba(245,237,216,0.55)", fontSize: 12, fontFamily: FONT_UI, whiteSpace: "nowrap" },
  search: { background: "rgba(245,237,216,0.08)", border: "1px solid rgba(245,237,216,0.18)", color: CREAM, borderRadius: 8, padding: "7px 12px", fontSize: 13, fontFamily: FONT_UI, width: 150, outline: "none" },
  themeTrigger: { display: "flex", alignItems: "center", gap: 8, background: "rgba(245,237,216,0.08)", border: "1px solid rgba(245,237,216,0.18)", color: CREAM, borderRadius: 8, padding: "6px 11px", fontSize: 13, fontFamily: FONT_UI, fontWeight: 600, outline: "none", cursor: "pointer" },
  themeMenu: { position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 160, background: "rgba(18,13,24,0.98)", border: "1px solid rgba(245,237,216,0.16)", borderRadius: 12, padding: 6, zIndex: 30, boxShadow: "0 18px 44px -18px rgba(0,0,0,0.8)", backdropFilter: "blur(10px)" },
  themeOpt: { display: "flex", alignItems: "center", gap: 10, width: "100%", background: "transparent", border: "none", color: "rgba(245,237,216,0.85)", padding: "8px 10px", borderRadius: 8, fontSize: 13, fontFamily: FONT_UI, fontWeight: 600, cursor: "pointer", textAlign: "left" },
  themeOptOn: { background: "rgba(212,164,154,0.22)", color: CREAM },
  swatch: { width: 16, height: 16, borderRadius: 5, flex: "0 0 auto", boxShadow: "inset 0 0 0 1px rgba(245,237,216,0.25)" },
  toggle: { display: "flex", background: "rgba(245,237,216,0.08)", borderRadius: 8, padding: 3, gap: 2 },
  tbtn: { border: "none", background: "transparent", color: "rgba(245,237,216,0.6)", padding: "5px 11px", borderRadius: 6, fontSize: 12, fontFamily: FONT_UI, fontWeight: 600, cursor: "pointer" },
  tbtnOn: { background: CREAM, color: "#141019" },
  btn: { border: "1px solid rgba(245,237,216,0.2)", background: "transparent", color: "rgba(245,237,216,0.75)", padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: FONT_UI, fontWeight: 600, cursor: "pointer" },
  btnOn: { background: CREAM, color: "#141019", borderColor: CREAM },
  close: { border: "1px solid rgba(245,237,216,0.2)", background: "transparent", color: CREAM, padding: "6px 14px", borderRadius: 8, fontSize: 13, fontFamily: FONT_UI, fontWeight: 600, cursor: "pointer" },
  canvas: { flex: "1 1 auto", position: "relative", minHeight: 0, overflow: "hidden" },
  legend: { position: "absolute", left: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 6, zIndex: 5,
    background: "rgba(10,8,18,0.6)", padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(245,237,216,0.1)", backdropFilter: "blur(4px)" },
  legendHint: { color: "rgba(245,237,216,0.45)", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  legendItem: { color: "rgba(245,237,216,0.85)", fontSize: 11, display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", padding: 0 },
  dot: { width: 9, height: 9, borderRadius: "50%", display: "inline-block", flex: "0 0 auto" },
  hint: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "rgba(245,237,216,0.7)", fontSize: 15, fontFamily: FONT_DISPLAY, fontStyle: "italic", zIndex: 5 },
  footer: { position: "absolute", right: 16, bottom: 16, display: "flex", alignItems: "center", gap: 14, zIndex: 5,
    background: "rgba(10,8,18,0.9)", padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(245,237,216,0.14)", maxWidth: 460 },
  fname: { color: CREAM, fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fpath: { color: "rgba(245,237,216,0.5)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  open: { border: "none", background: CREAM, color: "#141019", padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", flex: "0 0 auto" },
};
