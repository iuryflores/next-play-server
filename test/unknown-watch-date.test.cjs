const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Cada execução usa banco local exclusivo, sem dados reais ou serviços de catálogo.
const database = 'nextplay_unknown_date_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');

test('data desconhecida preserva consumo, progresso e XP sem fabricar datas diárias', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_unknown_date_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('unknown-a'), b = await register('unknown-b');
  const payload = { title: 'Filme antigo', kind: 'movie', status: 'completed', watchedDateUnknown: true, stars: 4 };
  let r = await call('/library', 'POST', a, payload); assert.equal(r.status, 201);
  const movie = (await r.json()).item;
  assert.equal(movie.completedOn, null); assert.equal(movie.watchedDateUnknown, true); assert.ok(movie.completedAt); assert.equal(movie.lastWatchedAt, undefined);
  const moviePath = '/library/' + movie.id;
  r = await call(moviePath, 'PATCH', a, { title: movie.title, kind: 'movie', status: 'completed', stars: 5 });
  assert.equal(r.status, 200); assert.equal((await r.json()).item.watchedDateUnknown, true);
  assert.equal((await call(moviePath, 'PATCH', b, payload)).status, 404);
  assert.equal((await call(moviePath, 'PATCH', a, payload, 'https://evil.example')).status, 403);
  for (const extra of [{ watchedDateUnknown: null }, { watchedDateUnknown: 'true' }, { completedOn: '2020-01-01' }]) assert.equal((await call(moviePath, 'PATCH', a, { ...payload, ...extra })).status, 400);
  r = await call(moviePath, 'PATCH', a, { ...payload, watchedDateUnknown: false, completedOn: '2020-01-01' });
  assert.equal(r.status, 200); assert.equal((await r.json()).item.completedOn, '2020-01-01');
  await call(moviePath, 'PATCH', a, payload);
  r = await call('/library', 'POST', a, { title: 'Série local', kind: 'series', status: 'planned' }); assert.equal(r.status, 201);
  const series = (await r.json()).item, itemId = new Types.ObjectId(series.id), catalogId = 'tmdb:series:987654';
  await db.collection('library_items').updateOne({ _id: itemId }, { $set: { catalogId } });
  await db.collection('series_seasons').insertOne({ catalogId, number: 1, name: 'Temporada 1', total: 3, loaded: true, episodes: [1, 2, 3].map(number => ({ number, name: 'Episódio ' + number, airDate: '2020-01-01', runtime: 30 })) });
  const path = '/library/' + series.id + '/episodes';
  const mark = { season: 1, episode: 1, watched: true, watchedDateUnknown: true, stars: 4 };
  r = await call(path, 'PATCH', a, mark); assert.equal(r.status, 200);
  let episode = (await r.json()).seasons[0].episodes[0];
  assert.equal(episode.watched, true); assert.equal(episode.watchedAt, null); assert.equal(episode.watchedDateUnknown, true);
  let stored = await db.collection('episode_progress').findOne({ itemId, episode: 1 }); assert.ok(stored.recordedAt instanceof Date); assert.equal(stored.watchedAt, null);
  r = await call(path, 'PATCH', a, { season: 1, episode: 1, watched: true, stars: 5 }); assert.equal(r.status, 200); assert.equal((await r.json()).seasons[0].episodes[0].watchedDateUnknown, true);
  assert.equal((await call(path, 'PATCH', a, { ...mark, watchedDateUnknown: null })).status, 400);
  assert.equal((await call(path, 'PATCH', b, mark)).status, 404);
  r = await call('/library', 'GET', a); let card = (await r.json()).items.find(row => row.id === series.id);
  assert.equal(card.episodeProgress.watched, 1); assert.equal(card.episodeProgress.next.episode, 2); assert.equal(card.lastWatchedAt, undefined);
  const stats = await (await call('/library/stats', 'GET', a)).json(); assert.equal(stats.episodes, 1); assert.equal(stats.minutes, 30);
  const xp = await (await call('/progression/sync', 'POST', a, {})).json();
  assert.equal(xp.breakdown.find(row => row.kind === 'episode').units, 1); assert.equal(xp.breakdown.find(row => row.kind === 'movie').units, 1);
  // Um lote sem data não apaga a data real de um episódio já registrado.
  await call(path, 'PATCH', a, { season: 1, episode: 2, watched: true });
  const known = await db.collection('episode_progress').findOne({ itemId, episode: 2 });
  r = await call(path + '/watch-many', 'POST', a, { scope: 'season', season: 1, watchedDateUnknown: true }); assert.equal(r.status, 201);
  const episodes = (await r.json()).seasons[0].episodes; assert.ok(episodes.every(row => row.watched)); assert.equal(episodes[2].watchedAt, null); assert.equal(episodes[1].watchedAt, known.watchedAt.toISOString());
  await call(path, 'PATCH', a, { season: 1, episode: 1, watched: false });
  episode = (await (await call(path, 'GET', a)).json()).seasons[0].episodes[0]; assert.equal(episode.watched, false); assert.equal(episode.watchedDateUnknown, false);
});


test('metas diárias ignoram datas desconhecidas mesmo com data de registro', () => {
  const { dailyEpisodeRecord, seasonInOneDay } = require('../dist/achievements/achievement-rules');
  const rows = [1, 2, 3].map(key => ({ key: String(key), watchedAt: null, recordedAt: new Date(), watchOrigin: 'individual' }));
  assert.equal(dailyEpisodeRecord(rows, 'America/Sao_Paulo'), 0);
  assert.equal(seasonInOneDay(rows, ['1', '2', '3'], 'America/Sao_Paulo'), false);
});
