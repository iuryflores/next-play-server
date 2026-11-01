const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { RottenTomatoesService, RottenTomatoesController, movieResult, score } = require('../dist/rotten-tomatoes/rotten-tomatoes.module');
const hit = { type: 'movie', title: 'Interstellar', vanity: 'interstellar_2014', releaseYear: 2014, rottenTomatoes: { criticsScore: 73, audienceScore: 87 } };

test('year filter is sent to provider, isolates cache and excludes other years', async t => {
  process.env.ROTTEN_TOMATOES_ENABLED = 'true';
  process.env.ROTTEN_TOMATOES_ALGOLIA_APP_ID = 'ABCDEFGHIJ';
  process.env.ROTTEN_TOMATOES_ALGOLIA_API_KEY = 'test-key';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const params = new URLSearchParams(JSON.parse(init.body).requests[0].params);
    assert.match(params.get('filters'), /releaseYear = (2014|2026)/);
    return Response.json({ results: [{ hits: [hit, { ...hit, releaseYear: 2026, vanity: 'other_2026' }] }] });
  });
  const service = new RottenTomatoesService();
  assert.deepEqual((await service.search('Interstellar', 'movie', '2014')).results.map(r => r.year), [2014]);
  assert.deepEqual((await service.search('Interstellar', 'movie', '2026')).results.map(r => r.year), [2026]);
  assert.equal(calls, 2);
  await assert.rejects(service.search('Movie', 'movie', '2026 OR 1=1'), /Ano inválido/);
});

test('series use TV results and URLs, never a namesake movie', () => {
  const series = { ...hit, type: 'tv', title: 'Breaking Bad', vanity: 'breaking_bad', releaseYear: 2008 };
  assert.equal(movieResult(series, 'series').url, 'https://www.rottentomatoes.com/tv/breaking_bad');
  assert.equal(movieResult(hit, 'series'), null);
  assert.equal(movieResult(series, 'movie'), null);
});

test('series controller uses the original title and rejects mismatched catalog kinds', async () => {
  const controller = new RottenTomatoesController(
    { search: async (title, kind) => { assert.equal(title, 'Breaking Bad'); assert.equal(kind, 'series'); return { results: [] }; } },
    { me: async () => ({ id: 'user' }) },
    { limit: () => {}, detail: async id => { assert.equal(id, 'tmdb:series:1396'); return { originalTitle: 'Breaking Bad', title: 'Localized title' }; } },
  );
  const result = await controller.search({ cookies: {} }, 'Localized title', 'tmdb:series:1396', 'series');
  assert.equal(result.searchedTitle, 'Breaking Bad');
  await assert.rejects(controller.search({ cookies: {} }, 'Movie', 'tmdb:movie:123', 'series'), /inválida/);
});

test('scores preserve zero and missing scores without confusing media', () => {
  assert.equal(score(0), 0);
  for (const value of [null, undefined, '', '73', -1, 101, NaN]) assert.equal(score(value), null);
  assert.equal(movieResult({ ...hit, type: 'tv' }), null);
  assert.equal(movieResult({ ...hit, vanity: 'https://evil.test' }), null);
  assert.equal(movieResult(null), null);
  assert.deepEqual(movieResult(hit), { title: 'Interstellar', directors: [], year: 2014, url: 'https://www.rottentomatoes.com/m/interstellar_2014', tomatometer: 73, popcornmeter: 87 });
  assert.equal(movieResult({ ...hit, rottenTomatoes: undefined }).popcornmeter, null);
});

test('server searches on demand, caches, limits fields and never sends account cookies', async t => {
  process.env.ROTTEN_TOMATOES_ENABLED = 'true';
  process.env.ROTTEN_TOMATOES_ALGOLIA_APP_ID = 'ABCDEFGHIJ';
  process.env.ROTTEN_TOMATOES_ALGOLIA_API_KEY = 'test-key';
  process.env.ROTTEN_TOMATOES_COOKIE = 'test-account-secret';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://abcdefghij-dsn.algolia.net/1/indexes/*/queries');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.stringify(init).includes('test-account-secret'), false);
    const request = JSON.parse(init.body).requests[0];
    assert.equal(request.indexName, 'content_rt');
    assert.match(new URLSearchParams(request.params).get('filters'), /type:movie/);
    return Response.json({ results: [{ hits: [hit, hit, { ...hit, type: 'tv' }] }] });
  });
  const service = new RottenTomatoesService();
  assert.equal(calls, 0);
  const result = await service.search('Interstellar');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].tomatometer, 73);
  assert.deepEqual(await service.search(' interstellar '), result);
  assert.equal(calls, 1);
  await assert.rejects(service.search('a'));
  await assert.rejects(service.search(['injection']));
  assert.equal(calls, 1);
  process.env.ROTTEN_TOMATOES_ENABLED = 'false';
  await assert.rejects(service.search('Interstellar'), /configurada/);
});

test('provider errors are sanitized and not cached', async t => {
  process.env.ROTTEN_TOMATOES_ENABLED = 'true';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('secret response'); });
  const service = new RottenTomatoesService();
  for (let i = 0; i < 2; i++) await assert.rejects(service.search('Movie'), error => !error.message.includes('secret') && error.getStatus() === 502);
  assert.equal(calls, 2);
});

test('controller authenticates and rate limits before making external requests', async () => {
  let calls = 0;
  const service = { search: async () => { calls++; return { results: [] }; } };
  const denied = new RottenTomatoesController(service, { me: async () => { throw new Error('unauthorized'); } }, { limit: () => assert.fail('not authenticated') });
  await assert.rejects(denied.search({ cookies: {} }, 'Movie'), /unauthorized/);
  assert.equal(calls, 0);
  const limited = new RottenTomatoesController(service, { me: async () => ({ id: 'user' }) }, { limit: () => { throw new Error('limited'); } });
  await assert.rejects(limited.search({ cookies: {} }, 'Movie'), /limited/);
  assert.equal(calls, 0);
});

test('automatic movie lookup resolves original title instead of Portuguese title', async () => {
  let searched = '';
  const controller = new RottenTomatoesController(
    { search: async title => { searched = title; return { results: [], queriedAt: '2026-09-09' }; } },
    { me: async () => ({ id: 'user' }) },
    { limit: () => {}, directors: async id => {
      assert.equal(id, 'tmdb:movie:123');
      return { directors: [{ id: 1, name: 'Destin Daniel Cretton' }], supported: true };
    }, detail: async (id, language) => {
      assert.equal(id, 'tmdb:movie:123'); assert.equal(language, 'en-US');
      return { title: 'Homem-Aranha: Um Novo Dia', originalTitle: 'Spider-Man: Brand New Day' };
    } },
  );
  const result = await controller.search({ cookies: {} }, 'Homem-Aranha: Um Novo Dia', 'tmdb:movie:123');
  assert.equal(searched, 'Spider-Man: Brand New Day');
  assert.equal(result.searchedTitle, searched);
  assert.deepEqual(result.searchedDirectors, ['Destin Daniel Cretton']);
  await assert.rejects(controller.search({ cookies: {} }, 'Movie', 'https://example.com'), /inválida/);
});
