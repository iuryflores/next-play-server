// Este cenário testa o fluxo legado; confirmação obrigatória tem suíte própria.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = `nextplay_catalog_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${database}`;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test'; process.env.ALLOW_REGISTRATION = 'true';
process.env.TMDB_API_ACCESS_TOKEN = 'test-tmdb-secret'; process.env.IGDB_CLIENT_ID = 'test-client'; process.env.IGDB_CLIENT_SECRET = 'test-igdb-secret';
const { createApp } = require('../dist/bootstrap');
const { CatalogService } = require('../dist/catalog/catalog.module');
const { getConnectionToken } = require('@nestjs/mongoose');
test('catalog search, canonical imports, duplication, missing credentials and token cache', async t => {
  const originalFetch = global.fetch; let tokenCalls = 0; let externalCalls = 0;
  const discovery = [];
  global.fetch = async (input, options) => {
    const url = String(input);
    if (!url.startsWith('https://')) return originalFetch(input, options);
    externalCalls++;
    if (url.startsWith('https://id.twitch.tv/')) { tokenCalls++; assert.ok(options.body.includes('client_secret=test-igdb-secret')); return Response.json({ access_token: 'test-token', expires_in: 3600 }); }
    if (url.startsWith('https://api.igdb.com/')) {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      if (url.endsWith('/genres')) return Response.json([{ id: 12, name: 'Role-playing (RPG)' }]);
      if (options.body.includes('genres = (12)')) return Response.json([{ id: 34, name: 'Outro RPG', genres: [{ id: 12, name: 'Role-playing (RPG)' }] }]);
      return Response.json([{ id: 33, name: 'Jogo teste', game_localizations: [{ name: 'Juego localizado', region: { identifier: 'es-ES' } }], slug: 'jogo-teste', first_release_date: 1609459200, cover: { image_id: 'testcover' }, genres: [{ id: 12, name: 'Role-playing (RPG)' }] }]);
    }
    if (url.startsWith('https://api.themoviedb.org/')) {
      assert.equal(options.headers.Authorization, 'Bearer test-tmdb-secret');
      if (url.includes('/genre/')) return Response.json({ genres: [{ id: 14, name: 'Fantasia' }, { id: 27, name: 'Terror' }] });
      if (url.includes('/discover/')) {
        discovery.push(url);
        const genres = new URL(url).searchParams.get('with_genres');
        const tv = url.includes('/tv');
        return Response.json({ results: [{ id: tv ? 24 : 12, title: 'Nova fantasia', name: 'Nova fantasia', genre_ids: [14] }, ...(genres.includes('27') ? [{ id: 13, title: 'Novo terror', genre_ids: [27] }] : []), { id: 11, title: 'Filme teste', genre_ids: [14] }] });
      }
      const tv = url.includes('/tv');
      const item = { id: tv ? 22 : 11, title: tv ? undefined : 'Filme teste', name: tv ? 'Série teste' : undefined, original_title: tv ? undefined : 'Original movie', original_name: tv ? 'Original series' : undefined, poster_path: '/test.jpg', overview: 'Sinopse teste', release_date: '2020-01-01', genres: [{ id: 14, name: 'Fantasia' }] };
      const language = new URL(url).searchParams.get('language');
      if (language === 'en-US') { item.title = 'English movie'; item.overview = 'English synopsis'; }
      if (language === 'es-ES') { item.title = 'Película española'; item.overview = 'Sinopsis española'; }
      return Response.json((url.includes('/search/') || url.includes('/popular')) ? { results: [item] } : item);
    }
    throw new Error('Unexpected external request');
  };
  const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const connection = app.get(getConnectionToken());
  t.after(async () => { global.fetch = originalFetch; try { assert.match(database, /^nextplay_catalog_test_[a-f0-9]{32}$/); assert.equal(connection.name, database); await connection.dropDatabase(); } finally { await app.close(); } });
  const request = (path, method = 'GET', body, cookie) => originalFetch(`${base}/api${path}`, { method, headers: { origin: process.env.CLIENT_ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/catalog/search?kind=movie&q=test')).status, 401); assert.equal(externalCalls, 0);
  const registration = await request('/auth/register', 'POST', { email: 'catalog@example.test', password: 'Long-test-password-123!' });
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  for (const kind of ['movie', 'series', 'game']) {
    const response = await request(`/catalog/search?kind=${kind}&q=test`, 'GET', undefined, cookie);
    assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.results.length, 1); assert.equal(data.results[0].kind, kind);
    assert.ok(!JSON.stringify(data).includes('secret')); assert.match(data.results[0].coverUrl, /^https:\/\//);
  }
  assert.equal((await request('/catalog/suggestions?kind=movie')).status, 401);
  for (const kind of ['movie', 'series', 'game']) {
    const response = await request('/catalog/suggestions?kind=' + kind, 'GET', undefined, cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].kind, kind);
    const before = externalCalls;
    assert.equal((await request('/catalog/suggestions?kind=' + kind, 'GET', undefined, cookie)).status, 200);
    assert.equal(externalCalls, before);
  }
  assert.equal((await request('/catalog/suggestions?kind=book', 'GET', undefined, cookie)).status, 400);
  const service = app.get(CatalogService);
  await service.search('game', 'another'); assert.equal(tokenCalls, 1);
  service.tokenExpires = 0; await service.search('game', 'third'); assert.equal(tokenCalls, 2);
  assert.equal((await request('/catalog/search?kind=book&q=test', 'GET', undefined, cookie)).status, 400);
  assert.equal((await request('/catalog/search?kind=movie&q=a', 'GET', undefined, cookie)).status, 400);
  const payload = { title: 'Forged title', kind: 'movie', status: 'planned', catalogId: 'tmdb:movie:11' };
  const imported = await request('/library', 'POST', payload, cookie); assert.equal(imported.status, 201);
  const { item } = await imported.json(); assert.equal(item.title, 'Filme teste'); assert.equal(item.originalTitle, 'Original movie'); assert.equal(item.catalogId, 'tmdb:movie:11'); assert.deepEqual(item.genres, ['Fantasia']);
  assert.deepEqual((await service.detail('igdb:game:33')).genres, ['Role-playing (RPG)']);
  assert.equal((await request('/library', 'POST', payload, cookie)).status, 409);
  assert.equal((await request('/library', 'POST', { ...payload, kind: 'book' }, cookie)).status, 400);
  assert.equal((await request('/library', 'POST', { ...payload, catalogId: 'https://evil.example' }, cookie)).status, 400);
  assert.equal((await request('/library', 'POST', { ...payload, coverUrl: 'https://evil.example/a.png' }, cookie)).status, 400);
  const updated = await request(`/library/${item.id}`, 'PATCH', { title: 'Forged', kind: 'book', status: 'completed' }, cookie);
  assert.equal(updated.status, 200); const changed = (await updated.json()).item; assert.equal(changed.kind, 'movie'); assert.equal(changed.title, 'Filme teste'); assert.equal(changed.status, 'completed'); assert.equal(changed.coverUrl, item.coverUrl);
  const beforeLocal = externalCalls;
  const secondRegistration = await request('/auth/register', 'POST', { email: 'local@example.test', password: 'Long-test-password-123!' });
  const secondCookie = secondRegistration.headers.get('set-cookie').split(';')[0];
  service.cache.clear();
  assert.equal((await request('/library', 'POST', payload, secondCookie)).status, 201);
  assert.equal(externalCalls, beforeLocal);
  const firstSuggestions = await (await request('/catalog/suggestions?kind=movie', 'GET', undefined, cookie)).json();
  assert.deepEqual(firstSuggestions.results.map(item => item.catalogId), ['tmdb:movie:12']);
  assert.ok(discovery.some(url => new URL(url).searchParams.get('with_genres') === '14'));
  for (let i = 0; i < 2; i++) {
    assert.equal((await request('/library', 'POST', { title: 'Terror manual ' + i, kind: 'movie', status: 'planned', genres: ['Terror'] }, cookie)).status, 201);
  }
  const personalized = await (await request('/catalog/suggestions?kind=movie', 'GET', undefined, cookie)).json();
  assert.equal(personalized.results[0].catalogId, 'tmdb:movie:13');
  const otherUser = await (await request('/catalog/suggestions?kind=movie', 'GET', undefined, secondCookie)).json();
  assert.deepEqual(otherUser.results.map(item => item.catalogId), ['tmdb:movie:12']);
  assert.equal((await request('/library', 'POST', { title: 'Série', kind: 'series', status: 'planned', genres: ['Fantasia'] }, cookie)).status, 201);
  const seriesSuggestions = await (await request('/catalog/suggestions?kind=series', 'GET', undefined, cookie)).json();
  assert.equal(seriesSuggestions.results[0].kind, 'series');
  assert.ok(discovery.some(url => url.includes('/discover/tv')));
  assert.equal((await request('/library', 'POST', { title: 'RPG', kind: 'game', status: 'planned', genres: ['Role-playing (RPG)'] }, cookie)).status, 201);
  const games = await (await request('/catalog/suggestions?kind=game', 'GET', undefined, cookie)).json();
  assert.equal(games.results[0].catalogId, 'igdb:game:34');
  assert.equal((await request('/auth/preferences', 'POST', { language: 'en-US' }, cookie)).status, 200);
  let localized = await (await request('/catalog/search?kind=movie&q=localized', 'GET', undefined, cookie)).json();
  assert.equal(localized.results[0].title, 'English movie');
  // A coleção só lê traduções salvas; nunca busca centenas de títulos externos.
  const beforeUncachedLibrary = externalCalls;
  let library = await (await request('/library', 'GET', undefined, cookie)).json();
  assert.equal(library.items.find(row => row.catalogId === 'tmdb:movie:11').title, 'Filme teste');
  assert.equal(externalCalls, beforeUncachedLibrary);
  await service.localize({ catalogId: 'tmdb:movie:11', title: 'Filme teste' }, 'en-US');
  library = await (await request('/library', 'GET', undefined, cookie)).json();
  assert.equal(library.items.find(row => row.catalogId === 'tmdb:movie:11').title, 'English movie');
  const callsBeforeCache = externalCalls;
  await request('/library', 'GET', undefined, cookie);
  assert.equal(externalCalls, callsBeforeCache);
  assert.equal((await request('/auth/preferences', 'POST', { language: 'es-ES' }, cookie)).status, 200);
  await service.localize({ catalogId: 'tmdb:movie:11', title: 'Filme teste' }, 'es-ES');
  library = await (await request('/library', 'GET', undefined, cookie)).json();
  assert.equal(library.items.find(row => row.catalogId === 'tmdb:movie:11').title, 'Película española');
  const otherLibrary = await (await request('/library', 'GET', undefined, secondCookie)).json();
  assert.equal(otherLibrary.items.find(row => row.catalogId === 'tmdb:movie:11').title, 'Filme teste');
  assert.equal((await connection.collection('library_items').findOne({ catalogId: 'tmdb:movie:11' })).title, 'Filme teste');
  const beforeExplore = externalCalls;
  await request('/library/explore', 'GET', undefined, cookie);
  assert.ok(externalCalls > beforeExplore);
  assert.equal((await service.detail('igdb:game:33', 'es-ES')).title, 'Juego localizado');
  delete process.env.IGDB_CLIENT_SECRET; const unavailable = new CatalogService(); await assert.rejects(() => unavailable.search('game', 'unknown'), error => error.getStatus() === 503);
  delete process.env.TMDB_API_ACCESS_TOKEN; delete process.env.TMDB_API_KEY;
  await assert.rejects(() => unavailable.search('movie', 'unknown'), error => error.getStatus() === 503);
});

