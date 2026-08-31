/**
 * Dashboard — main landing page.
 *
 * Sections:
 *   A. Batch Upload panel (JSON textarea → POST /api/batches)
 *   B. Start New Run button → POST /api/runs
 *   C. Live polling (GET /api/runs/:id every 2s, stops on completed/failed)
 *   D. Route distribution chart (recharts PieChart — status breakdown)
 *   E. Recent Exceptions Preview (top 3 from GET /api/runs/:id/exceptions)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  Play, Upload, ChevronDown, ChevronUp, CheckCircle2,
  AlertTriangle, AlertCircle, Clock, Hash, Layers, Info, Code2, ChevronRight,
} from 'lucide-react';

import {
  createRun, getRun, getExceptions, uploadBatch,
  type RunResponse, type Exception, type BatchUploadPayload,
  ApiError,
} from '../api/client';
import { useRunContext } from '../context/RunContext';
import { StatCard } from '../components/StatCard';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { DecisionSourceBadge } from '../components/DecisionSourceBadge';
import { SkeletonStatCards } from '../components/SkeletonStatCards';
import { formatPaise, formatDecimal } from '../utils/format';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert raw snake_case reasonCode to a readable label */
function humanizeReasonCode(code: string): string {
  const MAP: Record<string, string> = {
    fs_score_in_review_band: 'Score in review band',
    ambiguous_duplicate: 'Ambiguous duplicate',
    split_payment_ambiguous: 'Split payment (ambiguous)',
    no_match_found: 'No match found',
    high_exposure: 'High exposure',
    human_review_exception: 'Human review exception',
  };
  return MAP[code] ?? code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Status badge rendering */
function RunStatusBadge({ status }: { status: string }) {
  const configs = {
    pending:    { color: 'var(--color-gray)',    bg: 'var(--color-gray-dim)',    border: 'var(--color-gray-border)',    label: 'Pending' },
    processing: { color: 'var(--color-amber)',   bg: 'var(--color-amber-dim)',   border: 'var(--color-amber-border)',   label: 'Processing…' },
    completed:  { color: 'var(--color-success)', bg: 'var(--color-success-dim)', border: 'var(--color-success-border)', label: 'Completed' },
    failed:     { color: 'var(--color-red)',     bg: 'var(--color-red-dim)',     border: 'var(--color-red-border)',     label: 'Failed' },
  } as const;

  const cfg = configs[status as keyof typeof configs] ?? configs.pending;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold"
      style={{
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        // P2: smooth color transition between status states (pending → processing → completed)
        transition: 'background-color 300ms ease, color 300ms ease, border-color 300ms ease',
      }}
    >
      {status === 'processing' && (
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ background: cfg.color }}
        />
      )}
      {cfg.label}
    </span>
  );
}

// ─── Pie chart colors ───────────────────────────────────────────────────────
// Note: GET /api/runs/:id progress does not expose per-decidedBy breakdown.
// This chart shows RUN STATUS breakdown: Resolved / In Review / Failed.
//
// 'Resolved' here is NOT the same thing DecisionSourceBadge's teal means -
// it's every finalized case regardless of decidedBy (stage1_exact,
// stage7_auto, AND post_ai all count), whereas teal is reserved specifically
// for "deterministic, zero AI involvement" (see DecisionSourceBadge.tsx).
// Using teal here previously conflated the two - fixed by using the success
// token instead (positive-outcome green, not a decision-source color at all).
// Amber=reviewQueued and Red=failed DO still match their single, consistent
// meaning everywhere else (amber=human/pending, red=failed/error), so those
// two are left as-is.
const PIE_COLORS = {
  resolved:     '#04db7c', // var(--color-success) - positive outcome, NOT a decision-source color
  reviewQueued: '#F59E0B',
  failed:       '#F87171',
};

// ─── Sample Batch Payload ──────────────────────────────────────────────────────

