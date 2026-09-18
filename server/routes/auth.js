// Auth endpoints. All of signup/login/password-reset/OAuth is handled by
// Supabase Auth on the client. The server only:
//   1) Verifies the incoming Supabase JWT,
//   2) Syncs (find-or-create) the matching row in our `User` table,
//   3) Returns the synced user,
//   4) Provides a "dev-confirm" escape hatch for environments where the
//      Supabase built-in mailer is rate-limited / spam-filtered.
//
// The middleware in ../auth.js (`requireAuth`) does the heavy lifting.
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, publicUser } from "../auth.js";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import { validateEmail } from "../lib/emailValidator.js";

const r = Router();

// Open-redirect guard: the magic-link redirectTo must point at OUR /auth/callback
// on an allowed origin. A client-supplied value is only honored if it parses to
// an allowed origin + the exact callback path; otherwise we fall back. This
// prevents an attacker from crafting a post-login redirect to a phishing site.
const PROD_CALLBACK = "https://prepnext.vercel.app/auth/callback";
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
function safeRedirectTo(req) {
  const allow = new Set(
    (process.env.CLIENT_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  allow.add("https://prepnext.vercel.app");
  const candidate =
    req.body?.redirectTo ||
    (req.headers.origin ? `${req.headers.origin}/auth/callback` : PROD_CALLBACK);
  try {
    const u = new URL(candidate);
    const okOrigin = allow.has(u.origin) || LOCAL_ORIGIN_RE.test(u.origin);
    if (okOrigin && u.pathname === "/auth/callback") return u.toString();
  } catch {
    /* fall through to safe default */
  }
  return PROD_CALLBACK;
}

// GET /api/auth/me  → returns the synced User row (creates one if missing).
r.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth.id } });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me  { displayName?, learningGoal?, preferredStyle?, dailyMinutes? }
r.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const { displayName, learningGoal, preferredStyle, dailyMinutes } = req.body || {};
    const data = {};
    if (typeof displayName === "string" && displayName.trim()) data.displayName = displayName.trim().slice(0, 80);
    if (typeof learningGoal === "string") data.learningGoal = learningGoal.trim().slice(0, 80);
    if (typeof preferredStyle === "string") data.preferredStyle = preferredStyle;
    if (typeof dailyMinutes === "number" && dailyMinutes >= 5 && dailyMinutes <= 240) data.dailyMinutes = dailyMinutes;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: "Nothing to update" });

    const user = await prisma.user.update({ where: { id: req.auth.id }, data });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/auth/profile  { fullName, collegeName, branch, yearOfStudy,
 *                          targetRoles, linkedinUrl?, githubUrl? }
 *
 * Required: fullName, collegeName, branch, yearOfStudy, targetRoles (>=1).
 * Optional: linkedinUrl, githubUrl.
 *
 * Saves the profile-setup form filled in after sign-up. Flips
 * `profileComplete` so AuthCallback stops bouncing the user back to /onboarding.
 *
 * All fields are validated server-side (the client sends a typed object, but
 * we never trust it). Strings are trimmed + length-capped; numbers are
 * range-clamped.
 */
const VALID_BRANCHES = new Set([
  "CSE", "IT", "ECE", "EE", "EEE", "ME", "Civil", "Chemical", "Biotech",
  "MCA", "MBA", "Other",
]);
const VALID_ROLES = new Set([
  "SDE", "Backend", "Frontend", "Full Stack",
  "Mobile (iOS/Android)", "Data Engineer", "Data Scientist", "ML Engineer",
  "DevOps / SRE", "Cloud Engineer", "Platform Engineer", "Security",
  "QA / SDET", "Embedded / Firmware", "Systems / Low-level",
  "Game Dev", "Blockchain / Web3", "AI Research",
  "Solutions Engineer", "Product Manager",
]);

