require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CatalogService } = require('../dist/catalog/catalog.module');
test('cast maps actors and roles, scopes episode guests, sanitizes photos and caches', async () => {
  const saved = new Map();
  const service = new CatalogService({ collection: () => ({ findOne: async query => saved.get(query._id), updateOne: async (query, update) => saved.set(query._id, update.$set) }) });
  const calls = [];
  service.tmdb = async (path, query) => {
    calls.push({ path, ...query });
    const person = { id: 1, name: 'Actor', character: 'Hero', profile_path: '/photo.jpg' };
    if (path.includes('aggregate')) return { cast: [{ ...person, roles: [{ character: 'Hero' }, { character: 'Narrator' }] }] };
    return { cast: [person, person, { id: 3, name: 'Unknown' }], guest_stars: path.includes('/episode/') ? [{ id: 2, name: 'Guest actor', character: 'Guest', profile_path: 'https://invalid.test/p.jpg' }] : [] };
  };
  const movie = await service.cast('tmdb:movie:11', 'en-US');
  assert.equal(movie.length, 1); assert.equal(movie[0].character, 'Hero'); assert.equal(movie[0].actor, 'Actor'); assert.match(movie[0].photo, /^https:\/\/image.tmdb.org/);
  await service.cast('tmdb:movie:11', 'en-US'); assert.equal(calls.length, 1);
  const episode = await service.cast('tmdb:series:22', 'es-ES', 1, 2);
  assert.equal(episode.length, 2); assert.equal(episode[1].photo, ''); assert.equal(calls[1].path, 'tv/22/season/1/episode/2/credits'); assert.equal(calls[1].language, 'es-ES');
  const series = await service.cast('tmdb:series:22', 'pt-BR'); assert.deepEqual(series.map(row => row.character), ['Hero', 'Narrator']);
  assert.deepEqual(await service.cast('igdb:game:1', 'pt-BR'), []);
  await assert.rejects(() => service.cast('tmdb:series:22', 'en-US', -1, 2), error => error.getStatus() === 400);
  service.tmdb = async () => { throw Error('offline'); };
  for (const value of saved.values()) value.expires = new Date(0);
  assert.deepEqual(await service.cast('tmdb:movie:11', 'en-US'), movie);
});
