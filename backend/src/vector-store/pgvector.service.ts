import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfig } from '../config/app-config';
import { Chunk, StrategyId } from '../common/types';
import { SerializedGraph } from '../rag/graph/graph.types';
import { migrate } from './migrator';

export interface StoredChunk {
  chunk: Chunk;
  embedding: Float32Array;
  contextHeader: string | null;
}

export interface DefaultKbManifest {
  documentCount: number;
  totalChars: number;
  corpusFingerprint: string;
  embeddingModel: string;
  seededAt: string;
}

export interface StrategyCoverage {
  strategy: StrategyId;
  chunkCount: number;
}

/**
 * pgvector access, scoped to the pre-embedded default knowledge base.
 *
 * There is intentionally no write path for user data here. Uploaded corpora,
 * evaluation runs and results never touch Postgres — they live in memory for the
 * lifetime of one experiment. This table exists only so the demo corpus does not
 * have to be re-embedded (and re-graph-extracted) on every visit.
 */
@Injectable()
export class PgVectorService implements OnModuleDestroy {
  private readonly logger = new Logger(PgVectorService.name);
  private pool: Pool | null = null;
  private available: boolean | null = null;

  constructor(private readonly config: AppConfig) {}

  getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.databaseUrl,
        max: 4,
        // Generous, because a serverless Postgres (Neon) suspends when idle and
        // the first connection after that has to wait for it to wake. TLS comes
        // from sslmode in the connection string.
        connectionTimeoutMillis: this.config.pgConnectTimeoutMs,
        idleTimeoutMillis: 30_000,
      });
      this.pool.on('error', (err) => this.logger.error(`pg pool error: ${err.message}`));
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  /**
   * Is the pre-embedded corpus usable?
   *
   * Only a definite answer is cached. A connection that timed out or was
   * refused says nothing about whether the corpus is seeded — and on a
   * serverless Postgres that is the *expected* result of the first request
   * after the database has been idle. Caching that as "unavailable" would make
   * one cold start re-embed the whole corpus on every later run, at real cost,
   * until the process restarted. So transient failures are retried, and only a
   * successful query (or a genuinely absent table) settles the flag.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;

    try {
      const result = await this.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM default_kb_chunks',
      );
      this.available = Number(result.rows[0]?.count ?? 0) > 0;
      return this.available;
    } catch (err) {
      // 42P01 = undefined_table: reachable database, migrations not run. That is
      // a real answer, so cache it.
      if ((err as { code?: string }).code === '42P01') {
        this.logger.warn(
          'Connected, but default_kb_chunks does not exist. Run "npm run migrate" and ' +
            '"npm run seed"; until then the default corpus is embedded on demand.',
        );
        this.available = false;
        return false;
      }

      this.logger.warn(
        `Could not reach pgvector (${(err as Error).message}). Falling back to embedding the ` +
          `default corpus on demand for this request; the next one will try again.`,
      );
      return false;
    }
  }

  /**
   * Query with one retry.
   *
   * A suspended serverless database drops the pooled socket, so the first
   * statement after an idle period can fail on a connection that looked healthy.
   * That failure is not a real error — retrying once turns it into latency.
   */
  private async query<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    try {
      return await this.getPool().query<T>(sql, params);
    } catch (err) {
      if (!isTransient(err)) throw err;
      this.logger.debug(`Retrying after a transient pg error: ${(err as Error).message}`);
      return this.getPool().query<T>(sql, params);
    }
  }

  /** Forget the cached availability flag — used by the seed script. */
  resetAvailability(): void {
    this.available = null;
  }

  /** Brings the schema up to date. Safe to call when it already is. */
  async migrate(): Promise<void> {
    const result = await migrate(this.getPool(), { log: (m) => this.logger.log(m) });
    if (!result.alreadyUpToDate) {
      this.logger.log(`Applied ${result.applied.length} migration(s)`);
    }
  }

  // ── Reads (runtime) ───────────────────────────────────────────────────────

  /** Every stored chunk for one strategy, in document order. */
  async loadChunks(strategy: StrategyId): Promise<StoredChunk[]> {
    const { rows } = await this.getPool().query<{
      chunk_id: string;
      doc_id: string;
      doc_title: string;
      category: string;
      ordinal: number;
      heading_path: string[];
      text: string;
      embed_text: string;
      context_header: string | null;
      char_start: number;
      char_end: number;
      token_estimate: number;
      embedding: string;
    }>(
      `SELECT chunk_id, doc_id, doc_title, category, ordinal, heading_path, text, embed_text,
              context_header, char_start, char_end, token_estimate, embedding::text AS embedding
         FROM default_kb_chunks
        WHERE strategy = $1
        ORDER BY doc_id, ordinal`,
      [strategy],
    );

    return rows.map((r) => ({
      chunk: {
        id: r.chunk_id,
        docId: r.doc_id,
        docTitle: r.doc_title,
        category: r.category,
        ordinal: r.ordinal,
        text: r.text,
        embedText: r.embed_text,
        headingPath: r.heading_path ?? [],
        charStart: r.char_start,
        charEnd: r.char_end,
        tokenEstimate: r.token_estimate,
      },
      embedding: parseVector(r.embedding),
      contextHeader: r.context_header,
    }));
  }

  async loadGraph(strategy: StrategyId = 'graphrag'): Promise<SerializedGraph | null> {
    const { rows } = await this.getPool().query<{ payload: SerializedGraph }>(
      'SELECT payload FROM default_kb_graph WHERE strategy = $1',
      [strategy],
    );
    return rows[0]?.payload ?? null;
  }

  async getManifest(): Promise<DefaultKbManifest | null> {
    try {
      const { rows } = await this.getPool().query<{
        document_count: number;
        total_chars: number;
        corpus_fingerprint: string;
        embedding_model: string;
        seeded_at: Date;
      }>('SELECT * FROM default_kb_manifest WHERE id = 1');

      const row = rows[0];
      if (!row) return null;

      return {
        documentCount: row.document_count,
        totalChars: row.total_chars,
        corpusFingerprint: row.corpus_fingerprint,
        embeddingModel: row.embedding_model,
        seededAt: row.seeded_at.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async getCoverage(): Promise<StrategyCoverage[]> {
    try {
      const { rows } = await this.getPool().query<{ strategy: string; count: string }>(
        'SELECT strategy, count(*)::text AS count FROM default_kb_chunks GROUP BY strategy',
      );
      return rows.map((r) => ({ strategy: r.strategy as StrategyId, chunkCount: Number(r.count) }));
    } catch {
      return [];
    }
  }

  // ── Writes (seed script only) ─────────────────────────────────────────────

  async clearStrategy(strategy: StrategyId): Promise<void> {
    await this.getPool().query('DELETE FROM default_kb_chunks WHERE strategy = $1', [strategy]);
    await this.getPool().query('DELETE FROM default_kb_graph WHERE strategy = $1', [strategy]);
  }

  async clearAll(): Promise<void> {
    await this.getPool().query('TRUNCATE default_kb_chunks, default_kb_graph, default_kb_manifest');
  }

  /** Bulk insert. Batched so one statement never carries thousands of vectors. */
  async saveChunks(
    strategy: StrategyId,
    items: Array<{ chunk: Chunk; embedding: Float32Array; contextHeader?: string | null }>,
    batchSize = 100,
  ): Promise<void> {
    const pool = this.getPool();

    for (let start = 0; start < items.length; start += batchSize) {
      const batch = items.slice(start, start + batchSize);
      const values: unknown[] = [];
      const tuples: string[] = [];

      batch.forEach((item, i) => {
        const base = i * 14;
        tuples.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
            `$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},` +
            `$${base + 13},$${base + 14})`,
        );
        values.push(
          strategy,
          item.chunk.id,
          item.chunk.docId,
          item.chunk.docTitle,
          item.chunk.category,
          item.chunk.ordinal,
          item.chunk.headingPath,
          item.chunk.text,
          item.chunk.embedText,
          item.contextHeader ?? null,
          item.chunk.charStart,
          item.chunk.charEnd,
          item.chunk.tokenEstimate,
          toVectorLiteral(item.embedding),
        );
      });

      await pool.query(
        `INSERT INTO default_kb_chunks
           (strategy, chunk_id, doc_id, doc_title, category, ordinal, heading_path, text,
            embed_text, context_header, char_start, char_end, token_estimate, embedding)
         VALUES ${tuples.join(',')}
         ON CONFLICT (strategy, chunk_id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           embed_text = EXCLUDED.embed_text,
           context_header = EXCLUDED.context_header`,
        values,
      );
    }
  }

  async saveGraph(strategy: StrategyId, payload: SerializedGraph, levels: number): Promise<void> {
    await this.getPool().query(
      `INSERT INTO default_kb_graph
         (strategy, payload, entities, relationships, communities, levels)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (strategy) DO UPDATE SET
         payload = EXCLUDED.payload,
         entities = EXCLUDED.entities,
         relationships = EXCLUDED.relationships,
         communities = EXCLUDED.communities,
         levels = EXCLUDED.levels,
         created_at = now()`,
      [
        strategy,
        JSON.stringify(payload),
        payload.entities.length,
        payload.relationships.length,
        payload.communities.length,
        levels,
      ],
    );
  }

  async saveManifest(manifest: Omit<DefaultKbManifest, 'seededAt'>): Promise<void> {
    await this.getPool().query(
      `INSERT INTO default_kb_manifest
         (id, document_count, total_chars, corpus_fingerprint, embedding_model, seeded_at)
       VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET
         document_count = EXCLUDED.document_count,
         total_chars = EXCLUDED.total_chars,
         corpus_fingerprint = EXCLUDED.corpus_fingerprint,
         embedding_model = EXCLUDED.embedding_model,
         seeded_at = now()`,
      [
        manifest.documentCount,
        manifest.totalChars,
        manifest.corpusFingerprint,
        manifest.embeddingModel,
      ],
    );
  }
}

/** pgvector renders a vector as "[0.1,0.2,...]". */
export function parseVector(literal: string): Float32Array {
  const body = literal.trim().replace(/^\[|\]$/g, '');
  if (!body) return new Float32Array(0);
  const parts = body.split(',');
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

export function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`;
}

/**
 * Failures worth one retry: the connection died or never arrived, rather than
 * the statement being wrong.
 *
 * A serverless Postgres that has suspended produces exactly these — the pool
 * still holds a socket the far end has already closed. A syntax error or a
 * constraint violation would repeat identically, so those are left to throw.
 */
export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = (err as Error | null)?.message ?? '';

  const TRANSIENT_CODES = new Set([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    '57P01', // admin_shutdown — the server terminated the connection
    '57P03', // cannot_connect_now — still starting up
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
  ]);

  if (code && TRANSIENT_CODES.has(code)) return true;

  return (
    /Connection terminated/i.test(message) ||
    /timeout exceeded when trying to connect/i.test(message) ||
    /socket hang up/i.test(message)
  );
}