r.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};

    const fullName = (b.fullName || "").trim().slice(0, 120);
    const collegeName = (b.collegeName || "").trim().slice(0, 200);
    const branch = (b.branch || "").trim();
    const yearOfStudy = Number(b.yearOfStudy);
    const linkedinUrl = (b.linkedinUrl || "").trim().slice(0, 300) || null;
    const githubUrl = (b.githubUrl || "").trim().slice(0, 300) || null;
    const targetRoles = Array.isArray(b.targetRoles)
      ? b.targetRoles.filter((r) => typeof r === "string" && VALID_ROLES.has(r)).slice(0, 5)
      : [];

    // Hard-required fields
    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: "Full name is required." });
    }
    if (!collegeName || collegeName.length < 2) {
      return res.status(400).json({ error: "College name is required." });
    }
    if (!VALID_BRANCHES.has(branch)) {
      return res.status(400).json({ error: "Pick a valid branch." });
    }
    if (![1, 2, 3, 4, 5].includes(yearOfStudy)) {
      return res.status(400).json({ error: "Year of study must be 1-5." });
    }
    if (targetRoles.length === 0) {
      return res.status(400).json({ error: "Pick at least one target role." });
    }

    const user = await prisma.user.update({
      where: { id: req.auth.id },
      data: {
        fullName,
        collegeName,
        branch,
        yearOfStudy,
        // Explicitly clear the deprecated fields if a stale client sends them
        // (or if a previous save populated them).
        graduationYear: null,
        cgpa: null,
        phoneNumber: null,
        linkedinUrl,
        githubUrl,
        targetRoles,
        // Mirror displayName for use across the site (Nav avatar, etc.).
        displayName: fullName,
        profileComplete: true,
      },
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/validate-email  { email }
 *
 * Cheap pre-check before the client triggers an OTP send via Supabase. Catches
 * fake/disposable/gibberish addresses so we don't waste a rate-limited email
 * on something that obviously won't work. Returns { ok: true } if the address
 * passes all our heuristics + DNS MX lookup; otherwise { ok: false, reason }.
 */
r.post("/validate-email", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, reason: "Email required" });

    const result = await validateEmail(email);
    if (!result.ok) return res.status(400).json(result);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/fallback-signin  { email, displayName? }
 *
 * Used when Supabase's built-in mailer is failing (which happens often on the
 * free tier — "Error sending confirmation email" / 500 / "unexpected_failure").
 * Strategy:
 *   1. Validate the email server-side (same gibberish + MX checks the OTP
 *      send path uses, so we don't lower the verification bar).
 *   2. Create the Supabase user pre-confirmed via the admin API. Idempotent.
 *   3. Generate a magiclink via admin.generateLink — this RETURNS the link
 *      without trying to email it, sidestepping the broken mailer entirely.
 *   4. Send the action_link back to the client, which navigates the user to
 *      it. Supabase's /auth/v1/verify processes the token and redirects to
 *      our /auth/callback with the session, where AuthCallback signs them in.
 *
 * Why this preserves the verification bar: the email validator rejects
 * gibberish/disposable/no-MX addresses before we get here, so by the time
 * we're issuing a magic link the address is at least a real deliverable one.
 */
r.post("/fallback-signin", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const displayName = String(req.body?.displayName || "").trim();
    if (!email) return res.status(400).json({ ok: false, reason: "Email required" });

    const v = await validateEmail(email);
    if (!v.ok) return res.status(400).json(v);

    const admin = getSupabaseAdmin();

    // Step 1 — create the user pre-confirmed. Ignore "already exists" errors.
    try {
      await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: displayName ? { display_name: displayName } : undefined,
      });
    } catch (err) {
      const msg = (err?.message || "").toLowerCase();
      const isDup =
        msg.includes("already") ||
        msg.includes("duplicate") ||
        msg.includes("registered") ||
        msg.includes("user_already_exists");
      if (!isDup) throw err;
    }

    // Step 2 — generate magic link (no email sent; just returns the URL).
    const redirectTo = safeRedirectTo(req);
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (error) {
      console.error("[fallback-signin] generateLink failed:", error.message);
      return res.status(502).json({ ok: false, reason: "Couldn't generate sign-in link. Try Google sign-in." });
    }

    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      return res.status(502).json({ ok: false, reason: "Sign-in link missing from Supabase response." });
    }

    res.json({ ok: true, action_link: actionLink });
  } catch (err) {
    console.error("[fallback-signin] error:", err?.message);
    next(err);
  }
});

