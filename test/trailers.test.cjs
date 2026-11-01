const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');
test('trailers filter unsafe keys, prefer official trailers, cache by language and fall back to English', async () => {
  const saved = new Map();
  const service = new CatalogService({ collection: () => ({ findOne: async query => saved.get(query._id), updateOne: async (query, update) => saved.set(query._id, update.$set) }) });
  const calls = [];
  service.tmdb = async (path, query) => {
    calls.push({ path, language: query.language });
    return { results: query.language === 'es-ES' ? [] : [
      { site: 'YouTube', key: '../invalid!', name: 'Unsafe', type: 'Trailer', official: true },
      { site: 'Vimeo', key: 'abcdefghijk', name: 'Other provider', type: 'Trailer' },
      { site: 'YouTube', key: 'abcdefghij0', name: 'Teaser', type: 'Teaser', official: true },
      { site: 'YouTube', key: 'abcdefghij1', name: 'Unofficial', type: 'Trailer' },
      { site: 'YouTube', key: 'abcdefghij2', name: 'Official', type: 'Trailer', official: true },
    ] };
  };
  const result = await service.trailer('tmdb:movie:123', 'pt-BR');
  assert.equal(result.key, 'abcdefghij2');
  assert.equal(result.language, 'pt-BR');
  await service.trailer('tmdb:movie:123', 'pt-BR'); assert.equal(calls.length, 1);
  assert.equal((await service.trailer('tmdb:series:123', 'es-ES')).language, 'en-US');
  assert.deepEqual(calls.slice(1), [{ path: 'tv/123/videos', language: 'es-ES' }, { path: 'tv/123/videos', language: 'en-US' }]);
  assert.equal(await service.trailer('igdb:game:123', 'en-US'), null);
  service.tmdb = async () => ({ results: [] });
  assert.equal(await service.trailer('tmdb:movie:456', 'pt-BR'), null);
  service.tmdb = async () => { throw new Error('Offline'); };
  assert.equal(await service.trailer('tmdb:movie:456', 'pt-BR'), null);
  await assert.rejects(() => service.trailer('tmdb:movie:789', 'pt-BR'), /Offline/);
});
