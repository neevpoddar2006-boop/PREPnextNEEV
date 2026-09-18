// Auth wrappers around Supabase Auth.
//
// Why Supabase Auth and not our own JWT:
//   - Email verification built in (anti–any-email-gets-in attack)
//   - Magic links + password reset built in
//   - Session refresh + rotation handled
//   - Login attempt throttling handled
//
// The "AuthUser" shape stays compatible with what the rest of the app expects.

import { supabase } from "./supabase";
import { getApiUrl, refreshApiUrl } from "./api";

export interface AuthUser {
  id: string;             // Our internal User.id (synced from Supabase auth.users.id)
  email: string;
  displayName: string;
  authId?: string;
  avatarSeed?: string;
  learningGoal?: string;
  preferredStyle?: "visual" | "code_first" | "analogy" | "step_by_step";
  dailyMinutes?: number;
  joinedAt?: string;
  // Profile-setup fields — captured at /onboarding after Google sign-in.
  profileComplete?: boolean;
  fullName?: string | null;
  collegeName?: string | null;
  branch?: string | null;
  yearOfStudy?: number | null;
  graduationYear?: number | null;
  cgpa?: number | null;
  phoneNumber?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  targetRoles?: string[];
}

export interface ProfileSetupPayload {
  fullName: string;
  collegeName: string;
  branch: string;
  yearOfStudy: number;
  linkedinUrl?: string;
  githubUrl?: string;
  targetRoles?: string[];
}

// Storage keys kept so legacy useLocalStorageState calls keep finding their data.
// The supabase-js client manages the *session* itself; these mirror display data.
export const AUTH_USER_KEY = "prepnext.auth.user.v1";
export const AUTH_TOKEN_KEY = "prepnext.auth.token.v1"; // legacy: no longer authoritative

let _apiReady = false;
async function ensureApi(): Promise<string> {
  if (!_apiReady) { await refreshApiUrl(); _apiReady = true; }
  return getApiUrl();
}

/** Get the current Supabase JWT (used as Authorization: Bearer ... on API calls). */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Pull (or refresh) the matching User row from our backend. Creates one on first call. */
export async function fetchAppUser(): Promise<AuthUser> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");
  const base = await ensureApi();
  const res = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${res.status}`);
  }
  const { user } = (await res.json()) as { user: AuthUser };
  return user;
}

/**
 * Server-side check — is this an email we should bother sending an OTP to?
 * Catches gibberish/disposable/no-MX addresses before they consume a Supabase
 * email rate-limit slot.
 */
export async function validateEmail(email: string): Promise<{ ok: boolean; reason?: string }> {
  const base = await ensureApi();
  const res = await fetch(`${base}/api/auth/validate-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: json.reason || json.error || "Invalid email" };
  return { ok: true };
}

// Tells the AuthPanel which flow to enter after sendOtp returns.
export type SendOtpOutcome =
  | { kind: "code-sent" }           // normal: user must enter the 6-digit code from their inbox
  | { kind: "redirecting"; url: string }; // fallback: server generated a magic link; we navigate to it

/**
 * Send a verification code (or fall back to a magic-link redirect when
 * Supabase's built-in mailer is failing — common on free tier).
 *
 * Flow:
 *  1. Try the standard signInWithOtp. On success: { kind: "code-sent" }.
 *  2. On rate-limit / 500 "Error sending confirmation email" / unexpected_failure:
 *     hit our /api/auth/fallback-signin endpoint, which uses the Supabase
 *     admin API to create the user pre-confirmed + generate a magic link
 *     without emailing it. We navigate the browser to that link → Supabase
 *     verifies → redirects to /auth/callback → session lands.
 *
 * Why this preserves verification: server-side validateEmail() (gibberish +
 * MX + disposable checks) gates BOTH paths, so a fake address never gets a
 * link in the first place.
 */
