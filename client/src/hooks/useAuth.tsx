// Auth state powered by Supabase Auth — exposed through a single shared
// React Context so the WHOLE app has exactly ONE source of truth.
//
// Why a provider (and not a bare hook):
//   Previously `useAuth()` was a plain hook holding its own state + its own
//   `onAuthStateChange` subscription + its own `/api/auth/me` fetch. Because it
//   was called from 6 components (RequireAuth, Nav, MobileTabBar, Dashboard,
//   AuthPanel, Onboarding), a single protected page mounted ~4 independent
//   copies. Each copy:
//     • fetched /api/auth/me on mount, and
//     • installed its own auth listener that re-fetched /api/auth/me on EVERY
//       auth event (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED).
//   Result on login: ~8–12 concurrent duplicate /me calls, each triggering a
//   server-side Supabase getUser() round-trip + a User-row upsert racing on the
//   unique constraint — i.e. the slow, flaky "finishing sign-in" the incident
//   describes.
//
// Now: one <AuthProvider> subscribes once, fetches /me once (with in-flight
// dedup), and every `useAuth()` consumer reads the same state via context.
//
// Behavior preserved from the old hook:
//   - `isAuthenticated` depends ONLY on token presence, so a slow /me never
//     traps a logged-in user in a redirect loop.
//   - Initial state is primed synchronously from Supabase's localStorage key so
//     RequireAuth doesn't flash-redirect a logged-in user on hard refresh.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase, SUPABASE_CONFIGURED } from "../lib/supabase";
import {
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  fetchAppUser,
  loginEmail,
  signupEmail,
  devConfirmEmail,
  logout as apiLogout,
  type AuthUser,
} from "../lib/auth";

const SUPA_STORAGE_KEY = "prepnext.supabase.auth.v1";

// No-backend preview mode: whenever Supabase isn't really configured yet
// (VITE_SUPABASE_URL/ANON_KEY missing — true on a fresh checkout AND on a
// prod deploy before real credentials are added), skip Supabase entirely and
// act as a permanently signed-in preview user instead of crashing. This is
// what let the app render at all before a database existed; it turns itself
// off automatically the moment real Supabase credentials are set, in any
// environment. Can also be forced on locally via VITE_AUTH_BYPASS=true.
const AUTH_BYPASS = !SUPABASE_CONFIGURED || import.meta.env.VITE_AUTH_BYPASS === "true";
const BYPASS_TOKEN = "preview-mode-token";
const BYPASS_USER: AuthUser = {
  id: "preview-user",
  email: "preview@prepnext.local",
  displayName: "Preview User",
  profileComplete: true,
  fullName: "Preview User",
  collegeName: "Preview Mode",
  branch: "CSE",
  yearOfStudy: 3,
  targetRoles: ["SDE"],
};

/** Read the token synchronously from Supabase's localStorage (set by supabase-js). */
function readInitialToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SUPA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const tok: string | undefined = parsed?.access_token || parsed?.currentSession?.access_token;
    if (!tok) return null;
    // Check expiry if present
    const exp: number | undefined = parsed?.expires_at || parsed?.currentSession?.expires_at;
    if (exp && exp * 1000 < Date.now()) return null;
    return tok;
  } catch {
    return null;
  }
}

function readInitialUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch { return null; }
}

export interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  signup: (email: string, password: string, displayName: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refetch: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Single owner of auth state. Mount ONCE, high in the tree (App.tsx).
 * Subscribes to Supabase auth exactly once and fetches the app user exactly
 * once per sign-in (concurrent calls are deduped).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Prime from localStorage so the first render already reflects a logged-in user.
  const [token, setToken] = useState<string | null>(() => (AUTH_BYPASS ? BYPASS_TOKEN : readInitialToken()));
  const [user, setUser] = useState<AuthUser | null>(() => (AUTH_BYPASS ? BYPASS_USER : readInitialUser()));
  const [loading, setLoading] = useState<boolean>(() => (AUTH_BYPASS ? false : !readInitialToken()));

  // Mirror `user` into a ref so the auth listener can read the latest value
  // without re-subscribing (keeps the subscription stable for the app's life).
  const userRef = useRef<AuthUser | null>(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // Dedup /api/auth/me: while a fetch is in flight, every caller shares the
  // same promise instead of firing its own request. This is what collapses the
  // login-time request storm down to a single /me.
  const inflightRef = useRef<Promise<AuthUser | null> | null>(null);
  const loadUser = useCallback(async (): Promise<AuthUser | null> => {
    if (inflightRef.current) return inflightRef.current;
    const p = (async () => {
      try {
        const u = await fetchAppUser();
        setUser(u);
        userRef.current = u;
        try { window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u)); } catch {}
        return u;
      } catch (e) {
        // Don't clear the token on a transient /me failure — the user stays
        // logged in (isAuthenticated tracks the token) and can retry.
        console.warn("[auth] fetchAppUser failed:", (e as Error)?.message);
        return null;
      } finally {
        inflightRef.current = null;
      }
    })();
    inflightRef.current = p;
    return p;
  }, []);

  // One subscription for the whole app: cold-start hydration + login/logout/
  // refresh from any tab. onAuthStateChange fires INITIAL_SESSION immediately
  // on subscribe, which covers the cold-start case (no separate getSession()).
  useEffect(() => {
    if (AUTH_BYPASS) return;
    let active = true;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      const t = session?.access_token ?? null;
      setToken(t);
      try { window.localStorage.setItem(AUTH_TOKEN_KEY, t || ""); } catch {}

      if (!t) {
        setUser(null);
        userRef.current = null;
        try { window.localStorage.removeItem(AUTH_USER_KEY); } catch {}
        setLoading(false);
        return;
      }

      // Only (re)fetch the app user when it's a genuine sign-in or we don't
      // have one yet. A bare TOKEN_REFRESHED (hourly) rotates the JWT but the
      // user row is unchanged — no need to hit /me again.
      if (event === "SIGNED_IN" || !userRef.current) {
        void loadUser();
      }
      setLoading(false);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadUser]);

  const login = useCallback(async (email: string, password: string) => {
    if (AUTH_BYPASS) return BYPASS_USER;
    await loginEmail(email, password);
    const u = await loadUser();
    return (u ?? (null as unknown as AuthUser));
  }, [loadUser]);

  /**
   * Sign up + immediately bring the user in.
   * Server creates the user via admin API (no email sent, no rate limit),
   * then we sign in to establish a Supabase session.
   */
  const signup = useCallback(async (email: string, password: string, displayName: string) => {
    if (AUTH_BYPASS) return BYPASS_USER;
    const { needsEmailConfirmation } = await signupEmail(email, password, displayName);

    if (!needsEmailConfirmation) {
      const u = await loadUser();
      return (u ?? (null as unknown as AuthUser));
    }

    // Server-side admin signup should never set needsEmailConfirmation, but if
    // something falls through, try dev-confirm + login as a safety net.
    const confirmed = await devConfirmEmail(email);
    if (confirmed) {
      try {
        await loginEmail(email, password);
        const u = await loadUser();
        if (u) return u;
      } catch { /* fall through */ }
    }
    return { id: "", email, displayName, emailVerified: false } as AuthUser;
  }, [loadUser]);

  const logout = useCallback(async () => {
    if (AUTH_BYPASS) return; // permanently "signed in" in this mode
    await apiLogout();
    setToken(null);
    setUser(null);
    userRef.current = null;
  }, []);

  // Force a fresh /api/auth/me — used after profile-setup so the UI immediately
  // reflects the new profileComplete + fullName without a hard reload. Bypasses
  // the "already have a user" short-circuit by clearing the dedup slot first.
  const refetch = useCallback(async () => {
    if (AUTH_BYPASS) return BYPASS_USER;
    if (!token) return null;
    inflightRef.current = null;
    return loadUser();
  }, [token, loadUser]);

  const value = useMemo<AuthContextValue>(() => ({
    token,
    user,
    isAuthenticated: Boolean(token),
    loading,
    login,
    signup,
    logout,
    refetch,
  }), [token, user, loading, login, signup, logout, refetch]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Read the shared auth state. Must be used under <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within <AuthProvider>. Wrap the app in App.tsx.");
  }
  return ctx;
}
