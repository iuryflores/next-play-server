const { test } = require('node:test');
const assert = require('node:assert/strict');
const { positions, rankingChanges, snapshot } = require('../dist/library/ranking-snapshot');
test('ranking movement counts positions, ties, new entries and removals', () => {
  const before = { actors: positions([{ id: 'a', count: 10 }, { id: 'b', count: 7 }, { id: 'c', count: 5 }]) };
  const after = { actors: positions([{ id: 'a', count: 10 }, { id: 'b', count: 7 }, { id: 'c', count: 11 }, { id: 'd', count: 1 }]) };
  assert.deepEqual(rankingChanges(before, after), { actors: { c: 2, a: -1, b: -1, d: null } });
  assert.deepEqual(positions([{ id: 'z', count: 3 }, { id: 'a', count: 3 }, { id: 'b', count: 1 }]), { a: 1, z: 1, b: 3 });
  assert.deepEqual(rankingChanges(after, after), { actors: { c: 0, a: 0, b: 0, d: 0 } });
  assert.deepEqual(rankingChanges(before, { actors: { b: 1 } }), { actors: { b: 1 } });
});
test('snapshots separate media and combine actor identities across roles', () => {
  const data = { minutes: 0, bySeries: [], preferences: {
    actors: [{ id: 'a', kind: 'movie', count: 2 }, { id: 'a', kind: 'series', count: 4 }, { id: 'b', kind: 'movie', count: 5 }], characters: [], productionCompanies: [], seriesProductionCompanies: [], watchedMovieCompanies: [], watchedSeriesCompanies: [], feelingSources: []
  } };
  const result = snapshot(data, [{ id: '1', kind: 'movie', status: 'planned', genres: ['Ação', 'ação'] }, { id: '2', kind: 'series', status: 'active', genres: ['Drama'], episodeProgress: { watched: 1 } }]);
  assert.equal(result['general:actors'].a, 1);
  assert.equal(result['movie:actors'].a, 2);
  assert.deepEqual(result['movie:addedGenres'], { acao: 1 });
  assert.deepEqual(result['movie:watchedGenres'], {});
  assert.deepEqual(result['series:watchedGenres'], { drama: 1 });
});
