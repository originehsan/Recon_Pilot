/**
 * Exceptions — human review queue.
 *
 * Fetches GET /api/runs/:id/exceptions and renders a sortable table.
 * Each row has an inline expand form for Approve / Reject / Mark Unresolved.
 * On successful resolve (200), the row is removed from local state.
 *
 * If no runId is in context (e.g. direct URL navigation), shows EmptyState.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2, XCircle, HelpCircle, ChevronDown, ChevronUp,
  RefreshCw, AlertTriangle,
} from 'lucide-react';

import {
  getExceptions, resolveException,
  type Exception, type ResolvePayload,
  ApiError,
} from '../api/client';
import { useRunContext } from '../context/RunContext';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { DecisionSourceBadge } from '../components/DecisionSourceBadge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPaise(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

// ─── Inline Resolve Form ──────────────────────────────────────────────────────

interface ResolveFormProps {
  exception: Exception;
  onResolved: (reviewId: number) => void;
  onCancel: () => void;
}

function ResolveForm({ exception, onResolved, onCancel }: ResolveFormProps) {
  const [ledgerOrderId, setLedgerOrderId] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null); // action key being submitted
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(action: ResolvePayload['action']) {
    setFormError(null);

    if (action === 'approve_match') {
      const id = Number(ledgerOrderId);
      if (!ledgerOrderId || !Number.isInteger(id) || id <= 0) {
        setFormError('A valid Ledger Order ID is required to approve a match.');
        return;
      }
    }

    setSubmitting(action);

    const payload: ResolvePayload = {
      action,
      ledgerOrderId: action === 'approve_match' ? Number(ledgerOrderId) : null,
    };

    try {
      await resolveException(exception.reviewId, payload);
      onResolved(exception.reviewId);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Resolution failed — please try again.';
      setFormError(msg);
    } finally {
      setSubmitting(null);
    }
  }

  const isBusy = submitting !== null;

  return (
    <div
      className="px-6 py-4 flex flex-col gap-4"
      style={{
        background: 'var(--color-bg-elevated)',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold section-label">Resolve Exception #{exception.reviewId}</span>
      </div>

      {formError && (
        <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />
      )}

      {/* Approve Match — requires ledgerOrderId */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label
            htmlFor={`ledger-order-${exception.reviewId}`}
            className="text-xs font-medium block mb-1"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Ledger Order ID <span style={{ color: 'var(--color-red)' }}>*</span>
            <span className="ml-1" style={{ color: 'var(--color-text-muted)' }}>
              (required for Approve Match)
            </span>
          </label>
          <input
            id={`ledger-order-${exception.reviewId}`}
            type="number"
            min="1"
            value={ledgerOrderId}
            onChange={(e) => setLedgerOrderId(e.target.value)}
            placeholder="e.g. 42"
            disabled={isBusy}
            className="mono text-sm px-3 py-2 rounded-lg w-40"
            style={{
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-primary)',
              outline: 'none',
            }}
          />
        </div>

        <button
          id={`approve-btn-${exception.reviewId}`}
          onClick={() => submit('approve_match')}
          disabled={isBusy || !ledgerOrderId}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-default disabled:opacity-40 mt-5"
          style={{
            background: 'var(--color-brand-dim)',
            color: 'var(--color-brand)',
            border: '1px solid var(--color-brand-border)',
          }}
        >
          {submitting === 'approve_match' ? (
            <span
              className="w-4 h-4 rounded-full animate-spin border-2"
              style={{ borderColor: 'var(--color-brand-border)', borderTopColor: 'var(--color-brand)' }}
            />
          ) : (
            <CheckCircle2 size={14} />
          )}
          Approve Match
        </button>
      </div>

      {/* Other actions */}
      <div className="flex items-center gap-3">
        <button
          id={`reject-btn-${exception.reviewId}`}
          onClick={() => submit('reject')}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-default disabled:opacity-40"
          style={{
            background: 'transparent',
            color: 'var(--color-red)',
            border: '1px solid var(--color-red-border)',
          }}
        >
          {submitting === 'reject' ? (
            <span
              className="w-4 h-4 rounded-full animate-spin border-2"
              style={{ borderColor: 'var(--color-red-border)', borderTopColor: 'var(--color-red)' }}
            />
          ) : (
            <XCircle size={14} />
          )}
          Reject
        </button>

        <button
          id={`unresolved-btn-${exception.reviewId}`}
          onClick={() => submit('mark_unresolved')}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-default disabled:opacity-40"
          style={{
            background: 'transparent',
            color: 'var(--color-gray)',
            border: '1px solid var(--color-gray-border)',
          }}
        >
          {submitting === 'mark_unresolved' ? (
            <span
              className="w-4 h-4 rounded-full animate-spin border-2"
              style={{ borderColor: 'var(--color-gray-border)', borderTopColor: 'var(--color-gray)' }}
            />
          ) : (
            <HelpCircle size={14} />
          )}
          Mark Unresolved
        </button>

        <button
          onClick={onCancel}
          disabled={isBusy}
          className="ml-auto text-xs transition-default disabled:opacity-40"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Exception Row ────────────────────────────────────────────────────────────