const SAMPLE_BATCH: BatchUploadPayload = {
  settlements: [
    {
      entityId: 'ent_demo_001',
      type: 'settlement',
      settlementId: 'stl_demo_001',
      settlementUtr: 'UTR_DEMO_001',
      orderId: 'ord_demo_001',
      paymentId: 'pay_demo_001',
      amount: 100000,
      fee: 200,
      tax: 36,
      onHold: false,
      disputeId: null,
      creditType: null,
      narration: 'Payment for order ORD001',
    },
    {
      entityId: 'ent_demo_001',
      type: 'settlement',
      settlementId: 'stl_demo_002',
      settlementUtr: 'UTR_DEMO_002',
      orderId: 'ord_demo_002',
      paymentId: 'pay_demo_002',
      amount: 250000,
      fee: 500,
      tax: 90,
      onHold: false,
      disputeId: null,
      creditType: null,
      narration: null,
    },
  ],
  orders: [
    {
      orderId: 'ord_demo_001',
      expectedAmount: 100000,
      expectedReference: 'REF001',
      expectedDate: '2026-08-20',
    },
    {
      orderId: 'ord_demo_002',
      expectedAmount: 250000,
      expectedReference: null,
      expectedDate: null,
    },
  ],
};

// ─── HowMatchingWorks ─────────────────────────────────────────────────────────
// Controlled disclosure replacing the native <details> element so we can
// add hover effects, chevron rotation, and rich step styling.

const MATCHING_STEPS = [
  { label: 'Exact matching',       desc: 'hash-based identity check' },
  { label: 'Similarity scoring',   desc: 'Fellegi-Sunter probabilistic model' },
  { label: 'Optimal assignment',   desc: 'Hungarian algorithm' },
  { label: 'AI investigation',     desc: 'only for genuinely ambiguous cases' },
  { label: 'Decision gate',        desc: 'sole finalization point; no module bypasses it' },
] as const;

