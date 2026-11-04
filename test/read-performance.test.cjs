const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Types } = require('mongoose');
const { rankingSummaries } = require('../dist/library/ranking-summary');
const { AchievementsService } = require('../dist/achievements/achievements.module');
const { FriendsService } = require('../dist/friends/friends.module');

test('ranking inicia cinco leituras independentes antes de aguardar resultados', { timeout: 2000 }, async () => {
  const owner = new Types.ObjectId();
  const started = new Set(), releases = [];
  const read = name => {
    started.add(name);
    const pending = new Promise(resolve => releases.push(() => resolve([])));
    if (started.size === 5) releases.forEach(resolve => resolve());
    return pending;
  };
  const db = { name: 'parallel-read-test', collection: name => ({
    find: filter => ({ toArray: () => name === 'users' ? Promise.resolve([{ _id: owner, displayName: 'Pessoa' }]) : read(name === 'library_items' ? filter.kind === 'series' ? 'series' : 'consumption' : name) }),
    aggregate: () => ({ toArray: () => read('xp') }),
    findOne: async () => null,
    updateOne: async () => ({}),
  }) };
  const model = { find: () => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) }) };
  const result = await new FriendsService(model, db, { signedUrl: () => assert.fail() }).list(String(owner), 'visit');
  assert.equal(started.size, 5);
  assert.equal(result.ranking.length, 1);
  assert.equal(result.ranking[0].xp, 0);
});

test('resumo de cem participantes usa três consultas e mantém totais isolados sem buscar preferências', async () => {
  const owners = Array.from({ length: 100 }, () => new Types.ObjectId());
  const items = owners.map(owner => ({ _id: new Types.ObjectId(), ownerId: owner, catalogId: 'tmdb:series:1', status: 'completed' }));
  const progress = items.flatMap(item => [{ itemId: item._id, season: 1, episode: 1 }, { itemId: item._id, season: 1, episode: 2 }]);
  const datasets = { library_items: items, episode_progress: progress, series_seasons: [{ catalogId: 'tmdb:series:1', number: 1, episodes: [{ number: 1, runtime: 45 }, { number: 2 }] }] };
  const calls = [];
  const result = await rankingSummaries({ collection: name => {
    assert.ok(datasets[name], 'não pode consultar elenco, preferências ou créditos');
    return { find: (filter, options) => { calls.push({ name, filter, options }); return { toArray: async () => datasets[name] }; } };
  } }, owners.map(String));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].filter.ownerId.$in.length, 100);
  for (const owner of owners) assert.deepEqual(result.get(String(owner)), { minutes: 45, episodes: 2, missingRuntime: 1, pendingSeries: 1 });
  const empty = await rankingSummaries({ collection: () => assert.fail() }, []);
  assert.equal(empty.size, 0);
});

test('métricas automáticas coalescem concorrência e invalidam por revisão, fuso e expiração', async () => {
  const owner = new Types.ObjectId();
  let revision = 1, count = 0;
  const service = new AchievementsService({ collection: name => { assert.equal(name, 'user_xp_sync'); return { findOne: async () => ({ revision }) }; } });
  service.metrics = async () => { count++; return { counts: { movies: count }, evidence: {} }; };
  const values = await Promise.all(Array.from({ length: 10 }, () => service.automaticMetrics(owner, 'UTC')));
  assert.equal(count, 1);
  assert.ok(values.every(value => value.counts.movies === 1));
  await service.automaticMetrics(owner, 'UTC');
  assert.equal(count, 1);
  revision++;
  assert.equal((await service.automaticMetrics(owner, 'UTC')).counts.movies, 2);
  await service.automaticMetrics(owner, 'America/Sao_Paulo');
  assert.equal(count, 3);
  for (const entry of service.metricCache.values()) entry.expires = 0;
  await service.automaticMetrics(owner, 'UTC');
  assert.equal(count, 4);
});

test('falha no cálculo de conquistas não envenena o cache nem impede nova tentativa', async () => {
  const service = new AchievementsService({ collection: () => ({ findOne: async () => ({ revision: 1 }) }) });
  let calls = 0;
  service.metrics = async () => { if (++calls === 1) throw Error('temporary'); return { counts: {}, evidence: {} }; };
  const owner = new Types.ObjectId();
  await assert.rejects(service.automaticMetrics(owner, 'UTC'), /temporary/);
  assert.deepEqual(await service.automaticMetrics(owner, 'UTC'), { counts: {}, evidence: {} });
  assert.equal(calls, 2);
});
