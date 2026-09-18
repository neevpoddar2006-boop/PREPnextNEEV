# PrepNext — The Placement-Prep Operating System for Indian Students

**Live:** https://prepnext.vercel.app

PrepNext is a full-stack, production-deployed platform that takes a college
student through the **entire placement journey in one place** —
**Learn → Practice → Build → Interview → Placement** — with email sign-in,
a single **Placement Readiness Score**, and structured, opinionated content end
to end.

---

## The journey model

The whole product is organized around the five stages a student actually moves
through, and a single score that tells them where they stand:

```
Learn  →  Practice  →  Build  →  Interview  →  Placement
DSA       Patterns +    Projects   Mock OA +     Recruiter map +
roadmap   problems      (10        interview     PYQ vault +
          + aptitude    domains)   resources     prep kits
                    │
                    ▼
        Placement Readiness Score (0–100)
   DSA · Patterns · Projects · Mock OA · Consistency
```

The **Placement Readiness Score** aggregates the journey into one number with a
per-dimension breakdown and an "improve next →" nudge that routes the student to
their weakest area. Weights: **DSA 25% · Coding patterns 20% · Projects 20% ·
Mock OA 20% · Consistency 15%**, with bands (Getting started → Building up →
Interview-ready → Placement-ready).

---

## Highlights

- **Full-stack TypeScript/Node app** on **Vercel** (static SPA + serverless API) with managed **PostgreSQL** on **Supabase**.
- **Email + password authentication** via Supabase Auth — server-verified JWTs, centralized route guards, enforced profile completion, per-user isolation.
- **Journey-based navigation** — primary nav (Dashboard, DSA, Patterns, Aptitude, Projects, Mock OA) plus a grouped Prep menu (Practice / Interview / Placement).
- **Placement Readiness Score** — one 0–100 metric across the whole journey, on the dashboard.
- **Projects module** — **10 domains, 30 structured projects** (Web, Backend, AI/ML, Cybersecurity, Cloud, DevOps, Mobile, Blockchain, Data Science, Open Source) with per-project detail and difficulty paths.
- **Coding Patterns module** — **26 interview patterns** with explanations and practice problems, tracked toward readiness.
- **DSA practice hub** — curated problems across topics with in-platform solutions, complexity analysis, LeetCode links, and 4-state progress.
- **Recruiter map + PYQ vault + Mock OA** — verified-CTC company kits, previous-year questions, and timed self-graded online-assessment mocks.
- **Performance & UX** — route-based code-splitting, memoized components, glassmorphism UI, framer-motion transitions, fully responsive, accessible (ARIA, keyboard nav, skip-link), and a low-eye-strain type scale tuned for multi-hour study sessions.

---

## Architecture

```
React SPA (Vercel static)
   │  fetch /api/*
   ▼
Express app as a Vercel serverless function (api/index.js → server/app.js)
   │  Prisma  +  @prisma/adapter-pg
   ▼
PostgreSQL (Supabase)  +  Supabase Auth (email + password)
```

- **Frontend** and **API** are served from one Vercel domain; a rewrite routes `/api/*` into the serverless function.
- **Data-driven content** — each domain (projects, patterns, DSA topics) is one typed TS data file aggregated in an index registry; the UI renders from the data.
- **Progress** (checklist, solved problems, projects built, active days) is tracked client-side via a `useLearningProgress` store and feeds the readiness score.
- **CI/CD** — push to `main` → Vercel builds (`prisma generate` + `vite build`) and deploys automatically.

---

## Tech stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, TypeScript, Vite 7, Tailwind CSS v4 (`@theme` tokens), React Router 7, framer-motion, react-markdown, jsPDF + qrcode |
| **Backend** | Node 20, Express 4 (ESM), Vercel serverless functions |
| **Database** | PostgreSQL (Supabase), Prisma ORM, `@prisma/adapter-pg`, SQL migrations |
| **Auth** | Supabase Auth (email + password); server-side JWT verification + route guards |
| **Infra / DevOps** | Vercel (hosting + serverless), Supabase (managed Postgres + Auth), Git-based CI/CD |

