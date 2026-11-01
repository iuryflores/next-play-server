const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');

test('large libraries use two batch reads without remote refreshes, preserving progress and fallbacks', async () => {
  const calls = [];
  const service = new CatalogService({ collection: name => ({ find: query => {
    calls.push({ name, query });
    return { toArray: async () => name === 'catalog_translations'
      ? [{ _id: 'tmdb:series:1:en-US', value: { title: 'English title' }, expires: new Date(0) }]
      : [{ _id: 'tmdb:series:1:1:en-US', episodes: [{ number: 2, name: 'Episode two' }] }] };
  } }) });
  service.detail = async () => { throw new Error('Remote requests forbidden'); };
  service.localize = async () => { throw new Error('Individual queries forbidden'); };
  const series = { id: 's', catalogId: 'tmdb:series:1', title: 'Original', episodeProgress: { watched: 1, next: { season: 1, episode: 2, name: 'Original episode' } } };
  const items = [series, ...Array.from({ length: 662 }, (_, i) => ({ id: String(i), catalogId: `tmdb:movie:${i}`, title: 'Fallback' }))];
  const result = await service.localizeMany(items, 'en-US');
  assert.equal(result.length, 663);
  assert.equal(calls.length, 2);
  assert.equal(result[0].title, 'English title');
  assert.equal(result[0].episodeProgress.next.name, 'Episode two');
  assert.equal(result[0].episodeProgress.watched, 1);
  assert.equal(series.episodeProgress.next.name, 'Original episode');
  assert.equal(result[1].title, 'Fallback');
  assert.equal(await service.localizeMany(items, 'pt-BR'), items);
});
