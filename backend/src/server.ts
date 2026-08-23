// Importing config first ensures env vars are validated (and the process
// exits with a clear error) before the server ever starts listening.
import { config } from './config';
import mysql from 'mysql2/promise';
import { getPool } from './db/pool';
import app from './app';

const PORT = 3000;

/**
 * Any batch_runs row still in 'processing' at startup means the process
 * that was running it crashed or was restarted before it finished - it can
 * never complete now (the fire-and-forget async work that would have
 * finished it is gone). Marked 'failed' with a clear error_message rather
 * than left stuck in 'processing' forever, which would otherwise
 * permanently trip POST /api/runs's "a run is already in progress" guard.
 */
async function recoverStaleRuns(): Promise<void> {
  const pool = getPool();
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE batch_runs
     SET status = 'failed', error_message = 'Interrupted by server restart.', completed_at = NOW()
     WHERE status = 'processing'`,
  );
  if (result.affectedRows > 0) {
    console.log(`⚠️  Recovered ${result.affectedRows} stale run(s) left in 'processing' state (server must have restarted mid-run).`);
  }
}

async function start(): Promise<void> {
  await recoverStaleRuns();

  app.listen(PORT, () => {
    console.log(`🚀 Server listening at http://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   Connected DB target: ${config.db.host}/${config.db.database}`);
  });
}

start().catch((err) => {
  console.error('❌ Server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
