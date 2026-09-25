import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import knexFactory, { Knex } from 'knex';
import { MongoClient, Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StatsStore } from '../../src/db/types';

let sql: Knex;
let mongo: Db;
let statsStore: StatsStore;
vi.mock('../../src/db/sql/knexClient', () => ({ getKnex: () => sql }));
vi.mock('../../src/db/mongo/mongoClient', () => ({ getMongoDb: async () => mongo }));
vi.mock('../../src/db', () => ({ getDb: () => ({ stats: statsStore, metadataCache: { recordDownload: async () => undefined } }) }));

import { SqlStatsRepository } from '../../src/db/sql/sqlStatsRepository';
import { MongoStatsRepository } from '../../src/db/mongo/mongoStatsRepository';
import { SqlJobRepository } from '../../src/db/sql/sqlJobRepository';
import { MongoJobRepository } from '../../src/db/mongo/mongoJobRepository';
import { runSqlMigrations } from '../../src/db/sql/sqlSchema';
import { runMongoMigrations } from '../../src/db/mongo/mongoSchema';
import { recordFetchStat, recordDownloadStat } from '../../src/services/statsService';
import { getStatsTotals, resetStatsTotalsCache } from '../../src/services/statsTotalsService';
import { getStats, streamStats } from '../../src/controllers/statsController';

const targets = [
  { name: 'SQLite', client: 'better-sqlite3', url: '' },
  { name: 'MongoDB', client: 'mongodb', url: '' },
  { name: 'PostgreSQL', client: 'pg', url: process.env.STATS_TEST_POSTGRES_URL },
  { name: 'MySQL', client: 'mysql2', url: process.env.STATS_TEST_MYSQL_URL },
  { name: 'MariaDB', client: 'mysql2', url: process.env.STATS_TEST_MARIADB_URL },
];

