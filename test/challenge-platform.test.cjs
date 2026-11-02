const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Isolamento local: nenhum desafio ou acompanhamento real participa dos testes.
const database = 'nextplay_platform_goal_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');
const { challengeProgress, challengePlatformKey } = require('../dist/challenges/challenges.module');

test('plataforma normaliza grafia, separa consoles e preserva a contagem geral', () => {
  const goal = { kind: 'game', startsOn: '2020-01-01', endsOn: '2020-12-31', platform: ' PS5 ' };
  const items = [
    { kind: 'game', title: 'Primeiro', platform: 'ps5', completedOn: '2020-01-01' },
    { kind: 'game', title: 'Segundo', platform: ' PS5 ', completedOn: '2020-12-31' },
    { kind: 'game', title: 'PS4', platform: 'PS4', completedOn: '2020-06-01' },
    { kind: 'game', title: 'Sem plataforma', completedOn: '2020-06-01' },
    { kind: 'game', title: 'DLC', platform: 'PS5', completedOn: '2020-06-01', parentGameCatalogId: 'igdb:game:1' },
  ];
  assert.equal(challengeProgress(goal, items, new Set(), '2026-11-02').count, 2);
  assert.equal(challengeProgress({ ...goal, platform: undefined }, items, new Set(), '2026-11-02').count, 4);
  assert.equal(challengeProgress({ ...goal, platform: 'Nintendo Switch' }, items, new Set(), '2026-11-02').count, 0);
  assert.equal(challengePlatformKey(' Console  próprio '), challengePlatformKey('CONSOLE PROPRIO'));
  assert.notEqual(challengePlatformKey('PS4'), challengePlatformKey('PS5'));
});

test('meta por plataforma persiste, protege validações e congela somente conclusões elegíveis', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_platform_goal_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('platform-goal-a'), b = await register('platform-goal-b');
  const add = async (title, platform, extra = {}, cookie = a) => { const r = await call('/library', 'POST', cookie, { title, kind: 'game', status: 'completed', completedOn: '2020-06-01', platform, ...extra }); assert.equal(r.status, 201); return (await r.json()).item; };
  await add('PS5 primeiro', 'PS5'); const second = await add('PS5 segundo', ' ps5 '); await add('PS4 jogo', 'PS4'); await add('PC jogo', 'PC'); await add('Sem plataforma', '');
  await add('Em andamento', 'PS5', { status: 'active' }); await add('Fora do período', 'PS5', { completedOn: '2019-12-31' });
  const dlc = await add('DLC', 'PS5'); await db.collection('library_items').updateOne({ _id: new Types.ObjectId(dlc.id) }, { $set: { parentGameCatalogId: 'igdb:game:42' } });
  await add('Outra conta', 'PS5', {}, b);
  const payload = { id: randomUUID(), name: 'Jogos de PS5', kind: 'game', platform: ' PS5 ', target: 5, startsOn: '2020-01-01', endsOn: '2020-12-31', timeZone: 'America/Sao_Paulo' };
  assert.equal((await call('/challenges', 'POST', a, payload)).status, 201);
  const list = async cookie => (await (await call('/challenges', 'GET', cookie)).json()).challenges;
  let goal = (await list(a)).find(goal => goal.id === payload.id); assert.equal(goal.platform, 'PS5'); assert.equal(goal.count, 2); assert.equal(goal.percent, 40); assert.equal(goal.evidence.length, 2);
  assert.equal((await list(b)).length, 0);
  assert.equal((await call('/challenges', 'POST', a, { ...payload, platform: 'ps5' })).status, 201);
  assert.equal((await call('/challenges', 'POST', a, { ...payload, platform: 'PS4' })).status, 409);
  assert.equal(await db.collection('personal_challenges').countDocuments(), 1);
  // Sem o novo campo, a assinatura e o comportamento de desafios já existentes são mantidos.
  const general = { ...payload, id: randomUUID(), name: 'Qualquer plataforma' }; delete general.platform;
  assert.equal((await call('/challenges', 'POST', a, general)).status, 201);
  assert.equal((await call('/challenges', 'POST', a, { ...general, platform: '' })).status, 201);
  goal = (await list(a)).find(goal => goal.id === general.id); assert.equal(goal.platform, null); assert.equal(goal.count, 5);
  const signature = (await db.collection('personal_challenges').findOne({ _id: general.id })).signature;
  assert.equal(signature, JSON.stringify([general.name, general.kind, general.target, general.startsOn, general.endsOn, general.timeZone]));
  for (const platform of [null, 5, [], {}, 'x'.repeat(61)]) assert.equal((await call('/challenges', 'POST', a, { ...payload, id: randomUUID(), platform })).status, 400);
  for (const kind of ['movie', 'book']) assert.equal((await call('/challenges', 'POST', a, { ...payload, id: randomUUID(), kind })).status, 400);
  assert.equal((await call('/challenges', 'POST', a, { ...payload, id: randomUUID() }, 'https://evil.example')).status, 403);
  assert.equal((await call('/challenges/' + payload.id + '/close', 'POST', b)).status, 404);
  assert.equal((await call('/challenges/' + payload.id + '/close', 'POST', a)).status, 204);
  await db.collection('library_items').updateOne({ _id: new Types.ObjectId(second.id) }, { $set: { platform: 'PC' } });
  goal = (await list(a)).find(goal => goal.id === payload.id); assert.equal(goal.count, 2); assert.equal(goal.platform, 'PS5'); assert.equal(goal.phase, 'closed');
  const open = { ...payload, id: randomUUID(), name: 'PS5 em andamento' }; await call('/challenges', 'POST', a, open);
  assert.equal((await list(a)).find(goal => goal.id === open.id).count, 1);
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0);
  const spec = await (await call('/docs-json')).json(); assert.equal(spec.components.schemas.CreateChallengeDto.properties.platform.maxLength, 60); assert.equal(spec.components.schemas.CreateChallengeDto.required.includes('platform'), false);
});
