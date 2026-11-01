require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');
test('suggestion pages advance, cache separately and stop at the end', async () => {
  const service = new CatalogService();
  const calls = [];
  service.tmdb = async (path, params) => {
    calls.push({ path, ...params });
    return { results: Array.from({ length: params.page === '1' ? 20 : 3 }, (_, i) => ({ id: Number(params.page) * 100 + i, title: 'Movie ' + i })) };
  };
  const first = await service.suggestions('movie', undefined, 'en-US', 1);
  const second = await service.suggestions('movie', undefined, 'en-US', 2);
  assert.equal(first.nextPage, 2); assert.equal(second.nextPage, null);
  assert.ok(second.results.every(item => !first.results.some(previous => previous.catalogId === item.catalogId)));
  await service.suggestions('movie', undefined, 'en-US', 2);
  assert.equal(calls.length, 2); assert.equal(calls[1].page, '2'); assert.equal(calls[1].language, 'en-US');
  await service.suggestions('series', undefined, 'es-ES', 1);
  assert.equal(calls[2].path, 'tv/popular');
  const queries = [];
  service.igdb = async body => { queries.push(body); return Array.from({ length: body.includes('offset 0;') ? 20 : 0 }, (_, id) => ({ id: id + 1, name: 'Game ' + id })); };
  assert.equal((await service.suggestions('game', undefined, 'en-US', 1)).nextPage, 2);
  assert.equal((await service.suggestions('game', undefined, 'en-US', 2)).nextPage, null);
  assert.match(queries[1], /offset 20;/);
  for (const page of [0, -1, 1.5, 501, NaN]) await assert.rejects(() => service.suggestions('movie', undefined, 'en-US', page), error => error.getStatus() === 400);
});
