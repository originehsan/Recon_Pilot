# ReconPilot — Project Context

## What this is
A settlement reconciliation system built for the Razorpay AI Buildathon 2026 (Track: AI Finance Controller).

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
5 requests/minute, 20 requests/day. A full pipeline run against a non-trivial dataset can consume
most of the daily quota in ONE run. Always test UI changes with a small manually-uploaded batch
(5-10 records), never trigger a run against the full seeded dataset during UI iteration.

## Design system (locked — based on Razorpay's real "Blade" design system, not an invented palette)

### Base tokens (dark theme)
- background: #070e1c
- surface/card: #0f172a
- border: #1c2536
- foreground (primary text): #f4f5f7
- muted (secondary text): #97a0af
- brand/action color — buttons, links, active nav, primary CTAs. ONE color, used ONLY for actions,
  never for semantic status: #0d94fb (Dodger Blue)
- success: #04db7c

### Semantic decision-source colors (used ONLY on decidedBy badges and the route-distribution chart —
never on buttons, nav, or generic UI chrome, to avoid diluting their meaning)
- Deterministic: teal #14B8A6
- AI-Assisted: purple #A78BFA
- Human: amber #F59E0B
- Error/Rejected/Failed: red #F87171

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