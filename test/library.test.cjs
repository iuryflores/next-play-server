// Este cenário testa o fluxo legado; confirmação obrigatória tem suíte própria.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = `nextplay_library_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${database}`;
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.NODE_ENV = 'test';
process.env.ALLOW_REGISTRATION = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
test('library CRUD, validation, persistence and account isolation', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const connection = app.get(getConnectionToken());
  t.after(async () => { try { assert.match(database, /^nextplay_library_test_[a-f0-9]{32}$/); assert.equal(connection.name, database); await connection.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', body, cookie, origin = process.env.CLIENT_ORIGIN) => fetch(`${base}/api${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const register = async email => { const result = await call('/auth/register', 'POST', { email, password: 'Long-test-password-123!' }); assert.equal(result.status, 201); return result.headers.get('set-cookie').split(';')[0]; };
  const first = await register('first@example.test'); const second = await register('second@example.test');
  assert.equal((await call('/library')).status, 401);
  assert.deepEqual((await (await call('/library', 'GET', undefined, first)).json()).items, []);
  let book;
  for (const kind of ['movie', 'series', 'game', 'book']) {
    const result = await call('/library', 'POST', { title: `Meu ${kind}`, kind, status: 'planned', notes: 'Uma indicação' }, first);
    assert.equal(result.status, 201); const { item } = await result.json(); assert.equal(item.ownerId, undefined); if (kind === 'book') book = item;
  }
  assert.equal((await (await call('/library', 'GET', undefined, first)).json()).items.length, 4);
  assert.equal((await (await call('/library', 'GET', undefined, second)).json()).items.length, 0);
  const updated = { title: book.title, kind: 'book', status: 'completed', notes: 'Terminei de ler' };
  assert.equal((await call(`/library/${book.id}`, 'PATCH', updated, second)).status, 404);
  assert.equal((await call(`/library/${book.id}`, 'DELETE', undefined, second)).status, 404);
  assert.equal((await call(`/library/${book.id}`, 'PATCH', updated, first, 'https://evil.example')).status, 403);
  assert.equal((await call('/library', 'POST', { ...updated, ownerId: 'forged' }, first)).status, 400);
  assert.equal((await call('/library', 'POST', { ...updated, title: '  ' }, first)).status, 400);
  assert.equal((await call('/library', 'POST', { ...updated, status: 'invalid' }, first)).status, 400);
  assert.equal((await call('/library/invalid', 'PATCH', updated, first)).status, 400);
  const result = await call(`/library/${book.id}`, 'PATCH', updated, first); assert.equal(result.status, 200); assert.equal((await result.json()).item.status, 'completed');
  const another = await createApp(); await another.listen(0, '127.0.0.1');
  const archivePath = `/library/${book.id}/archive`;
  assert.equal((await call(archivePath, 'POST', { archived: true }, second)).status, 404);
  assert.equal((await call(archivePath, 'POST', { archived: true }, first, 'https://evil.example')).status, 403);
  assert.equal((await call(archivePath, 'POST', { archived: 'true' }, first)).status, 400);
  const archived = await call(archivePath, 'POST', { archived: true }, first);
  assert.equal(archived.status, 200);
  const archivedItem = (await archived.json()).item;
  assert.equal(archivedItem.archived, true); assert.equal(archivedItem.status, 'completed'); assert.equal(archivedItem.notes, 'Terminei de ler');
  const storedItems = (await (await call('/library', 'GET', undefined, first)).json()).items;
  assert.equal(storedItems.length, 4); assert.equal(storedItems.find(item => item.id === book.id).archived, true);
  assert.equal((await call('/library', 'POST', { title: book.title, kind: 'book', status: 'planned' }, first)).status, 409);
  const restoredItem = (await (await call(archivePath, 'POST', { archived: false }, first)).json()).item;
  assert.equal(restoredItem.archived, false); assert.equal(restoredItem.completedOn, archivedItem.completedOn);
  try { const restored = await fetch(`${await another.getUrl()}/api/library`, { headers: { cookie: first } }); assert.equal((await restored.json()).items.find(item => item.id === book.id).notes, 'Terminei de ler'); }
  finally { await another.close(); }
  assert.equal((await call(`/library/${book.id}`, 'DELETE', undefined, first)).status, 204);
  assert.equal((await (await call('/library', 'GET', undefined, first)).json()).items.length, 3);
  // Reabrir a coleção não consulta provedores nem grava metadados título a título.
  const { CatalogService } = require('../dist/catalog/catalog.module');
  let providerCalls = 0;
  app.get(CatalogService).detail = async () => { providerCalls++; throw new Error('Provider unavailable'); };
  const movie = await connection.collection('library_items').findOne({ title: 'Meu movie' });
  await connection.collection('library_items').updateOne({ _id: movie._id }, { $set: { catalogId: 'tmdb:movie:1', year: String(new Date().getUTCFullYear()) }, $unset: { releaseDate: 1 } });
  await connection.collection('catalog_titles').updateOne({ key: movie.catalogKey }, { $set: { releaseDate: '2027-01-01', unreleased: true } });
  const refreshed = await call('/library', 'GET', undefined, first);
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).items.find(item => item.id === movie._id.toString()).releaseDate, '2027-01-01');
  assert.equal(providerCalls, 0);
  assert.equal((await connection.collection('library_items').findOne({ _id: movie._id })).releaseDate, undefined);
});
