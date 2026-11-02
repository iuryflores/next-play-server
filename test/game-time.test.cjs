const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// A suíte trabalha somente em um banco local aleatório, sem acessar dados reais.
const database = 'nextplay_game_time_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
test('registro rápido soma tempo atomicamente, permite corrigir total e preserva os demais dados', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try {
    assert.match(database, /^nextplay_game_time_test_[a-f0-9]{32}$/); assert.equal(db.name, database);
    await db.dropDatabase();
  } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, {
    method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const register = async name => {
    const result = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' });
    assert.equal(result.status, 201); return result.headers.get('set-cookie').split(';')[0];
  };
  const a = await register('game-time-a'), b = await register('game-time-b');
  const create = async payload => {
    const result = await call('/library', 'POST', a, payload); assert.equal(result.status, 201); return (await result.json()).item;
  };
  const game = await create({ kind: 'game', title: 'Jogo teste', status: 'planned', platform: 'PC', playtimeMinutes: 30, notes: 'Notas privadas' });
  const path = `/library/${game.id}/playtime`;
  assert.equal((await call(path, 'PATCH', undefined, { mode: 'add', minutes: 20 })).status, 401);
  assert.equal((await call(path, 'PATCH', b, { mode: 'add', minutes: 20 })).status, 404);
  assert.equal((await call(path, 'PATCH', a, { mode: 'add', minutes: 20 }, 'https://evil.example')).status, 403);
  for (const body of [{ mode: 'add', minutes: 0 }, { mode: 'add', minutes: -1 }, { mode: 'total', minutes: 1.5 }, { mode: 'bad', minutes: 1 }, { mode: 'add', minutes: 6000001 }, { mode: 'add', minutes: 1, ownerId: 'forged' }]) {
    assert.equal((await call(path, 'PATCH', a, body)).status, 400);
  }
  const results = await Promise.all([50, 70].map(async minutes => {
    const response = await call(path, 'PATCH', a, { mode: 'add', minutes }); assert.equal(response.status, 200); return (await response.json()).item;
  }));
  const updated = results.find(item => item.playtimeMinutes === 150);
  assert.ok(updated, 'somas simultâneas não perdem minutos');
  assert.equal(updated.status, 'active'); assert.equal(updated.platform, 'PC'); assert.equal(updated.notes, 'Notas privadas');
  const total = await (await call(path, 'PATCH', a, { mode: 'total', minutes: 290 })).json();
  assert.equal(total.item.playtimeMinutes, 290, '4h50min em minutos inteiros');
  assert.equal((await call(path, 'PATCH', a, { mode: 'add', minutes: 6000000 })).status, 400);
  const cleared = await (await call(path, 'PATCH', a, { mode: 'total', minutes: 0 })).json();
  assert.equal(cleared.item.playtimeMinutes, 0);
  const completed = await create({ title: 'Zerado', kind: 'game', status: 'completed', completedOn: '2026-10-20', stars: 4, notes: 'Finalizado' });
  const replayed = await (await call(`/library/${completed.id}/playtime`, 'PATCH', a, { mode: 'add', minutes: 60 })).json();
  assert.equal(replayed.item.status, 'completed'); assert.equal(replayed.item.completedOn, '2026-10-20'); assert.equal(replayed.item.stars, 4);
  const movie = await create({ title: 'Filme', kind: 'movie', status: 'planned' });
  assert.equal((await call(`/library/${movie.id}/playtime`, 'PATCH', a, { mode: 'add', minutes: 60 })).status, 404);
});
