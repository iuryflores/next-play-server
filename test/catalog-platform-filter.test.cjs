const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('search filters before pagination and isolates platform caches', async () => {
  const service = new CatalogService({});
  const queries = [];
  service.igdb = async query => {
    queries.push(query);
    return Array.from({ length: 21 }, (_, i) => ({ id: i + 1, name: `Game ${i}` }));
  };
  const result = await service.search('game', 'Game', 'pt-BR', 2, 167);
  assert.equal(result.results.length, 20);
  assert.equal(result.nextPage, 3);
  assert.match(queries[0], /where platforms = \(167\);/);
  assert.match(queries[0], /offset 20;/);
  await service.search('game', 'Game', 'pt-BR', 2, 167);
  assert.equal(queries.length, 1);
  await service.search('game', 'Game', 'pt-BR', 2, 6);
  assert.match(queries[1], /where platforms = \(6\);/);
  await service.search('game', 'Game', 'pt-BR', 2);
  assert.doesNotMatch(queries[2], /where platforms/);
});

test('suggestions filter platforms and keep separate caches and next pages', async () => {
  const service = new CatalogService({});
  const queries = [];
  service.igdb = async query => {
    queries.push(query);
    return Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Game ${i}` }));
  };
  const result = await service.suggestions('game', undefined, 'pt-BR', 1, 7);
  assert.equal(result.nextPage, 2);
  assert.match(queries[0], /& platforms = \(7\)/);
  await service.suggestions('game', undefined, 'pt-BR', 1, 7);
  assert.equal(queries.length, 1);
  await service.suggestions('game', undefined, 'pt-BR', 2, 7);
  assert.match(queries[1], /offset 20;/);
  await service.suggestions('game', undefined, 'pt-BR', 1);
  assert.doesNotMatch(queries[2], /& platforms/);
});

test('invalid platform parameters never reach the provider', async () => {
  const service = new CatalogService({});
  service.igdb = async () => assert.fail('must validate before querying');
  for (const platform of [NaN, 0, -1, 1.5, Infinity]) {
    await assert.rejects(service.search('game', 'Game', 'pt-BR', 1, platform), /Plataforma inválida/);
    await assert.rejects(service.suggestions('game', undefined, 'pt-BR', 1, platform), /Plataforma inválida/);
  }
  await assert.rejects(service.search('movie', 'Movie', 'pt-BR', 1, 6), /Plataforma inválida/);
});
