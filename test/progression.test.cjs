const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Banco exclusivamente local e aleatório; nenhum teste acessa os dados da conta real.
const database = 'nextplay_progression_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.SWAGGER_ENABLED = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');
const { levelFromXp, xpCandidates } = require('../dist/progression/progression-rules');

test('níveis crescem sem teto fixo e respeitam os limites exatos de cada avanço', () => {
  for (const n of [0, 1, 2, 3, 10, 100, 10000]) {
    const floor = 100 * n + 25 * n * (n - 1) / 2;
    const result = levelFromXp(floor);
    assert.equal(result.level, n + 1); assert.equal(result.currentXp, 0);
    assert.equal(result.requiredXp, 100 + n * 25);
    if (n > 0) {
      const before = levelFromXp(floor - 1);
      assert.equal(before.level, n); assert.equal(before.currentXp, before.requiredXp - 1);
    }
  }
  assert.deepEqual(levelFromXp(-50), { level: 1, totalXp: 0, currentXp: 0, requiredXp: 100 });
});

test('regras deduplicam obras e episódios, limitam horas e não pontuam apenas intenções', () => {
  const series = { _id: 's1', title: 'Série', kind: 'series', status: 'active', catalogId: 'tmdb:series:1' };
  const game = { _id: 'g1', title: 'Jogo', kind: 'game', status: 'completed', catalogId: 'igdb:game:1', playtimeMinutes: 999999, stars: 5, feeling: 'loved' };
  const rows = xpCandidates([series, game, { ...game, _id: 'g2' }, { _id: 'm', title: 'Planejado', kind: 'movie', status: 'planned', stars: 5 }], [
    { itemId: 's1', season: 1, episode: 1, watchedAt: new Date(), stars: 4 },
    { itemId: 's1', season: 1, episode: 1, watchedAt: new Date(), feeling: 'loved' },
    { itemId: 's1', season: 0, episode: 1, watchedAt: new Date() },
    { itemId: 'other', season: 1, episode: 2, watchedAt: new Date() },
  ], []);
  assert.equal(rows.filter(row => row.kind === 'game').length, 1);
  assert.equal(rows.filter(row => row.kind === 'review').length, 2);
  assert.equal(rows.filter(row => row.kind === 'episode').length, 1);
  assert.equal(rows.find(row => row.kind === 'hour').units, 100);
  assert.ok(!rows.some(row => row.label === 'Planejado'));
  assert.equal(xpCandidates([{ ...game, playtimeMinutes: 59 }], [], []).filter(row => row.kind === 'hour').length, 0);
});

test('XP persiste, reconhece histórico e protege edições repetidas, concorrência e contas', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try {
    assert.match(database, /^nextplay_progression_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase();
  } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, {
    method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const register = async name => {
    const response = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' });
    assert.equal(response.status, 201); return { cookie: response.headers.get('set-cookie').split(';')[0], id: (await response.json()).user.id };
  };
  const a = await register('xp-a'), b = await register('xp-b');
  const sync = async (user = a, body) => { const response = await call('/progression/sync', 'POST', user.cookie, body); assert.equal(response.status, 200); return response.json(); };
  assert.equal((await call('/progression')).status, 401);
  assert.equal((await call('/progression/sync', 'POST')).status, 401);
  assert.equal((await call('/progression/sync', 'POST', a.cookie, undefined, 'https://evil.example')).status, 403);
  assert.equal((await sync()).level, 1);
  const ownerId = new Types.ObjectId(a.id), movieId = new Types.ObjectId(), gameId = new Types.ObjectId(), seriesId = new Types.ObjectId();
  await db.collection('library_items').insertMany([
    { _id: movieId, ownerId, title: '$Filme privado', kind: 'movie', status: 'completed', catalogId: 'tmdb:movie:123', stars: 5 },
    { ownerId, title: 'Livro sem data', kind: 'book', status: 'completed', catalogId: 'googlebooks:book:one' },
    { _id: gameId, ownerId, title: 'Jogo', kind: 'game', status: 'completed', playtimeMinutes: 290, catalogId: 'igdb:game:123' },
    { _id: seriesId, ownerId, title: 'Série', kind: 'series', status: 'active', catalogId: 'tmdb:series:123' },
    { ownerId, title: 'Planejado', kind: 'book', status: 'planned' },
  ]);
  await db.collection('episode_progress').insertMany([
    { itemId: seriesId, season: 1, episode: 1, watchedAt: new Date(), feeling: 'loved' },
    { itemId: seriesId, season: 0, episode: 1, watchedAt: new Date() },
  ]);
  await db.collection('achievement_awards').insertMany([
    { ownerId, key: 'first-play-1', unlockedAt: new Date() }, { ownerId, key: 'unknown', unlockedAt: new Date() },
  ]);
  const expected = 20 + 3 + 50 + 50 + 8 + 5 + 3 + 25;
  const concurrent = await Promise.all([sync(), sync(), sync()]);
  assert.ok(concurrent.every(result => result.totalXp === expected));
  let state = concurrent[0];
  assert.equal(state.level, 2); assert.equal(state.currentXp, 64); assert.equal(state.requiredXp, 125);
  assert.ok(state.recent.some(row => row.label === '$Filme privado'), 'título não é interpretado como expressão MongoDB');
  const recordedAt = state.recent.find(row => row.label === '$Filme privado').recordedAt;
  assert.equal((await sync(b)).totalXp, 0, 'dados da outra conta não entram no XP');
  assert.equal((await sync(a, { xp: 999999, level: 900, ownerId: b.id })).totalXp, expected, 'pontos enviados pelo cliente não são usados');
  await db.collection('library_items').updateOne({ _id: movieId }, { $set: { status: 'planned', stars: 1 } });
  assert.equal((await sync()).totalXp, expected);
  await db.collection('library_items').deleteOne({ _id: movieId });
  await db.collection('library_items').insertOne({ ownerId, title: 'Filme recadastrado', kind: 'movie', status: 'completed', catalogId: 'tmdb:movie:123', feeling: 'liked' });
  assert.equal((await sync()).totalXp, expected, 'mesma referência recadastrada não repete pontos');
  await db.collection('library_items').updateOne({ _id: gameId }, { $set: { playtimeMinutes: 350 } });
  assert.equal((await sync()).totalXp, expected + 2);
  await db.collection('library_items').updateOne({ _id: gameId }, { $set: { playtimeMinutes: 60 } });
  assert.equal((await sync()).totalXp, expected + 2, 'correção para baixo não remove XP reconhecido');
  await db.collection('library_items').updateOne({ _id: gameId }, { $set: { playtimeMinutes: 6000000 } });
  state = await sync();
  assert.equal(state.totalXp, expected - 8 + 200);
  assert.equal(state.breakdown.find(row => row.kind === 'hour').units, 100);
  const count = await db.collection('user_xp_credits').countDocuments({ ownerId });
  await sync();
  assert.equal(await db.collection('user_xp_credits').countDocuments({ ownerId }), count);
  state = await (await call('/progression', 'GET', a.cookie)).json();
  assert.equal(state.totalXp, expected - 8 + 200);
  assert.equal(state.recent.find(row => row.label === '$Filme privado').recordedAt, recordedAt, 'sincronizar não redata créditos existentes');
  assert.equal((await (await call('/progression', 'GET', b.cookie)).json()).totalXp, 0);
  const spec = await (await call('/docs-json')).json();
  assert.ok(spec.paths['/api/progression/sync']); assert.ok(spec.components.schemas.ProgressionDto);
});
