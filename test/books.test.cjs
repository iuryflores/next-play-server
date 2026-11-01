const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { BooksService, normalizedIsbn } = require('../dist/books/books.module');

// Fixtures brasileiras sintéticas: verificam o contrato, sem afirmar cobertura real do Google.
const volume = (id = 'dom_test', isbn = '9788535914849') => ({ id, volumeInfo: {
  title: 'Dom Casmurro', authors: ['Machado de Assis'], publisher: 'Editora de teste', language: 'pt', publishedDate: '2020-01-01',
  industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }], description: '<p>Texto de teste.</p>',
  imageLinks: { thumbnail: 'http://books.google.com/books/content?id=' + id },
} });
function mock(t, response) {
  const original = global.fetch, key = process.env.GOOGLE_BOOKS_API_KEY;
  process.env.GOOGLE_BOOKS_API_KEY = 'test-key-never-real';
  const urls = [];
  global.fetch = async url => { urls.push(new URL(url)); return response(urls.length); };
  t.after(() => { global.fetch = original; if (key === undefined) delete process.env.GOOGLE_BOOKS_API_KEY; else process.env.GOOGLE_BOOKS_API_KEY = key; });
  return urls;
}
test('busca por título e autor usa campos corretos, preserva edições e reutiliza cache', async t => {
  const urls = mock(t, () => Response.json({ kind: 'books#volumes', totalItems: 2, items: [volume(), volume('dom_other')] }));
  const books = new BooksService();
  const query = { q: 'Dom Casmurro', field: 'title', page: 1 };
  const result = await books.search(query);
  assert.equal(urls[0].searchParams.get('q'), 'intitle:Dom Casmurro');
  assert.equal(result.results.length, 2); assert.equal(result.nextPage, null);
  assert.equal(result.results[0].catalogId, 'googlebooks:book:dom_test');
  assert.deepEqual(result.results[0].authors, ['Machado de Assis']);
  assert.match(result.results[0].coverUrl, /^https:/); assert.equal(result.results[0].overview, 'Texto de teste.');
  await books.search(query); assert.equal(urls.length, 1);
  await books.search({ q: 'Clarice Lispector', field: 'author', page: 1 });
  assert.equal(urls[1].searchParams.get('q'), 'inauthor:Clarice Lispector');
});
test('ISBN aceita hífens e ISBN-10 equivalente, rejeita dígito incorreto e outra edição', async t => {
  const urls = mock(t, () => Response.json({ kind: 'books#volumes', totalItems: 2, items: [volume(), volume('wrong', '9788575221129')] }));
  assert.equal(normalizedIsbn('978-85-359-1484-9'), '9788535914849');
  assert.throws(() => normalizedIsbn('9788535914840'), /ISBN inválido/);
  assert.equal(normalizedIsbn('0-306-40615-2'), '0306406152');
  const books = new BooksService();
  const result = await books.search({ q: '978-85-359-1484-9', field: 'isbn', page: 1 });
  assert.equal(result.results.length, 1); assert.equal(result.nextPage, null);
  assert.equal(urls[0].searchParams.get('q'), 'isbn:9788535914849');
  await assert.rejects(books.search({ q: '123', field: 'isbn', page: 1 }), /ISBN inválido/);
  assert.equal(urls.length, 1);
  global.fetch = async () => Response.json({ kind: 'books#volumes', totalItems: 1, items: [volume('equivalent', '9780306406157')] });
  assert.equal((await books.search({ q: '0-306-40615-2', field: 'isbn', page: 1 })).results.length, 1);
});
test('detalhes verificam ID, removem imagens externas e não permitem URL arbitrária', async t => {
  const item = volume(); item.volumeInfo.imageLinks.thumbnail = 'https://evil.example/cover';
  const urls = mock(t, () => Response.json(item)); const books = new BooksService();
  const result = await books.detail('googlebooks:book:dom_test');
  assert.equal(result.coverUrl, '');
  assert.equal(urls[0].pathname, '/books/v1/volumes/dom_test');
  await assert.rejects(books.detail('googlebooks:book:https://evil.example'), /inválida/);
  await assert.rejects(books.detail('googlebooks:book:different'), /outra edição/);
});
test('indisponibilidade e cota não viram lista vazia nem expõem mensagens/chaves do Google', async t => {
  const urls = mock(t, () => Response.json({ error: { message: 'secret-upstream-key' } }, { status: 429 }));
  const books = new BooksService();
  await assert.rejects(books.search({ q: 'Dom Casmurro', field: 'title', page: 1 }), error => error.getStatus() === 503 && !error.message.includes('secret-upstream'));
  await assert.rejects(books.search({ q: 'Clarice', field: 'author', page: 1 }), /limite/);
  assert.equal(urls.length, 1, 'circuito temporário evita repetir chamadas com cota esgotada');
  delete process.env.GOOGLE_BOOKS_API_KEY;
  await assert.rejects(new BooksService().search({ q: 'Dom', field: 'title', page: 1 }), /não está configurada/);
});
test('falhas transitórias, JSON inválido e ausência de resultados têm contratos distintos', async t => {
  let mode = 'failure';
  mock(t, () => mode === 'failure' ? new Response('', { status: 500 }) : mode === 'invalid' ? new Response('not-json') : Response.json({ kind: 'books#volumes', totalItems: 0 }));
  const books = new BooksService(); const query = { q: 'Livro', field: 'title', page: 1 };
  await assert.rejects(books.search(query), e => e.getStatus() === 502);
  mode = 'invalid'; await assert.rejects(books.search(query), /inválida/);
  mode = 'empty'; assert.deepEqual(await books.search(query), { results: [], nextPage: null });
});
test('página seguinte e limite por usuário respeitam isolamento', async t => {
  const urls = mock(t, () => Response.json({ kind: 'books#volumes', totalItems: 100, items: Array.from({ length: 20 }, (_, i) => volume('v' + i)) }));
  const books = new BooksService();
  assert.equal((await books.search({ q: 'Machado', field: 'author', page: 2 })).nextPage, 3);
  assert.equal(urls[0].searchParams.get('startIndex'), '20');
  for (let i = 0; i < 30; i++) books.limit('a');
  assert.throws(() => books.limit('a'), e => e.getStatus() === 429); books.limit('b');
});
test('sugestões gerais são compartilhadas no cache e não consultam dados do usuário', async t => {
  const english = volume('english'); english.volumeInfo.language = 'en';
  const urls = mock(t, () => Response.json({ kind: 'books#volumes', totalItems: 30, items: [volume(), volume(), english] }));
  const books = new BooksService();
  const first = await books.suggestions(); const second = await books.suggestions();
  assert.deepEqual(first, second); assert.equal(urls.length, 1);
  assert.equal(first.results.length, 1, 'não repete o mesmo volume nem sugere edições em outro idioma');
  assert.equal(urls[0].searchParams.get('langRestrict'), 'pt');
  assert.equal(urls[0].searchParams.get('maxResults'), '20');
  await books.suggestions(2); assert.equal(urls[1].searchParams.get('startIndex'), '20');
});
