const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = 'nextplay_challenges_test_' + randomUUID().replaceAll('-', '');
// Banco local exclusivo, inclusive para validar snapshots sem alterar dados reais.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');
const { challengeProgress, validChallengeDate } = require('../dist/challenges/challenges.module');

test('metas usam datas inclusivas, identidades distintas e não inventam conclusões para horas ou DLCs', () => {
  const challenge = { kind: 'game', startsOn: '2020-01-01', endsOn: '2020-12-31' };
  const items = [
    { kind: 'game', title: 'A', catalogId: 'igdb:game:1', completedOn: '2020-01-01' },
    { kind: 'game', title: 'A repetido', catalogId: 'igdb:game:1', completedOn: '2020-02-01' },
    { kind: 'game', title: 'B', completedOn: '2020-12-31' },
    { kind: 'game', title: 'Sem data' },
    { kind: 'game', title: 'Inválida', completedOn: '2020-02-30' },
    { kind: 'game', title: 'Antes', completedOn: '2019-12-31' },
    { kind: 'game', title: 'Depois', completedOn: '2021-01-01' },
    { kind: 'game', title: 'DLC', completedOn: '2020-04-01', parentGameCatalogId: 'igdb:game:1' },
    { kind: 'game', title: 'DLC antiga', catalogId: 'igdb:game:3', completedOn: '2020-04-01' },
    { kind: 'movie', title: 'Filme', completedOn: '2020-04-01' },
  ];
  const result = challengeProgress(challenge, items, new Set(['igdb:game:3']), '2026-11-02');
  assert.equal(result.count, 2); assert.equal(result.evidence[0].title, 'B');
  assert.equal(challengeProgress(challenge, items, new Set(['igdb:game:3']), '2020-01-01').count, 1);
  assert.equal(validChallengeDate('2020-02-29'), true); assert.equal(validChallengeDate('2021-02-29'), false);
});

