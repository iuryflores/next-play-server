const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('title and company searches paginate together, deduplicate and isolate cached pages', async () => {
  const service = new CatalogService();
  const calls = [];
  service.tmdb = async (path, query) => {
    calls.push({ path, query });
    if (path === 'search/company') return { results: [{ id: 1, name: 'Marvel Studios' }, { id: 2, name: 'Marvel Television' }, { id: 3, name: 'Unrelated' }] };
    const page = Number(query.page);
    if (path.startsWith('search/')) return { total_pages: 1, results: page === 1 ? [{ id: 11, title: 'Marvel title', name: 'Marvel show' }] : [] };
    assert.equal(query.with_companies, '1|2');
    return { total_pages: 2, results: page === 1 ? [{ id: 11, title: 'Marvel title' }, { id: 12, title: 'Avengers' }] : [{ id: 13, title: 'Another production' }] };
  };
  const first = await service.search('movie', 'Marvel', 'pt-BR', 1);
  assert.deepEqual(first.results.map(item => item.catalogId), ['tmdb:movie:11', 'tmdb:movie:12']);
  assert.equal(first.nextPage, 2);
  const second = await service.search('movie', 'Marvel', 'pt-BR', 2);
  assert.deepEqual(second.results.map(item => item.catalogId), ['tmdb:movie:13']);
  assert.equal(second.nextPage, null);
  const count = calls.length;
  assert.deepEqual(await service.search('movie', 'Marvel', 'pt-BR', 1), first);
  assert.equal(calls.length, count);
  await service.search('series', 'Marvel', 'en-US', 1);
  assert.ok(calls.some(call => call.path === 'discover/tv' && call.query.language === 'en-US'));
});

test('search validates pages and respects title-only pagination with no matching company', async () => {
  const service = new CatalogService();
  for (const page of [0, -1, 501, 1.5, NaN]) await assert.rejects(() => service.search('movie', 'test', 'pt-BR', page), error => error.getStatus() === 400);
  service.tmdb = async path => path === 'search/company' ? { results: [] } : { total_pages: 3, results: [] };
  assert.equal((await service.search('movie', 'test', 'pt-BR', 2)).nextPage, 3);
  assert.equal((await service.search('movie', 'test', 'pt-BR', 3)).nextPage, null);
});

test('game pagination uses lookahead without losing the extra game', async () => {
  const service = new CatalogService();
  service.igdb = async query => {
    assert.match(query, /limit 21;/);
    const offset = Number(query.match(/offset (\d+);/)[1]);
    return Array.from({ length: offset === 0 ? 21 : 1 }, (_, index) => ({ id: offset + index + 1, name: 'Game' }));
  };
  const first = await service.search('game', 'test', 'pt-BR', 1);
  assert.equal(first.results.length, 20);
  assert.equal(first.nextPage, 2);
  const last = await service.search('game', 'test', 'pt-BR', 2);
  assert.equal(last.results[0].catalogId, 'igdb:game:21');
  assert.equal(last.nextPage, null);
});
