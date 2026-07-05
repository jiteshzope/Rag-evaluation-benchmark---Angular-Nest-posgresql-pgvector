import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppliedMigration, diffMigrations, loadMigrations, migrationsDir } from './migrator';
import { isTransient } from './pgvector.service';

function writeMigrations(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragbench-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

const applied = (
  version: string,
  name: string,
  checksum: string,
): [string, AppliedMigration] => [
  version,
  { version, name, checksum, appliedAt: new Date('2026-01-01T00:00:00Z') },
];

describe('loadMigrations', () => {
  it('orders by version, not by directory order', () => {
    const dir = writeMigrations({
      '0010_tenth.sql': 'SELECT 10;',
      '0002_second.sql': 'SELECT 2;',
      '0001_first.sql': 'SELECT 1;',
    });

    expect(loadMigrations(dir).map((m) => m.version)).toEqual(['0001', '0002', '0010']);
  });

  it('rejects a filename that does not carry a version', () => {
    const dir = writeMigrations({ 'add_column.sql': 'SELECT 1;' });
    expect(() => loadMigrations(dir)).toThrow(/named correctly/i);
  });

  it('rejects two migrations claiming the same version', () => {
    const dir = writeMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' });
    expect(() => loadMigrations(dir)).toThrow(/share the version number/i);
  });

  it('ignores non-SQL files', () => {
    const dir = writeMigrations({ '0001_first.sql': 'SELECT 1;', 'README.md': 'notes' });
    expect(loadMigrations(dir)).toHaveLength(1);
  });

  /**
   * A Windows checkout can rewrite LF to CRLF. If that changed the checksum,
   * every already-applied migration would read as modified and every deploy
   * from that checkout would refuse to run.
   */
  it('checksums independently of line endings', () => {
    const lf = writeMigrations({ '0001_first.sql': 'SELECT 1;\nSELECT 2;\n' });
    const crlf = writeMigrations({ '0001_first.sql': 'SELECT 1;\r\nSELECT 2;\r\n' });

    expect(loadMigrations(lf)[0].checksum).toBe(loadMigrations(crlf)[0].checksum);
  });

  it('gives different content different checksums', () => {
    const a = writeMigrations({ '0001_first.sql': 'SELECT 1;' });
    const b = writeMigrations({ '0001_first.sql': 'SELECT 2;' });

    expect(loadMigrations(a)[0].checksum).not.toBe(loadMigrations(b)[0].checksum);
  });

  it('reports a missing directory rather than silently finding nothing', () => {
    expect(() => loadMigrations(path.join(os.tmpdir(), 'ragbench-does-not-exist'))).toThrow(
      /not found/i,
    );
  });
});

describe('the shipped migrations', () => {
  it('load and are well formed', () => {
    const migrations = loadMigrations(migrationsDir());
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0].name).toBe('initial_schema');
    for (const m of migrations) expect(m.sql.trim().length).toBeGreaterThan(0);
  });

  /**
   * The first migration is the schema earlier builds applied directly, so it has
   * to be a no-op against a database that already has those objects.
   */
  it('create objects idempotently in the initial migration', () => {
    const initial = loadMigrations(migrationsDir())[0].sql;
    const creates = initial.match(/CREATE (TABLE|INDEX|EXTENSION)[^;]*/gi) ?? [];

    expect(creates.length).toBeGreaterThan(0);
    for (const statement of creates) {
      expect(statement).toMatch(/IF NOT EXISTS/i);
    }
  });
});

describe('diffMigrations', () => {
  const files = loadMigrations(
    writeMigrations({ '0001_first.sql': 'SELECT 1;', '0002_second.sql': 'SELECT 2;' }),
  );

  it('marks everything pending against an empty database', () => {
    expect(diffMigrations(files, new Map()).map((s) => s.state)).toEqual(['pending', 'pending']);
  });

  it('marks matching checksums as applied', () => {
    const db = new Map([applied('0001', 'first', files[0].checksum)]);
    const [first, second] = diffMigrations(files, db);

    expect(first.state).toBe('applied');
    expect(second.state).toBe('pending');
  });

  it('marks an applied file that has since been edited as modified', () => {
    const db = new Map([applied('0001', 'first', 'a-different-checksum')]);
    expect(diffMigrations(files, db)[0].state).toBe('modified');
  });

  it('reports a migration the database ran that is no longer on disk', () => {
    const db = new Map([
      applied('0001', 'first', files[0].checksum),
      applied('0009', 'from_the_future', 'whatever'),
    ]);
    const statuses = diffMigrations(files, db);

    expect(statuses.find((s) => s.version === '0009')?.state).toBe('missing');
  });

  it('keeps statuses in version order', () => {
    const db = new Map([applied('0009', 'from_the_future', 'x')]);
    expect(diffMigrations(files, db).map((s) => s.version)).toEqual(['0001', '0002', '0009']);
  });
});

/**
 * Which failures earn a retry. Getting this wrong in either direction is
 * expensive: too narrow and a serverless cold start re-embeds the corpus, too
 * broad and a genuine SQL error is run twice before surfacing.
 */
describe('isTransient', () => {
  it.each([
    ['ECONNRESET', { code: 'ECONNRESET' }],
    ['ETIMEDOUT', { code: 'ETIMEDOUT' }],
    ['admin shutdown', { code: '57P01' }],
    ['cannot connect now', { code: '57P03' }],
    ['connection failure', { code: '08006' }],
    ['terminated connection', new Error('Connection terminated unexpectedly')],
    ['connect timeout', new Error('timeout exceeded when trying to connect')],
  ])('retries on %s', (_label, err) => {
    expect(isTransient(err)).toBe(true);
  });

  it.each([
    ['undefined table', { code: '42P01' }],
    ['syntax error', { code: '42601' }],
    ['unique violation', { code: '23505' }],
    ['an ordinary error', new Error('column "nope" does not exist')],
    ['null', null],
    ['undefined', undefined],
  ])('does not retry on %s', (_label, err) => {
    expect(isTransient(err)).toBe(false);
  });
});
