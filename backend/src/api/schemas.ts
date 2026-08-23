// Zod request-body schemas for backend/src/api/routes/. Field names for
// BatchUploadSchema mirror ingested_settlements/ledger_orders' own DB
// columns exactly (this is the raw-ingestion shape, not
// matching/types.ts's Settlement/LedgerOrder - those are the pipeline's
// internal, DB-loaded/transformed shape, a different layer entirely; see
// dbLoader.ts). No mismatch to reconcile there.

import { z } from 'zod';

export const BatchUploadSchema = z.object({
  settlements: z
    .array(
      z.object({
        entityId: z.string(),
        type: z.string(),
        settlementId: z.string().nullable(),
        settlementUtr: z.string().nullable(),
        orderId: z.string().nullable(),
        paymentId: z.string().nullable(),
        amount: z.number().int(),
        fee: z.number().int(),
        tax: z.number().int(),
        onHold: z.boolean().default(false),
        disputeId: z.string().nullable(),
        creditType: z.string().nullable(),
        narration: z.string().nullable(),
      }),
    )
    .min(1),
  orders: z
    .array(
      z.object({
        orderId: z.string(),
        expectedAmount: z.number().int(),
        expectedReference: z.string().nullable(),
        expectedDate: z.string().nullable(),
      }),
    )
    .min(1),
});

export type BatchUploadInput = z.infer<typeof BatchUploadSchema>;

// batchId is validated here but, per Step 0's explicit scope decision,
// intentionally never used to filter what a run processes - runFullPipeline
// and every existing verification script already process ALL unresolved
// settlements/orders in the DB regardless of batch_id. Accepted (and
// ignored) rather than removed from the schema, so a caller that sends it
// isn't rejected for a field the prompt's own Step 1 explicitly specifies.
export const CreateRunSchema = z.object({ batchId: z.number().int().optional() });

export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export const ResolveExceptionSchema = z.object({
  action: z.enum(['approve_match', 'reject', 'mark_unresolved']),
  ledgerOrderId: z.number().int().nullable(),
  notes: z.string().max(1000).optional(),
});

export type ResolveExceptionInput = z.infer<typeof ResolveExceptionSchema>;
