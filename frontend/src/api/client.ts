/**
 * ReconPilot API Client
 *
 * Typed fetch wrappers for every backend endpoint.
 * All functions throw ApiError on non-2xx responses.
 *
 * Error shape from backend (app.ts global error handler):
 *   { error: string }              — all non-2xx
 *   { error: string, details: [] } — Zod validation (400)
 */

// ─── Error Type ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  public readonly status: number;
  public readonly details?: unknown[];

  constructor(status: number, message: string, details?: unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    return res.json() as Promise<T>;
  }

  let body: { error?: string; details?: unknown[] } = {};
  try {
    body = await res.json();
  } catch {
    // response body wasn't JSON — use status text
  }

  throw new ApiError(
    res.status,
    body.error ?? `HTTP ${res.status}: ${res.statusText}`,
    body.details,
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Matches orchestrate.ts ProgressCounts exactly */
export interface ProgressCounts {
  totalCases: number;
  processed: number;
  resolved: number;
  reviewQueued: number;
  failed: number;
}

export type RunStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** GET /api/runs/:id response */
export interface RunResponse {
  runId: number;
  status: RunStatus;
  progress: ProgressCounts | null; // null until processing starts
  startedAt: string | null;
  completedAt: string | null;
  error_message?: string; // present if status === 'failed'
}

/** POST /api/runs — 202 success */
export interface CreateRunSuccess {
  runId: number;
  status: 'pending';
}

/** POST /api/runs — 409 conflict (a run is already in progress) */
export interface RunConflict {
  error: string;
  existingRunId: number;
}

/** GET /api/runs/:id/exceptions — one row */
export interface Exception {
  reviewId: number;
  reasonCode: string;
  exposureAmount: number; // stored as DECIMAL in DB (paise), numeric here
  priorityScore: number;
  status: 'pending' | 'resolved' | 'dismissed';
  settlementEntityId: string;
  settlementAmount: number;
  narration: string | null;
  createdAt: string;
}

/** POST /api/exceptions/:id/resolve — request body */
export interface ResolvePayload {
  action: 'approve_match' | 'reject' | 'mark_unresolved';
  ledgerOrderId: number | null;
  notes?: string;
}

/** POST /api/exceptions/:id/resolve — response */
export interface ResolveResponse {
  decision: unknown; // ResolvedDecision branded type from backend (opaque to frontend)
}

/** actorType values from audit_events.actor_type ENUM */
export type ActorType = 'SYSTEM' | 'AI' | 'HUMAN' | 'DECISION_GATE';

/** GET /api/audit — one event row */
export interface AuditEvent {
  id: number;
  entityType: string;
  entityId: number;
  stage: string;
  actorType: ActorType;
  evidenceUsed: unknown | null;   // JSON column — parsed by mysql2
  aiRawOutput: unknown | null;    // null unless actorType === 'AI'
  decisionGateOutput: unknown | null; // null unless actorType === 'DECISION_GATE'
  sequenceNo: number;
  createdAt: string;
}

/** POST /api/batches — request body (matches BatchUploadSchema) */
export interface BatchUploadPayload {
  settlements: Array<{
    entityId: string;
    type: string;
    settlementId: string | null;
    settlementUtr: string | null;
    orderId: string | null;
    paymentId: string | null;
    amount: number;
    fee: number;
    tax: number;
    onHold: boolean;
    disputeId: string | null;
    creditType: string | null;
    narration: string | null;
  }>;
  orders: Array<{
    orderId: string;
    expectedAmount: number;
    expectedReference: string | null;
    expectedDate: string | null;
  }>;
}

/** POST /api/batches — 201 response */
export interface BatchUploadResponse {
  batchId: number;
  settlementsInserted: number;
  ordersInserted: number;
  skippedSettlements?: Array<{ index: number; reason: string }>;
  skippedOrders?: Array<{ index: number; reason: string }>;
}

// ─── Endpoint Wrappers ────────────────────────────────────────────────────────

/**
 * POST /api/batches
 * Uploads settlements and orders for processing.
 * Returns 201 with batch summary.
 */
export async function uploadBatch(payload: BatchUploadPayload): Promise<BatchUploadResponse> {
  const res = await fetch('/api/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<BatchUploadResponse>(res);
}

/**
 * POST /api/runs
 * Kicks off the full reconciliation pipeline asynchronously.
 * Returns 202 with runId on success.
 * Throws ApiError with status 409 + existingRunId if a run is already in progress.
 */
export async function createRun(): Promise<CreateRunSuccess> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (res.status === 409) {
    const body = (await res.json()) as RunConflict;
    // Surface existingRunId via ApiError so callers can recover gracefully
    const err = new ApiError(409, body.error, undefined);
    (err as ApiError & { existingRunId: number }).existingRunId = body.existingRunId;
    throw err;
  }

  return handleResponse<CreateRunSuccess>(res);
}

/**
 * GET /api/runs/:id
 * Polls run status. Returns progress counts and status.
 */
export async function getRun(runId: number): Promise<RunResponse> {
  const res = await fetch(`/api/runs/${runId}`);
  return handleResponse<RunResponse>(res);
}

/**
 * GET /api/runs/:id/exceptions
 * Returns the global review queue (sorted by priorityScore DESC from API;
 * also sorted client-side as a defensive measure).
 */
export async function getExceptions(runId: number): Promise<Exception[]> {
  const res = await fetch(`/api/runs/${runId}/exceptions`);
  return handleResponse<Exception[]>(res);
}

/**
 * POST /api/exceptions/:id/resolve
 * Finalizes a human review decision through the decision gate.
 * The `id` here is review_queue.id (reviewId from getExceptions).
 */
export async function resolveException(
  reviewId: number,
  payload: ResolvePayload,
): Promise<ResolveResponse> {
  const res = await fetch(`/api/exceptions/${reviewId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<ResolveResponse>(res);
}

/**
 * GET /api/audit?entityType=&entityId=
 * Returns audit events for a given entity, ordered by sequenceNo ASC.
 */
export async function getAuditEvents(
  entityType: string,
  entityId: number,
): Promise<AuditEvent[]> {
  const params = new URLSearchParams({
    entityType,
    entityId: String(entityId),
  });
  const res = await fetch(`/api/audit?${params.toString()}`);
  return handleResponse<AuditEvent[]>(res);
}
