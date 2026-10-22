/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { BuiltInFtsProvider, TRIGRAM_BUILD_LOCK_KEYS } from './builtin-fts.provider';

/**
 * Postgres runtime coverage for match=contains: the pg_trgm/unaccent schema buildContainsIndex creates
 * when SEARCH_CONTAINS_ENABLED is on, queried through BuiltInFtsProvider. Companion to the SQLite spec
 * (builtin-fts.provider.contains.spec.ts); asserts the same contract (substring, case- and
 * accent-insensitive, every term required, short terms narrowing, literal wildcards) plus what only
 * Postgres has: the term rule pg_trgm imposes, the CONCURRENTLY build and its lock, and the indexes
 * actually answering the query.
 *
 * `messages` comes from the real data migration chain, on a scratch database of its own, so the plans
 * below are chosen among the indexes production has (IDX_messages_createdAt among them), not among the
 * ones a hand-made table happens to carry. Skipped unless DATABASE_TYPE=postgres; connects with
 * DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME, and the role must be allowed to create databases and the
 * two extensions (the CI postgres:16 service's owner role is).
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

/** Named for the suite so a crashed run leaves an obvious orphan rather than a mystery database. */
const SCRATCH_DB = 'openwa_contains_search_probe';

const connection = (database: string): DataSourceOptions => ({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'openwa',
  password: process.env.DATABASE_PASSWORD || 'openwa',
  database,
});

const containsOn = new ConfigService({ search: { containsEnabled: true } });

