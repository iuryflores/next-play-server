const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const database = 'nextplay_series_rating_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.NODE_ENV = 'test';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { AuthService } = require('../dist/auth/auth.service');
const { ProgressionService } = require('../dist/progression/progression.module');

test('nota geral da série não conclui episódios e permanece após edição', async t => {
  const app = await createApp(), db = app.get(getConnectionToken());
  app.get(ProgressionService).onModuleDestroy();
  t.after(async () => {
    try { assert.match(database, /^nextplay_series_rating_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); }
    finally { await app.close(); }
  });
  const owner = new Types.ObjectId(), other = new Types.ObjectId();
  const id = new Types.ObjectId(), privateId = new Types.ObjectId();
  app.get(AuthService).me = async () => ({ id: owner.toString(), language: 'pt-BR' });
  await db.collection('library_items').insertMany([
    { _id: id, ownerId: owner, kind: 'series', status: 'active', title: 'Série', notes: 'Privado', stars: 0 },
    { _id: privateId, ownerId: other, kind: 'series', status: 'completed', title: 'Outra série', stars: 2 },
  ]);
  await db.collection('episode_progress').insertOne({ itemId: id, season: 1, episode: 1, watchedDateUnknown: true });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const patch = (target, body, action = '/rating') => fetch(base + '/api/library/' + target + action, {
    method: 'PATCH', headers: { origin: process.env.CLIENT_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const response = await patch(id, { stars: 4 });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).item.stars, 4);
  let stored = await db.collection('library_items').findOne({ _id: id });
  assert.equal(stored.status, 'active'); assert.equal(stored.notes, 'Privado');
  assert.equal(stored.completedAt, undefined); assert.equal(stored.episodesCompletedAt, undefined);
  assert.equal(await db.collection('episode_progress').countDocuments({ itemId: id }), 1);
  assert.equal((await patch(id, { title: 'Série', kind: 'series', status: 'active', notes: 'Editado' }, '')).status, 200);
  stored = await db.collection('library_items').findOne({ _id: id });
  assert.equal(stored.stars, 4);
  for (const body of [{ stars: 6 }, { stars: -1 }, { stars: 2.5 }, {}, { stars: null }, { stars: 5, status: 'completed' }]) {
    assert.equal((await patch(id, body)).status, 400);
  }
  assert.equal((await patch(privateId, { stars: 5 })).status, 404);
  assert.equal((await patch(id, { stars: 0 })).status, 200);
  assert.equal((await db.collection('library_items').findOne({ _id: id })).stars, 0);
});
