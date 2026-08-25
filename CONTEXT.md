# ReconPilot — Project Context

## What this is
A settlement reconciliation system built for the Razorpay AI Buildathon 2026 (Track 4: AI Finance Controller).

## Core thesis (never violate this in any UI/UX decision)
A deterministic matching engine (hash-matching, Fellegi-Sunter probabilistic scoring, Hungarian algorithm)
resolves what it can with certainty. An LLM (Gemini) is only invoked for genuinely ambiguous cases.
A single "decision gate" module is the sole place any case gets finalized — no module, including the
AI layer, can write a final decision directly.

Every finalized decision has a `decidedBy` value:
- `stage1_exact` / `stage7_auto` — fully deterministic, ZERO AI involvement
- `post_ai` — AI investigated, decision gate confirmed
- `human` — manual reviewer decision

**This distinction (deterministic vs. AI-assisted vs. human) is the single most judged aspect of this
project.** It must always be visually unambiguous in the UI — never buried, never a small text label.

## Backend (complete, do not modify without explicit instruction)
- Express + TypeScript, MySQL, runs on http://localhost:3000
- Endpoints: POST /api/batches, POST /api/runs, GET /api/runs/:id, GET /api/runs/:id/exceptions,
  POST /api/exceptions/:id/resolve, GET /api/audit
- Always read the actual route files in backend/src/api/routes/ for exact request/response shapes —
  never assume field names from this doc alone.

## Critical constraint — Gemini free-tier quota
5 requests/minute, ~20 requests/day. A full pipeline run against a non-trivial dataset can consume
most of the daily quota in ONE run. Always test with a small manually-uploaded batch (5-10 records),
never trigger a run against the full seeded dataset during routine iteration.

## Design system (locked — based on Razorpay's real "Blade" design system, not an invented palette)

### Base tokens (dark theme)
- background: #070e1c
- surface/card: #0f172a
- border: #1c2536
- foreground (primary text): #E8ECF1
- text-secondary: #8B96A5 — description/supporting text under a bold label (e.g. pipeline-strip node
  descriptions, Decision Architecture supporting text). Distinct from `muted` below — used for the
  label/description two-tier hierarchy pattern established across the app.
- muted (tertiary/least-important text — timestamps, hints): #97a0af
- brand/action color — buttons, links, active nav, primary CTAs. ONE color, used ONLY for actions,
  never for semantic status: #0d94fb (Dodger Blue)
- success: #04db7c

### Semantic decision-source colors (used ONLY on decidedBy badges, the pipeline-strip nodes, and the
route-distribution chart — never on buttons, nav, or generic UI chrome, to avoid diluting their meaning)
- Deterministic: teal #14B8A6
- AI-Assisted: purple #A78BFA
- Human: amber #F59E0B
- Error/Rejected/Failed: red #F87171

**This separation was previously audited and grep-verified with zero cross-contamination — teal must
never be reused for brand/action purposes again.**

### Typography
- Font: Mulish (Google Fonts) with Inter, system-ui as fallbacks
- Body: 14px, line-height 1.5
- Headings: font-weight 700, letter-spacing -0.01em
- Monospace (e.g. 'JetBrains Mono', ui-monospace) for ALL ids, amounts, hashes, transaction
  references — this is deliberate, it's how Razorpay makes data "look engineered" rather than
  decorative

### Shape & elevation (the "Blade Edge" — this is what makes it look premium, not generic)
- Border radius: 4px default, 6px for medium components, 12px max (only for large containers) —
  NOT the large 12-16px rounded-everything look
- 3-tier shadow system: low (subtle card lift), medium (dropdowns/popovers), high (modals) — cards
  need real elevation via shadow, not just a 1px border, to avoid the "flat floating box" look
- Thin 1px borders in the border color, used alongside shadows, not instead of them

### Density
Real fintech dashboards (Razorpay, Stripe) are DATA-DENSE, not generously-empty. Reduce vertical
whitespace between sections. Empty states should be compact, not a huge centered block with excessive
padding — an empty-state icon+message+button should take up a modest card area, not dominate the
whole viewport.

### Status pills
Semantic pills with SUBTLE background fills (not solid-color-fill buttons) — e.g. a "matched" pill
is a soft-tinted background with the semantic color as text/border, not a solid-filled badge.

## UI status — FROZEN (do not iterate further without explicit instruction)

Seven rounds of design work are complete and verified:
1. Design tokens defined and applied.
2. Color-semantics fix — brand/action color fully separated from the decision-source teal semantic,
   grep-verified zero cross-contamination across the codebase.
3. Shadow elevation, tightened border-radius, increased density, monospace on all IDs/amounts/scores.
4. Copywriting pass — implementation-detail language (raw API routes, algorithm names in primary
   copy, emoji-as-warnings, raw enum values) moved into a collapsed "How matching works" disclosure
   or removed; primary copy uses product-language ("Matched automatically," "AI-assisted"), not
   implementation-narration.
5. Alignment audit — nav-bar edges, table column alignment, audit-trail timeline metadata (fixed via
   justify-between rather than a fixed pixel column, since badge width varies by decidedBy value).
6. Motion system — skeleton loading states, success micro-confirmation flash, count-up numbers,
   smooth badge color-transitions, semantic hover-glow, staggered list fade-in. Principle used:
   "calm motion that confirms state, never flair for its own sake" — no decorative/ambient animation.
7. The Decision Architecture card was rebuilt as a compact horizontal pipeline strip
   (Match → Score → Assign → Investigate → Gate) instead of three static badge rows, to give the
   product's core architecture a distinctive visual signature. Empty states across Dashboard,
   Exceptions, and Audit Lookup were made page-specific and distinct instead of using identical
   generic copy.

**Explicitly rejected — do not reintroduce these:**
- Glassmorphism / backdrop-blur anywhere — recreates the generic "AI-generated SaaS" look this
  project deliberately moved away from.
- Teal used for any brand/action/generic-interactive purpose — breaks the verified decision-source
  semantic separation (see Claim 2 above).

**UI is frozen.** Do not suggest, propose, or make further visual/layout changes unless the user
explicitly asks for a specific new change in that session.