function HowMatchingWorks() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2">
      {/* Trigger row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 group"
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <ChevronRight
          size={13}
          style={{
            color: 'var(--color-brand)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms ease',
            flexShrink: 0,
          }}
        />
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--color-text-primary)' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLSpanElement).style.textDecoration = 'underline';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLSpanElement).style.textDecoration = 'none';
          }}
        >
          How matching works
        </span>
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-border)',
            lineHeight: 1,
          }}
        >
          5 steps
        </span>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="mt-3 flex flex-col gap-3 pl-1">
          {MATCHING_STEPS.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              {/* Circle number badge — centered against the two-line block */}
              <span
                className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                style={{
                  background: 'var(--color-brand-dim)',
                  color: 'var(--color-brand)',
                  border: '1px solid var(--color-brand-border)',
                  lineHeight: 1,
                }}
              >
                {i + 1}
              </span>
              {/* Stacked label / description */}
              <div className="flex flex-col gap-0.5">
                <span
                  className="text-xs font-semibold leading-snug"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {step.label}
                </span>
                <span
                  className="text-xs leading-snug"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {step.desc}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Dashboard() {
  const navigate = useNavigate();
  const { runId, setRunId } = useRunContext();

  // Run state
  const [runData, setRunData] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Exceptions preview
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [exceptionsLoading, setExceptionsLoading] = useState(false);
  const [exceptionsError, setExceptionsError] = useState<string | null>(null);

  // Batch upload panel
  const [batchPanelOpen, setBatchPanelOpen] = useState(false);
  const [batchJson, setBatchJson] = useState(JSON.stringify(SAMPLE_BATCH, null, 2));
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchSuccess, setBatchSuccess] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  // ── Polling ───────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback((id: number) => {
    stopPolling();

    async function poll() {
      try {
        const data = await getRun(id);
        setRunData(data);
        setRunError(null);

        if (data.status === 'completed' || data.status === 'failed') {
          stopPolling();
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Failed to fetch run status';
        setRunError(msg);
        // Don't stop polling on transient errors — backend might recover
      }
    }

    // Poll immediately, then every 2 seconds
    void poll();
    pollingRef.current = setInterval(poll, 2000);
  }, [stopPolling]);

  // Load exceptions preview whenever a run completes
  useEffect(() => {
    if (!runId || runData?.status !== 'completed') return;

    setExceptionsLoading(true);
    setExceptionsError(null);

    getExceptions(runId)
      .then((rows) => {
        // Sort defensively (API returns sorted, but we ensure it)
        const sorted = [...rows].sort((a, b) => b.priorityScore - a.priorityScore);
        setExceptions(sorted.slice(0, 3));
      })
      .catch((err: unknown) => {
        const msg = err instanceof ApiError ? err.message : 'Failed to load exceptions';
        setExceptionsError(msg);
      })
      .finally(() => setExceptionsLoading(false));
  }, [runId, runData?.status]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // ── Start Run ─────────────────────────────────────────────────────────────

  async function handleStartRun() {
    setIsStarting(true);
    setRunError(null);

    try {
      const result = await createRun();
      setRunId(result.runId);
      startPolling(result.runId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Expected: a run is already in progress — switch to polling it
        const existingId = (err as ApiError & { existingRunId?: number }).existingRunId;
        if (existingId != null) {
          setRunId(existingId);
          startPolling(existingId);
          // Not an error state — just resume polling
        } else {
          setRunError('A run is already in progress (could not retrieve run ID).');
        }
      } else {
        setRunError(err instanceof ApiError ? err.message : 'Failed to start run');
      }
    } finally {
      setIsStarting(false);
    }
  }

  // ── Batch Upload ──────────────────────────────────────────────────────────

  async function handleBatchUpload() {
    setBatchLoading(true);
    setBatchError(null);
    setBatchSuccess(null);

    let parsed: BatchUploadPayload;
    try {
      parsed = JSON.parse(batchJson) as BatchUploadPayload;
    } catch {
      setBatchError('Invalid JSON — please check the payload format.');
      setBatchLoading(false);
      return;
    }

    try {
      const result = await uploadBatch(parsed);
      setBatchSuccess(
        `Batch #${result.batchId} uploaded: ${result.settlementsInserted} settlements, ${result.ordersInserted} orders.` +
        (result.skippedSettlements?.length ? ` (${result.skippedSettlements.length} settlements skipped)` : '') +
        (result.skippedOrders?.length ? ` (${result.skippedOrders.length} orders skipped)` : ''),
      );
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : 'Batch upload failed');
    } finally {
      setBatchLoading(false);
    }
  }

  // ── Derived chart data ────────────────────────────────────────────────────

  const progress = runData?.progress;
  const chartData = progress
    ? [
        { name: 'Resolved', value: progress.resolved, color: PIE_COLORS.resolved },
        { name: 'In Review', value: progress.reviewQueued, color: PIE_COLORS.reviewQueued },
        { name: 'Failed', value: progress.failed, color: PIE_COLORS.failed },
      ].filter((d) => d.value > 0)
    : [];

  const isCompleted = runData?.status === 'completed';
  const isFailed    = runData?.status === 'failed';
  const isRunning   = runData?.status === 'pending' || runData?.status === 'processing';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    // gap-4 to match Exceptions.tsx and AuditLookup.tsx's identical
    // top-level header-to-sibling-sections rhythm (was gap-5 here only -
    // the one page out of three using a different value with no semantic
    // reason for the difference).
    <div className="flex flex-col gap-4">

      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Settlement Reconciliation
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Deterministic matching engine · AI investigation for ambiguous cases · Human review gate
          </p>
        </div>
      </div>

      {/* ── Decision Architecture ─────────────────────────────────────────── */}
      <div className="card p-5 flex flex-col justify-between gap-6">
        <p className="section-label">Decision Architecture</p>

        <div className="relative flex items-start justify-between">
          {/* Connecting Line (background) */}
          <div 
            className="absolute top-[5px] h-[1px]" 
            style={{ left: '2rem', right: '2rem', background: 'var(--color-border)' }} 
          />

          {/* Node 1: MATCH */}
          <div className="flex flex-col items-center gap-2 relative z-10 w-16">
            <div 
              className="w-3 h-3 rounded-full border-2" 
              style={{ background: 'var(--color-bg-surface)', borderColor: 'var(--color-teal)' }} 
            />
            <div className="flex flex-col items-center">
              <span className="mono text-[10px] font-bold tracking-wider" style={{ color: 'var(--color-text-primary)' }}>MATCH</span>
              {progress && progress.totalCases !== undefined && (
                <span className="text-[10px] font-semibold mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {progress.totalCases.toLocaleString()}
                </span>
              )}
            </div>
          </div>

          {/* Node 2: SCORE */}
          <div className="flex flex-col items-center gap-2 relative z-10 w-16">
            <div 
              className="w-3 h-3 rounded-full border-2" 
              style={{ background: 'var(--color-bg-surface)', borderColor: 'var(--color-teal)' }} 
            />
            <div className="flex flex-col items-center">
              <span className="mono text-[10px] font-bold tracking-wider" style={{ color: 'var(--color-text-primary)' }}>SCORE</span>
              {/* Structural-only count */}
            </div>
          </div>

          {/* Node 3: ASSIGN */}
          <div className="flex flex-col items-center gap-2 relative z-10 w-16">
            <div 
              className="w-3 h-3 rounded-full border-2" 
              style={{ background: 'var(--color-bg-surface)', borderColor: 'var(--color-teal)' }} 
            />
            <div className="flex flex-col items-center">
              <span className="mono text-[10px] font-bold tracking-wider" style={{ color: 'var(--color-text-primary)' }}>ASSIGN</span>
              {/* Structural-only count */}
            </div>
          </div>

          {/* Node 4: INVESTIGATE */}
          <div className="flex flex-col items-center gap-2 relative z-10 w-16">
            <div 
              className="w-3 h-3 rounded-full border-2" 
              style={{ background: 'var(--color-bg-surface)', borderColor: 'var(--color-purple)' }} 
            />
            <div className="flex flex-col items-center">
              <span className="mono text-[10px] font-bold tracking-wider" style={{ color: 'var(--color-text-primary)' }}>INVESTIGATE</span>
              {/* Structural-only count */}
            </div>
          </div>

          {/* Node 5: GATE */}
          <div className="flex flex-col items-center gap-2 relative z-10 w-16">
            {/* Bold/thick-border treatment for Decision Gate */}
            <div 
              className="w-3 h-3 rounded-full border-2" 
              style={{ background: 'var(--color-teal)', borderColor: 'var(--color-teal)' }} 
            />
            <div className="flex flex-col items-center">
              <span className="mono text-[10px] font-bold tracking-wider" style={{ color: 'var(--color-text-primary)' }}>GATE</span>
              {progress && progress.resolved !== undefined && (
                <span className="text-[10px] font-semibold mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {progress.resolved.toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Guarantee */}
        <p
          className="text-xs"
          style={{
            color: 'var(--color-text-primary)',
            borderTop: '1px solid var(--color-border)',
            paddingTop: '0.625rem',
            fontWeight: 600,
          }}
        >
          Every decision passes through the same gate — AI can investigate, but it can never finalize a case on its own.
        </p>
      </div>

      {/* ── Section A: Batch Upload ──────────────────────────────────────── */}
      <div className="card card-hover overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-4 transition-default"
          style={{ color: 'var(--color-text-primary)' }}
          onClick={() => setBatchPanelOpen((v) => !v)}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-elevated)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          <div className="flex items-center gap-2.5">
            <Upload size={16} style={{ color: 'var(--color-brand)' }} />
            <span className="text-sm font-semibold">Upload Batch</span>
            <span className="section-label">Load your settlement data</span>
          </div>
          {batchPanelOpen
            ? <ChevronUp size={16} style={{ color: 'var(--color-text-muted)' }} />
            : <ChevronDown size={16} style={{ color: 'var(--color-text-muted)' }} />}
        </button>

        {batchPanelOpen && (
          <div
            className="px-5 pb-5 flex flex-col gap-3"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <p className="text-xs pt-4" style={{ color: 'var(--color-text-muted)' }}>
              Paste your batch as JSON, or try it with the sample below (5–10 records).
            </p>

            <div
              className="flex items-center gap-2 text-xs"
              style={{ color: 'var(--color-amber)' }}
            >
              <AlertCircle size={13} className="shrink-0" />
              Keep test batches small — this keeps the demo responsive for everyone reviewing it.
            </div>

            {/* Textarea label */}
            <div className="flex items-center gap-1.5 mt-1" style={{ color: 'var(--color-text-muted)' }}>
              <Code2 size={12} />
              <span className="section-label">Batch input · JSON</span>
            </div>

            <textarea
              value={batchJson}
              onChange={(e) => setBatchJson(e.target.value)}
              rows={12}
              className="mono text-xs w-full p-3 rounded resize-y"
              style={{
                background: 'var(--color-bg-base)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                outline: 'none',
                fontFamily: 'var(--font-mono)',
              }}
              spellCheck={false}
            />

            {batchError && <ErrorBanner message={batchError} onDismiss={() => setBatchError(null)} />}
            {batchSuccess && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                style={{
                  background: 'var(--color-brand-dim)',
                  color: 'var(--color-brand)',
                  border: '1px solid var(--color-brand-border)',
                }}
              >
                <CheckCircle2 size={14} />
                {batchSuccess}
              </div>
            )}

            <div className="flex justify-end">
              <button
                onClick={handleBatchUpload}
                disabled={batchLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-default disabled:opacity-50"
                style={{
                  background: 'var(--color-brand)',
                  color: '#0B0F14',
                }}
              >
                {batchLoading ? (
                  <span
                    className="w-4 h-4 rounded-full animate-spin border-2"
                    style={{ borderColor: '#0B0F1440', borderTopColor: '#0B0F14' }}
                  />
                ) : (
                  <Upload size={14} />
                )}
                {batchLoading ? 'Uploading…' : 'Upload Batch'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Section B: Start New Run ─────────────────────────────────────── */}
      <div
        className="card p-5 flex items-start justify-between gap-4"
      >
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Reconciliation Run
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            Every settlement is matched automatically using deterministic rules. Only cases the
            system can't resolve with certainty go to AI investigation — and AI never closes a
            case on its own. A final deterministic check has to sign off before any exception
            is resolved.
          </p>

          {/* ── How Matching Works disclosure ── */}
          <HowMatchingWorks />
        </div>

        <button
          id="start-run-btn"
          onClick={handleStartRun}
          disabled={isStarting || isRunning}
          className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold transition-default disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            background: isRunning ? 'var(--color-amber-dim)' : 'var(--color-brand)',
            color: isRunning ? 'var(--color-amber)' : '#0B0F14',
            border: isRunning ? '1px solid var(--color-amber-border)' : 'none',
            minWidth: '140px',
          }}
        >
          {isStarting ? (
            <span
              className="w-4 h-4 rounded-full animate-spin border-2"
              style={{ borderColor: '#0B0F1440', borderTopColor: '#0B0F14' }}
            />
          ) : isRunning ? (
            <Clock size={15} />
          ) : (
            <Play size={15} />
          )}
          {isStarting ? 'Starting…' : isRunning ? 'Run in Progress' : 'Start New Run'}
        </button>
      </div>

      {/* Run errors */}
      {runError && <ErrorBanner message={runError} onDismiss={() => setRunError(null)} />}

      {/* ── Section C: Live Progress ─────────────────────────────────────── */}
      {runData && (
        <div className="flex flex-col gap-4">
          {/* Status header */}
          <div className="flex items-center gap-3">
            <RunStatusBadge status={runData.status} />
            {runData.runId && (
              <span className="text-xs mono" style={{ color: 'var(--color-text-muted)' }}>
                Run #{runData.runId}
              </span>
            )}
            {runData.startedAt && (
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Started {new Date(runData.startedAt).toLocaleTimeString()}
              </span>
            )}
            {isCompleted && runData.completedAt && (
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                · Completed {new Date(runData.completedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Stat cards */}
          {progress ? (
            <div className="grid grid-cols-5 gap-3">
              <StatCard
                label="Total Cases"
                value={progress.totalCases}
                icon={Hash}
                accentColor="gray"
              />
              <StatCard
                label="Processed"
                value={progress.processed}
                icon={Layers}
                accentColor="gray"
              />
              {/* Resolved gets a subtle success-green ring - the one card
                  that carries the headline "did this run succeed" signal,
                  given slightly more visual weight than its four siblings.
                  Achieved with a wrapper (not a StatCard prop) so StatCard's
                  existing API stays untouched. */}
              <div
                className="rounded-md"
                style={{ boxShadow: '0 0 0 1px var(--color-success-border)' }}
              >
                <StatCard
                  label="Resolved"
                  value={progress.resolved}
                  icon={CheckCircle2}
                  accentColor="success"
                  description="Finalized by gate"
                />
              </div>
              <StatCard
                label="In Review"
                value={progress.reviewQueued}
                icon={Clock}
                accentColor="amber"
                description="Pending human review"
              />
              <StatCard
                label="Failed"
                value={progress.failed}
                icon={AlertTriangle}
                accentColor="red"
              />
            </div>
          ) : (
            // No progress data yet — show skeleton stat cards while the initial
            // poll hasn't returned data (replaces the plain "Waiting…" text)
            <SkeletonStatCards />
          )}

          {/* Failed banner */}
          {isFailed && (
            <ErrorBanner
              message={`Run #${runData.runId} failed`}
              detail={(runData as RunResponse & { error_message?: string }).error_message ?? 'Check server logs for details, or try starting a new run.'}
            />
          )}
        </div>
      )}

      {/* ── Section D: Route Distribution Chart ─────────────────────────── */}
      {isCompleted && progress && chartData.length > 0 && (
        <div className="card p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3
                className="text-sm font-semibold"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Run Outcome Distribution
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Status breakdown across all {progress.totalCases} cases
              </p>
            </div>
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs"
              style={{
                background: 'var(--color-bg-elevated)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              <Info size={12} />
              Outcome totals only — per-source breakdown available in the Audit trail
            </div>
          </div>

          <div className="flex gap-8 items-center">
            <div style={{ width: 280, height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} strokeWidth={0} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-bg-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '6px',
                      color: 'var(--color-text-primary)',
                      fontSize: '12px',
                    }}
                    formatter={(value, name) => [value, name]}
                  />
                  <Legend
                    formatter={(value) => (
                      <span style={{ color: 'var(--color-text-secondary)', fontSize: '12px' }}>
                        {value}
                      </span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Legend details */}
            <div className="flex flex-col gap-3 flex-1">
              {[
                { label: 'Resolved',  value: progress.resolved,     color: PIE_COLORS.resolved,     desc: 'Finalized by the decision gate' },
                { label: 'In Review', value: progress.reviewQueued, color: PIE_COLORS.reviewQueued, desc: 'Awaiting human review' },
                { label: 'Failed',    value: progress.failed,       color: PIE_COLORS.failed,       desc: 'Could not be automatically resolved' },
              ].map(({ label, value, color, desc }) => (
                <div key={label} className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ background: color }}
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                        {label}
                      </span>
                      <span className="text-sm font-bold mono" style={{ color }}>
                        {value}
                      </span>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Section E: Recent Exceptions Preview ─────────────────────────── */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Recent Exceptions
          </h3>
          {runId && (
            <button
              onClick={() => navigate('/exceptions')}
              className="text-xs font-medium transition-default"
              style={{ color: 'var(--color-brand)' }}
            >
              View All →
            </button>
          )}
        </div>

        {!runId ? (
          <EmptyState
            icon={Play}
            title="No run started"
            message="Start a reconciliation run to see exceptions here."
            action={{ label: 'Start a Run', onClick: handleStartRun }}
          />
        ) : exceptionsLoading ? (
          // P1: inline skeleton for the recent-exceptions preview
          // (3 shimmer rows matching the preview item shape)
          <div role="status" aria-label="Loading exceptions…" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between px-5 py-3.5 gap-4"
                style={{
                  borderBottom: i < 2 ? '1px solid var(--color-border-subtle)' : 'none',
                }}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="skeleton-line h-5 rounded-full" style={{ width: 80, flexShrink: 0 }} />
                  <div className="flex-1 flex flex-col gap-1.5">
                    <div className="skeleton-line h-4 rounded" style={{ width: '60%' }} />
                    <div className="skeleton-line h-3 rounded" style={{ width: '40%' }} />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 items-end shrink-0">
                  <div className="skeleton-line h-4 rounded" style={{ width: 72 }} />
                  <div className="skeleton-line h-3 rounded" style={{ width: 56 }} />
                </div>
              </div>
            ))}
          </div>
        ) : exceptionsError ? (
          <div className="p-5">
            <ErrorBanner message={exceptionsError} onDismiss={() => setExceptionsError(null)} />
          </div>
        ) : !isCompleted ? (
          <div className="px-5 py-8 text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
            Exceptions will appear here once the run completes.
          </div>
        ) : exceptions.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No exceptions — all clear"
            message="All cases were resolved deterministically or via AI investigation."
          />
        ) : (
          <div>
            {exceptions.map((ex, idx) => (
              <div
                key={ex.reviewId}
                className="flex items-center justify-between px-5 py-3.5 gap-4 row-enter"
                style={{
                  borderBottom: idx < exceptions.length - 1 ? '1px solid var(--color-border-subtle)' : 'none',
                  // P3: stagger each preview row; cap at first 10 (only 3 here, but consistent with table)
                  animationDelay: `${Math.min(idx, 9) * 35}ms`,
                }}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <DecisionSourceBadge value="human" size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {humanizeReasonCode(ex.reasonCode)}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {ex.narration ?? ex.settlementEntityId}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right">
                    <p className="text-sm font-semibold mono" style={{ color: 'var(--color-amber)' }}>
                      {formatPaise(ex.exposureAmount)}
                    </p>
                    <p className="text-xs mono" style={{ color: 'var(--color-text-muted)' }}>
                      Priority: {formatDecimal(ex.priorityScore, 0)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
