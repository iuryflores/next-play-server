const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Types } = require('mongoose');
const database = 'np_read_perf_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { LibraryService } = require('../dist/library/library.module');
const { ProgressionService } = require('../dist/progression/progression.module');
const { rankingSummaries } = require('../dist/library/ranking-summary');

test('resumo em lote preserva resultados da estatística completa em banco local', async t => {
  const app = await createApp(), db = app.get(getConnectionToken());
  app.get(ProgressionService).onModuleDestroy();
  t.after(async () => { try { assert.match(database, /^np_read_perf_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const owners = Array.from({ length: 20 }, () => new Types.ObjectId());
  const series = owners.flatMap(owner => Array.from({ length: 3 }, (_, n) => ({ _id: new Types.ObjectId(), ownerId: owner, title: 'Série ' + n, kind: 'series', status: n === 2 ? 'completed' : 'active', catalogId: 'tmdb:series:' + (n + 1), genres: ['Drama'] })));
  const movies = owners.flatMap(owner => Array.from({ length: 10 }, (_, n) => ({ ownerId: owner, title: 'Filme ' + n, kind: 'movie', status: 'completed', runtime: 90, genres: ['Ação'] })));
  await db.collection('library_items').insertMany([...series, ...movies]);
  await db.collection('series_seasons').insertMany([1, 2, 3].map(id => ({ catalogId: 'tmdb:series:' + id, number: 1, loaded: true, episodes: Array.from({ length: 10 }, (_, n) => ({ number: n + 1, runtime: n === 9 ? null : 45, airDate: '2020-01-01' })) })));
  await db.collection('episode_progress').insertMany(series.flatMap(item => Array.from({ length: 10 }, (_, n) => ({ itemId: item._id, season: 1, episode: n + 1, watchedDateUnknown: true }))));
  const library = app.get(LibraryService);
  const started = performance.now();
  const baseline = new Map();
  for (const owner of owners) baseline.set(String(owner), await library.stats(String(owner)));
  const fullMs = performance.now() - started;
  const batchStarted = performance.now();
  const optimized = await rankingSummaries(db, owners.map(String));
  const batchMs = performance.now() - batchStarted;
  for (const [owner, result] of optimized) {
    const previous = baseline.get(owner);
    assert.deepEqual(result, { minutes: previous.minutes, episodes: previous.episodes, missingRuntime: previous.missingRuntime, pendingSeries: previous.pendingSeries });
  }
  console.log(JSON.stringify({ scenario: '20 participantes, 60 séries, 600 episódios, MongoDB local', fullStatsMs: Number(fullMs.toFixed(1)), batchSummaryMs: Number(batchMs.toFixed(1)) }));
});
