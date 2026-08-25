/**
 * AuditLookup — read the audit_events table for any entity.
 *
 * Form: entityType dropdown + entityId number input → GET /api/audit
 *
 * Renders results as a vertical timeline ordered by sequenceNo ASC.
 * Per event, three visually distinct sections (only if non-null):
 *   "Evidence Used"        → gray-bordered box
 *   "AI Raw Output"        → purple-bordered box  (actorType = AI only)
 *   "Decision Gate Output" → teal-bordered box   (actorType = DECISION_GATE only)
 *
 * This visual separation is the concrete proof that AI output and the final
 * decision are never merged into one blob — never collapse these sections.
 */

import { useState } from 'react';
import { Search, ChevronRight } from 'lucide-react';

import {
  getAuditEvents,
  type AuditEvent,
  ApiError,
} from '../api/client';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';
import { ErrorBanner } from '../components/ErrorBanner';
import { DecisionSourceBadge } from '../components/DecisionSourceBadge';

// ─── Entity Types (matches audit_events.entity_type values in backend) ────────

const ENTITY_TYPES = [
  { value: 'settlement',      label: 'Settlement' },
  { value: 'ledger_order',    label: 'Ledger Order' },
  { value: 'match_candidate', label: 'Match Candidate' },
  { value: 'resolution',      label: 'Resolution' },
] as const;

// ─── JSON Evidence Box ────────────────────────────────────────────────────────

interface EvidenceBoxProps {
  title: string;
  /** Border/accent color CSS variable reference */
  accentColor: string;
  borderColor: string;
  bgColor: string;
  data: unknown;
}

