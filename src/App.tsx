import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import keakLogo from "./assets/icon_keak_2.png";
import keakLogoDark from "./assets/icon_keak_2.png";
import { useUiLang } from "./i18n";
import "./App.css";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "https://c--8d6c4aab-d6cd-4281-ad41-da14196d68fc-prod.lovable.cloud") as string;
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_GjF5OPvQRDcdLyuiFGroOg_FiyrnhjN") as string;

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
  { code: "ca", label: "Català" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
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
  const [, , t] = useUiLang();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [altMode, setAltMode] = useState<string>(() => localStorage.getItem("keak_alt_mode") || "keak_ai");
  const [actionMode, setActionMode] = useState<string>(() => localStorage.getItem("keak_action_mode") || "ask");
  const [showCaptions, setShowCaptions] = useState<boolean>(() => localStorage.getItem("keak_show_captions") !== "0");
  const [language, setLanguage] = useState<string>(() => localStorage.getItem("keak_language") || "auto");
  // "Connect your AI" — which model powers screen control (TARS), and the per-provider credential.
  // Claude + OpenAI connect through the user's SUBSCRIPTION (no per-call cost); Gemini uses a key.
  const [cuProvider, setCuProvider] = useState<string>(() => localStorage.getItem("keak_cu_provider") || "claude");
  const [claudeToken, setClaudeToken] = useState<string>(() => localStorage.getItem("keak_cu_claude_token") || "");
  const [openaiKey, setOpenaiKey] = useState<string>(() => localStorage.getItem("keak_cu_openai_key") || "");
  // Set by the ChatGPT device-login flow; read here so a connected subscription shows as connected.
  const [openaiToken, setOpenaiToken] = useState<string>(() => localStorage.getItem("keak_cu_openai_token") || "");
  const [openaiUserCode, setOpenaiUserCode] = useState<string>("");
  const [geminiKey, setGeminiKey] = useState<string>(() => localStorage.getItem("keak_cu_gemini_key") || "");
  const [connectMsg, setConnectMsg] = useState<string>("");

  useEffect(() => {
    // Request mic permission in the main (visible, decorated) window so WebView2 can show the dialog.
    // Once granted here, the overlay window (same tauri://localhost origin) inherits it silently.
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(s => s.getTracks().forEach(t => t.stop()))
      .catch(() => {});

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
        // Dictation (Ctrl+Win) gating for the overlay: minutes used + the plan's allowance (all in seconds;
        // -1 = unlimited). Paid plans dictate freely; free/lapsed plans get the free taste, then it locks.
        localStorage.setItem("keak_dictation_used", String(Math.round(Number(data[0].dictation_used) || 0)));
        localStorage.setItem("keak_dictation_extra", String(Math.round(Number(data[0].dictation_extra) || 0)));
        const DICT_LIMITS: Record<string, number> = { free: 900, starter: 10800, plus: 10800, pro: -1, team: -1 };
        localStorage.setItem("keak_dictation_limit", String(DICT_LIMITS[plan] ?? 900));
        // Personalization bridge for the overlay window (Keak AI greets you by name).
        localStorage.setItem("keak_user_name", data[0].full_name || "there");
        // Voice choice for Keak AI (female/male), read by the overlay when calling keak-tts.
        localStorage.setItem("keak_voice_gender", data[0].voice_gender || "female");
        // Screen-vision permission (allow/disallow), read by the overlay before screenshotting.
        localStorage.setItem("keak_screen_vision_allowed", data[0].ai_screen_vision ? "1" : "0");
        if (!localStorage.getItem("keak_assistant_name")) {
          localStorage.setItem("keak_assistant_name", "Keak");
        }
        // Ctrl+Alt = Keak AI for EVERYONE by default. Keak AI runs on the user's own connected AI, so there's
        // no reason to gate it behind a paid plan. (The old build defaulted free plans to Thought Dump, which
        // made Ctrl+Alt just write text like Ctrl+Win instead of opening the voice assistant.)
        if (!localStorage.getItem("keak_alt_mode")) {
          localStorage.setItem("keak_alt_mode", "keak_ai");
          setAltMode("keak_ai");
        } else if (
          localStorage.getItem("keak_alt_mode") === "thought_dump" &&
          !localStorage.getItem("keak_alt_migrated_v2")
        ) {
          // One-time migration: fix the free installs that were auto-set to Thought Dump by the old default.
          localStorage.setItem("keak_alt_mode", "keak_ai");
          setAltMode("keak_ai");
        }
        localStorage.setItem("keak_alt_migrated_v2", "1");
      }
    }
  }

  function chooseAltMode(mode: string) {
    setAltMode(mode);
    localStorage.setItem("keak_alt_mode", mode);
  }

  function chooseActionMode(mode: string) {
    setActionMode(mode);
    localStorage.setItem("keak_action_mode", mode);
  }

  function toggleCaptions() {
    const next = !showCaptions;
    setShowCaptions(next);
    localStorage.setItem("keak_show_captions", next ? "1" : "0");
  }

  function chooseCuProvider(p: string) {
    setCuProvider(p);
    localStorage.setItem("keak_cu_provider", p);
    setConnectMsg("");
  }
  function saveClaudeToken() {
    localStorage.setItem("keak_cu_claude_token", claudeToken.trim());
    setConnectMsg(claudeToken.trim() ? "Claude connected." : "Cleared.");
  }
  function saveOpenaiKey() {
    localStorage.setItem("keak_cu_openai_key", openaiKey.trim());
    setConnectMsg(openaiKey.trim() ? "OpenAI key saved." : "Cleared.");
  }
  function saveGeminiKey() {
    localStorage.setItem("keak_cu_gemini_key", geminiKey.trim());
    setConnectMsg(geminiKey.trim() ? "Gemini connected." : "Cleared.");
  }
  async function copySetupCmd() {
    try { await navigator.clipboard.writeText("claude setup-token"); setConnectMsg("Copied. Paste it in a terminal, then paste the token back here."); }
    catch { setConnectMsg("Run this in a terminal: claude setup-token"); }
  }
  // "Sign in with ChatGPT" — device-authorization flow. Ask Rust for a device+user code, open the
  // verification page, show the code, then poll until the user authorizes and store the subscription token.
  async function startOpenAiLogin() {
    setOpenaiUserCode("");
    setConnectMsg("Opening ChatGPT sign-in...");
    let d: { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; interval?: number };
    try {
      d = JSON.parse(await invoke<string>("openai_login_start"));
    } catch (e) {
      setConnectMsg(`Couldn't start ChatGPT sign-in (${e}). You can paste an OpenAI API key instead.`);
      return;
    }
    const deviceCode = d.device_code || "";
    const code = d.user_code || "";
    const uri = d.verification_uri_complete || d.verification_uri || "";
    if (!deviceCode) { setConnectMsg("ChatGPT sign-in didn't return a code. Try again."); return; }
    setOpenaiUserCode(code);
    if (uri) { try { await invoke("open_url", { url: uri }); } catch { /* user can still type the code */ } }
    setConnectMsg("Waiting for you to authorize in the browser...");
    const intervalMs = Math.max(2, d.interval || 5) * 1000;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        window.clearInterval(timer); setOpenaiUserCode(""); setConnectMsg("Sign-in timed out. Try again.");
        return;
      }
      let r: { ok?: boolean; pending?: boolean; access_token?: string; refresh_token?: string; account_id?: string };
      try {
        r = JSON.parse(await invoke<string>("openai_login_poll", { deviceCode }));
      } catch (e) {
        window.clearInterval(timer); setOpenaiUserCode(""); setConnectMsg(`Sign-in failed: ${e}`);
        return;
      }
      if (r.ok && r.access_token) {
        window.clearInterval(timer);
        localStorage.setItem("keak_cu_openai_token", r.access_token);
        localStorage.setItem("keak_cu_openai_refresh", r.refresh_token || "");
        localStorage.setItem("keak_cu_openai_account", r.account_id || "");
        localStorage.setItem("keak_cu_provider", "openai");
        setOpenaiToken(r.access_token);
        setCuProvider("openai");
        setOpenaiUserCode("");
        setConnectMsg("ChatGPT connected. Your subscription now powers screen control.");
      }
    }, intervalMs);
  }
  const cuConnected =
    cuProvider === "claude" ? !!claudeToken.trim()
    : cuProvider === "openai" ? !!(openaiKey.trim() || openaiToken.trim())
    : !!geminiKey.trim();

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
        <span className="main-tagline">{t("You talk, we write.")}</span>
      </div>

      {!session ? (
        <div className="card login-form">
          <h2>{isSignUp ? t("Create account") : t("Sign in")}</h2>
          <p className="hint">
            {isSignUp ? t("Create a free Keak account.") : t("Use the same account as your Keak web dashboard.")}
          </p>
          <input
            type="email"
            placeholder={t("Email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (isSignUp ? signUp() : login())}
            autoFocus
          />
          <input
            type="password"
            placeholder={t("Password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (isSignUp ? signUp() : login())}
          />
          {error && <p className="error-msg">{error}</p>}
          <button onClick={isSignUp ? signUp : login} disabled={loading}>
            {loading ? (isSignUp ? t("Creating account...") : t("Signing in...")) : (isSignUp ? t("Create account") : t("Sign in"))}
          </button>
          <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>
            {isSignUp ? t("Already have an account? ") : t("No account yet? ")}
            <span
              style={{ textDecoration: "underline", cursor: "pointer" }}
              onClick={() => { setIsSignUp(!isSignUp); setError(""); }}
            >
              {isSignUp ? t("Sign in") : t("Create one")}
            </span>
          </p>
          <div className="divider"><span>{t("or")}</span></div>
          <button className="google-btn" onClick={signInWithGoogle}>
            {t("Sign in with Google")}
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
            <p className="shortcut-label">{t("Your shortcuts")}</p>
            <div className="shortcut-list">
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Win</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">{t("Dictate")}</span>
                  <span className="shortcut-desc">{t("Hold, speak, release. Your words appear.")}</span>
                </div>
              </div>
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Alt</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">Keak AI</span>
                  <span className="shortcut-desc">{t("Hold and talk. Keak AI answers out loud.")}</span>
                </div>
              </div>
              <div className="shortcut-item">
                <div className="shortcut-keys">
                  <kbd>Ctrl</kbd><span className="plus">+</span><kbd>Alt</kbd>
                </div>
                <div className="shortcut-meta">
                  <span className="shortcut-name">{t("Thought Dump")}</span>
                  <span className="shortcut-desc">{t("Ramble freely. Keak organizes it.")}</span>
                </div>
              </div>
            </div>
            <p className="shortcut-hint">
              {t("Works in any app on your computer. Hold to talk, let go to drop the text in.")}
            </p>
          </div>

          <div className="card altmode-card">
            <p className="shortcut-label">{t("Ctrl + Alt does")}</p>
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
                {t("Thought Dump")}
              </button>
            </div>
            <p className="shortcut-hint">
              {altMode === "keak_ai"
                ? t("Hold Ctrl+Alt to talk to your Keak AI assistant. It answers out loud.")
                : t("Hold Ctrl+Alt to ramble; Keak reorganizes it into clean text.")}
            </p>
          </div>

          <div className="card altmode-card">
            <p className="shortcut-label">{t("When Keak does an action")}</p>
            <div className="seg">
              <button
                className={`seg-btn${actionMode === "full" ? " seg-btn--on" : ""}`}
                onClick={() => chooseActionMode("full")}
              >
                {t("Full access")}
              </button>
              <button
                className={`seg-btn${actionMode === "ask" ? " seg-btn--on" : ""}`}
                onClick={() => chooseActionMode("ask")}
              >
                {t("Ask first")}
              </button>
              <button
                className={`seg-btn${actionMode === "off" ? " seg-btn--on" : ""}`}
                onClick={() => chooseActionMode("off")}
              >
                {t("Off")}
              </button>
            </div>
            <p className="shortcut-hint">
              {actionMode === "full"
                ? t("Keak finishes the job. It saves the calendar event and sends the reply on its own.")
                : actionMode === "ask"
                ? t("Keak sets everything up (the event, the draft reply) and leaves the final click to you.")
                : t("Keak only talks and dictates. It won't create events or draft replies for you.")}
            </p>
          </div>

          <div className="card altmode-card">
            <p className="shortcut-label">{t("Show captions")}</p>
            <div className="seg">
              <button
                className={`seg-btn${showCaptions ? " seg-btn--on" : ""}`}
                onClick={() => { if (!showCaptions) toggleCaptions(); }}
              >
                {t("On")}
              </button>
              <button
                className={`seg-btn${!showCaptions ? " seg-btn--on" : ""}`}
                onClick={() => { if (showCaptions) toggleCaptions(); }}
              >
                {t("Off")}
              </button>
            </div>
            <p className="shortcut-hint">
              {showCaptions
                ? t("When Keak talks, the words show under the orb. Turn off to just hear it.")
                : t("Keak talks out loud but won't print the words on screen.")}
            </p>
          </div>

          <div className="card altmode-card cu-card">
            <p className="shortcut-label">
              Connect your AI{cuConnected && <span className="cu-ok"> · connected</span>}
            </p>
            <p className="shortcut-hint cu-lead">
              Powers screen control. Keak uses your own AI, so there's no extra cost per action.
            </p>
            <div className="seg">
              <button
                className={`seg-btn${cuProvider === "claude" ? " seg-btn--on" : ""}`}
                onClick={() => chooseCuProvider("claude")}
              >
                Claude
              </button>
              <button
                className={`seg-btn${cuProvider === "openai" ? " seg-btn--on" : ""}`}
                onClick={() => chooseCuProvider("openai")}
              >
                OpenAI
              </button>
              <button
                className={`seg-btn${cuProvider === "gemini" ? " seg-btn--on" : ""}`}
                onClick={() => chooseCuProvider("gemini")}
              >
                Gemini
              </button>
            </div>

            {cuProvider === "claude" && (
              <div className="cu-body">
                <p className="cu-step">
                  Use your Claude subscription. Run this in a terminal, sign in, then paste the token it gives you.
                </p>
                <div className="cu-cmd">
                  <code>claude setup-token</code>
                  <button className="cu-copy" onClick={copySetupCmd}>Copy</button>
                </div>
                <input
                  className="cu-input"
                  type="password"
                  placeholder="Paste your Claude token"
                  value={claudeToken}
                  onChange={(e) => setClaudeToken(e.target.value)}
                />
                <button className="cu-save" onClick={saveClaudeToken}>Save</button>
              </div>
            )}

            {cuProvider === "openai" && (
              <div className="cu-body">
                <button className="cu-oauth" onClick={startOpenAiLogin}>Sign in with ChatGPT</button>
                {openaiUserCode && (
                  <div className="cu-code">
                    <span className="cu-code-label">Enter this code at ChatGPT</span>
                    <span className="cu-code-value">{openaiUserCode}</span>
                  </div>
                )}
                <p className="cu-step">Use your ChatGPT subscription, or paste an OpenAI API key instead.</p>
                <input
                  className="cu-input"
                  type="password"
                  placeholder="OpenAI API key (optional)"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                />
                <button className="cu-save" onClick={saveOpenaiKey}>Save key</button>
              </div>
            )}

            {cuProvider === "gemini" && (
              <div className="cu-body">
                <p className="cu-step">Paste a Google AI Studio key (aistudio.google.com/apikey).</p>
                <input
                  className="cu-input"
                  type="password"
                  placeholder="Gemini API key"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                />
                <button className="cu-save" onClick={saveGeminiKey}>Save key</button>
              </div>
            )}

            {connectMsg && <p className="cu-msg">{connectMsg}</p>}
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
