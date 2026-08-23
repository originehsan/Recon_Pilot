// Runnable migration script.
//
//   npm run migrate
//
// Runs every *.sql file in migrations/, in filename-sorted order, against
// the configured MySQL database, printing clear success/failure output.
// Migrations are meant to run once each; re-running a migration that isn't
// itself idempotent (e.g. an ALTER TABLE ADD COLUMN) will fail loudly rather
// than silently - that's a legitimate, clearly-reported signal that it was
// already applied, not a bug.

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../config';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(): Promise<void> {
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  console.log(`Found ${migrationFiles.length} migration file(s) in ${MIGRATIONS_DIR}:`);
  for (const file of migrationFiles) console.log(`  - ${file}`);

  console.log(`\nConnecting to MySQL at ${config.db.host} (database: ${config.db.database})...`);
  const connection = await mysql.createConnection({
    host: config.db.host,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`\nRunning migration: ${file} ...`);
      await connection.query(sql);
      console.log(`✅ ${file} applied.`);
    }

    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
    console.log('\n✅ All migrations completed successfully.');
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