test('desafios privados: criação idempotente, contagem real, encerramento congelado e paginação', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_challenges_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('challenge-a'), b = await register('challenge-b');
  const add = async (title, kind = 'game', extra = {}, cookie = a) => { const r = await call('/library', 'POST', cookie, { title, kind, status: 'completed', completedOn: '2020-06-01', ...extra }); assert.equal(r.status, 201); return (await r.json()).item; };
  await add('Principal'); const archived = await add('Arquivado', 'game', { completedOn: '2020-12-31' }); await call('/library/' + archived.id + '/archive', 'POST', a, { archived: true });
  await add('Fora do período', 'game', { completedOn: '2019-12-31' }); await add('Só horas', 'game', { status: 'active', playtimeMinutes: 500 });
  const unknown = await add('Legado sem data'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(unknown.id) }, { $unset: { completedOn: '' } });
  const dlc = await add('DLC dependente'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(dlc.id) }, { $set: { parentGameCatalogId: 'igdb:game:42' } });
  const oldDlc = await add('DLC legado'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(oldDlc.id) }, { $set: { catalogId: 'igdb:game:77' } });
  const standalone = await add('Expansão independente'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(standalone.id) }, { $set: { catalogId: 'igdb:game:88' } });
  await db.collection('catalog_game_addons').insertOne({ _id: 'igdb:game:42', refs: [{ id: 77, contentType: 'dlc' }, { id: 88, contentType: 'standalone-expansion' }] });
  await add('Filme conhecido', 'movie'); await add('Filme sem data', 'movie', { completedOn: undefined, watchedDateUnknown: true }); await add('Livro lido', 'book'); await add('De outra pessoa', 'game', {}, b);
  const payload = { id: randomUUID(), name: 'Meus jogos', kind: 'game', target: 3, startsOn: '2020-01-01', endsOn: '2020-12-31', timeZone: 'America/Sao_Paulo' };
  assert.equal((await call('/challenges')).status, 401); assert.equal((await call('/challenges', 'POST', a, payload, 'https://evil.example')).status, 403);
  const results = await Promise.all([call('/challenges', 'POST', a, payload), call('/challenges', 'POST', a, payload)]); assert.ok(results.every(r => r.status === 201));
  assert.equal(await db.collection('personal_challenges').countDocuments(), 1);
  assert.equal((await call('/challenges', 'POST', a, { ...payload, target: 4 })).status, 409);
  const list = async cookie => (await (await call('/challenges', 'GET', cookie)).json());
  let data = await list(a), goal = data.challenges[0]; assert.equal(goal.count, 3); assert.equal(goal.achieved, true); assert.equal(goal.percent, 100); assert.equal(goal.phase, 'ended'); assert.equal(goal.evidence.length, 3); assert.ok(!('ownerId' in goal));
  assert.equal((await list(b)).challenges.length, 0);
  const movieGoal = { ...payload, id: randomUUID(), name: 'Filmes', kind: 'movie', target: 50 };
  await call('/challenges', 'POST', a, movieGoal); assert.equal((await list(a)).challenges.find(row => row.id === movieGoal.id).count, 1);
  const bookGoal = { ...payload, id: randomUUID(), name: 'Livros', kind: 'book', target: 2 }; await call('/challenges', 'POST', a, bookGoal); assert.equal((await list(a)).challenges.find(row => row.id === bookGoal.id).count, 1);
  for (const extra of [{ target: 0 }, { target: 1.5 }, { target: 10001 }, { kind: 'series' }, { name: '  ' }, { startsOn: '2020-02-30' }, { endsOn: '2019-12-31' }, { timeZone: 'Invalid/Zone' }, { snapshot: { count: 999 } }]) assert.equal((await call('/challenges', 'POST', a, { ...payload, id: randomUUID(), ...extra })).status, 400);
  assert.equal((await call('/challenges/' + payload.id + '/close', 'POST', b)).status, 404); assert.equal((await call('/challenges/' + payload.id, 'DELETE', b)).status, 404);
  assert.equal((await call('/challenges/' + payload.id + '/close', 'POST', a, undefined, 'https://evil.example')).status, 403);
  assert.equal((await call('/challenges/' + payload.id + '/close', 'POST', a)).status, 204);
  await call('/challenges/' + payload.id + '/close', 'POST', a);
  await db.collection('library_items').updateMany({ kind: 'game' }, { $set: { status: 'planned' } });
  goal = (await list(a)).challenges.find(row => row.id === payload.id); assert.equal(goal.count, 3); assert.equal(goal.phase, 'closed'); assert.ok(goal.closedAt);
  const current = { ...payload, id: randomUUID(), name: 'Meta atual' }; await call('/challenges', 'POST', a, current); assert.equal((await list(a)).challenges.find(row => row.id === current.id).count, 0);
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0);
  for (let i = 0; i < 20; i++) assert.equal((await call('/challenges', 'POST', a, { ...payload, id: randomUUID(), name: 'Meta ' + i })).status, 201);
  const first = await list(a); assert.equal(first.challenges.length, 20); assert.ok(first.nextBefore);
  const next = await (await call('/challenges?before=' + first.nextBefore, 'GET', a)).json(); assert.equal(next.challenges.length, 4); assert.equal(next.nextBefore, null);
  assert.equal(new Set([...first.challenges, ...next.challenges].map(row => row.id)).size, 24);
  assert.equal((await call('/challenges?before=invalid', 'GET', a)).status, 400);
  assert.equal((await call('/challenges?before=' + payload.id, 'GET', b)).status, 404);
  const beforeTitles = await db.collection('library_items').countDocuments(); assert.equal((await call('/challenges/' + payload.id, 'DELETE', a)).status, 204); assert.equal(await db.collection('library_items').countDocuments(), beforeTitles);
  const spec = await (await call('/docs-json')).json(); assert.ok(spec.paths['/api/challenges'].post); assert.ok(spec.paths['/api/challenges/{id}/close'].post);
});
