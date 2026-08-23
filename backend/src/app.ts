import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import apiRouter from './api/router';

const app = express();

// Allow all origins - fine for local dev, but a real production deployment
// should restrict this to the actual frontend's origin instead.
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'alive' });
});

app.use('/api', apiRouter);

// Unmatched routes get a JSON 404, consistent with the rest of this API,
// rather than Express's default HTML error page.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler - must be registered last (4-arg signature is what
// tells Express this is an error handler, not regular middleware).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.issues });
    return;
  }

  console.error(err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

export default app;