for (const target of targets) {
  describe.skipIf(target.url === undefined)(`public stats on ${target.name}`, () => {
    let memoryServer: MongoMemoryServer;
    let mongoClient: MongoClient;
    let server: http.Server;
    let port: number;
    beforeAll(async () => {
      if (target.client === 'mongodb') {
        memoryServer = await MongoMemoryServer.create();
        mongoClient = await MongoClient.connect(memoryServer.getUri());
        mongo = mongoClient.db('stats_test');
        await runMongoMigrations();
        statsStore = new MongoStatsRepository();
      } else {
        sql = knexFactory({ client: target.client, connection: target.client === 'better-sqlite3' ? { filename: ':memory:' } : target.url,
          useNullAsDefault: target.client === 'better-sqlite3', pool: { min: 1, max: target.client === 'better-sqlite3' ? 1 : 5 } });
        await runSqlMigrations();
        statsStore = new SqlStatsRepository();
      }
      resetStatsTotalsCache();
      const app = express();
      // The real app's requestId middleware assigns req.guestId from a cookie; this test app is minimal,
      // so a header stands in for it — lets each test control exactly which visitor id a connection carries.
      app.use((req, _res, next) => { req.guestId = (req.headers['x-test-visitor'] as string) || undefined; next(); });
      app.get('/stats', (req, res, next) => { void getStats(req, res).catch(next); });
      app.get('/stats/events', streamStats);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      port = (server.address() as AddressInfo).port;
    }, 120_000);

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.client === 'mongodb') {
        await mongoClient?.close();
        await memoryServer?.stop();
      } else await sql?.destroy();
      resetStatsTotalsCache();
    });

    it('includes visitor and legacy fetches, excluding internal, revalidation and failure rows', async () => {
      const before = await statsStore.totals();
      for (const source of ['user', 'internal', 'revalidation'] as const) {
        await statsStore.recordFetchStat({ platform: 'youtube', success: true, source });
      }
      await statsStore.recordFetchStat({ platform: 'youtube', success: false });
      await statsStore.recordFetchStat({ platform: 'youtube', success: true, mediaId: 'legacy-null' });
      if (target.client === 'mongodb') await mongo.collection('fetch_stats').updateOne({ mediaId: 'legacy-null' }, { $set: { source: null } });
      else await sql('fetch_stats').where({ media_id: 'legacy-null' }).update({ source: null });
      expect((await statsStore.totals()).fetches - before.fetches).toBe(2);
      if (target.client === 'mongodb') {
        await mongo.collection('fetch_stats').insertOne({ platform: 'youtube', success: true });
        expect((await statsStore.totals()).fetches - before.fetches).toBe(3);
      }
    });

    it('counts concurrent visitor writes exactly and counts only successful downloads', async () => {
      const before = await statsStore.totals();
      await Promise.all(Array.from({ length: 20 }, () => recordFetchStat({ platform: 'youtube', success: true })));
      for (const success of [true, false, false]) await recordDownloadStat({ platform: 'youtube', kind: 'video', success });
      expect(await getStatsTotals()).toEqual({ fetches: before.fetches + 20, downloads: before.downloads + 1, online: before.online });
    });

    it('invalidates a warm total immediately after a committed write and forbids browser caching', async () => {
      const before = await getStatsTotals();
      await recordFetchStat({ platform: 'youtube', success: true });
      const response = await fetch(`http://127.0.0.1:${port}/stats`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ fetches: before.fetches + 1 });
    });

    it('pushes the committed fetch and download totals over SSE without waiting for the polling interval', async () => {
      const snapshots: Array<{ fetches: number; downloads: number }> = [];
      const req = http.get(`http://127.0.0.1:${port}/stats/events`);
      const res = await new Promise<http.IncomingMessage>((resolve) => req.once('response', resolve));
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (frame.startsWith('data: ')) snapshots.push(JSON.parse(frame.slice(6)));
        }
      });
      try {
        await vi.waitFor(() => expect(snapshots.length).toBe(1), { timeout: 1000 });
        const before = snapshots[0];
        await recordFetchStat({ platform: 'youtube', success: true });
        await recordDownloadStat({ platform: 'youtube', kind: 'audio', success: true });
        await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ fetches: before.fetches + 1, downloads: before.downloads + 1 }), { timeout: 1000 });
      } finally { res.destroy(); req.destroy(); }
    });

    it('counts distinct present visitors, collapses repeated presence from the same one, and excludes stale rows', async () => {
      const before = await statsStore.totals();
      await statsStore.recordPresence('visitor-a');
      await statsStore.recordPresence('visitor-b');
      await statsStore.recordPresence('visitor-a'); // same visitor again: still one row, not two
      expect((await statsStore.totals()).online).toBe(before.online + 2);

      // A presence row older than the configured window (default 60s) must not count as online.
      const staleAt = new Date(Date.now() - 5 * 60_000);
      if (target.client === 'mongodb') {
        await mongo.collection('visitor_presence').updateOne({ _id: 'visitor-a' } as never, { $set: { lastSeenAt: staleAt } });
      } else {
        await sql('visitor_presence').where({ visitor_id: 'visitor-a' }).update({ last_seen_at: staleAt });
      }
      expect((await statsStore.totals()).online).toBe(before.online + 1);
    });

    it('prunePresence removes only rows old enough that no window could ever count them again', async () => {
      await statsStore.recordPresence('prune-fresh');
      await statsStore.recordPresence('prune-stale');
      const staleAt = new Date(Date.now() - 2 * 3_600_000);
      if (target.client === 'mongodb') {
        await mongo.collection('visitor_presence').updateOne({ _id: 'prune-stale' } as never, { $set: { lastSeenAt: staleAt } });
      } else {
        await sql('visitor_presence').where({ visitor_id: 'prune-stale' }).update({ last_seen_at: staleAt });
      }
      await statsStore.prunePresence(3_600_000);
      const remainingIds = target.client === 'mongodb'
        ? (await mongo.collection('visitor_presence').find({ _id: { $in: ['prune-fresh', 'prune-stale'] } } as never).toArray()).map((r) => r._id)
        : (await sql('visitor_presence').whereIn('visitor_id', ['prune-fresh', 'prune-stale']).select('visitor_id')).map((r: { visitor_id: string }) => r.visitor_id);
      expect(remainingIds).toEqual(['prune-fresh']);
    });

    it('counts a real /stats/events connection as an online visitor', async () => {
      const before = await statsStore.totals();
      const req = http.get(`http://127.0.0.1:${port}/stats/events`, { headers: { 'x-test-visitor': `sse-visitor-${target.client}` } });
      const res = await new Promise<http.IncomingMessage>((resolve) => req.once('response', resolve));
      try {
        await vi.waitFor(async () => expect((await statsStore.totals()).online).toBe(before.online + 1), { timeout: 1000 });
      } finally { res.destroy(); req.destroy(); }
    });

    it('persists the prepared job media key for completion accounting', async () => {
      const jobs = target.client === 'mongodb' ? new MongoJobRepository() : new SqlJobRepository();
      const job = await jobs.create({ platform: 'youtube', mediaId: null, canonicalUrl: 'https://youtube.com/watch?v=abc', requestedFormat: { formatId: '18', kind: 'video' } });
      await jobs.updateStatus(job.id, 'completed', { media_id: 'abc' });
      expect((await jobs.get(job.id)).mediaId).toBe('abc');
    });
  });
}
