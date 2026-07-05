import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';

/**
 * Forward-only SQL migrations for the pgvector database.
 *
 * Small on purpose. The schema is three tables that exist to cache the demo
 * corpus, and a hosted Postgres (Neon) is the deployment target, so what is
 * actually needed is: apply pending files in order, exactly once, without two
 * deploys racing each other. That does not justify a migration framework.
 *
 * There are no down-migrations. Rolling a schema backwards on a live database
 * is where most migration accidents happen, and this schema is a cache — the
 * recovery path for a bad migration is to fix it forward and re-seed, which
 * costs one seed run rather than a restore.
 */

/** Namespaced lock id so two concurrent deploys serialise instead of racing. */
const ADVISORY_LOCK_ID = 8_147_263_501;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  version: string;
  name: string;
  state: 'applied' | 'pending' | 'modified' | 'missing';
  appliedAt?: Date;
}

export type MigrationLogger = (message: string) => void;

/**
 * Where the .sql files live.
 *
 * Resolved relative to this module so it works both under ts-node (src) and
 * from a compiled build (dist) — nest-cli copies the directory as an asset.
 */
export function migrationsDir(): string {
  return path.join(__dirname, 'migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));

  const migrations = files.map((file) => {
    const match = FILENAME_PATTERN.exec(file);
    if (!match) {
      throw new Error(
        `Migration "${file}" is not named correctly. Use NNNN_lower_snake_case.sql, ` +
          `for example 0003_add_something.sql.`,
      );
    }

    // Normalise line endings before hashing: a checkout that converts LF to CRLF
    // must not read as a modified migration.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');

    return {
      version: match[1],
      name: match[2],
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16),
    };
  });

  migrations.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Two migrations share the version number ${m.version}.`);
    }
    seen.add(m.version);
  }

  return migrations;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      name        TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      duration_ms INTEGER     NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(client: PoolClient): Promise<Map<string, AppliedMigration>> {
  const { rows } = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');

  return new Map(
    rows.map((r) => [
      r.version,
      { version: r.version, name: r.name, checksum: r.checksum, appliedAt: r.applied_at },
    ]),
  );
}

/**
 * Compares the files on disk with what the database says it has run.
 *
 * `modified` means an already-applied file has been edited since — the database
 * no longer matches the file that describes it, and re-running would not fix it.
 * `missing` means the database ran something that is no longer on disk, which
 * usually means the code is older than the database.
 */
export function diffMigrations(
  files: MigrationFile[],
  applied: Map<string, AppliedMigration>,
): MigrationStatus[] {
  const statuses: MigrationStatus[] = files.map((file) => {
    const record = applied.get(file.version);
    if (!record) return { version: file.version, name: file.name, state: 'pending' };
    return {
      version: file.version,
      name: file.name,
      state: record.checksum === file.checksum ? 'applied' : 'modified',
      appliedAt: record.appliedAt,
    };
  });

  const onDisk = new Set(files.map((f) => f.version));
  for (const record of applied.values()) {
    if (!onDisk.has(record.version)) {
      statuses.push({
        version: record.version,
        name: record.name,
        state: 'missing',
        appliedAt: record.appliedAt,
      });
    }
  }

  return statuses.sort((a, b) => a.version.localeCompare(b.version));
}

export async function migrationStatus(pool: Pool, dir?: string): Promise<MigrationStatus[]> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    return diffMigrations(loadMigrations(dir), await readApplied(client));
  } finally {
    client.release();
  }
}

export interface MigrateResult {
  applied: MigrationFile[];
  alreadyUpToDate: boolean;
}

/**
 * Applies every pending migration, in order, each in its own transaction.
 *
 * Per-migration transactions rather than one big one: a failure then leaves the
 * database at a known version — everything before the bad file is committed and
 * recorded — instead of rolling back work that was already correct.
 */
export async function migrate(
  pool: Pool,
  options: { dir?: string; log?: MigrationLogger } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const files = loadMigrations(options.dir);

  const client = await pool.connect();
  try {
    // Held for the whole run so a second deploy waits rather than applying the
    // same file twice.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    try {
      await ensureMigrationsTable(client);
      const applied = await readApplied(client);

      const modified = diffMigrations(files, applied).filter((s) => s.state === 'modified');
      if (modified.length > 0) {
        throw new Error(
          `These migrations were changed after being applied: ` +
            `${modified.map((m) => `${m.version}_${m.name}`).join(', ')}. ` +
            `An applied migration is a record of what the database actually ran, so editing ` +
            `one cannot change the database. Add a new migration instead.`,
        );
      }

      const pending = files.filter((f) => !applied.has(f.version));
      if (pending.length === 0) {
        log(`Database is up to date (${files.length} migration(s) applied).`);
        return { applied: [], alreadyUpToDate: true };
      }

      for (const file of pending) {
        const startedAt = Date.now();
        log(`Applying ${file.version}_${file.name}…`);

        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
             VALUES ($1, $2, $3, $4)`,
            [file.version, file.name, file.checksum, Date.now() - startedAt],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${file.version}_${file.name} failed and was rolled back: ` +
              `${(err as Error).message}`,
          );
        }

        log(`  applied in ${Date.now() - startedAt}ms`);
      }

      return { applied: pending, alreadyUpToDate: false };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
