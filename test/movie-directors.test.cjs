const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('credits include all directors, exclude other jobs, deduplicate and cache', async () => {
  let cached = null;
  let calls = 0;
  const service = new CatalogService({ collection: name => {
    assert.equal(name, 'catalog_directors');
    return {
      findOne: async () => cached,
      updateOne: async (query, update) => { cached = { ...query, ...update.$set }; },
    };
  } });
  service.tmdb = async endpoint => {
    calls++;
    assert.equal(endpoint, 'movie/157336/credits');
    return { crew: [
      { id: 1, name: ' Director One ', job: 'Director' },
      { id: 2, name: 'Director Two', job: 'Director' },
      { id: 1, name: 'Director One', job: 'Director' },
      { id: 3, name: 'Producer', job: 'Producer' },
      { id: 4, name: 'Assistant', job: 'Assistant Director' },
      { id: 5, name: ' ', job: 'Director' },
    ] };
  };
  const expected = { supported: true, directors: [{ id: 1, name: 'Director One' }, { id: 2, name: 'Director Two' }] };
  assert.deepEqual(await service.directors('tmdb:movie:157336'), expected);
  assert.deepEqual(await service.directors('tmdb:movie:157336'), expected);
  assert.equal(calls, 1);
});

test('unsupported references do not access the provider', async () => {
  const service = new CatalogService({ collection: () => { throw new Error('Unexpected database access'); } });
  for (const id of [undefined, 'tmdb:series:123', 'manual', 'tmdb:movie:../123']) {
    assert.deepEqual(await service.directors(id), { directors: [], supported: false });
  }
});

test('invalid credits are not cached as an empty director list', async () => {
  const service = new CatalogService({ collection: () => ({
    findOne: async () => null,
    updateOne: async () => { throw new Error('Invalid response must not be cached'); },
  }) });
  service.tmdb = async () => ({});
  await assert.rejects(service.directors('tmdb:movie:123'), /Não foi possível carregar a direção/);
});
