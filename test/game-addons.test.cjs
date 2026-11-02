const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const database = 'nextplay_game_addons_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { CatalogService } = require('../dist/catalog/catalog.module');
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');
function fixture() {
  const records = new Map();
  const service = new CatalogService({ collection: name => ({
    findOne: async query => records.get(name + ':' + query._id) || null,
    updateOne: async (query, update) => records.set(name + ':' + query._id, { ...query, ...update.$set }),
  }) });
  return { service, records };
}
const child = id => ({ id, name: 'Content ' + id, slug: 'content-' + id, summary: 'Description', cover: { image_id: 'safe_image' }, first_release_date: 1577836800, platforms: [{ name: 'PC (Microsoft Windows)' }], game_localizations: [{ name: 'Conteúdo ' + id, region: { identifier: 'pt_BR' } }] });

test('DLCs e expansões usam vínculos explícitos, deduplicação, idioma, cache e páginas de vinte', async () => {
  const f = fixture(); let calls = 0;
  f.service.igdb = async body => {
    calls++;
    if (body.includes('fields dlcs')) return [{ id: 42, dlcs: [...Array.from({ length: 25 }, (_, i) => i + 1), 42, 1], expansions: [2, 26], standalone_expansions: [27] }];
    const ids = body.match(/where id = \(([^)]+)\)/)[1].split(',').map(Number); assert.ok(ids.length <= 20);
    return ids.reverse().map(child);
  };
  const first = await f.service.gameAddons('igdb:game:42', 'pt-BR', 1);
  assert.equal(first.total, 27); assert.equal(first.results.length, 20); assert.equal(first.nextPage, 2); assert.equal(calls, 2);
  assert.equal(first.results[0].catalogId, 'igdb:game:1'); assert.equal(first.results[0].title, 'Conteúdo 1'); assert.equal(first.results[1].contentType, 'dlc');
  assert.deepEqual(await f.service.gameAddons('igdb:game:42', 'pt-BR', 1), first); assert.equal(calls, 2);
  const second = await f.service.gameAddons('igdb:game:42', 'pt-BR', 2); assert.equal(second.results.length, 7); assert.equal(second.nextPage, null);
  assert.equal(second.results[5].contentType, 'expansion'); assert.equal(second.results[6].contentType, 'standalone-expansion'); assert.equal(calls, 3);
  const english = await f.service.gameAddons('igdb:game:42', 'en-US'); assert.equal(english.results[0].title, 'Content 1'); assert.equal(calls, 4);
  for (const record of f.records.values()) record.expires = new Date(0);
  await f.service.gameAddons('igdb:game:42'); assert.equal(calls, 6);
  for (const page of [0, -1, 1.5, 501, NaN]) await assert.rejects(f.service.gameAddons('igdb:game:42', 'pt-BR', page), /Página inválida/);
});

test('ausência é distinta de falha, e títulos removidos não bloqueiam a próxima página', async () => {
  const f = fixture(); let calls = 0;
  f.service.igdb = async () => { calls++; return [{ id: 42 }]; };
  const none = await f.service.gameAddons('igdb:game:42'); assert.equal(none.supported, true); assert.equal(none.total, 0); assert.deepEqual(none.results, []);
  await f.service.gameAddons('igdb:game:42'); assert.equal(calls, 1);
  for (const id of [undefined, 'manual', 'tmdb:movie:42', 'igdb:game:../42']) assert.equal((await f.service.gameAddons(id)).supported, false);
  const g = fixture(); g.service.igdb = async () => { throw Error('provider failure'); };
  await assert.rejects(g.service.gameAddons('igdb:game:42'), /provider failure/); assert.equal(g.records.size, 0);
  g.service.igdb = async () => [{ id: 42, dlcs: ['invalid'] }]; await assert.rejects(g.service.gameAddons('igdb:game:42'), /Resposta inválida/); assert.equal(g.records.size, 0);
  g.service.igdb = async body => body.includes('fields dlcs') ? [{ id: 42, dlcs: Array.from({ length: 21 }, (_, i) => i + 1) }] : [];
  const removed = await g.service.gameAddons('igdb:game:42'); assert.equal(removed.results.length, 0); assert.equal(removed.nextPage, 2);
  g.service.igdb = async () => [{ id: 999, name: 'Unrelated' }]; await assert.rejects(g.service.gameAddons('igdb:game:42', 'pt-BR', 2), /Resposta inválida/);
});

