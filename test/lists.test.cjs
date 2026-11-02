const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Types } = require('mongoose');
const { getConnectionToken } = require('@nestjs/mongoose');
// Banco descartável e exclusivo: os cenários não consultam listas ou amizades reais.
const database = 'np_lists_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false'; process.env.SWAGGER_ENABLED = 'true';
const { createApp } = require('../dist/bootstrap');

test('listas ordenadas privadas ou para amigos: isolamento, revogação, reenvios e conflitos', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const db = app.get(getConnectionToken()), base = await app.getUrl();
  t.after(async () => { try { assert.match(database, /^np_lists_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', user, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(user ? { cookie: user.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = async (path, user) => { const r = await call(path, 'GET', user); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const register = async name => { const r = await call('/auth/register', 'POST', null, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return { id: (await r.json()).user.id, cookie: r.headers.get('set-cookie').split(';')[0] }; };
  const a = await register('lists-a'), b = await register('lists-b'), c = await register('lists-c');
  const add = async (user, title, status) => { const r = await call('/library', 'POST', user, { title, kind: 'movie', status, notes: 'PRIVATE-NOTES', stars: 4 }); assert.equal(r.status, 201); return (await r.json()).item; };
  const first = await add(a, 'Filme para sábado', 'planned'), second = await add(a, 'Outro filme', 'completed'), foreign = await add(c, 'Título alheio', 'planned');
  const body = { name: '  Fim de semana  ', description: 'Minha seleção', visibility: 'private', itemIds: [first.id, second.id], requestId: randomUUID() };
  assert.equal((await call('/lists')).status, 401);
  assert.equal((await call('/lists', 'POST', a, body, 'https://evil.example')).status, 403);
  for (const extra of [{ name: ' ' }, { name: 'x'.repeat(101) }, { description: null }, { description: 'x'.repeat(1001) }, { visibility: 'public' }, { requestId: 'bad' }, { itemIds: null }, { itemIds: [foreign.id] }, { itemIds: [first.id, first.id] }, { itemIds: ['bad'] }, { itemIds: Array(101).fill(first.id) }, { notes: 'no' }]) {
    assert.equal((await call('/lists', 'POST', a, { ...body, ...extra, requestId: extra.requestId || randomUUID() })).status, 400);
  }
  let response = await call('/lists', 'POST', a, body); assert.equal(response.status, 201);
  let list = await response.json(); assert.equal(list.name, 'Fim de semana'); assert.equal(list.mine, true); assert.deepEqual(list.entries.map(e => e.sourceId), body.itemIds);
  const retried = await call('/lists', 'POST', a, body); assert.equal(retried.status, 201); assert.equal((await retried.json()).id, list.id);
  assert.equal(await db.collection('social_lists').countDocuments(), 1);
  assert.equal((await call('/lists', 'POST', a, { ...body, name: 'Outro nome' })).status, 409);
  assert.equal((await call('/lists/' + list.id, 'GET', b)).status, 404);
  assert.equal((await json('/lists?scope=friends', b)).lists.length, 0);
  const edit = { name: list.name, description: list.description, visibility: 'friends', itemIds: [second.id, first.id], revision: list.revision };
  assert.equal((await call('/lists/' + list.id, 'PATCH', b, edit)).status, 404);
  assert.equal((await call('/lists/' + list.id, 'DELETE', c, { revision: 0 })).status, 404);
  response = await call('/lists/' + list.id, 'PATCH', a, edit); assert.equal(response.status, 200); list = await response.json();
  assert.equal((await call('/lists/' + list.id, 'GET', b)).status, 404, 'um link não concede acesso a desconhecidos');
  await call('/friends/requests', 'POST', a, { code: b.id });
  let state = await json('/friends', b); const link = state.connections.find(row => row.incoming); assert.ok(link);
  assert.equal((await call('/lists/' + list.id, 'GET', b)).status, 404, 'convite pendente não concede acesso');
  await call('/friends/' + link.id + '/accept', 'POST', b);
  let shared = await json('/lists/' + list.id, b); assert.equal(shared.mine, false); assert.deepEqual(shared.entries.map(e => e.title), [second.title, first.title]);
  for (const secret of ['PRIVATE-NOTES', 'stars', 'notes', 'status', 'sourceId', first.id, second.id, '@example.test']) assert.equal(JSON.stringify(shared).includes(secret), false);
  assert.equal((await json('/lists?scope=friends', b)).lists[0].id, list.id);
  assert.equal((await json('/lists?scope=mine', b)).lists.length, 0);
  assert.equal((await call('/lists?scope=other', 'GET', a)).status, 400);
  assert.equal((await call('/lists?before=bad', 'GET', a)).status, 400);
  assert.equal((await call('/lists/bad', 'GET', a)).status, 400);
  // Somente uma aba pode salvar a revisão lida; a outra não sobrescreve silenciosamente.
  const writes = await Promise.all(['Seleção A', 'Seleção B'].map(name => call('/lists/' + list.id, 'PATCH', a, { ...edit, name, revision: list.revision })));
  assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]); list = await json('/lists/' + list.id, a);
  assert.equal((await call('/lists/' + list.id, 'DELETE', a, { revision: 0 })).status, 409);
  const duplicate = await db.collection('library_items').findOne({ _id: new Types.ObjectId(first.id) }); const duplicateId = new Types.ObjectId();
  await db.collection('library_items').insertOne({ ...duplicate, _id: duplicateId });
  assert.equal((await call('/lists', 'POST', a, { ...body, itemIds: [first.id, duplicateId.toString()], requestId: randomUUID() })).status, 400);
  await db.collection('library_items').deleteOne({ _id: duplicateId });
  await call('/library/' + first.id, 'DELETE', a);
  assert.equal((await json('/lists/' + list.id, b)).entries.some(entry => entry.title === first.title), true, 'curadoria não se perde ao remover acompanhamento');
  response = await call('/lists/' + list.id, 'PATCH', a, { ...edit, name: list.name, revision: list.revision, visibility: 'private' }); assert.equal(response.status, 200); list = await response.json();
  assert.equal((await call('/lists/' + list.id, 'GET', b)).status, 404);
  assert.equal((await json('/lists?scope=friends', b)).lists.length, 0);
  response = await call('/lists/' + list.id, 'PATCH', a, { ...edit, revision: list.revision }); assert.equal(response.status, 200); list = await response.json();
  await call('/friends/' + link.id, 'DELETE', a);
  assert.equal((await call('/lists/' + list.id, 'GET', b)).status, 404, 'desfazer amizade revoga o link');
  // Paginação estável por criação e independente de renomear listas.
  const source = await db.collection('social_lists').findOne({ _id: new Types.ObjectId(list.id) });
  await db.collection('social_lists').insertMany(Array.from({ length: 31 }, (_, i) => ({ ...source, _id: new Types.ObjectId(), name: 'Lista ' + i, requestId: randomUUID() })));
  const page1 = await json('/lists', a), page2 = await json('/lists?before=' + page1.nextBefore, a);
  assert.equal(page1.lists.length, 30); assert.equal(page2.lists.length, 2); assert.equal(new Set([...page1.lists, ...page2.lists].map(row => row.id)).size, 32);
  assert.equal((await call('/lists/' + list.id, 'DELETE', a, { revision: list.revision })).status, 204);
  assert.equal((await call('/lists/' + list.id, 'GET', a)).status, 404);
  assert.ok(await db.collection('library_items').findOne({ _id: new Types.ObjectId(second.id), status: 'completed' }));
  const schema = await json('/docs-json', a); assert.equal(schema.components.schemas.CreateList.properties.itemIds.maxItems, 100);
});
