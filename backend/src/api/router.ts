// Aggregates every route module under backend/src/api/routes/ into one
// Router, mounted at /api in app.ts. No webhook endpoint here - explicitly
// descoped for this prompt.

import { Router } from 'express';
import batchesRouter from './routes/batches';
import runsRouter from './routes/runs';
import exceptionsRouter from './routes/exceptions';
import auditRouter from './routes/audit';

const router = Router();

router.use(batchesRouter);
router.use(runsRouter);
router.use(exceptionsRouter);
router.use(auditRouter);

export default router;
