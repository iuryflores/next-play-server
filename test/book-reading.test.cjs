// Testa o fluxo HTTP com banco descartável; não utiliza Atlas nem dados locais do usuário.
process.env.NODE_ENV = 'test';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.SWAGGER_ENABLED = 'true';
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const database = 'nextplay_reading_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { BooksService } = require('../dist/books/books.module');

test('leitura privada permite quero ler/lendo/lido sem modificar exemplares possuídos', async t => {
  const app = await createApp();
  const db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(database, /^nextplay_reading_test_[a-f0-9]{32}$/);
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path, method = 'GET', body, cookie) => fetch(base + '/api' + path, {
    method, headers: { Origin: process.env.CLIENT_ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function account(email) {
    const response = await request('/auth/register', 'POST', { email, password: 'Reading-test-password-123!' });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const a = await account('reader-a@example.test'), b = await account('reader-b@example.test');
  const books = app.get(BooksService);
  let calls = 0;
  books.detail = async catalogId => {
    calls++;
    return { catalogId, kind: 'book', title: 'Dom Casmurro', authors: ['Machado de Assis'], genres: ['Fiction / Classics'], publisher: 'Rocco', isbn: '9788535914849', language: 'pt', year: '2011', coverUrl: '', overview: '', sourceUrl: '' };
  };
  const input = { title: 'Título enviado', kind: 'book', status: 'planned', catalogId: 'googlebooks:book:' + 'a'.repeat(100) };
  const response = await request('/library', 'POST', input, a);
  assert.equal(response.status, 201);
  let item = (await response.json()).item;
  assert.equal(item.title, 'Dom Casmurro');
  assert.deepEqual(item.authors, ['Machado de Assis']);
  assert.equal(item.publisher, 'Rocco');
  assert.equal(item.bookMetadataVersion, undefined);
  assert.equal(await db.collection('collector_copies').countDocuments(), 0);
  assert.equal((await request('/library', 'POST', input, a)).status, 409);
  assert.equal((await request('/library', 'POST', { ...input, kind: 'movie' }, b)).status, 400);
  assert.deepEqual((await (await request('/library', 'GET', undefined, b)).json()).items, []);
  assert.equal((await request('/library/' + item.id, 'PATCH', input, b)).status, 404);
  assert.equal((await request('/library/' + item.id, 'DELETE', undefined, b)).status, 404);
  const copyResponse = await request('/collector/copies', 'POST', { title: input.title, kind: 'book', catalogId: input.catalogId, format: 'physical', edition: 'Capa dura' }, a);
  assert.equal(copyResponse.status, 201);
  const copies = await db.collection('collector_copies').find({}).toArray();
  const initialCalls = calls;
  for (const status of ['active', 'completed', 'planned']) {
    const result = await request('/library/' + item.id, 'PATCH', { ...input, status, ...(status === 'completed' ? { completedOn: '2026-01-01', stars: 4 } : {}) }, a);
    assert.equal(result.status, 200);
    item = (await result.json()).item;
    assert.equal(item.status, status);
    assert.equal(item.isbn, '9788535914849');
    assert.deepEqual(item.authors, ['Machado de Assis']);
    if (status === 'completed') { assert.equal(item.completedOn, '2026-01-01'); assert.equal(item.stars, 4); assert.ok(item.completedAt); }
    else { assert.equal(item.completedAt, null); assert.equal(item.stars, 0); }
  }
  assert.equal(calls, initialCalls, 'editar leitura preserva metadados sem consultar o Google');
  assert.equal((await request('/library/' + item.id, 'PATCH', { ...input, authors: ['Forjado'] }, a)).status, 400);
  assert.equal((await request('/library/' + item.id, 'DELETE', undefined, a)).status, 204);
  assert.deepEqual(await db.collection('collector_copies').find({}).toArray(), copies);
  const manual = await request('/library', 'POST', { title: 'Livro sem catálogo', kind: 'book', status: 'completed', stars: 5 }, a);
  assert.equal(manual.status, 201);
  assert.equal((await manual.json()).item.status, 'completed');
  books.request = async () => ({ kind: 'books#volumes', totalItems: 0, items: [] });
  assert.equal((await request('/catalog/books/suggestions?context=reading', 'GET', undefined, a)).status, 200);
  assert.equal((await request('/catalog/books/suggestions?context=collection', 'GET', undefined, a)).status, 200);
  assert.equal((await request('/catalog/books/suggestions?context=other', 'GET', undefined, a)).status, 400);
});