test('consulta privada e adição independente preservam jogo principal e impedem duplicados', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken()), catalog = app.get(CatalogService); let calls = 0;
  catalog.igdb = async body => { calls++; return body.includes('fields dlcs') ? [{ id: 42, expansions: [99] }] : [child(99)]; };
  t.after(async () => { try { assert.match(database, /^nextplay_game_addons_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api' + path, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('addons-a'), b = await register('addons-b');
  let r = await call('/library', 'POST', a, { title: 'Jogo principal', kind: 'game', status: 'active', platform: 'PC', playtimeMinutes: 1200 }); assert.equal(r.status, 201);
  const parent = (await r.json()).item, itemId = new Types.ObjectId(parent.id), path = '/library/' + parent.id + '/game-addons';
  assert.equal((await call(path)).status, 401); assert.equal((await call(path, 'GET', b)).status, 404); assert.equal(calls, 0);
  assert.equal((await (await call(path, 'GET', a)).json()).supported, false); assert.equal(calls, 0);
  await db.collection('library_items').updateOne({ _id: itemId }, { $set: { catalogId: 'igdb:game:42' } });
  const before = await db.collection('library_items').findOne({ _id: itemId });
  r = await call(path, 'GET', a); assert.equal(r.status, 200); const list = await r.json(); assert.equal(list.results[0].catalogId, 'igdb:game:99'); assert.equal(list.results[0].contentType, 'expansion'); assert.equal(calls, 2);
  await call(path, 'GET', a); assert.equal(calls, 2);
  for (const page of ['0', '1.2', 'invalid', '501']) assert.equal((await call(path + '?page=' + page, 'GET', a)).status, 400);
  const payload = { title: list.results[0].title, kind: 'game', status: 'planned', catalogId: list.results[0].catalogId };
  assert.equal((await call('/library', 'POST', a, payload, 'https://evil.example')).status, 403);
  r = await call('/library', 'POST', a, payload); assert.equal(r.status, 201); const addon = (await r.json()).item;
  assert.notEqual(addon.id, parent.id); assert.equal(addon.status, 'planned'); assert.equal(addon.playtimeMinutes, 0); assert.equal(addon.parentGameCatalogId, 'igdb:game:42');
  assert.equal((await call('/library', 'POST', a, payload)).status, 409);
  await call('/library/' + addon.id, 'PATCH', a, { title: addon.title, kind: 'game', status: 'completed', playtimeMinutes: 60 });
  assert.deepEqual(await db.collection('library_items').findOne({ _id: itemId }), before);
  assert.equal(await db.collection('library_items').countDocuments({ ownerId: before.ownerId }), 2);
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0);
  const groupedList = (await (await call('/library', 'GET', a)).json()).items;
  assert.equal(groupedList.find(item => item.id === parent.id).playtimeMinutes, 1200);
  assert.equal(groupedList.find(item => item.id === addon.id).playtimeMinutes, 60);
  assert.equal(groupedList.find(item => item.id === addon.id).parentGameCatalogId, 'igdb:game:42');
  const related = await (await call(path, 'GET', a)).json();
  assert.equal(related.trackedParts.length, 1); assert.equal(related.trackedParts[0].id, addon.id); assert.equal(related.trackedParts[0].playtimeMinutes, 60);
  // Documentos antigos continuam com suas horas originais: o vínculo vem do diretório já consultado.
  await db.collection('library_items').updateOne({ _id: new Types.ObjectId(addon.id) }, { $unset: { parentGameCatalogId: '' } });
  const legacy = (await (await call('/library', 'GET', a)).json()).items.find(item => item.id === addon.id);
  assert.equal(legacy.parentGameCatalogId, 'igdb:game:42'); assert.equal(legacy.playtimeMinutes, 60);
  assert.equal((await db.collection('library_items').findOne({ _id: new Types.ObjectId(addon.id) })).parentGameCatalogId, undefined);
  assert.equal((await call('/library/' + addon.id + '/game-sessions', 'POST', a, { id: randomUUID(), playedOn: '2026-10-01', mode: 'add', minutes: 30 })).status, 201);
  assert.equal((await db.collection('library_items').findOne({ _id: new Types.ObjectId(addon.id) })).playtimeMinutes, 90);
  assert.deepEqual(await db.collection('library_items').findOne({ _id: itemId }), before);

  r = await call('/library', 'POST', a, { title: 'Filme', kind: 'movie', status: 'planned' }); const movie = (await r.json()).item;
  assert.equal((await call('/library/' + movie.id + '/game-addons', 'GET', a)).status, 400);
  const spec = await (await call('/docs-json')).json(); assert.ok(spec.paths['/api/library/{id}/game-addons'].get.parameters.find(param => param.name === 'page'));
});


test('detalhes do catálogo só agrupam dependências confirmadas, preservando expansões independentes', async () => {
  const f = fixture();
  f.service.igdb = async body => {
    if (body.includes('fields dlcs')) return [{ id: 42, dlcs: [2], expansions: [3], standalone_expansions: [4] }];
    if (body.includes('where id = (')) return [2, 3, 4].map(child);
    const id = Number(body.match(/where id = (\d+);/)[1]); return [{ ...child(id), parent_game: 42 }];
  };
  assert.equal((await f.service.detail('igdb:game:2')).parentGameCatalogId, 'igdb:game:42');
  assert.equal((await f.service.detail('igdb:game:3')).parentGameCatalogId, 'igdb:game:42');
  assert.equal((await f.service.detail('igdb:game:4')).parentGameCatalogId, undefined);
});
