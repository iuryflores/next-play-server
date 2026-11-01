const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_bulk_stats_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { EpisodesService } = require('../dist/episodes/episodes.module');
const { LibraryService } = require('../dist/library/library.module');
test('bulk seasons and whole shows count every episode and runtime exactly once', async t => {
  const app = await createApp(); const db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_bulk_stats_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const owner = new Types.ObjectId(), first = new Types.ObjectId(), second = new Types.ObjectId();
  await db.collection('library_items').insertMany([
    { _id: first, ownerId: owner, title: 'First', kind: 'series', status: 'active', catalogId: 'tmdb:series:901' },
    { _id: second, ownerId: owner, title: 'Second', kind: 'series', status: 'planned', catalogId: 'tmdb:series:902' },
  ]);
  const episodes = count => Array.from({ length: count }, (_, i) => ({ number: i + 1, name: 'Episode ' + (i + 1), airDate: '2020-01-01', runtime: 40 }));
  await db.collection('series_seasons').insertMany([
    { catalogId: 'tmdb:series:901', number: 1, name: 'S1', total: 10, loaded: true, episodes: episodes(10) },
    { catalogId: 'tmdb:series:901', number: 2, name: 'S2', total: 9, loaded: true, episodes: [...episodes(8), { number: 9, name: 'Future', airDate: '2099-01-01', runtime: 40 }] },
    { catalogId: 'tmdb:series:902', number: 1, name: 'S1', total: 3, loaded: true, episodes: episodes(3) },
  ]);
  const service = app.get(EpisodesService), library = app.get(LibraryService);
  const watch = dto => service.watchMany(owner.toString(), first.toString(), dto);
  const check = async (count, minutes) => { const stats = await library.stats(owner.toString()); assert.equal(stats.episodes, count); assert.equal(stats.minutes, minutes); return stats; };
  await service.watch(owner.toString(), first.toString(), { season: 1, episode: 1, watched: true, stars: 5, feeling: 'happy' });
  await watch({ scope: 'season', season: 1 }); await check(10, 400);
  await watch({ scope: 'season', season: 1 }); await check(10, 400);
  await db.collection('catalog_cast').insertOne({ _id: 'tmdb:series:901:pt-BR:all:all', cast: [{ id: '100:Hero', character: 'Hero', actor: 'Actor', photo: '' }] });
  await watch({ scope: 'season', season: 1, favoriteCharacter: 'Hero' });
  await watch({ scope: 'season', season: 1, favoriteCharacter: 'Hero' });
  let voted = await check(10, 400);
  assert.equal(voted.preferences.characters.find(entry => entry.name === 'Hero').count, 10);
  assert.equal(voted.preferences.actors.find(entry => entry.id === '100').count, 10);
  await watch({ scope: 'season', season: 2, favoriteCharacter: 'Other' });
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: first, season: 2, favoriteCharacter: 'Other' }), 8);
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: first, season: 2, episode: 9 }), 0);
  await watch({ scope: 'season', season: 1, favoriteCharacter: 'Changed' });
  voted = await check(18, 720);
  assert.equal(voted.preferences.characters.find(entry => entry.name === 'Changed').count, 10);
  assert.ok(!voted.preferences.characters.some(entry => entry.name === 'Hero'));
  await watch({ scope: 'season', season: 1 });
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: first, season: 1, favoriteCharacter: 'Changed' }), 10);
  await watch({ scope: 'series' }); await check(18, 720);
  await watch({ scope: 'series' }); await check(18, 720);
  const saved = await db.collection('episode_progress').findOne({ itemId: first, season: 1, episode: 1 }); assert.equal(saved.stars, 5); assert.equal(saved.feeling, 'happy');
  await service.watchMany(owner.toString(), second.toString(), { scope: 'series' });
  const stats = await check(21, 840); assert.equal(stats.seriesCompleted, 2); assert.equal(stats.totalEpisodes, 21); assert.equal(stats.seriesMissingTotals, 0); assert.deepEqual(stats.bySeries.map(s => s.episodes), [18, 3]);
  await db.collection('series_seasons').updateOne({catalogId:'tmdb:series:901',number:2},{$push:{episodes:{number:10,name:'Undated',airDate:'',runtime:40}}});
  const unknown=await check(21,840);assert.equal(unknown.totalEpisodes,21);assert.equal(unknown.seriesMissingTotals,1);
  await service.watch(owner.toString(), first.toString(), { season: 1, episode: 1, watched: false }); await check(20, 800);
  await assert.rejects(() => service.unwatchMany(new Types.ObjectId().toString(), first.toString(), { scope: 'series' }), error => error.getStatus() === 404);
  await service.unwatchMany(owner.toString(), first.toString(), { scope: 'season', season: 1 }); await check(11, 440);
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: first, season: 1 }), 0);
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: first, season: 2 }), 8);
  await service.unwatchMany(owner.toString(), first.toString(), { scope: 'series' }); await check(3, 120);
  const cleared = await db.collection('library_items').findOne({ _id: first }); assert.equal(cleared.status, 'planned'); assert.equal(cleared.completedAt, null); assert.equal(cleared.episodesCompletedAt, undefined);
  await service.unwatchMany(owner.toString(), first.toString(), { scope: 'series' }); await check(3, 120);
});

