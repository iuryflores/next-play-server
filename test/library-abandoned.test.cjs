const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Cada execução usa um banco descartável e contas exclusivas.
const database = 'nextplay_abandoned_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test';
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');

test('somente o dono pode abandonar e retomar uma obra, mantendo o progresso', async t => {
  const app = await createApp();
  const db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(database, /^nextplay_abandoned_test_[a-f0-9]{32}$/);
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally {
      await app.close();
    }
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const call = (path, method, cookie, body) => fetch(base + '/api' + path, {
    method,
    headers: { origin: process.env.CLIENT_ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const register = async name => {
    const response = await call('/auth/register', 'POST', undefined, {
      email: name + '@example.test',
      password: 'Long-test-password-123!',
    });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const owner = await register('owner');
  const visitor = await register('visitor');
  const created = await call('/library', 'POST', owner, {
    title: 'Jogo em andamento', kind: 'game', status: 'active', playtimeMinutes: 90, notes: 'Capítulo 3',
  });
  assert.equal(created.status, 201);
  const { item: game } = await created.json();
  const path = '/library/' + game.id;
  const setAbandoned = (cookie, abandoned) => call(path + '/abandoned', 'PATCH', cookie, { abandoned });
  assert.equal(game.abandoned, false);
  assert.equal((await setAbandoned(undefined, true)).status, 401);
  assert.equal((await setAbandoned(visitor, true)).status, 404);
  assert.equal((await setAbandoned(owner, 'true')).status, 400);

  assert.equal((await setAbandoned(owner, true)).status, 200);
  assert.equal((await setAbandoned(owner, true)).status, 200);
  const { items } = await (await call('/library', 'GET', owner)).json();
  const abandoned = items.find(item => item.id === game.id);
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.status, 'active');
  assert.equal(abandoned.playtimeMinutes, 90);
  assert.equal(abandoned.notes, 'Capítulo 3');

  const resumed = await setAbandoned(owner, false);
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).item.abandoned, false);
  const { events } = await (await call(path + '/game-status-history', 'GET', owner)).json();
  assert.deepEqual(events.map(event => event.type), ['resumed', 'abandoned', 'added']);
});
