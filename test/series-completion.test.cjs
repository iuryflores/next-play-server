const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_series_completion_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { LibraryService } = require('../dist/library/library.module');
const { CatalogService } = require('../dist/catalog/catalog.module');
const { ProgressionService } = require('../dist/progression/progression.module');
const { EpisodesService } = require('../dist/episodes/episodes.module');
const { finishedSeries } = require('../dist/library/series-completion');

test('encerramento não presume episódios futuros, temporadas incompletas ou total ausente', () => {
  const seen = new Set(['1:1']);
  const seasons = [{ number: 1, loaded: true, episodes: [{ number: 1, airDate: '2099-01-01' }] }];
  assert.equal(finishedSeries({ seriesStatus: 'ended', episodeCount: 1 }, seasons, seen, '2026-11-03'), false);
  seasons[0].episodes[0].airDate = '2020-01-01';
  assert.equal(finishedSeries({ seriesStatus: 'ended' }, seasons, seen, '2026-11-03'), false);
  seasons[0].loaded = false;
  assert.equal(finishedSeries({ seriesStatus: 'ended', episodeCount: 1 }, seasons, seen, '2026-11-03'), false);
});

test('séries encerradas e canceladas só concluem com todo o catálogo assistido', async t => {
  const app = await createApp(), db = app.get(getConnectionToken());
  app.get(ProgressionService).onModuleDestroy();
  t.after(async () => { try { assert.match(database, /^nextplay_series_completion_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  let providerReads = 0;
  app.get(CatalogService).upcoming = async () => { providerReads++; throw new Error('Provedor indisponível'); };
  const owner = new Types.ObjectId();
  const scenarios = [
    { status: 'ended', total: 2, seen: 2, completed: true },
    { status: 'canceled', total: 2, seen: 2, completed: true },
    { status: 'returning', total: 2, seen: 2, completed: false },
    { status: 'unknown', total: 2, seen: 2, completed: false },
    { status: 'ended', total: 3, seen: 2, completed: false },
    { status: 'ended', total: 2, seen: 1, completed: false },
    { status: 'ended', total: 2, seen: 2, completed: false, rewatch: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    scenario.id = new Types.ObjectId(); scenario.catalogId = 'tmdb:series:' + (index + 1);
    const rewatchId = scenario.rewatch ? new Types.ObjectId() : null;
    await db.collection('library_items').insertOne({ _id: scenario.id, ownerId: owner, kind: 'series', status: 'active', title: 'Série ' + index, catalogId: scenario.catalogId, stars: 4, notes: '', ...(rewatchId ? { rewatchActiveId: rewatchId } : {}) });
    await db.collection('series_seasons').insertMany([
      { catalogId: scenario.catalogId, number: 1, loaded: true, total: 2, episodes: [{ number: 1, airDate: '2020-01-01' }, { number: 2, airDate: '2020-01-02' }] },
      { catalogId: scenario.catalogId, number: 0, loaded: false, total: 10, episodes: [] },
    ]);
    await db.collection('series_upcoming').insertOne({ _id: scenario.catalogId + ':pt-BR', value: { seriesStatus: scenario.status, episodeCount: scenario.total, episode: null, ended: ['ended', 'canceled'].includes(scenario.status) }, expires: new Date(Date.now() + 3600000) });
    await db.collection('episode_progress').insertMany(Array.from({ length: scenario.seen }, (_, n) => ({ itemId: rewatchId || scenario.id, season: 1, episode: n + 1, watchedAt: null, watchedDateUnknown: true })));
  }
  const library = app.get(LibraryService);
  const result = await library.list(String(owner));
  for (const scenario of scenarios) {
    const row = result.find(row => row.id === String(scenario.id));
    assert.equal(row.status, scenario.completed ? 'completed' : 'active');
    assert.equal(row.stars, 4);
    const stored = await db.collection('library_items').findOne({ _id: scenario.id });
    assert.equal(stored.status, scenario.completed ? 'completed' : 'active');
    if (scenario.completed) { assert.equal(stored.watchedDateUnknown, true); assert.equal(stored.completedOn, null); assert.ok(stored.episodesCompletedAt); }
  }
  assert.equal(providerReads, 0, 'cache em lote evita rede por série na abertura');
  const revision = (await db.collection('user_xp_sync').findOne({ _id: owner })).revision;
  await library.list(String(owner));
  assert.equal((await db.collection('user_xp_sync').findOne({ _id: owner })).revision, revision, 'releitura não repete conclusão');
  await app.get(EpisodesService).watch(String(owner), String(scenarios[0].id), { season: 1, episode: 2, watched: false });
  assert.equal((await library.list(String(owner))).find(row => row.id === String(scenarios[0].id)).status, 'active');
});
