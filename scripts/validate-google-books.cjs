// Validação real sob demanda, separada da suíte offline. Nunca imprime chave/URL com credenciais.
require('reflect-metadata');
const { BooksService } = require('../dist/books/books.module');
const cases = [
  { field: 'title', q: 'Dom Casmurro', expected: /dom casmurro/i },
  { field: 'title', q: 'A hora da estrela', expected: /hora da estrela/i },
  { field: 'author', q: 'Clarice Lispector', expected: /clarice lispector/i },
  // ISBN confirmado no catálogo da Penguin-Companhia:
  // https://www.companhiadasletras.com.br/livro/9788582850350/dom-casmurro
  { field: 'isbn', q: '9788582850350', expected: /dom casmurro/i },
];
(async () => {
  const service = new BooksService();
  let failed = false;
  for (const entry of cases) {
    try {
      const result = await service.search({ field: entry.field, q: entry.q, page: 1 });
      const matching = result.results.filter(book => entry.expected.test(entry.field === 'author' ? book.authors.join(' ') : book.title));
      console.log(JSON.stringify({ field: entry.field, query: entry.q, count: result.results.length, matched: matching.length, books: matching.slice(0, 3).map(({ catalogId, title, authors, isbn, publisher, language, coverUrl }) => ({ catalogId, title, authors, isbn, publisher, language, hasCover: Boolean(coverUrl) })) }));
      if (!matching.length) failed = true;
      if (matching[0]) {
        const detail = await service.detail(matching[0].catalogId);
        if (detail.catalogId !== matching[0].catalogId || !detail.title) failed = true;
      }
    } catch (error) {
      failed = true; console.log(JSON.stringify({ field: entry.field, query: entry.q, status: error.getStatus?.(), message: error.message }));
      if (error.getStatus?.() === 503) break;
    }
  }
  if (failed) process.exitCode = 1;
})();
