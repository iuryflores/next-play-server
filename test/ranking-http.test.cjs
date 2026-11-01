const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_ranking_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { AuthService } = require('../dist/auth/auth.service');
test('only ranking visits calculate movements; saves skip statistics and same-visit reads preserve comparison', async t => {
  const app = await createApp(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_ranking_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const owner = new Types.ObjectId(), other = new Types.ObjectId(), target = new Types.ObjectId();
  app.get(AuthService).me = async () => ({ id: owner.toString(), language: 'pt-BR' });
  const movie = (title, genre, status) => ({ ownerId: owner, title, kind: 'movie', status, genres: [genre], notes: '', runtime: 90, productionCompanies: [] });
  await db.collection('library_items').insertMany([
    movie('First', 'Action', 'completed'), movie('Second', 'Action', 'completed'), movie('Third', 'Drama', 'completed'), { ...movie('Fourth', 'Drama', 'planned'), _id: target }, { ...movie('Private', 'Other', 'completed'), ownerId: other }
  ]);
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const patch = async status => {
    const response = await fetch(base + '/api/library/' + target, { method: 'PATCH', headers: { origin: process.env.CLIENT_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Fourth', kind: 'movie', status, notes: '' }) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  const { LibraryService } = require('../dist/library/library.module');
  const library = app.get(LibraryService), originalStats = library.stats.bind(library);
  let calculations = 0;
  library.stats = async (...args) => { calculations++; return originalStats(...args); };
  const stats = async (visit = 'second') => (await fetch(base + '/api/library/stats', { headers: { 'X-Ranking-Visit': visit } })).json();
  assert.deepEqual((await stats('first')).rankingChanges, {});
  const beforeSaveCalculations = calculations;
  await patch('completed');
  assert.equal(calculations, beforeSaveCalculations);
  assert.equal((await db.collection('ranking_visits').findOne({ _id: owner.toString() + ':stats' })).visitId, 'first');
  const first = await stats();
  assert.equal(first.rankingChanges['movie:watchedGenres'].drama, 0);
  assert.deepEqual((await stats()).rankingChanges, first.rankingChanges);
  assert.equal(await db.collection('ranking_movements').countDocuments({ _id: other.toString() }), 0);
  await patch('planned');
  assert.equal((await stats('third')).rankingChanges['movie:watchedGenres'].drama, 0);
  const beforeFailure = await stats('third');
  const invalid = await fetch(base + '/api/library/' + target, { method: 'PATCH', headers: { origin: process.env.CLIENT_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Fourth', kind: 'movie', status: 'invalid' }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await stats('third')).rankingChanges, beforeFailure.rankingChanges);
  assert.equal((await stats('fourth')).rankingChanges['movie:watchedGenres'].drama, 0);
});