(POSTGRES_ENABLED ? describe : describe.skip)('BuiltInFtsProvider match=contains (postgres)', () => {
  let admin: DataSource;
  let ds: DataSource;

  const insert = (id: string, sessionId: string, body: string, ts: number) =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","type","direction","timestamp") ` +
        `VALUES ($1,$2,$3,$4,'dest@c.us',$5,'text','incoming',$6)`,
      [id, sessionId, `${id}-chat`, `${id}-from`, body, ts],
    );

  const trigramState = async () =>
    (
      await ds.query<Array<{ extensions: number; fn: boolean; idx: boolean | null }>>(
        `SELECT (SELECT count(*)::int FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent')) AS extensions,
                to_regprocedure('openwa_unaccent(text)') IS NOT NULL AS fn,
                (SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_messages_body_trgm') AS idx`,
      )
    )[0];

  beforeAll(async () => {
    admin = new DataSource(connection(process.env.DATABASE_NAME || 'openwa'));
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    ds = new DataSource({
      ...connection(SCRATCH_DB),
      migrations: [join(__dirname, '../../../database/migrations/*{.ts,.js}')],
    });
    await ds.initialize();
    await ds.runMigrations();
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`).catch(() => undefined);
    await admin?.destroy().catch(() => undefined);
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM "messages"`);
    await ds.query(`DROP INDEX IF EXISTS "idx_messages_body_trgm"`);
    await ds.query(`DROP FUNCTION IF EXISTS openwa_unaccent(text)`);
    await ds.query(`DROP EXTENSION IF EXISTS pg_trgm`);
    await ds.query(`DROP EXTENSION IF EXISTS unaccent`);
    await insert('m1', 's1', 'Your invoice INV-2048 is ready for download', 10);
    await insert('m2', 's1', 'Thanks, I will pay the invoice today', 20);
    await insert('m3', 's2', 'Meeting moved to the Café Résumé at 10am', 30);
    await insert('m4', 's1', 'Order shipped with a 10% discount, tracking id 42', 40);
  });

  describe('building the schema', () => {
    it('creates nothing and answers 501 naming SEARCH_CONTAINS_ENABLED while the setting is off', async () => {
      const provider = new BuiltInFtsProvider(ds);
      await provider.buildContainsIndex();

      const attempt = provider.search({ q: 'voic', match: 'contains' });
      await expect(attempt).rejects.toBeInstanceOf(NotImplementedException);
      await expect(attempt).rejects.toThrow(/SEARCH_CONTAINS_ENABLED=true/);
      expect(await trigramState()).toEqual({ extensions: 0, fn: false, idx: null });
    });

    it('creates the extensions, the wrapper and a valid index, and a second build changes nothing', async () => {
      const provider = new BuiltInFtsProvider(ds, containsOn);
      await expect(provider.search({ q: 'voic', match: 'contains' })).rejects.toThrow(/still being built/);

      await provider.buildContainsIndex();
      await provider.buildContainsIndex();

      expect(await trigramState()).toEqual({ extensions: 2, fn: true, idx: true });
      expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(2);
    });

    it('drops and rebuilds an INVALID index a failed CONCURRENTLY build left behind', async () => {
      await expect(
        ds.query(`CREATE UNIQUE INDEX CONCURRENTLY "idx_messages_body_trgm" ON "messages" ("sessionId")`),
      ).rejects.toThrow();
      expect((await trigramState()).idx).toBe(false);

      const provider = new BuiltInFtsProvider(ds, containsOn);
      await provider.buildContainsIndex();

      expect((await trigramState()).idx).toBe(true);
      expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(2);
    });

    it('leaves the build to the replica holding the lock, then serves the index it built', async () => {
      const other = ds.createQueryRunner();
      await other.connect();
      try {
        await other.query(`SELECT pg_advisory_lock($1, $2)`, [...TRIGRAM_BUILD_LOCK_KEYS]);
        const waiting = new BuiltInFtsProvider(ds, containsOn);
        await waiting.buildContainsIndex();

        expect(await trigramState()).toEqual({ extensions: 0, fn: false, idx: null });
        await expect(waiting.search({ q: 'voic', match: 'contains' })).rejects.toThrow(/still being built/);

        await other.query(`SELECT pg_advisory_unlock($1, $2)`, [...TRIGRAM_BUILD_LOCK_KEYS]);
        await new BuiltInFtsProvider(ds, containsOn).buildContainsIndex();

        expect((await waiting.search({ q: 'voic', match: 'contains' })).total).toBe(2);
      } finally {
        await other.release();
      }
    });
  });

  describe('searching', () => {
    let provider: BuiltInFtsProvider;

    beforeEach(async () => {
      provider = new BuiltInFtsProvider(ds, containsOn);
      await provider.buildContainsIndex();
    });

    it('finds any part of a word, ignoring case and accents, and marks it', async () => {
      const res = await provider.search({ q: 'voic', match: 'contains' });
      expect(res.total).toBe(2);
      expect(res.hits.map(h => h.snippet).sort()).toEqual([
        'Thanks, I will pay the in<mark>voic</mark>e today',
        'Your in<mark>voic</mark>e INV-2048 is ready for download',
      ]);

      for (const q of ['cafe', 'CAFÉ', 'resume']) {
        expect((await provider.search({ q, match: 'contains' })).hits.map(h => h.messageId)).toEqual(['m3']);
      }
    });

    it('requires every term, narrows with short ones, and rejects short terms alone', async () => {
      expect((await provider.search({ q: 'invoice 2048', match: 'contains' })).hits.map(h => h.messageId)).toEqual([
        'm1',
      ]);
      expect((await provider.search({ q: 'invoice to', match: 'contains' })).hits.map(h => h.messageId)).toEqual([
        'm2',
      ]);
      await expect(provider.search({ q: 'id to', match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a query with no run of three letters or digits, which pg_trgm cannot look up', async () => {
      for (const q of ['😂😂😂', '...', ':-)', 'a.b.c']) {
        await expect(provider.search({ q, match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
      }
      expect((await provider.search({ q: ':-) invoice', match: 'contains' })).total).toBe(0);
      expect((await provider.search({ q: 'INV-2048', match: 'contains' })).total).toBe(1);
    });

    it('matches LIKE wildcards literally, the fullwidth forms unaccent folds into them included', async () => {
      await insert('m5', 's1', 'price 100 dollars', 50);
      expect((await provider.search({ q: '10% discount', match: 'contains' })).hits.map(h => h.messageId)).toEqual([
        'm4',
      ]);
      expect((await provider.search({ q: 'invoice _', match: 'contains' })).total).toBe(0);
      expect((await provider.search({ q: '100％', match: 'contains' })).total).toBe(0);
      expect((await provider.search({ q: 'price＿100', match: 'contains' })).total).toBe(0);
    });

    it('transliterates letters SQLite leaves alone, which docs/26 lists as a dialect difference', async () => {
      await insert('m5', 's1', 'Shipped from Łódź to the Straße', 50);
      expect((await provider.search({ q: 'lodz', match: 'contains' })).hits.map(h => h.messageId)).toEqual(['m5']);
      expect((await provider.search({ q: 'strasse', match: 'contains' })).hits.map(h => h.messageId)).toEqual(['m5']);
    });

    it('ranks whole words first, newest first within a score, and scores a scoped caller too', async () => {
      await insert('m5', 's1', 'reinvoiced items are listed below', 50);
      const res = await provider.search({ q: 'invoice', match: 'contains', sessionIds: ['s1'] });

      expect(res.hits.map(h => [h.messageId, h.score])).toEqual([
        ['m2', 3],
        ['m1', 3],
        ['m5', 1],
      ]);
    });

    it('pages with the window total', async () => {
      const page = await provider.search({ q: 'invoice', match: 'contains', limit: 1, offset: 1 });
      expect(page.total).toBe(2);
      expect(page.hits).toHaveLength(1);
    });

    // A handful of rows is cheaper to scan than to look up, so the planner is told not to scan: what
    // these prove is that the SQL the provider emits matches the indexed expressions and CAN use them.
    // The SQL is captured from a real search; one query runner keeps SET LOCAL and EXPLAIN together.
    const plan = async (settings: string[], q: string): Promise<string> => {
      const query = jest.spyOn(ds, 'query');
      await provider.search({ q, match: 'contains' });
      const [sql, params] = query.mock.calls.find(([text]) => /ILIKE/.test(text)) as [string, unknown[]];
      query.mockRestore();
      const runner = ds.createQueryRunner();
      await runner.startTransaction();
      try {
        for (const setting of settings) await runner.query(`SET LOCAL ${setting} = off`);
        const rows = (await runner.query(`EXPLAIN ${sql}`, params)) as Array<{ 'QUERY PLAN': string }>;
        return rows.map(r => r['QUERY PLAN']).join('\n');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
    };

    it('answers the substring predicate from the GIN trigram index', async () => {
      expect(await plan(['enable_seqscan', 'enable_indexscan'], 'voic')).toContain('idx_messages_body_trgm');
    });

    it('can fetch the most recently stored candidates by walking IDX_messages_createdAt', async () => {
      expect(await plan(['enable_seqscan', 'enable_bitmapscan'], 'voic')).toContain(
        'Index Scan Backward using "IDX_messages_createdAt"',
      );
    });
  });
});