---

## Key features

### Learn
- **Structured DSA roadmap** with per-topic lessons (definition, syntax, worked example) and progress tracking.
- **Aptitude, Core CS, System Design, Interview resources** — typed resource libraries with instant search, bookmarking, and SEO-complete pages.

### Practice
- **DSA practice hub** — hand-curated problems with company tags, in-platform solutions, complexity analysis, LeetCode integration, and 4-state progress (Not Started / In Progress / Solved / Revision).
- **Coding Patterns** — 26 reusable interview patterns, each with practice problems.

### Build
- **Projects module** — 10 domains × structured project paths (30 projects), each with a detail page covering what you build, the stack, and milestones; "built" toggles feed the readiness score.

### Interview & Placement
- **Mock OA** — timed, self-graded online-assessment mocks with a rubric and result page.
- **Recruiter map** — curated companies with eligibility, rounds, OA platforms, and verified-only CTC bands.
- **PYQ vault** — verified previous-year questions with expected approaches and a student contribution/verification flow.
- **Per-company prep kits**, salary insights, company compare, mastery radar, and verifiable **certificates** (PDF + QR + verify URL).

### Accounts & data
- Email + password sign-in (Supabase Auth) with intended-destination redirect.
- Centralized route protection; direct-URL access to protected pages is guarded.
- Per-user data isolation so accounts never share progress on the same device.

---

## Run locally

**Prerequisites:** Node 20+ and a free [Supabase](https://supabase.com) project
(Postgres + Auth). Everything else installs from npm.

```bash
# 1. Clone and install dependencies (root + client)
git clone https://github.com/neevpoddar2006-boop/PREPnextNEEV.git
cd PREPnextNEEV
npm run install:all

# 2. Configure environment
cp server/.env.example server/.env     # DATABASE_URL, DIRECT_URL, SUPABASE_* keys
cp client/.env.example client/.env     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

# 3. Create the database schema (+ optional seed data)
cd server && npm run db:migrate && npm run db:seed && cd ..

# 4. Start both dev servers (Express API + Vite client)
npm run dev
```

`npm run dev` starts the Express API first, which writes a `.ports.json` at the
repo root; Vite waits for that file, then bakes the API URL into the client dev
bundle. So always start the client via the root `npm run dev` — running
`cd client && npm run dev` on its own fails until the server is up.

Where each value comes from:

| Variable | Where to find it |
|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → **Transaction** pooler (port 6543) |
| `DIRECT_URL` | Supabase → Project Settings → Database → **Session** pooler (port 5432), used for migrations |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key (**server-only**) |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — optional, powers the AI tutor |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) — optional, powers the PrepNext Assistant |

The AI keys are optional: without them the app runs fully, and only the AI tutor
and Assistant features are disabled.

See [`DATABASE_SETUP.md`](DATABASE_SETUP.md) for the full database guide and
[`summary.md`](summary.md) for the current product/architecture overview.

## Deploy (Vercel + Supabase)

1. Create a **Supabase** project; copy the Postgres connection string (pooled).
2. Apply migrations: `cd server && DATABASE_URL="<supabase-url>" npx prisma migrate deploy`.
3. In **Vercel → Settings → Environment Variables**, set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` (and the `VITE_SUPABASE_*` client keys).
4. Push to `main` — Vercel builds and deploys automatically.

---

## Roadmap

PrepNext is moving toward **institution-grade** adoption. Strategy and the
phased build plan live in [`SAAS_READINESS.md`](SAAS_READINESS.md),
[`COMPETITOR_ANALYSIS.md`](COMPETITOR_ANALYSIS.md), and
[`PHASE2_REPORT.md`](PHASE2_REPORT.md). Next milestones: server-synced progress,
a TPO/admin cohort dashboard, SSO + CSV bulk onboarding, and multi-tenancy.

---
