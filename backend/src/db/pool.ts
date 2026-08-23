// Shared connection pool for library code (decisionGate/, audit/) that gets
// used both from the orchestration layer and from verification scripts -
// as opposed to standalone scripts (seed.ts, matching/dbLoader.ts) that
// manage their own short-lived pool. Centralizing this one gives tests a
// single module to mock (`vi.mock('../../db/pool')`) instead of mocking
// mysql2 directly in every file that touches the database.

import mysql from 'mysql2/promise';
import { config } from '../config';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    });
  }
  return pool;
}
