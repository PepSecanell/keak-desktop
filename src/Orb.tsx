import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The always-on "Standby" orb: a small Keak orb in a screen corner. Click it to talk to Keak AI hands-free.
// It drives the SAME Keak AI flow as Ctrl+Alt, but on the HIDDEN overlay (orb_talk_* + alt-start/alt-stop), so
// this corner orb is the ONLY orb the user sees — no second orb pops in the middle. Keak answers out loud.
// Wake-word ("Hey Keak") detection plugs into the same start/stop path next.
type Phase = "idle" | "recording" | "busy";

export default function Orb() {
  const [phase, setPhase] = useState<Phase>("idle");

  async function onClick() {
    if (phase === "idle") {
      setPhase("recording");
      try { await invoke("orb_talk_start"); } catch { setPhase("idle"); }
    } else if (phase === "recording") {
      setPhase("busy"); // keep it lit while Keak thinks + speaks
      try { await invoke("orb_talk_stop"); } catch { /* ignore */ }
    }
    // busy: ignore clicks until the turn finishes
  }

  // "orb-active" = a "Hey Keak" wake started a turn; "orb-idle" = the turn ended. Keep the orb in sync.
  useEffect(() => {
    const p1 = listen("orb-idle", () => setPhase("idle"));
    const p2 = listen("orb-active", () => setPhase("recording"));
    return () => { p1.then((f) => f()); p2.then((f) => f()); };
  }, []);

  return (
    <div className="orb-wrap">
      <button
        className={`orb${phase !== "idle" ? " orb--on" : ""}${phase === "busy" ? " orb--busy" : ""}`}
        onClick={onClick}
        title={phase === "idle" ? "Talk to Keak" : phase === "recording" ? "Listening… click to send" : "Thinking…"}
      >
        <span className="orb-core" />
      </button>
      <style>{`
        html, body, #root { margin: 0; padding: 0; background: transparent; overflow: hidden; }
        .orb-wrap { width: 96px; height: 96px; display: flex; align-items: center; justify-content: center; }
        .orb {
          width: 64px; height: 64px; border: none; padding: 0; cursor: pointer;
          border-radius: 50%; background: transparent; position: relative; -webkit-app-region: no-drag;
        }
        .orb-core {
          display: block; width: 64px; height: 64px; border-radius: 50%;
          background: radial-gradient(circle at 34% 30%, #E7C3B7 0%, #D4A49A 42%, #C68B7E 100%);
          box-shadow: 0 6px 18px rgba(44,21,8,0.28), 0 0 0 1px rgba(198,139,126,0.5) inset;
          animation: breathe 3.4s ease-in-out infinite;
        }
        .orb:hover .orb-core { transform: scale(1.06); }
        .orb--on .orb-core {
          animation: pulse 1.1s ease-in-out infinite;
          box-shadow: 0 6px 18px rgba(44,21,8,0.3), 0 0 0 3px rgba(212,164,154,0.55), 0 0 26px rgba(212,164,154,0.85);
        }
        .orb--busy .orb-core { animation: pulse 1.7s ease-in-out infinite; }
        @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
      `}</style>
    </div>
  );
}
