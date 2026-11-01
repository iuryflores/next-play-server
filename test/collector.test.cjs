// Banco descartável exclusivo desta suíte; nunca utiliza Atlas nem dados de desenvolvimento.
process.env.NODE_ENV = 'test';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.SWAGGER_ENABLED = 'true';
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const database = 'nextplay_collector_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { CatalogService } = require('../dist/catalog/catalog.module');
const { BooksService } = require('../dist/books/books.module');

test('acervo privado permite cópias e edições independentes do acompanhamento', async t => {
  const app = await createApp();
  const db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(database, /^nextplay_collector_test_[a-f0-9]{32}$/);
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path, method = 'GET', body, cookie, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, {
    method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  async function account(email) {
    const response = await request('/auth/register', 'POST', { email, password: 'Collector-test-password-123!' });
    assert.equal(response.status, 201);
    const { user } = await response.json();
    return { user, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const a = await account('collector-a@example.test'), b = await account('collector-b@example.test');
  const path = '/collector/copies';
  const original = { title: 'F1 2025', kind: 'game', format: 'physical', platform: 'PS5', edition: 'Standard', notes: 'Lacrado' };
  // Uma obra acompanhada não entra automaticamente no acervo e não é afetada por ele.
  await db.collection('library_items').insertOne({ ownerId: new Types.ObjectId(a.user.id), title: original.title, kind: 'game', status: 'completed', stars: 5, notes: 'Histórico preservado' });
  const before = await db.collection('library_items').find({}).toArray();
  assert.deepEqual((await (await request(path, 'GET', undefined, a.cookie)).json()).copies, []);
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, 'POST', original, a.cookie, 'https://evil.example')).status, 403);
  assert.equal((await request(path, 'POST', original)).status, 401);
  for (const body of [ { ...original, status: 'completed' }, { ...original, ownerId: b.user.id }, { ...original, title: '  ' }, { ...original, format: 'rented' }, { ...original, notes: 'x'.repeat(2001) }, { ...original, catalogId: 'tmdb:movie:1' } ]) {
    assert.equal((await request(path, 'POST', body, a.cookie)).status, 400);
  }
  const copies = [];
  for (const body of [original, original, { ...original, format: 'digital', platform: 'Steam', edition: 'Deluxe' }]) {
    const response = await request(path, 'POST', body, a.cookie); assert.equal(response.status, 201);
    const { copy } = await response.json(); copies.push(copy);
    assert.equal(copy.ownerId, undefined); assert.equal(copy.status, undefined);
    assert.ok(copy.createdAt); assert.ok(copy.updatedAt);
  }
  assert.equal(new Set(copies.map(c => c.id)).size, 3);
  assert.equal((await (await request(path, 'GET', undefined, a.cookie)).json()).copies.length, 3);
  assert.deepEqual((await (await request(path, 'GET', undefined, b.cookie)).json()).copies, []);
  assert.equal((await request(path + '/' + copies[0].id, 'PATCH', original, b.cookie)).status, 404);
  assert.equal((await request(path + '/' + copies[0].id, 'DELETE', undefined, b.cookie)).status, 404);
  assert.equal((await request(path + '/invalid', 'DELETE', undefined, a.cookie)).status, 404);
  const edit = await request(path + '/' + copies[0].id, 'PATCH', { ...original, edition: 'Colecionador', notes: 'Cópia 1' }, a.cookie);
  assert.equal(edit.status, 200);
  let list = (await (await request(path, 'GET', undefined, a.cookie)).json()).copies;
  assert.equal(list.find(c => c.id === copies[0].id).edition, 'Colecionador');
  assert.equal(list.find(c => c.id === copies[1].id).edition, 'Standard');
  assert.equal((await request(path + '/' + copies[0].id, 'DELETE', undefined, a.cookie)).status, 204);
  list = (await (await request(path, 'GET', undefined, a.cookie)).json()).copies;
  assert.equal(list.length, 2); assert.ok(list.some(c => c.id === copies[1].id));
  assert.equal((await request(path, 'POST', { ...original, title: 'Livro físico', kind: 'book', platform: '', edition: 'Capa dura' }, a.cookie)).status, 201);

  let calls = 0;
  app.get(CatalogService).detail = async id => { calls++; return { title: 'Obra do catálogo', kind: 'game', catalogId: id, coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/test.jpg', year: '2025' }; };
  const linked = { ...original, catalogId: 'igdb:game:99' };
  const { copy } = await (await request(path, 'POST', linked, a.cookie)).json();
  assert.equal(copy.title, 'Obra do catálogo'); assert.equal(calls, 1);
  assert.equal((await request(path + '/' + copy.id, 'PATCH', { ...linked, edition: 'Outra edição' }, a.cookie)).status, 200);
  assert.equal(calls, 1, 'editar uma cópia existente não consulta o catálogo');
  const books = app.get(BooksService);
  let bookCalls = 0;
  books.detail = async id => { bookCalls++; return { catalogId: id, kind: 'book', title: 'Dom Casmurro', authors: ['Machado de Assis'], genres: ['Fiction / Classics'], isbn: '9788535914849', publisher: 'Editora de teste', language: 'pt', coverUrl: '', year: '2020' }; };
  const bookInput = { title: 'Título do cliente', kind: 'book', format: 'physical', edition: 'Capa dura', catalogId: 'googlebooks:book:dom_test' };
  const savedBooks = [];
  for (let i = 0; i < 2; i++) {
    const response = await request(path, 'POST', bookInput, a.cookie); assert.equal(response.status, 201);
    const saved = (await response.json()).copy; savedBooks.push(saved);
    assert.equal(saved.title, 'Dom Casmurro'); assert.equal(saved.isbn, '9788535914849');
    assert.deepEqual(saved.authors, ['Machado de Assis']);
    assert.deepEqual(saved.genres, ['Fiction / Classics']);
    assert.equal(saved.bookMetadataVersion, undefined);
  }
  assert.notEqual(savedBooks[0].id, savedBooks[1].id);
  assert.equal((await request(path + '/' + savedBooks[0].id, 'PATCH', { ...bookInput, edition: 'Bolso' }, a.cookie)).status, 200);
  assert.equal(bookCalls, 2, 'editar preserva os metadados da edição sem depender do Google');
  const persisted = (await (await request(path, 'GET', undefined, a.cookie)).json()).copies;
  assert.equal(persisted.find(c => c.id === savedBooks[0].id).isbn, '9788535914849');
  assert.equal(persisted.find(c => c.id === savedBooks[1].id).edition, 'Capa dura');
  assert.equal((await request(path, 'POST', { ...bookInput, kind: 'game' }, a.cookie)).status, 400);
  assert.equal((await request(path, 'POST', { ...bookInput, isbn: 'client-forged' }, a.cookie)).status, 400);
  assert.equal((await request('/catalog/books/search?q=Dom')).status, 401);
  let searchCalls = 0;
  books.search = async query => { searchCalls++; assert.equal(query.field, 'author'); assert.equal(query.page, 2); return { results: [], nextPage: null }; };
  assert.equal((await request('/catalog/books/search?q=Clarice&field=author&page=2', 'GET', undefined, a.cookie)).status, 200);
  for (const query of ['q=x', 'q=Dom&field=other', 'q=Dom&page=0', 'q=Dom&page=51', 'q=Dom&extra=true']) assert.equal((await request('/catalog/books/search?' + query, 'GET', undefined, a.cookie)).status, 400);
  assert.equal(searchCalls, 1);
  assert.equal((await request('/catalog/books/suggestions')).status, 401);
  books.request = async (_path, params) => ({ kind: 'books#volumes', totalItems: 2, items: [
    { id: 'dom_test', volumeInfo: { title: 'Dom Casmurro', authors: ['Machado de Assis'], categories: ['Fiction / Classics'], publisher: 'Editora de teste', language: 'pt' } },
    { id: 'other_classic', volumeInfo: { title: 'Outro clássico', authors: ['Outro autor'], categories: ['Fiction / Classics'], publisher: 'Editora de teste', language: 'pt' } },
  ] });
  const recommendations = await (await request('/catalog/books/suggestions', 'GET', undefined, a.cookie)).json();
  assert.equal(recommendations.personalized, true);
  assert.deepEqual(recommendations.results.map(book => book.title), ['Outro clássico']);
  const otherAccount = await (await request('/catalog/books/suggestions', 'GET', undefined, b.cookie)).json();
  assert.equal(otherAccount.personalized, false, 'não usa o acervo da outra conta para personalizar');
  books.suggestions = async (page, ownerId) => { assert.equal(page, 1); assert.equal(ownerId, a.user.id); return { results: [], nextPage: null }; };
  assert.equal((await request('/catalog/books/suggestions', 'GET', undefined, a.cookie)).status, 200);
  assert.equal((await request('/catalog/books/suggestions?page=0', 'GET', undefined, a.cookie)).status, 400);
  assert.equal((await request('/catalog/books/suggestions?q=secret', 'GET', undefined, a.cookie)).status, 400);
  assert.deepEqual(await db.collection('library_items').find({}).toArray(), before);
  assert.equal(await db.collection('episode_progress').countDocuments(), 0);
  const spec = await (await request('/docs-json')).json();
  for (const endpoint of [path, path + '/{id}']) assert.ok(spec.paths['/api' + endpoint]);
  const input = spec.components.schemas.CollectorCopyDto;
  assert.deepEqual(input.properties.format.enum, ['physical', 'digital']);
  assert.equal(input.properties.notes.maxLength, 2000);
  assert.equal(input.properties.status, undefined);
  assert.ok(spec.components.schemas.CollectorCopiesResultDto);
  assert.ok(spec.paths['/api/catalog/books/search']);
  assert.ok(spec.paths['/api/catalog/books/suggestions']);
  assert.ok(spec.components.schemas.BookSearchResultDto);
  assert.match(input.properties.catalogId.pattern, /googlebooks/);
  assert.ok(spec.components.schemas.CollectorCopyResponseDto.properties.isbn);
  assert.ok(spec.components.schemas.CollectorCopyResponseDto.properties.genres);
  assert.ok(spec.components.schemas.BookSearchResultDto.properties.personalized);
});
