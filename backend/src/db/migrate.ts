// Runnable migration script.
//
//   npm run migrate
//
// Runs every *.sql file in migrations/, in filename-sorted order, against
// the configured MySQL database, printing clear success/failure output.
//
// Tracks which migrations have already run in a bootstrapped
// `schema_migrations` table and skips them on subsequent runs - standard
// migration-runner practice, and specifically what makes this idempotent
// even for migrations whose own SQL isn't (e.g. a plain ALTER TABLE ADD
// COLUMN - MySQL 8.0.46, this project's target, does not support
// "ADD COLUMN IF NOT EXISTS" syntax, so tracking is the only thing making
// re-runs safe here, not per-migration idempotent SQL). `schema_migrations`
// itself isn't a numbered migration file; it's bootstrapped directly by
// this script before anything else runs.

import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { config } from '../config';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_schema_migrations_filename (filename)
  ) ENGINE=InnoDB;
`;

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
    await connection.query(SCHEMA_MIGRATIONS_TABLE_SQL);

    const [appliedRows] = await connection.query<mysql.RowDataPacket[]>('SELECT filename FROM schema_migrations');
    const alreadyApplied = new Set(appliedRows.map((row) => row.filename as string));

    for (const file of migrationFiles) {
      if (alreadyApplied.has(file)) {
        console.log(`\n⏭️  ${file} already applied - skipping.`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`\nRunning migration: ${file} ...`);
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log(`✅ ${file} applied.`);
    }

    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
    console.log('\n✅ All migrations up to date.');
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
