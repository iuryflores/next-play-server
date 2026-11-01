const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_history_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { LibraryService } = require('../dist/library/library.module');
test('watch history uses viewing dates, latest watched episode, and account ownership', async t => {
  const app = await createApp(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_history_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const owner = new Types.ObjectId(), show = new Types.ObjectId(), movie = new Types.ObjectId();
  await db.collection('library_items').insertMany([
    { _id: show, ownerId: owner, title: 'Show', kind: 'series', status: 'active', catalogId: 'tmdb:series:901', updatedAt: new Date('2026-09-07') },
    { _id: movie, ownerId: owner, title: 'Movie', kind: 'movie', status: 'completed', completedOn: '2026-01-02', completedAt: new Date('2026-09-07') },
  ]);
  await db.collection('episode_progress').insertMany([
    { itemId: show, season: 1, episode: 1, watchedAt: new Date('2026-02-01T15:00:00Z') },
    { itemId: show, season: 1, episode: 2, watchedAt: new Date('2026-02-03T15:00:00Z') },
  ]);
  const service = app.get(LibraryService);
  const movieDraft = await service.create(owner.toString(), { title: 'Unwatched movie', kind: 'movie', status: 'active' });
  assert.equal(movieDraft.status, 'planned');
  const movieEdit = await service.update(owner.toString(), movieDraft.id, { title: 'Unwatched movie', kind: 'movie', status: 'active' });
  assert.equal(movieEdit.status, 'planned');
  const storedDraft = await db.collection('library_items').findOne({ _id: new Types.ObjectId(movieDraft.id) });
  assert.equal(storedDraft.status, 'planned');
  let items = await service.list(owner.toString());
  let series = items.find(item => item.id === show.toString());
  assert.equal(new Date(series.lastWatchedAt).toISOString(), '2026-02-03T15:00:00.000Z'); assert.deepEqual(series.lastWatchedEpisode, { season: 1, episode: 2 });
  assert.equal(new Date(items.find(item => item.id === movie.toString()).lastWatchedAt).toISOString(), '2026-01-02T00:00:00.000Z');
  await db.collection('library_items').updateOne({ _id: show }, { $set: { notes: 'Edited', updatedAt: new Date() } });
  items = await service.list(owner.toString()); assert.equal(new Date(items.find(item => item.id === show.toString()).lastWatchedAt).toISOString(), '2026-02-03T15:00:00.000Z');
  await db.collection('episode_progress').deleteOne({ itemId: show, episode: 2 });
  items = await service.list(owner.toString()); series = items.find(item => item.id === show.toString()); assert.equal(series.lastWatchedEpisode.episode, 1);
  assert.deepEqual(await service.list(new Types.ObjectId().toString()), []);
  const { CatalogService } = require('../dist/catalog/catalog.module');
  let calls = 0;
  app.get(CatalogService).detail = async () => { calls++; return { runtime: 120 }; };
  await db.collection('library_items').updateOne({ _id: movie }, { $set: { catalogId: 'tmdb:movie:902', archived: true } });
  assert.equal((await service.stats(owner.toString())).moviesMissingRuntime, 1);
  await assert.rejects(() => service.movieRuntime(new Types.ObjectId().toString(), movie.toString()), error => error.getStatus() === 404);
  await service.movieRuntime(owner.toString(), movie.toString());
  await service.movieRuntime(owner.toString(), movie.toString());
  assert.equal(calls, 1);
  const stats = await service.stats(owner.toString()); assert.equal(stats.movieMinutes, 120); assert.equal(stats.moviesMissingRuntime, 0);
  assert.equal((await service.stats(new Types.ObjectId().toString())).movieMinutes, 0);
});