function EvidenceBox({ title, accentColor, borderColor, bgColor, data }: EvidenceBoxProps) {
  if (data === null || data === undefined) return null;

  return (
    <div
      className="rounded-md overflow-hidden"
      style={{ border: `1px solid ${borderColor}` }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 flex items-center gap-2"
        style={{ background: bgColor, borderBottom: `1px solid ${borderColor}` }}
      >
        <div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: accentColor }}
        />
        <span
          className="text-xs font-semibold"
          style={{ color: accentColor }}
        >
          {title}
        </span>
      </div>

      {/* JSON body */}
      <pre
        className="mono text-xs p-3 overflow-y-auto"
        style={{
          maxHeight: '300px',
          color: 'var(--color-text-secondary)',
          background: 'var(--color-bg-base)',
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

// ─── Timeline Event ───────────────────────────────────────────────────────────

function TimelineEvent({ event, isLast }: { event: AuditEvent; isLast: boolean }) {
  const [collapsed, setCollapsed] = useState(false);

  // Format stage label
  const stageLabel = event.stage
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const hasEvidence    = event.evidenceUsed !== null && event.evidenceUsed !== undefined;
  const hasAiOutput    = event.aiRawOutput !== null && event.aiRawOutput !== undefined;
  const hasGateOutput  = event.decisionGateOutput !== null && event.decisionGateOutput !== undefined;

  return (
    <div className="flex gap-5">
      {/* Timeline gutter */}
      <div className="flex flex-col items-center" style={{ width: '20px', flexShrink: 0 }}>
        {/* Dot */}
        <div
          className="w-3 h-3 rounded-full border-2 shrink-0 mt-1.5"
          style={{
            borderColor: 'var(--color-teal)',
            background: hasGateOutput ? 'var(--color-teal)' : hasAiOutput ? 'var(--color-purple)' : 'var(--color-bg-surface)',
          }}
        />
        {/* Connector line */}
        {!isLast && (
          <div
            className="flex-1 w-px mt-1"
            style={{ background: 'var(--color-border)', minHeight: '24px' }}
          />
        )}
      </div>

      {/* Event card */}
      <div className="flex-1 pb-6">
        {/* Header */}
        {/* Two anchored groups via justify-between, not one flat inline-flex
            row: DecisionSourceBadge's rendered width varies with actorType
            ("Deterministic" is much wider than "Human" or "AI-Assisted"),
            so with everything in one inline-flex row the seq#/timestamp
            text that followed it landed at a different X per event. Moving
            it into its own right-hand group (with the chevron) anchors it
            to the row's right edge instead - consistent across every event
            regardless of label/badge width, without guessing fixed column
            widths for text that's genuinely variable-length. */}
        <button
          className="w-full text-left flex items-center justify-between gap-3 mb-3"
          onClick={() => setCollapsed((v) => !v)}
        >
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            <span
              className="text-sm font-semibold"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {stageLabel}
            </span>
            <DecisionSourceBadge value={event.actorType} size="sm" />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="section-label whitespace-nowrap">
              seq #{event.sequenceNo} · {new Date(event.createdAt).toLocaleString()}
            </span>
            <ChevronRight
              size={14}
              className="shrink-0 transition-default"
              style={{
                color: 'var(--color-text-muted)',
                transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              }}
            />
          </div>
        </button>

        {/* Evidence sections — three distinct boxes, NEVER collapsed into one */}
        {!collapsed && (
          <div className="flex flex-col gap-3">
            {hasEvidence && (
              <EvidenceBox
                title="Evidence Used"
                accentColor="var(--color-gray)"
                borderColor="var(--color-gray-border)"
                bgColor="var(--color-gray-dim)"
                data={event.evidenceUsed}
              />
            )}

            {hasAiOutput && (
              <EvidenceBox
                title="AI Raw Output"
                accentColor="var(--color-purple)"
                borderColor="var(--color-purple-border)"
                bgColor="var(--color-purple-dim)"
                data={event.aiRawOutput}
              />
            )}

            {hasGateOutput && (
              <EvidenceBox
                title="Decision Gate Output"
                accentColor="var(--color-teal)"
                borderColor="var(--color-teal-border)"
                bgColor="var(--color-teal-dim)"
                data={event.decisionGateOutput}
              />
            )}

            {!hasEvidence && !hasAiOutput && !hasGateOutput && (
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                No evidence payload recorded for this event.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Legend (shown above timeline) ───────────────────────────────────────────

function AuditLegend() {
  return (
    <div
      className="flex items-center gap-6 p-3 rounded-md text-xs"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <span className="section-label mr-1">Evidence boxes:</span>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--color-gray-dim)', border: '1px solid var(--color-gray-border)' }} />
        <span style={{ color: 'var(--color-text-muted)' }}>Evidence Used (system input)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--color-purple-dim)', border: '1px solid var(--color-purple-border)' }} />
        <span style={{ color: 'var(--color-text-muted)' }}>AI Raw Output (never finalized directly)</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--color-teal-dim)', border: '1px solid var(--color-teal-border)' }} />
        <span style={{ color: 'var(--color-text-muted)' }}>Decision Gate Output (the actual finalization)</span>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AuditLookup() {
  const [entityType, setEntityType] = useState<string>('settlement');
  const [entityId, setEntityId]     = useState<string>('');
  const [events, setEvents]         = useState<AuditEvent[] | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [lastQuery, setLastQuery]   = useState<{ entityType: string; entityId: number } | null>(null);

  async function handleLookup() {
    const id = Number(entityId);
    if (!entityId || !Number.isInteger(id)) {
      setError('Please enter a valid integer entity ID.');
      return;
    }

    setLoading(true);
    setError(null);
    setEvents(null);

    try {
      const results = await getAuditEvents(entityType, id);
      // API returns ordered by sequenceNo ASC — no client re-sort needed
      setEvents(results);
      setLastQuery({ entityType, entityId: id });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Audit lookup failed.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Page header */}
      <div>
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: 'var(--color-text-primary)' }}
        >
          Audit Lookup
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          Full decision trail for any entity — evidence used, AI-assisted output, and gate finalization are always kept separate.
        </p>
      </div>

      {/* Lookup Form */}
      <div className="card p-5">
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="entity-type"
              className="section-label"
            >
              Entity Type
            </label>
            <select
              id="entity-type"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="text-sm px-3 py-2 rounded-lg"
              style={{
                background: 'var(--color-bg-base)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                outline: 'none',
                minWidth: '180px',
              }}
            >
              {ENTITY_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="entity-id"
              className="section-label"
            >
              Entity ID
            </label>
            <input
              id="entity-id"
              type="number"
              min="1"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
              placeholder="e.g. 1"
              className="mono text-sm px-3 py-2 rounded-lg w-36"
              style={{
                background: 'var(--color-bg-base)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
                outline: 'none',
              }}
            />
          </div>

          <button
            id="audit-lookup-btn"
            onClick={handleLookup}
            disabled={loading || !entityId}
            className="flex items-center gap-2 px-5 py-2 rounded-md text-sm font-semibold transition-default disabled:opacity-50"
            style={{
              background: 'var(--color-brand)',
              color: '#0B0F14',
            }}
          >
            {loading ? (
              <span
                className="w-4 h-4 rounded-full animate-spin border-2"
                style={{ borderColor: '#0B0F1440', borderTopColor: '#0B0F14' }}
              />
            ) : (
              <Search size={15} />
            )}
            {loading ? 'Looking up…' : 'Look Up'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Loading */}
      {loading && <LoadingSpinner message="Looking up decision trail…" />}

      {/* Pre-search Empty State */}
      {events === null && !loading && !error && (
        <div className="mt-8">
          <EmptyState
            icon={Search}
            title="Ready to search"
            message="Search by settlement, order, match candidate, or resolution ID to see its full decision trail — evidence, AI output, and the final gate decision, always kept separate."
          />
        </div>
      )}

      {/* Results */}
      {events !== null && !loading && (
        <>
          {events.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No audit trail found"
              message={`No audit trail found for ${lastQuery?.entityType} #${lastQuery?.entityId} — double-check the ID, or confirm this entity has actually been processed by a reconciliation run.`}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {/* Results header */}
              <div className="flex items-center justify-between">
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  <span className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                    {events.length} event{events.length !== 1 ? 's' : ''}
                  </span>
                  {' '}for{' '}
                  <span
                    className="mono text-xs px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-brand)' }}
                  >
                    {lastQuery?.entityType}:{lastQuery?.entityId}
                  </span>
                </p>
              </div>

              {/* Legend */}
              <AuditLegend />

              {/* Timeline */}
              <div className="card p-5">
                {events.map((event, idx) => (
                  <TimelineEvent
                    key={event.id}
                    event={event}
                    isLast={idx === events.length - 1}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