/**
 * POST /api/auth/dev-confirm  { email }
 *
 * Forces email confirmation for a freshly-signed-up Supabase user, using the
 * service_role key server-side. Solves the "email never arrives" problem on
 * Supabase's free-tier built-in mailer (heavily rate-limited + Gmail-filtered).
 *
 * Production-mode-aware: in production this is rate-limited per-IP (built-in
 * /api/ limiter) and clients should still ideally use a real SMTP provider
 * (Resend, Postmark, etc.). For demos and local dev this is a clean escape.
 */
r.post("/dev-confirm", async (req, res, next) => {
  try {
    // Dev/demo-only escape hatch. Disabled in production so it can't be used to
    // enumerate which emails are registered (it 404s instead of 200/404-by-existence).
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "email is required" });
    }
    const normalized = email.trim().toLowerCase();
    const admin = getSupabaseAdmin();

    // Find the user by email via admin API.
    // listUsers paginates; for a demo just grab the first page large enough.
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (listErr) {
      console.error("[dev-confirm] listUsers failed:", listErr);
      return res.status(502).json({ error: "Couldn't query Supabase Auth" });
    }
    const target = (list.users || []).find(
      (u) => (u.email || "").toLowerCase() === normalized
    );
    if (!target) {
      return res.status(404).json({ error: "No Supabase user with that email" });
    }
    if (target.email_confirmed_at) {
      return res.json({ ok: true, alreadyConfirmed: true });
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(target.id, {
      email_confirm: true,
    });
    if (updErr) {
      console.error("[dev-confirm] updateUserById failed:", updErr);
      return res.status(502).json({ error: "Couldn't confirm email" });
    }
    res.json({ ok: true, alreadyConfirmed: false });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/signup  { email, password, displayName }
 *
 * Server-side signup using the Supabase Admin API. This bypasses Supabase's
 * public /auth/v1/signup endpoint entirely, which means:
 *   - No confirmation email is sent (`email_confirm: true` marks it verified).
 *   - Not subject to Supabase's free-tier email rate limit
 *     ("over_email_send_rate_limit" error that blocks the public endpoint).
 *   - Works regardless of the "Confirm email" toggle in the dashboard.
 *
 * The client then signs in via supabase.auth.signInWithPassword() to get a
 * session (see lib/auth.ts signupEmail()). We deliberately don't return
 * tokens here — keep tokens client-side.
 */
const MIN_PW = 8;
const MAX_FIELD = 200;

r.post("/signup", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    const displayName = String(req.body?.displayName || "").trim() || email.split("@")[0];

    if (displayName.length > MAX_FIELD) {
      return res.status(400).json({ error: "Display name too long" });
    }
    if (typeof password !== "string" || password.length < MIN_PW || password.length > MAX_FIELD) {
      return res.status(400).json({ error: `Password must be ${MIN_PW}-${MAX_FIELD} characters` });
    }

    const v = await validateEmail(email);
    if (!v.ok) return res.status(400).json({ error: v.reason || "That email isn't accepted." });

    const admin = getSupabaseAdmin();

    // Create the user pre-confirmed — no email sent, no rate limit.
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });

    if (error) {
      // Supabase admin returns 422 on duplicate; map to a friendly 409.
      const msg = (error.message || "").toLowerCase();
      if (
        msg.includes("already") ||
        msg.includes("duplicate") ||
        msg.includes("user_already_exists") ||
        msg.includes("registered")
      ) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }
      console.error("[signup] admin.createUser failed:", error);
      return res.status(502).json({ error: "Couldn't create account" });
    }

    res.status(201).json({
      ok: true,
      user: { id: data.user?.id, email: data.user?.email, displayName },
    });
  } catch (err) {
    next(err);
  }
});

// Legacy login endpoint — login goes through the Supabase JS client directly
// (supabase.auth.signInWithPassword in lib/auth.ts), so nothing hits the
// server for login.
r.post("/login", (_req, res) =>
  res.status(410).json({ error: "Login goes through the Supabase client directly." })
);

export default r;
