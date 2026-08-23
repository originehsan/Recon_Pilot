# ReconPilot — Settlement Reconciliation System

## Project Thesis

ReconPilot is a settlement reconciliation system built for the Razorpay AI Buildathon 2026 (Track: AI Finance Controller). The core thesis is that a deterministic matching engine (SHA-256 hash matching, Fellegi-Sunter probabilistic scoring, Hungarian algorithm assignment) resolves what it can with certainty, and an LLM (Gemini) is invoked only for genuinely ambiguous cases where deterministic evidence is insufficient. A single "decision gate" module is the sole place any case gets finalized — no module, including the AI layer, can write a final decision directly. Every finalized decision is tagged with a `decidedBy` value: `stage1_exact` or `stage7_auto` (deterministic, no AI), `post_ai` (AI investigated, gate confirmed), or `human` (manual reviewer decision).

---

## Repository Structure

```
recon-pilot/
├── backend/     # Express + TypeScript API, MySQL, Gemini AI
└── frontend/    # React + Vite + Tailwind v4 dashboard
```

---

## Backend Setup

### Prerequisites
- Node.js ≥ 18
- MySQL 8.0 running locally
- A Google Gemini API key (free tier works; see quota note below)

### Steps

```bash
cd backend

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your MySQL credentials and GEMINI_API_KEY

# 3. Run database migrations
npm run migrate

# 4. (Optional) Seed with synthetic test data
#    WARNING: this inserts a large dataset — see quota warning below
npm run seed

# 5. Start the development server
npm run dev
# Server runs at http://localhost:3000
# Health check: GET http://localhost:3000/health
```

---

## Frontend Setup

### Prerequisites
- Node.js ≥ 18
- Backend running at `http://localhost:3000`

### Steps

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Start the development server
npm run dev
# Frontend runs at http://localhost:5173
# API calls are proxied to http://localhost:3000 automatically (vite.config.ts)
```

### Running Both Together (two terminals)

```bash
# Terminal 1 — backend
cd backend && npm run dev

# Terminal 2 — frontend
cd frontend && npm run dev
```

Then open **http://localhost:5173** in your browser.

---

## Quick Demo Walk-Through

1. **Upload a small batch** — click "Upload Batch" on the Dashboard, paste a JSON payload (a small sample is pre-filled), click "Upload Batch". This seeds settlements and orders into the database.

2. **Start a run** — click "Start New Run". The pipeline runs asynchronously; the UI polls every 2 seconds and updates the progress cards live.

3. **Review the chart** — once the run completes, the pie chart shows resolved/in-review/failed case counts.

4. **Check exceptions** — click "View All" or navigate to "Exceptions". For any pending item, click "Resolve" to expand the inline form and approve/reject/mark-unresolved.

5. **Audit trail** — navigate to "Audit Lookup". Enter `entityType=resolution` and the resolution's numeric ID to see the full event trail, with Evidence Used, AI Raw Output, and Decision Gate Output displayed as three distinct, separately-colored boxes.

---

## Gemini API Quota Warning

> ⚠️ **Important for repeated UI testing.**
>
> The Gemini free tier allows approximately 15–20 requests per day (as of mid-2026). A single reconciliation run against the **full seeded dataset** may contain multiple `ai_investigation` cases and can consume most of this daily quota in one run.
>
> **Recommendation:** Use the "Upload Batch" panel on the Dashboard to upload a small manually-crafted batch of 5–10 records for repeated UI testing. Only trigger a run against the full seeded dataset when you need to exercise the AI path end-to-end for a final demo — and expect the run to take several minutes due to the 13-second inter-call pacing built into the backend.

---

## API Reference (quick summary)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/batches` | Upload settlements + orders |
| `POST` | `/api/runs` | Start a reconciliation run |
| `GET`  | `/api/runs/:id` | Poll run status + progress |
| `GET`  | `/api/runs/:id/exceptions` | List pending human-review items |
| `POST` | `/api/exceptions/:id/resolve` | Finalize a human review decision |
| `GET`  | `/api/audit?entityType=&entityId=` | Audit event trail for any entity |
