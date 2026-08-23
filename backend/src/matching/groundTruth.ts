// Shared ground-truth loading for the matching pipeline's training and
// verification scripts.
//
// See backend/src/db/seed.ts: every ground-truth entry's `order_id` field
// already holds the CANONICAL/true ledger_orders.order_id for that
// settlement - even for CORRUPTED_TRUNCATED/CORRUPTED_SUBSTITUTED entries,
// whose actual stored ingested_settlements.order_id is the corrupted value.
// That is exactly the "true order" mapping Fellegi-Sunter training needs
// (see Step 0 of this prompt), so no separate `trueOrderId` field or
// seed.ts change was necessary - see buildTrainingLabels.ts for where this
// is used.

import fs from 'fs';
import path from 'path';

export interface GroundTruthEntry {
  entity_id: string | null;
  order_id: string;
  category: string;
}

const GROUND_TRUTH_PATH = path.join(__dirname, '..', 'db', 'ground-truth.json');

export function loadGroundTruth(): GroundTruthEntry[] {
  const raw = fs.readFileSync(GROUND_TRUTH_PATH, 'utf-8');
  return JSON.parse(raw) as GroundTruthEntry[];
}