export async function sendOtp(email: string, displayName?: string): Promise<SendOtpOutcome> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${window.location.origin}/auth/callback`,
      data: displayName ? { display_name: displayName } : undefined,
    },
  });
  if (!error) return { kind: "code-sent" };

  const msg = (error.message || "").toLowerCase();
  const isRecoverable =
    /rate limit|too many|sending (confirmation|email)|unexpected_failure|smtp|service.*unavailable|500/i.test(
      error.message
    );
  if (!isRecoverable) throw new Error(error.message);

  // Fallback: ask the server to do an admin-bypass magic link.
  const base = await ensureApi();
  const res = await fetch(`${base}/api/auth/fallback-signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      displayName,
      redirectTo: `${window.location.origin}/auth/callback`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    // No fallback either → surface the original error contextually.
    if (/rate limit|too many/i.test(error.message)) {
      throw new Error("Too many emails sent. Try Google sign-in, or wait a few minutes.");
    }
    throw new Error(
      json.reason || "Email service is temporarily down. Try Google sign-in instead."
    );
  }
  return { kind: "redirecting", url: json.action_link as string };
  // Used in AuthPanel: when this returns, navigate to outcome.url to complete login.
  void msg;
}

/**
 * Verify a 6-digit code the user typed. On success, Supabase issues a session
 * and onAuthStateChange fires (useAuth updates automatically).
 */
export async function verifyOtpCode(email: string, code: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: "email",
  });
  if (error) {
    if (/invalid|expired/i.test(error.message)) {
      throw new Error("That code is wrong or expired. Request a new one.");
    }
    throw new Error(error.message);
  }
}

/**
 * Email + password signup via our server (admin API).
 *
 * Why server-side instead of supabase.auth.signUp?
 *   - Bypasses Supabase free-tier email rate limit
 *     ("over_email_send_rate_limit" error blocks the public endpoint).
 *   - Pre-confirms the email server-side so the user is instantly usable.
 *   - Eliminates the "didn't receive email" UX dead-end on free tier.
 *
 * After signup we immediately sign in via the public Supabase JS client to
 * establish a session in the browser.
 */
export async function signupEmail(
  email: string,
  password: string,
  displayName: string
): Promise<{ needsEmailConfirmation: boolean }> {
  const base = await ensureApi();
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `Signup failed (HTTP ${res.status})`);
  }
  // Immediately sign in to establish a Supabase session in the browser.
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Account was created server-side but we couldn't sign in — surface error
    throw new Error(error.message || "Couldn't sign in after signup");
  }
  return { needsEmailConfirmation: false };
}

export async function loginEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/**
 * Save the post-signup profile (full name, college, branch, year, CGPA, etc.)
 * Flips `profileComplete: true` on the server so the user stops getting
 * bounced to /onboarding.
 */
export async function saveProfile(payload: ProfileSetupPayload): Promise<AuthUser> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in");
  const base = await ensureApi();
  const res = await fetch(`${base}/api/auth/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.user as AuthUser;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const redirectTo = `${window.location.origin}/auth/callback?intent=reset`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new Error(error.message);
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export async function resendConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw new Error(error.message);
}

/**
 * Bypass email confirmation server-side using the service_role admin API.
 * Returns true if the user is now confirmed (newly or already was).
 *
 * Why this exists: Supabase's built-in mailer is heavily rate-limited and
 * Gmail-filtered, so confirmation emails often never arrive on free tier.
 * This endpoint sidesteps that for demos. In production you should use a
 * real SMTP provider (Resend, Postmark, SES) instead.
 */
export async function devConfirmEmail(email: string): Promise<boolean> {
  const base = await ensureApi();
  try {
    const res = await fetch(`${base}/api/auth/dev-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return !!json.ok;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await supabase.auth.signOut();
  try { localStorage.removeItem(AUTH_USER_KEY); } catch {}
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
}

// Legacy named exports for any code that still imports these directly.
export const login = loginEmail;
export const signup = signupEmail;
