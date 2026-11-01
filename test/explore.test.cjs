// Este cenário testa o fluxo legado; confirmação obrigatória tem suíte própria.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = `nextplay_explore_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${database}`;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test'; process.env.ALLOW_REGISTRATION = 'true'; process.env.TMDB_API_ACCESS_TOKEN = 'test-token';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
test('TMDB discovery uses collection genres while local games and books preserve exclusions and privacy', async t => {
  const realFetch = global.fetch;
  let externalCalls = 0;
  global.fetch = (url, options) => { if (String(url).startsWith('https://')) { externalCalls++; const address = new URL(String(url));
    if (address.pathname.includes('/genre/')) return Promise.resolve(Response.json({ genres: [{ id: 14, name: 'fantasia' }] }));
    const kind = address.pathname.endsWith('/movie') || address.pathname.includes('/movie/') ? 'movie' : 'series';
    if (address.pathname.includes('/discover/')) assert.equal(address.searchParams.get('with_genres'), '14');
    return Promise.resolve(Response.json({ results: [{ id: kind === 'movie' ? 910 : 911, title: 'TMDB ' + kind, name: 'TMDB ' + kind, genre_ids: [14] }] })); } return realFetch(url, options); };
  const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const db = app.get(getConnectionToken());
  t.after(async () => { global.fetch = realFetch; try { assert.match(database, /^nextplay_explore_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', body, cookie) => realFetch(`${base}/api${path}`, { method, headers: { origin: process.env.CLIENT_ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const register = async email => { const r = await call('/auth/register', 'POST', { email, password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const owner = await register('owner@example.test'), other = await register('other@example.test');
  assert.equal((await call('/library/explore')).status, 401);
  const add = async (title, kind, genres, cookie) => { const response = await call('/library', 'POST', { title, kind, genres, status: 'planned', notes: 'PRIVATE-NOTE' }, cookie); assert.equal(response.status, 201); return (await response.json()).item; };
  for (const kind of ['movie', 'series', 'game', 'book']) {
    await add(`My ${kind}`, kind, ['Fantasia'], owner);
    await add(`Suggested ${kind}`, kind, ['fantasia', 'Aventura'], other);
    await add(`Unrelated ${kind}`, kind, ['Drama'], other);
  }
  let response = await call('/library/explore', 'GET', undefined, owner);
  assert.equal(response.status, 200); let data = await response.json();
  assert.equal(data.sections.length, 4);
  for (const section of data.sections) {
    assert.equal(section.personalized, true); assert.equal(section.results.length, 1);
    assert.ok(section.results.every(item => item.title !== `My ${section.kind}`));
    assert.equal(section.results[0].title, ['movie', 'series'].includes(section.kind) ? `TMDB ${section.kind}` : `Suggested ${section.kind}`);
    assert.deepEqual(section.results[0].matches, ['fantasia']); assert.equal(section.results[0].relevance, 1);
    assert.equal(section.results[0].notes, undefined); assert.equal(section.results[0].ownerId, undefined); assert.equal(section.results[0].status, undefined);
  }
  assert.ok(!JSON.stringify(data).includes('PRIVATE-NOTE'));
  assert.equal((await call('/library/explore?kind=invalid', 'GET', undefined, owner)).status, 400);
  assert.equal((await call('/library/explore?page=0', 'GET', undefined, owner)).status, 400);
  const secondMoviePage = await (await call('/library/explore?kind=movie&page=2', 'GET', undefined, owner)).json();
  assert.equal(secondMoviePage.sections.length, 1); assert.equal(secondMoviePage.sections[0].kind, 'movie'); assert.equal(secondMoviePage.sections[0].nextPage, null);
  const book = data.sections.find(s => s.kind === 'book').results[0];
  response = await call('/library', 'POST', { title: 'Forged', kind: 'book', catalogId: book.catalogId, status: 'planned' }, owner);
  assert.equal(response.status, 201); const saved = (await response.json()).item;
  assert.equal(saved.title, book.title); assert.deepEqual(saved.genres, ['fantasia', 'Aventura']);
  assert.equal((await call('/library', 'POST', { title: book.title, kind: 'book', catalogId: book.catalogId, status: 'planned' }, owner)).status, 409);
  data = await (await call('/library/explore', 'GET', undefined, owner)).json();
  assert.ok(data.sections.find(s => s.kind === 'book').results.every(item => item.title !== book.title));
  for (const status of ['planned', 'active', 'completed']) {
    assert.equal((await call(`/library/${saved.id}`, 'PATCH', { title: saved.title, kind: 'book', status }, owner)).status, 200);
    const next = await (await call('/library/explore', 'GET', undefined, owner)).json();
    assert.ok(next.sections.find(s => s.kind === 'book').results.every(item => item.title !== book.title));
  }
  assert.equal((await call(`/library/${saved.id}`, 'DELETE', undefined, owner)).status, 204);
  assert.ok(await db.collection('catalog_titles').findOne({ key: book.catalogId }));
  const empty = await register('empty@example.test');
  data = await (await call('/library/explore', 'GET', undefined, empty)).json();
  assert.equal(data.sections[0].personalized, false); assert.ok(data.sections[0].results.length);
  assert.equal((await call('/library', 'POST', { title: 'Invalid', kind: 'book', status: 'planned', genres: ['a'.repeat(61)] }, owner)).status, 400);
  assert.ok(externalCalls > 0); assert.equal(await db.collection('catalog_titles').countDocuments({ title: /^TMDB / }), 0);
});
