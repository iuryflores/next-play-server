const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// A suíte usa apenas um banco local exclusivo, que é removido ao terminar.
const database = 'nextplay_notifications_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test';
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.SWAGGER_ENABLED = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');

test('central persiste eventos e leituras, protege contas e acompanha convites', async t => {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(database, /^nextplay_notifications_test_[a-f0-9]{32}$/);
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally { await app.close(); }
  });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, {
    method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const register = async name => {
    const response = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' });
    assert.equal(response.status, 201);
    return { cookie: response.headers.get('set-cookie').split(';')[0], id: (await response.json()).user.id };
  };
  const a = await register('notify-a'), b = await register('notify-b');
  const list = async user => {
    const response = await call('/notifications', 'GET', user.cookie);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await call('/notifications')).status, 401);
  assert.equal((await list(b)).unreadCount, 0);
  await db.collection('users').updateOne({ _id: new Types.ObjectId(a.id) }, { $set: { displayName: 'Alice', avatar: 'https://example.test/alice.jpg' } });
  assert.equal((await call('/friends/requests', 'POST', a.cookie, { code: b.id })).status, 204);
  let state = await list(b);
  assert.equal(state.unreadCount, 1);
  const invite = state.items[0];
  assert.equal(invite.kind, 'friend-request');
  assert.equal(invite.friendRequest.name, 'Alice');
  assert.equal(invite.friendRequest.avatar, 'https://example.test/alice.jpg');
  assert.equal(invite.friendRequest.status, 'pending');
  assert.ok(!JSON.stringify(state).includes('@example.test'));
  assert.equal((await list(a)).items.length, 0);
  assert.equal((await list(b)).unreadCount, 1, 'consultar não marca leitura');
  assert.equal((await call(`/notifications/${invite.id}/read`, 'PATCH', a.cookie)).status, 404);
  assert.equal((await call(`/notifications/${invite.id}/read`, 'PATCH', b.cookie, undefined, 'https://evil.example')).status, 403);
  assert.equal((await call('/notifications/read-all', 'POST', b.cookie, undefined, 'https://evil.example')).status, 403);
  assert.equal((await call('/notifications/invalid/read', 'PATCH', b.cookie)).status, 404);
  assert.equal((await call(`/notifications/${invite.id}/read`, 'PATCH', b.cookie)).status, 204);
  const readAt = (await list(b)).items[0].readAt;
  assert.ok(readAt);
  assert.equal((await call(`/notifications/${invite.id}/read`, 'PATCH', b.cookie)).status, 204);
  assert.equal((await list(b)).items[0].readAt, readAt, 'leitura idempotente');
  assert.equal((await call(`/friends/${invite.friendRequest.id}/accept`, 'POST', b.cookie)).status, 204);
  assert.equal((await list(b)).items[0].friendRequest.status, 'accepted');
  assert.equal((await call(`/friends/${invite.friendRequest.id}`, 'DELETE', a.cookie)).status, 204);
  assert.equal((await list(b)).items[0].friendRequest.status, 'closed');
  assert.equal((await call('/friends/requests', 'POST', a.cookie, { code: b.id })).status, 204);
  state = await list(b);
  assert.equal(state.items.length, 2, 'novo convite tem seu próprio evento');
  const pending = state.items.find(item => item.friendRequest.status === 'pending');
  assert.equal((await call(`/friends/${pending.friendRequest.id}`, 'DELETE', b.cookie)).status, 204);
  assert.equal((await list(b)).items.find(item => item.id === pending.id).friendRequest.status, 'closed');

  const ownerId = new Types.ObjectId(b.id);
  await db.collection('library_items').insertOne({ ownerId, kind: 'movie', title: 'Filme privado', status: 'completed' });
  await Promise.all(Array.from({ length: 3 }, async () => {
    assert.equal((await call('/achievements/sync', 'POST', b.cookie, {})).status, 200);
  }));
  state = await list(b);
  const achievement = state.items.find(item => item.achievement?.id === 'first-play-1');
  assert.ok(achievement, JSON.stringify(state));
  assert.ok(achievement.achievement.evidence.some(value => value.includes('Filme privado')));
  assert.equal(await db.collection('user_notifications').countDocuments({ ownerId, kind: 'achievement', sourceId: 'first-play-1' }), 1);
  assert.ok(!(await list(a)).items.some(item => item.achievement));
  assert.equal((await call(`/notifications/${achievement.id}/read`, 'PATCH', a.cookie)).status, 404);
  assert.equal((await call('/notifications/read-all', 'POST', b.cookie)).status, 204);
  assert.equal((await list(b)).unreadCount, 0);
  assert.equal((await call('/achievements/sync', 'POST', b.cookie, {})).status, 200);
  assert.equal((await list(b)).unreadCount, 0, 'sincronização não desfaz leitura');
  assert.equal((await db.collection('achievement_awards').findOne({ ownerId, key: 'first-play-1' })).celebratedAt, undefined, 'ler não dispensa celebração');
  assert.equal((await call('/notifications?cursor=invalid', 'GET', b.cookie)).status, 400);
  assert.equal((await call('/notifications?unknown=value', 'GET', b.cookie)).status, 400);

  // O histórico anterior à central é recuperado sem depender de uma nova conquista.
  await db.collection('achievement_awards').insertOne({ ownerId: new Types.ObjectId(a.id), key: 'cinephile-100', unlockedAt: new Date('2026-10-01'), celebratedAt: new Date(), evidence: ['Histórico privado'] });
  assert.equal((await list(a)).unreadCount, 1);
  assert.ok((await list(a)).items[0].achievement.evidence.includes('Histórico privado'));
  assert.ok(!(await list(b)).items.some(item => item.achievement?.evidence.includes('Histórico privado')));

  // Datas iguais exigem desempate pelo ID para não repetir nem perder registros entre páginas.
  await db.collection('user_notifications').insertMany(Array.from({ length: 35 }, (_, index) => ({ ownerId, kind: 'achievement', sourceId: 'fixture-' + index, createdAt: new Date('2026-10-02') })));
  state = await list(b);
  assert.equal(state.items.length, 30);
  assert.ok(state.nextCursor);
  const next = await (await call('/notifications?cursor=' + encodeURIComponent(state.nextCursor), 'GET', b.cookie)).json();
  const ids = [...state.items, ...next.items].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, await db.collection('user_notifications').countDocuments({ ownerId }));
  assert.equal(next.nextCursor, null);
  assert.equal((await call('/notifications/read-all', 'POST', b.cookie)).status, 204);
  assert.equal((await list(b)).unreadCount, 0);
  assert.equal((await list(a)).unreadCount, 1, 'marcar todas não altera outra conta');
  const schema = await (await fetch(base + '/api/docs-json')).json();
  assert.ok(schema.paths['/api/notifications']);
  assert.ok(schema.paths['/api/notifications/{id}/read']);
});
