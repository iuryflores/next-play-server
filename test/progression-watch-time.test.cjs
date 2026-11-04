const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { xpCandidates, xpRules } = require('../dist/progression/progression-rules');
const { ProgressionService } = require('../dist/progression/progression.module');
const { Types } = require('mongoose');
const movie = { _id: 'm', kind: 'movie', title: 'Filme', status: 'completed', catalogId: 'tmdb:movie:1', runtime: 90 };
const series = { _id: 's', kind: 'series', title: 'Série', status: 'active', catalogId: 'tmdb:series:1' };
const units = (rows, kind) => rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.units, 0);

test('filmes revistos só pontuam após conclusão e somam frações de hora por filme', () => {
  const rewatches = [{ id: 'r1', completedAt: new Date() }, { id: 'r1', completedAt: new Date() }, { id: 'r2' }, { id: 'r3', completedAt: 'invalid' }];
  const rows = xpCandidates([{ ...movie, rewatches }, { ...movie, _id: 'duplicado', rewatches }], [], []);
  assert.equal(units(rows, 'movie'), 1);
  assert.equal(units(rows, 'rewatch'), 1);
  assert.equal(units(rows, 'movieHour'), 3);
  assert.equal(rows.reduce((xp, row) => xp + row.units * xpRules[row.kind].rate, 0), 55);
  assert.equal(units(xpCandidates([{ ...movie, status: 'planned', rewatches: [{ id: 'pending' }] }], [], []), 'movieHour'), 0);
});

test('horas usam somente minutos válidos e respeitam limites exatos', () => {
  for (const [runtime, expected] of [[59, 0], [60, 1], [119, 1], [120, 2], [null, 0], [undefined, 0], [-20, 0], [NaN, 0], [Infinity, 0]]) {
    assert.equal(units(xpCandidates([{ ...movie, runtime }], [], []), 'movieHour'), expected);
  }
});

test('episódios continuam valendo individualmente e acumulam horas por série sem duplicar registros', () => {
  const rows = [
    { itemId: 's', season: 1, episode: 1, watchedAt: new Date(), runtime: 45 },
    { itemId: 's', season: 1, episode: 2, watchedDateUnknown: true, runtime: 45 },
    { itemId: 's', season: 1, episode: 2, watchedDateUnknown: true, runtime: 45 },
    { itemId: 's', season: 0, episode: 1, watchedAt: new Date(), runtime: 999 },
    { itemId: 's', season: 1, episode: 3, runtime: 999 },
    { itemId: 'other', season: 1, episode: 1, watchedAt: new Date(), runtime: 999 },
  ];
  const result = xpCandidates([series], rows, []);
  assert.equal(units(result, 'episode'), 2);
  assert.equal(units(result, 'episodeHour'), 1);
  assert.equal(units(xpCandidates([series], rows.map(row => ({ ...row, runtime: undefined })), []), 'episode'), 2);
  assert.equal(units(xpCandidates([series], rows.map(row => ({ ...row, runtime: undefined })), []), 'episodeHour'), 0);
});

test('sincronização reconhece cache local, credita só diferenças e preserva créditos após remoções', async () => {
  const movieId = new Types.ObjectId(), seriesId = new Types.ObjectId();
  let items = [{ ...movie, _id: movieId }, { ...series, _id: seriesId }];
  const episodeRows = [1, 2].map(episode => ({ itemId: seriesId, season: 1, episode, watchedDateUnknown: true }));
  const ledger = new Map();
  let writes = 0;
  const collections = {
    library_items: { find: () => ({ toArray: async () => items }) },
    episode_progress: { find: () => ({ toArray: async () => episodeRows }) },
    achievement_awards: { find: () => ({ toArray: async () => [] }) },
    series_seasons: { find: filter => { assert.deepEqual(filter.catalogId.$in, ['tmdb:series:1']); return { toArray: async () => [{ catalogId: 'tmdb:series:1', number: 1, episodes: [{ number: 1, runtime: 45 }, { number: 2, runtime: 45 }] }] }; } },
    user_xp_credits: {
      find: () => ({ toArray: async () => [...ledger.values()] }),
      bulkWrite: async operations => {
        writes += operations.length;
        for (const { updateOne: op } of operations) {
          const set = op.update[0].$set, old = ledger.get(op.filter._id);
          ledger.set(op.filter._id, { _id: op.filter._id, kind: set.kind.$literal, units: Math.max(set.units.$max[0], old?.units || 0), rate: set.rate });
        }
      },
    },
  };
  const service = new ProgressionService({ collection: name => { assert.ok(collections[name], name); return collections[name]; } });
  const owner = new Types.ObjectId().toString();
  await service.recognize(owner);
  assert.equal([...ledger.values()].find(row => row.kind === 'episodeHour').units, 1);
  const firstWrites = writes;
  await service.recognize(owner);
  assert.equal(writes, firstWrites);
  items[0].rewatches = [{ id: 'r1', completedAt: new Date() }];
  await service.recognize(owner);
  assert.equal([...ledger.values()].find(row => row.kind === 'rewatch').units, 1);
  assert.equal([...ledger.values()].find(row => row.kind === 'movieHour').units, 3);
  const lastWrites = writes;
  items[0].rewatches = [];
  items[0].runtime = null;
  await service.recognize(owner);
  assert.equal(writes, lastWrites);
  items = [items[1]];
  await service.recognize(owner);
  assert.equal(writes, lastWrites);
});
