/**
 * Applies the pgvector migrations.
 *
 *     npm run migrate           # apply everything pending
 *     npm run migrate:status    # show what is applied, pending or modified
 *
 * Connection:
 *   DATABASE_URL            the database to migrate
 *   MIGRATION_DATABASE_URL  used instead when set
 *
 * On Neon, point MIGRATION_DATABASE_URL at the *direct* endpoint rather than
 * the pooled one. The pooler runs PgBouncer in transaction mode, where session
 * state does not survive between statements — and this runner holds a session
 * advisory lock across the whole run so two deploys cannot apply the same file
 * twice. Serving traffic through the pooled endpoint is fine and unaffected.
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Pool } from 'pg';

import { migrate, migrationStatus } from '../src/vector-store/migrator';

// Same lookup order the app uses (see AppModule's ConfigModule.envFilePath), so
// the migration targets whatever database the server would talk to.
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/** Neon suspends idle databases; a cold start costs seconds on the first connect. */
const CONNECT_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 20_000);

function connectionString(): string {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'No database configured. Set DATABASE_URL (or MIGRATION_DATABASE_URL) in backend/.env.',
    );
    process.exit(2);
  }
  return url;
}

/** Never print the password when naming the target. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

async function main(): Promise<void> {
  const wantsStatus = process.argv.includes('--status');
  const url = connectionString();

  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  console.log(`Database: ${describeTarget(url)}`);

  try {
    if (wantsStatus) {
      const statuses = await migrationStatus(pool);
      if (statuses.length === 0) {
        console.log('No migrations found.');
        return;
      }

      const width = Math.max(...statuses.map((s) => `${s.version}_${s.name}`.length));
      for (const s of statuses) {
        const when = s.appliedAt ? s.appliedAt.toISOString().replace('T', ' ').slice(0, 19) : '';
        console.log(`  ${`${s.version}_${s.name}`.padEnd(width)}  ${s.state.padEnd(8)} ${when}`);
      }

      const blocked = statuses.filter((s) => s.state === 'modified' || s.state === 'missing');
      if (blocked.length > 0) {
        console.error(
          `\n${blocked.length} migration(s) do not match the database. ` +
            `"modified" means an applied file was edited; "missing" means the database ran ` +
            `something this checkout does not have.`,
        );
        process.exitCode = 1;
      }
      return;
    }

    const result = await migrate(pool, { log: (m) => console.log(m) });
    if (!result.alreadyUpToDate) {
      console.log(`Applied ${result.applied.length} migration(s).`);
    }
  } catch (err) {
    console.error(`\nMigration failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
