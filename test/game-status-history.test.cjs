const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Banco exclusivo para validar o histórico, sem leitura ou escrita em contas reais.
const database = 'nextplay_status_history_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');

test('histórico atômico de jogos: novas alterações, início por horas/sessão, arquivos, isolamento e paginação', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_status_history_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('timeline-a'), b = await register('timeline-b');
  const add = async (title, kind = 'game') => { const r = await call('/library', 'POST', a, { title, kind, status: 'planned' }); assert.equal(r.status, 201); return (await r.json()).item; };
  const start = Date.now(), game = await add('Jogo novo'), path = '/library/' + game.id;
  const history = async (id = game.id, before) => { const r = await call('/library/' + id + '/game-status-history' + (before ? '?before=' + before : ''), 'GET', a); assert.equal(r.status, 200); return r.json(); };
  let value = await history(); assert.equal(value.events.length, 1); assert.equal(value.events[0].type, 'added'); assert.equal(value.events[0].fromStatus, null); assert.equal(value.events[0].toStatus, 'planned'); assert.equal(value.earlierHistoryUnknown, false); assert.ok(Date.parse(value.events[0].recordedAt) >= start);
  assert.equal((await call(path + '/game-status-history')).status, 401); assert.equal((await call(path + '/game-status-history', 'GET', b)).status, 404);
  const change = (status, extra = {}) => call(path, 'PATCH', a, { title: game.title, kind: 'game', status, ...extra });
  const requests = await Promise.all([change('active'), change('active')]); assert.ok(requests.some(r => r.status === 200)); assert.ok(requests.every(r => [200, 409].includes(r.status)));
  await change('active', { notes: 'Somente notas', stars: 0 });
  await call(path + '/priority', 'PATCH', a, { priority: 'high' });
  value = await history(); assert.equal(value.events.length, 2); assert.equal(value.events[0].fromStatus, 'planned'); assert.equal(value.events[0].toStatus, 'active');
  assert.equal((await change('completed', { completedOn: '2000-01-01', stars: 4 })).status, 200);
  await change('completed', { stars: 5 }); value = await history(); assert.equal(value.events.length, 3); assert.equal(value.events[0].toStatus, 'completed'); assert.ok(Date.parse(value.events[0].recordedAt) >= start);
  await change('active');
  await Promise.all([call(path + '/archive', 'POST', a, { archived: true }), call(path + '/archive', 'POST', a, { archived: true })]);
  value = await history(); assert.equal(value.events.filter(event => event.type === 'archived').length, 1);
  await call(path + '/archive', 'POST', a, { archived: false }); await call(path + '/archive', 'POST', a, { archived: false });
  value = await history(); assert.equal(value.events[0].type, 'restored'); assert.equal(value.events.filter(event => event.type === 'restored').length, 1);
  const movie = await add('Filme', 'movie'); assert.equal((await call('/library/' + movie.id + '/game-status-history', 'GET', a)).status, 400);
  // Registros legados não ganham uma adição inventada nem uma data de consumo presumida.
  const legacy = await add('Legado'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(legacy.id) }, { $unset: { gameStatusHistory: '' } });
  value = await history(legacy.id); assert.equal(value.events.length, 0); assert.equal(value.earlierHistoryUnknown, true);
  const session = { id: randomUUID(), playedOn: '2000-01-01', mode: 'add', minutes: 60 };
  assert.equal((await call('/library/' + legacy.id + '/game-sessions', 'POST', a, session)).status, 201);
  await call('/library/' + legacy.id + '/game-sessions', 'POST', a, session);
  value = await history(legacy.id); assert.equal(value.events.length, 1); assert.equal(value.events[0].source, 'session'); assert.equal(value.events[0].toStatus, 'active'); assert.ok(Date.parse(value.events[0].recordedAt) >= start);
  await call('/library/' + legacy.id + '/game-sessions/' + session.id, 'DELETE', a); assert.equal((await history(legacy.id)).events.length, 1);
  const quick = await add('Horas rápidas');
  await call('/library/' + quick.id + '/playtime', 'PATCH', a, { mode: 'total', minutes: 0 }); assert.equal((await history(quick.id)).events.length, 1);
  await Promise.all([call('/library/' + quick.id + '/playtime', 'PATCH', a, { mode: 'add', minutes: 10 }), call('/library/' + quick.id + '/playtime', 'PATCH', a, { mode: 'add', minutes: 10 })]);
  value = await history(quick.id); assert.equal(value.events.length, 2); assert.equal(value.events[0].source, 'time-adjustment');
  const list = (await (await call('/library', 'GET', a)).json()).items; assert.ok(list.every(item => !('gameStatusHistory' in item))); assert.equal(list.find(item => item.id === quick.id).playtimeMinutes, 20);
  assert.equal((await call(path + '/game-status-history?before=invalid', 'GET', a)).status, 400);
  assert.equal((await call(path + '/game-status-history?before=' + value.events[0].id, 'GET', a)).status, 400);
  assert.equal((await call(path + '/game-status-history?extra=1', 'GET', a)).status, 400);
  assert.equal((await call(path, 'PATCH', a, { title: game.title, kind: 'game', status: 'active', gameStatusHistory: [] })).status, 400);
  // O cursor mantém a página seguinte mesmo se houver um evento novo entre as leituras.
  for (let i = 0; i < 40; i++) assert.equal((await change(i % 2 === 0 ? 'planned' : 'active')).status, 200);
  const first = await history(); assert.equal(first.events.length, 30); assert.ok(first.nextBefore);
  const snapshotIds = (await db.collection('library_items').findOne({ _id: new Types.ObjectId(game.id) })).gameStatusHistory.map(event => event.id);
  await change('completed');
  const second = await history(game.id, first.nextBefore); const readIds = [...first.events, ...second.events].map(event => event.id);
  assert.equal(new Set(readIds).size, snapshotIds.length); assert.deepEqual(new Set(readIds), new Set(snapshotIds)); assert.equal(second.nextBefore, null);
  // Uma DLC possui eventos próprios e não escreve no histórico do principal.
  const part = await add('DLC'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(part.id) }, { $set: { parentGameCatalogId: 'igdb:game:42' } });
  const mainBefore = await history(); await call('/library/' + part.id + '/game-sessions', 'POST', a, { ...session, id: randomUUID() });
  assert.deepEqual(await history(), mainBefore); assert.equal((await history(part.id)).events[0].source, 'session');
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0);
  const spec = await (await call('/docs-json')).json(); assert.ok(spec.paths['/api/library/{id}/game-status-history'].get);
});
