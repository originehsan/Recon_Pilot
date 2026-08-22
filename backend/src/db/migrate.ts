// Runnable migration script.
//
//   npm run migrate
//
// Reads 001_initial_schema.sql and executes it against the configured
// MySQL database, printing clear success/failure output.

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../config';

const MIGRATION_FILE = path.join(__dirname, 'migrations', '001_initial_schema.sql');

async function migrate(): Promise<void> {
  console.log(`Reading migration file: ${MIGRATION_FILE}`);
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf-8');

  console.log(`Connecting to MySQL at ${config.db.host} (database: ${config.db.database})...`);
  const connection = await mysql.createConnection({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    console.log('Running migration: 001_initial_schema.sql ...');
    await connection.query(sql);

    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
    console.log('✅ Migration completed successfully.');
    console.log(`   ${tables.length} table(s) present in database '${config.db.database}':`);
    for (const row of tables) {
      console.log(`   - ${Object.values(row)[0]}`);
    }
  } catch (err) {
    console.error('❌ Migration failed:');
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}

migrate();
