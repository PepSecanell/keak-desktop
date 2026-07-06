import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import keakLogo from "./assets/icon_keak.png";
import keakLogoDark from "./assets/icon_keak_2.png";
import "./App.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// The full Keak dashboard lives on the web. Once the native gate has authenticated (and fed the overlay
// its session via localStorage), we hand the session to the web app and show it as the main window, so the
// installed app IS the web dashboard (Wispr-Flow style) while the overlay stays native.
const DASHBOARD_URL = "https://keak.app";
function goToDashboard(s: Session) {
  const hash = `#access_token=${encodeURIComponent(s.access_token)}` +
    `&refresh_token=${encodeURIComponent(s.refresh_token || "")}` +
    `&kk_desktop=1`;
  window.location.replace(`${DASHBOARD_URL}/${hash}`);
}

// Guards against the deep-link callback firing twice (single-instance + on_open_url).
let oauthInFlight = false;

interface Profile {
  plan: string;
  minutes_used_this_month: number;
}

interface Session {
  access_token: string;
  email: string;
  refresh_token?: string;
}

// Dictation languages. gpt-4o-transcribe auto-detects, but pinning your language stops occasional
// mis-detection and makes Keak AI reply in it. "auto" sends no hint. More can be added anytime.
const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "zh", label: "中文 (Mandarin)" },
  { code: "hi", label: "हिन्दी (Hindi)" },
  { code: "ar", label: "العربية (Arabic)" },
];

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  starter: "Starter · $4.99/mo",
  pro: "Pro · $9.99/mo",
  team: "Team · $6.99/user/mo",
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [altMode, setAltMode] = useState<string>(() => localStorage.getItem("keak_alt_mode") || "keak_ai");
  const [language, setLanguage] = useState<string>(() => localStorage.getItem("keak_language") || "auto");

  useEffect(() => {
    const stored = localStorage.getItem("keak_session");
    if (stored) {
      const s: Session = JSON.parse(stored);
      setSession(s);
      // Already signed in: refresh the overlay bridge, then go straight to the web dashboard.
      fetchProfile(s.access_token).finally(() => goToDashboard(s));
    }

    // Listen for Google OAuth callback from deep link
    const unlistenPromise = listen<string>("oauth-callback", (event) => {
      handleOAuthCallback(event.payload);
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, []);

  async function handleOAuthCallback(callbackUrl: string) {
    if (oauthInFlight) return;
    oauthInFlight = true;
    try {
      // Parse query params with regex — new URL() rejects custom schemes in WebView2
      const codeMatch = callbackUrl.match(/[?&]code=([^&#]+)/);
      const code = codeMatch ? decodeURIComponent(codeMatch[1]) : null;

      if (code) {
        const verifier = localStorage.getItem("keak_pkce_verifier");
        localStorage.removeItem("keak_pkce_verifier");
        if (!verifier) { setError("Auth expired. Try Google sign-in again."); return; }
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
          body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
        });
        const data = await res.json();
        if (data.access_token) {
          const emailVal = data.user?.email || "";
          const s: Session = { access_token: data.access_token, email: emailVal, refresh_token: data.refresh_token };
          setSession(s);
          localStorage.setItem("keak_session", JSON.stringify(s));
          fetchProfile(data.access_token).finally(() => goToDashboard(s));
        } else {
          setError("Google sign-in failed: " + (data.error_description || data.error || "unknown"));
        }
        return;
      }

      // Implicit flow fallback: #access_token=...
      const hashMatch = callbackUrl.match(/#(.+)/);
      if (!hashMatch) { setError("No auth data received. Try again."); return; }
      const params = new URLSearchParams(hashMatch[1]);
      const accessToken = params.get("access_token");
      if (!accessToken) { setError("No token received. Try again."); return; }
      const payload = JSON.parse(atob(accessToken.split(".")[1]));
      const emailVal = payload.email || "";
      const s: Session = {
        access_token: accessToken,
        email: emailVal,
        refresh_token: params.get("refresh_token") || undefined,
      };
      setSession(s);
      localStorage.setItem("keak_session", JSON.stringify(s));
      fetchProfile(accessToken).finally(() => goToDashboard(s));
    } catch (e) {
      setError("Sign-in error: " + String(e));
    } finally {
      oauthInFlight = false;
    }
  }

  async function signInWithGoogle() {
    try {
      // Google blocks OAuth inside embedded webviews, so we sign in via the system browser on the official
      // domain; the /auth?desktop=1 bridge hands the session back to the desktop through the keak:// deep
      // link (implicit tokens in the hash), which handleOAuthCallback stores.
      await invoke("open_url", { url: "https://keak.app/auth?desktop=1" });
    } catch (e) {
      setError("Could not open browser: " + String(e));
    }
  }

  async function fetchProfile(token: string) {
    // select=* so newly added columns (voice_gender, language, …) never break this query.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=*`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data[0]) {
        setProfile(data[0]);
        const plan = data[0].plan ?? "free";
        localStorage.setItem("keak_plan", plan);
        // Personalization bridge for the overlay window (Keak AI greets you by name).
        localStorage.setItem("keak_user_name", data[0].full_name || "there");
        // Voice choice for Keak AI (female/male), read by the overlay when calling keak-tts.
        localStorage.setItem("keak_voice_gender", data[0].voice_gender || "female");
        // Screen-vision permission (allow/disallow), read by the overlay before screenshotting.
        localStorage.setItem("keak_screen_vision_allowed", data[0].ai_screen_vision ? "1" : "0");
        if (!localStorage.getItem("keak_assistant_name")) {
          localStorage.setItem("keak_assistant_name", "Keak");
        }
        // Default what Ctrl+Alt does, once: Keak AI on paid, Thought Dump on free.
        if (!localStorage.getItem("keak_alt_mode")) {
          const isPaidPlan = ["starter", "pro", "team"].includes(plan);
          const def = isPaidPlan ? "keak_ai" : "thought_dump";
          localStorage.setItem("keak_alt_mode", def);
          setAltMode(def);
        }
      }
    }
  }

  function chooseAltMode(mode: string) {
    setAltMode(mode);
    localStorage.setItem("keak_alt_mode", mode);
  }

  function chooseLanguage(code: string) {
    setLanguage(code);
    localStorage.setItem("keak_language", code);
    // Keep web + desktop in sync: mirror a concrete language to profiles.language (best-effort).
    // "auto" stays desktop-only (the web has no auto option), so we skip the patch for it.
    if (code !== "auto" && session) {
      try {
        const uid = JSON.parse(atob(session.access_token.split(".")[1])).sub;
        fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ language: code }),
        }).catch(() => {});
      } catch {
        // best-effort sync
      }
    }
  }

  async function login() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.access_token) {
        // Store refresh_token so the overlay can renew the session (tokens expire after ~1h).
        const s: Session = { access_token: data.access_token, email, refresh_token: data.refresh_token };
        setSession(s);
        localStorage.setItem("keak_session", JSON.stringify(s));
        fetchProfile(data.access_token).finally(() => goToDashboard(s));
      } else {
        const msg = data.error_description || data.msg || data.error || "Sign-in failed";
        setError(msg === "Email not confirmed"
          ? "Confirm your email first, or ask us to turn off email confirmation."
          : msg);
      }
    } catch (e) {
      setError("Could not reach the server. Check your connection.");
    }
    setLoading(false);
  }

  async function signUp() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.access_token) {
        const s: Session = { access_token: data.access_token, email, refresh_token: data.refresh_token };
        setSession(s);
        localStorage.setItem("keak_session", JSON.stringify(s));
        fetchProfile(data.access_token).finally(() => goToDashboard(s));
      } else if (data.id || data.email) {
        setError("Account created! Check your email to confirm, then sign in.");
        setIsSignUp(false);
      } else {
        setError(data.error_description || data.msg || data.error || "Could not create account");
      }
    } catch (e) {
      setError("Could not reach the server. Check your connection.");
    }
    setLoading(false);
  }

  function logout() {
    localStorage.removeItem("keak_session");
    localStorage.removeItem("keak_default_style");
    localStorage.removeItem("keak_plan");
    setSession(null);
    setProfile(null);
  }

  const isPaid = ["starter", "pro", "team"].includes(profile?.plan ?? "free");

  return (
    <div className="main-window">
      <div className="main-header">
        <img src={isPaid ? keakLogoDark : keakLogo} className="main-logo-img" alt="Keak" />
        <span className="main-title">Keak</span>
        <span className="main-tagline">You talk, we write.</span>
      </div>

      {!session ? (
        <div className="card login-form">
          <h2>{isSignUp ? "Create account" : "Sign in"}</h2>
          <p className="hint">
            {isSignUp ? "Create a free Keak account." : "Use the same account as your Keak web dashboard."}
          </p>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (isSignUp ? signUp() : login())}
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (isSignUp ? signUp() : login())}
          />
          {error && <p className="error-msg">{error}</p>}
          <button onClick={isSignUp ? signUp : login} disabled={loading}>
            {loading ? (isSignUp ? "Creating account..." : "Signing in...") : (isSignUp ? "Create account" : "Sign in")}
          </button>
          <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>
            {isSignUp ? "Already have an account? " : "No account yet? "}
            <span
              style={{ textDecoration: "underline", cursor: "pointer" }}
              onClick={() => { setIsSignUp(!isSignUp); setError(""); }}
            >
              {isSignUp ? "Sign in" : "Create one"}
            </span>
          </p>
          <div className="divider"><span>or</span></div>
          <button className="google-btn" onClick={signInWithGoogle}>
            Sign in with Google
          </button>
        </div>
      ) : (
        <div className="account-view">
          <div className="card account-card">
            <p className="account-email">{session.email}</p>
            <p className="account-plan">
              {PLAN_LABELS[profile?.plan ?? "free"] ?? "Free"}
            </p>
            {profile && (
              <p className="account-usage">
                {profile.minutes_used_this_month} min used this month
              </p>
            )}
          </div>

          <div className="card shortcut-card">
            <p className="shortcut-label">Your shortcuts</p>
            <div className="shortcut-list">
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Win</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">Dictate</span>
                  <span className="shortcut-desc">Hold, speak, release. Your words appear.</span>
                </div>
              </div>
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Alt</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">Keak AI</span>
                  <span className="shortcut-desc">Hold and talk. Keak AI answers out loud.</span>
                </div>
              </div>
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Alt</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">Thought Dump</span>
                  <span className="shortcut-desc">Ramble freely. Keak organizes it.</span>
                </div>
              </div>
            </div>
            <p className="shortcut-hint">
              Works in any app on your computer. Hold to talk, let go to drop the text in.
            </p>
          </div>

          <div className="card altmode-card">
            <p className="shortcut-label">Ctrl + Alt does</p>
            <div className="seg">
              <button
                className={`seg-btn${altMode === "keak_ai" ? " seg-btn--on" : ""}`}
                onClick={() => chooseAltMode("keak_ai")}
              >
                Keak AI
              </button>
              <button
                className={`seg-btn${altMode === "thought_dump" ? " seg-btn--on" : ""}`}
                onClick={() => chooseAltMode("thought_dump")}
              >
                Thought Dump
              </button>
            </div>
            <p className="shortcut-hint">
              {altMode === "keak_ai"
                ? "Hold Ctrl+Alt to talk to your Keak AI assistant. It answers out loud."
                : "Hold Ctrl+Alt to ramble; Keak reorganizes it into clean text."}
            </p>
          </div>

          <div className="card altmode-card">
            <p className="shortcut-label">Language</p>
            <select
              className="lang-select"
              value={language}
              onChange={(e) => chooseLanguage(e.target.value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <p className="shortcut-hint">
              {language === "auto"
                ? "Keak detects your language automatically. Pick one to lock it in for best accuracy."
                : "Keak will transcribe and reply in this language. More languages coming soon."}
            </p>
          </div>

          <button className="logout-btn" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