interface ExceptionRowProps {
  exception: Exception;
  isExpanded: boolean;
  onToggle: () => void;
  onResolved: (reviewId: number) => void;
}

function ExceptionRow({ exception: ex, isExpanded, onToggle, onResolved }: ExceptionRowProps) {
  return (
    <>
      <tr
        className="transition-default cursor-pointer"
        onClick={onToggle}
        style={{
          background: isExpanded ? 'var(--color-bg-elevated)' : undefined,
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)';
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = '';
        }}
      >
        {/* Reason */}
        <td className="px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <DecisionSourceBadge value="human" size="sm" />
            <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {humanizeReasonCode(ex.reasonCode)}
            </span>
          </div>
        </td>

        {/* Exposure */}
        <td className="px-5 py-3.5">
          <span
            className="text-sm font-semibold mono"
            style={{ color: 'var(--color-amber)' }}
          >
            {formatPaise(ex.exposureAmount)}
          </span>
        </td>

        {/* Narration */}
        <td className="px-5 py-3.5">
          {ex.narration ? (
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {ex.narration}
            </span>
          ) : (
            <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>—</span>
          )}
        </td>

        {/* Priority Score */}
        <td className="px-5 py-3.5 text-right">
          <span
            className="mono text-sm font-medium"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {ex.priorityScore.toFixed(4)}
          </span>
        </td>

        {/* Expand */}
        <td className="px-5 py-3.5 text-right">
          <button
            id={`resolve-toggle-${ex.reviewId}`}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="flex items-center gap-1.5 ml-auto px-3 py-1.5 rounded-lg text-xs font-medium transition-default"
            style={{
              background: isExpanded ? 'var(--color-brand-dim)' : 'var(--color-bg-elevated)',
              color: isExpanded ? 'var(--color-brand)' : 'var(--color-text-secondary)',
              border: `1px solid ${isExpanded ? 'var(--color-brand-border)' : 'var(--color-border)'}`,
            }}
          >
            Resolve
            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </td>
      </tr>

      {/* Inline Resolve Form */}
      {isExpanded && (
        <tr>
          <td colSpan={5} className="p-0">
            <ResolveForm
              exception={ex}
              onResolved={onResolved}
              onCancel={onToggle}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function Exceptions() {
  const navigate = useNavigate();
  const { runId } = useRunContext();

  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);

    try {
      const rows = await getExceptions(runId);
      // Sort defensively by priorityScore DESC
      const sorted = [...rows].sort((a, b) => b.priorityScore - a.priorityScore);
      setExceptions(sorted);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load exceptions.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleToggle(reviewId: number) {
    setExpandedId((prev) => (prev === reviewId ? null : reviewId));
  }

  function handleResolved(reviewId: number) {
    // Remove the resolved row immediately after confirmed 200 response
    setExceptions((prev) => prev.filter((ex) => ex.reviewId !== reviewId));
    setExpandedId(null);
  }

  // ── No runId case (direct URL navigation) ────────────────────────────────
  if (!runId) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="No active run"
        message="Navigate to the Dashboard to start a reconciliation run first."
        action={{ label: 'Go to Dashboard', onClick: () => navigate('/') }}
      />
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return <LoadingSpinner message="Loading exceptions…" size="lg" />;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--color-text-primary)' }}
          >
            Exceptions
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            Cases the decision gate could not auto-finalize · Run #{runId}
          </p>
        </div>

        <button
          id="refresh-exceptions-btn"
          onClick={() => void load()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-default"
          style={{
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border)',
          }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Empty state */}
      {!error && exceptions.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title="No exceptions — all clear"
          message="All cases in this run were resolved without requiring human review."
        />
      )}

      {/* Table */}
      {exceptions.length > 0 && (
        <div
          className="card overflow-hidden"
        >
          {/* Legend */}
          <div
            className="flex items-center gap-6 px-5 py-3"
            style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-elevated)' }}
          >
            <span className="section-label">
              {exceptions.length} exception{exceptions.length !== 1 ? 's' : ''} pending review
            </span>
            <div className="flex items-center gap-1.5">
              <DecisionSourceBadge value="human" size="sm" />
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                = awaiting human decision
              </span>
            </div>
          </div>

          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {[
                  { label: 'Reason', align: 'left' },
                  { label: 'Exposure', align: 'left' },
                  { label: 'Narration', align: 'left' },
                  { label: 'Priority Score', align: 'right' },
                  { label: '', align: 'right' },
                ].map(({ label, align }) => (
                  <th
                    key={label}
                    className={`px-5 py-3 text-${align}`}
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <span className="section-label">{label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex) => (
                <ExceptionRow
                  key={ex.reviewId}
                  exception={ex}
                  isExpanded={expandedId === ex.reviewId}
                  onToggle={() => handleToggle(ex.reviewId)}
                  onResolved={handleResolved}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
