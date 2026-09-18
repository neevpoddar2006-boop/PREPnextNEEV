// Singleton Supabase client used by the entire app.
// - Auto-persists session in localStorage (default behavior).
// - Auto-refreshes the JWT in the background.
// - Re-uses the same instance across hot reloads.
//
// Security notes:
// - The `anon` key is intentionally public (designed to be exposed to clients).
//   It only allows operations the project's RLS policies permit.
// - We don't use Supabase Postgres/Storage from the client directly; only auth.
//   All data access goes through our Express API for type safety + audit.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RAW_URL = import.meta.env.VITE_SUPABASE_URL;
const RAW_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// True once real Supabase credentials are wired up (server/.env + client/.env
// with a live project). Until then we run in a no-backend preview mode
// instead of crashing the whole app — see useAuth.tsx's AUTH_BYPASS.
export const SUPABASE_CONFIGURED = Boolean(RAW_URL && RAW_ANON_KEY);

if (!SUPABASE_CONFIGURED) {
  // Don't throw here — an uncaught error at module scope (no error boundary
  // wraps the app) takes down the entire React tree before anything paints,
  // which is why an unconfigured prod deploy showed a blank page instead of
  // a real error. Warn instead and fall back to a placeholder client; useAuth
  // never actually calls it while SUPABASE_CONFIGURED is false.
  console.warn(
    "[supabase] VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY are not set — running without a backend. " +
      "Sign-in is bypassed (preview mode). Set real values in client/.env (and on Vercel) to enable it."
  );
}

const SUPABASE_URL = RAW_URL || "https://placeholder.supabase.co";
const SUPABASE_ANON_KEY = RAW_ANON_KEY || "placeholder-anon-key";

const globalForSupabase = globalThis as unknown as { __prepnextSupabase?: SupabaseClient };

export const supabase: SupabaseClient =
  globalForSupabase.__prepnextSupabase ??
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true, // for OAuth + email-verification callback URLs
      storageKey: "prepnext.supabase.auth.v1",
    },
  });

if (import.meta.env.DEV) globalForSupabase.__prepnextSupabase = supabase;
