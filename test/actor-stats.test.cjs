const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_actor_stats_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { LibraryService } = require('../dist/library/library.module');

test('actor rankings combine roles, separate media, respect episode cast and exclude other users', async t => {
  const app = await createApp(); const db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_actor_stats_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const owner = new Types.ObjectId(), other = new Types.ObjectId();
  const ids = Array.from({ length: 4 }, () => new Types.ObjectId());
  await db.collection('library_items').insertMany([
    { _id: ids[0], ownerId: owner, title: 'Movie A', catalogId: 'tmdb:movie:1', kind: 'movie', status: 'completed', favoriteCharacter: 'Hero' },
    { _id: ids[1], ownerId: owner, title: 'Movie B', catalogId: 'tmdb:movie:2', kind: 'movie', status: 'completed', favoriteCharacter: 'Villain', archived: true },
    { _id: ids[2], ownerId: owner, title: 'Show', catalogId: 'tmdb:series:3', kind: 'series', status: 'active' },
    { _id: ids[3], ownerId: other, title: 'Foreign', catalogId: 'tmdb:movie:1', kind: 'movie', status: 'completed', favoriteCharacter: 'Hero' },
  ]);
  const member = (id, character) => ({ id: `${id}:${character}`, actor: `Actor ${id}`, character, photo: '' });
  await db.collection('catalog_cast').insertMany([
    { _id: 'tmdb:movie:1:en-US:all:all', cast: [member(10, 'Hero')] },
    { _id: 'tmdb:movie:1:pt-BR:all:all', cast: [member(10, 'Hero')] },
    { _id: 'tmdb:movie:2:en-US:all:all', cast: [member(10, 'Villain')] },
    { _id: 'tmdb:series:3:en-US:all:all', cast: [member(10, 'Lead'), member(20, 'Lead')] },
    { _id: 'tmdb:series:3:en-US:1:1', cast: [member(10, 'Lead')] },
    { _id: 'tmdb:series:3:en-US:1:2', cast: [member(20, 'Lead')] },
  ]);
  await db.collection('episode_progress').insertMany([1, 2, 3, 4].map(episode => ({ itemId: ids[2], season: 1, episode, favoriteCharacter: episode === 4 ? 'Unknown' : 'Lead' })));
  const stats = await app.get(LibraryService).stats(owner.toString());
  assert.deepEqual(stats.preferences.actors.map(({ id, kind, count }) => ({ id, kind, count })), [
    { id: '10', kind: 'movie', count: 2 }, { id: '10', kind: 'series', count: 1 }, { id: '20', kind: 'series', count: 1 },
  ]);
  assert.deepEqual(stats.preferences.actors.find(actor => actor.kind === 'movie').sources.map(source => [source.title, source.count]), [['Movie A',1],['Movie B',1]]);
  for(const actor of stats.preferences.actors) assert.equal(actor.sources.reduce((sum, source)=>sum+source.count,0), actor.count);
  assert.equal(stats.preferences.characters.find(entry => entry.name === 'Lead').count, 3);
  assert.equal(stats.preferences.characters.find(entry => entry.name === 'Hero').count, 1);
  assert.equal(stats.preferences.unmatchedActorVotes.series, 2);
  assert.equal(stats.preferences.characters.length, 4);
  const { EpisodesService } = require('../dist/episodes/episodes.module');
  await db.collection('series_seasons').insertOne({ catalogId: 'tmdb:series:3', number: 1, loaded: true, total: 4, episodes: [1,2,3,4].map(number => ({ number, name: 'Episode', airDate: '2020-01-01' })) });
  const episodes = app.get(EpisodesService), library = app.get(LibraryService);
  await episodes.watchMany(owner.toString(), ids[2].toString(), { scope: 'season', season: 1, favoriteCharacter: 'Lead', favoriteCastId: '20:Lead' });
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: ids[2], favoriteActorId: '20' }), 4);
  await assert.rejects(() => episodes.watch(owner.toString(), ids[2].toString(), { season: 1, episode: 1, watched: true, favoriteCharacter: 'Lead', favoriteCastId: '999:Lead' }), error => error.getStatus() === 400);
  await library.update(owner.toString(), ids[0].toString(), { title: 'Movie A', kind: 'movie', status: 'completed', favoriteCharacter: 'Hero', favoriteCastId: '10:Hero' });
  assert.equal((await db.collection('library_items').findOne({ _id: ids[0] })).favoriteActorId, '10');
  await db.collection('catalog_cast').deleteMany({});
  const persistent = await library.stats(owner.toString());
  assert.equal(persistent.preferences.actors.find(actor => actor.kind === 'series').count, 4);
  assert.equal(persistent.preferences.actors.find(actor => actor.kind === 'movie').count, 1);
  await episodes.watch(owner.toString(), ids[2].toString(), { season: 1, episode: 1, watched: true, favoriteCharacter: '', favoriteCastId: '' });
  assert.equal((await db.collection('episode_progress').findOne({ itemId: ids[2], episode: 1 })).favoriteActorId, '');
  await library.update(owner.toString(), ids[0].toString(), { title: 'Movie A', kind: 'movie', status: 'planned' });
  assert.equal((await db.collection('library_items').findOne({ _id: ids[0] })).favoriteActorId, '');

});
