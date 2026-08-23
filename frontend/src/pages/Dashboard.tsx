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
  AlertTriangle, Clock, Hash, Layers, Info,
} from 'lucide-react';

import {
  createRun, getRun, getExceptions, uploadBatch,
  type RunResponse, type Exception, type BatchUploadPayload,
  ApiError,
} from '../api/client';
import { useRunContext } from '../context/RunContext';
import { StatCard } from '../components/StatCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { DecisionSourceBadge } from '../components/DecisionSourceBadge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format paise integer as ₹ with Indian locale formatting */
function formatPaise(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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
    pending:    { color: 'var(--color-gray)',  bg: 'var(--color-gray-dim)',  border: 'var(--color-gray-border)',  label: 'Pending' },
    processing: { color: 'var(--color-amber)', bg: 'var(--color-amber-dim)', border: 'var(--color-amber-border)', label: 'Processing…' },
    completed:  { color: 'var(--color-success)', bg: 'var(--color-success-dim)', border: 'var(--color-success-border)', label: 'Completed' },
    failed:     { color: 'var(--color-red)',   bg: 'var(--color-red-dim)',   border: 'var(--color-red-border)',   label: 'Failed' },
  } as const;

  const cfg = configs[status as keyof typeof configs] ?? configs.pending;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold"
      style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}` }}
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

// ─── Pie chart colors — MUST match DecisionSourceBadge semantics ──────────────
// Note: GET /api/runs/:id progress does not expose per-decidedBy breakdown.
// This chart shows RUN STATUS breakdown: Resolved / In Review / Failed.
// Teal=resolved, Amber=reviewQueued, Red=failed — matching badge color semantics.
const PIE_COLORS = {
  resolved:     '#14B8A6',
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
    <div className="flex flex-col gap-5">

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
            <span className="section-label">Paste JSON payload to seed the database</span>
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
              Paste a JSON payload matching the{' '}
              <code
                className="px-1 rounded mono"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-brand)' }}
              >
                POST /api/batches
              </code>{' '}
              schema. A small sample (5–10 records) is pre-filled below.{' '}
              <strong style={{ color: 'var(--color-amber)' }}>
                ⚠ Use a small batch to conserve Gemini API quota.
              </strong>
            </p>

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
        className="card p-5 flex items-center justify-between gap-4"
      >
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            Reconciliation Run
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            Runs the full pipeline: hash matching → Fellegi-Sunter scoring → Hungarian algorithm →
            AI investigation (only for ambiguous cases) → decision gate finalization.
          </p>
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
              <StatCard
                label="Resolved"
                value={progress.resolved}
                icon={CheckCircle2}
                accentColor="success"
                description="Finalized by gate"
              />
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
            <div
              className="card p-4 text-sm"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Waiting for pipeline to start…
            </div>
          )}

          {/* Failed banner */}
          {isFailed && (
            <ErrorBanner
              message={`Run #${runData.runId} failed`}
              detail={(runData as RunResponse & { error_message?: string }).error_message ?? 'Check backend logs for details.'}
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
              Status breakdown · per-decidedBy breakdown not available from run summary API
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
                { label: 'Resolved', value: progress.resolved,     color: PIE_COLORS.resolved,     desc: 'Finalized through decision gate' },
                { label: 'In Review', value: progress.reviewQueued, color: PIE_COLORS.reviewQueued, desc: 'Queued for human review' },
                { label: 'Failed',   value: progress.failed,       color: PIE_COLORS.failed,       desc: 'Pipeline error or unresolvable' },
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
          <LoadingSpinner message="Loading exceptions…" />
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
                className="flex items-center justify-between px-5 py-3.5 gap-4"
                style={{
                  borderBottom: idx < exceptions.length - 1 ? '1px solid var(--color-border-subtle)' : 'none',
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
                      Priority: {ex.priorityScore.toFixed(4)}
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
