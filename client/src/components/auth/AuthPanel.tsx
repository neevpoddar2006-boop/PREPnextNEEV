import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { LogOut, ArrowRight, Loader2, Mail, Lock, User } from "lucide-react";
import { Button } from "../ui/Button";
import { useAuth } from "../../hooks/useAuth";
import { requestPasswordReset } from "../../lib/auth";

const shell =
  "w-full max-w-md rounded-3xl border border-[var(--color-line)] bg-[var(--color-card-soft)] backdrop-blur-2xl p-6 sm:p-7 shadow-[0_8px_50px_rgba(0,0,0,0.45)] ring-1 ring-[var(--color-neon)]/10";
const inputCls =
  "w-full mt-1 bg-[var(--color-input)] border border-[var(--color-line)] rounded-xl px-3.5 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none focus:border-[var(--color-neon)] focus:bg-[var(--color-input-strong)] transition-colors";
const labelCls = "text-[11px] uppercase tracking-widest text-[var(--color-text-faint)] mono flex items-center gap-1.5";

interface AuthPanelProps {
  redirectTo?: string;
}

type Mode = "login" | "signup" | "forgot";

// Auth surface — email + password.
//
// New users sign up with name/email/password (created pre-confirmed
// server-side via /api/auth/signup, no email delivery required); returning
// users sign in with email/password. "Forgot password" sends a reset link
// through Supabase, landing back on /auth/callback?intent=reset.
export function AuthPanel({ redirectTo }: AuthPanelProps = {}) {
  const { isAuthenticated, user, logout, login, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dest = redirectTo || (location.state as { from?: string } | null)?.from || "/dashboard";

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [didAuth, setDidAuth] = useState(false);
  useEffect(() => {
    if (isAuthenticated && didAuth) {
      navigate(dest, { replace: true });
    }
  }, [isAuthenticated, didAuth, dest, navigate]);

  // Signed-in state: show a welcome-back card with log-out.
  if (isAuthenticated && user) {
    return (
      <div className={shell}>
        <div className="mono text-xs uppercase tracking-[0.3em] text-[var(--color-neon)] mb-2">· signed in ·</div>
        <div className="display text-2xl">Welcome back, {user.displayName}.</div>
        <div className="text-[var(--color-text-faint)] text-sm mt-1">{user.email}</div>
        <div className="flex flex-wrap gap-3 mt-6">
          <Button onClick={() => navigate(dest, { replace: true })}>
            Go to dashboard <ArrowRight className="w-4 h-4" />
          </Button>
          <Button variant="ghost" onClick={logout}>
            <LogOut className="w-4 h-4" /> Log out
          </Button>
        </div>
      </div>
    );
  }

  const resetMessages = () => { setError(null); setInfo(null); };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    resetMessages();
    const cleanedEmail = email.trim().toLowerCase();
    if (!cleanedEmail) return setError("Enter your email.");

    if (mode === "forgot") {
      setBusy(true);
      try {
        await requestPasswordReset(cleanedEmail);
        setInfo("If an account exists for that email, a reset link is on its way.");
      } catch (err: any) {
        setError(err?.message || "Couldn't send reset email.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (mode === "signup" && !displayName.trim()) return setError("Enter your name.");

    setBusy(true);
    setDidAuth(true);
    try {
      if (mode === "signup") {
        await signup(cleanedEmail, password, displayName.trim());
      } else {
        await login(cleanedEmail, password);
      }
      // Redirect handled by the effect above once isAuthenticated flips.
    } catch (err: any) {
      setError(err?.message || (mode === "signup" ? "Couldn't create account." : "Sign-in failed."));
      setBusy(false);
      setDidAuth(false);
    }
  };

  const switchMode = (m: Mode) => {
    resetMessages();
    setMode(m);
  };

  return (
    <div className={shell}>
      <div className="mono text-xs uppercase tracking-[0.3em] text-[var(--color-neon)] mb-2">
        · {mode === "signup" ? "create account" : mode === "forgot" ? "reset password" : "sign in"} ·
      </div>
      <div className="display text-2xl">
        {mode === "signup" ? "Join PrepNext." : mode === "forgot" ? "Forgot your password?" : "Welcome back."}
      </div>
      <p className="text-[var(--color-text-dim)] text-sm mt-2">
        {mode === "signup"
          ? "Create an account with your email and a password."
          : mode === "forgot"
          ? "Enter your email and we'll send you a reset link."
          : "Sign in with your email and password."}
      </p>

      <form onSubmit={onSubmit} className="space-y-4 mt-6">
        {mode === "signup" && (
          <div>
            <label className={labelCls} htmlFor="auth-name">
              <User className="w-3 h-3" /> Full name
            </label>
            <input
              id="auth-name"
              className={inputCls}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Aarav Sharma"
              autoComplete="name"
              maxLength={80}
              required
            />
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="auth-email">
            <Mail className="w-3 h-3" /> Email
          </label>
          <input
            id="auth-email"
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@college.edu"
            autoComplete="email"
            maxLength={200}
            required
          />
        </div>

        {mode !== "forgot" && (
          <div>
            <label className={labelCls} htmlFor="auth-password">
              <Lock className="w-3 h-3" /> Password
            </label>
            <input
              id="auth-password"
              type="password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={8}
              maxLength={200}
              required
            />
          </div>
        )}

        {error && (
          <div className="text-[#ff5247] text-sm" role="alert">
            {error}
          </div>
        )}
        {info && <div className="text-[var(--color-neon-text)] text-xs">{info}</div>}

        <Button type="submit" fullWidth disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {mode === "signup" ? "Creating account…" : mode === "forgot" ? "Sending…" : "Signing in…"}
            </>
          ) : mode === "signup" ? (
            "Create account"
          ) : mode === "forgot" ? (
            "Send reset link"
          ) : (
            "Sign in"
          )}
        </Button>
      </form>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs">
        {mode === "login" && (
          <>
            <button
              type="button"
              className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              onClick={() => switchMode("forgot")}
            >
              Forgot password?
            </button>
            <button
              type="button"
              className="text-[var(--color-neon)] hover:underline"
              onClick={() => switchMode("signup")}
            >
              New here? Create an account →
            </button>
          </>
        )}
        {mode === "signup" && (
          <button
            type="button"
            className="text-[var(--color-neon)] hover:underline"
            onClick={() => switchMode("login")}
          >
            Already have an account? Sign in →
          </button>
        )}
        {mode === "forgot" && (
          <button
            type="button"
            className="text-[var(--color-neon)] hover:underline"
            onClick={() => switchMode("login")}
          >
            ← Back to sign in
          </button>
        )}
      </div>
    </div>
  );
}
