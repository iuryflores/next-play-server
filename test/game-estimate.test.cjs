const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const database = 'nextplay_game_estimate_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.NODE_ENV = 'test'; process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.ALLOW_REGISTRATION = 'true'; process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { CatalogService } = require('../dist/catalog/catalog.module');
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { Types } = require('mongoose');

function fixture() {
  let cached = null, writes = 0;
  const service = new CatalogService({ collection: name => {
    assert.equal(name, 'catalog_game_estimates');
    return { findOne: async query => cached?._id === query._id ? cached : null, updateOne: async (query, update) => { writes++; cached = { ...query, ...update.$set }; } };
  } });
  return { service, saved: () => cached, writes: () => writes };
}

test('estimativas IGDB convertem segundos, compartilham consultas e expiram sem incluir dados privados', async () => {
  const f = fixture(); let calls = 0;
  f.service.igdb = async (body, endpoint) => { calls++; assert.equal(endpoint, 'game_time_to_beats'); assert.match(body, /where game_id = 42;/); return [{ game_id: 42, hastily: 108001, normally: 144000, completely: 216000, count: 17 }]; };
  const values = await Promise.all([f.service.gameEstimate('igdb:game:42'), f.service.gameEstimate('igdb:game:42')]);
  assert.equal(calls, 1); assert.deepEqual(values[0], { supported: true, source: 'igdb', mainMinutes: 1801, extrasMinutes: 2400, completionistMinutes: 3600, sampleCount: 17 });
  assert.deepEqual(values[0], values[1]); await f.service.gameEstimate('igdb:game:42'); assert.equal(calls, 1);
  assert.ok(f.saved().expires > new Date(Date.now() + 6 * 86400000));
  f.saved().expires = new Date(0); await f.service.gameEstimate('igdb:game:42'); assert.equal(calls, 2);
});

test('ausências e tempos inválidos ficam nulos; falhas do provedor não viram ausência em cache', async () => {
  const f = fixture(); let calls = 0;
  f.service.igdb = async () => { calls++; return []; };
  const missing = await f.service.gameEstimate('igdb:game:42'); assert.equal(missing.supported, true); assert.equal(missing.mainMinutes, null);
  assert.ok(f.saved().expires < new Date(Date.now() + 2 * 86400000));
  f.saved().expires = new Date(0); f.service.igdb = async () => [{ game_id: 42, hastily: -1, normally: 0, completely: '3600', count: 0 }];
  const invalid = await f.service.gameEstimate('igdb:game:42'); assert.equal(invalid.mainMinutes, null); assert.equal(invalid.extrasMinutes, null); assert.equal(invalid.completionistMinutes, null); assert.equal(invalid.sampleCount, null);
  f.saved().expires = new Date(0); const writes = f.writes(); f.service.igdb = async () => { throw Error('temporarily unavailable'); };
  await assert.rejects(f.service.gameEstimate('igdb:game:42'), /temporarily unavailable/); assert.equal(f.writes(), writes);
  f.service.igdb = async () => ({}); await assert.rejects(f.service.gameEstimate('igdb:game:42'), /Resposta inválida/); assert.equal(f.writes(), writes);
  f.service.igdb = async () => [{ game_id: 999, hastily: 3600 }]; await assert.rejects(f.service.gameEstimate('igdb:game:42'), /Resposta inválida/);
  f.service.igdb = async () => [{ game_id: 42, hastily: 3600 }]; assert.equal((await f.service.gameEstimate('igdb:game:42')).mainMinutes, 60);
  for (const id of [undefined, 'tmdb:movie:42', 'manual', 'igdb:game:42; drop']) assert.equal((await f.service.gameEstimate(id)).supported, false);
});

test('endpoint de estimativa protege a conta e não altera horas, conclusão, sessões ou XP', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(), db = app.get(getConnectionToken()), catalog = app.get(CatalogService); let calls = 0;
  catalog.igdb = async () => { calls++; return [{ game_id: 42, hastily: 108000, normally: 144000, completely: 216000, count: 10 }]; };
  t.after(async () => { try { assert.match(database, /^nextplay_game_estimate_test_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await app.close(); } });
  const call = (path, method = 'GET', cookie, body) => fetch(base + '/api' + path, { method, headers: { origin: process.env.CLIENT_ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const register = async name => { const r = await call('/auth/register', 'POST', undefined, { email: name + '@example.test', password: 'Long-test-password-123!' }); assert.equal(r.status, 201); return r.headers.get('set-cookie').split(';')[0]; };
  const a = await register('estimate-a'), b = await register('estimate-b');
  let r = await call('/library', 'POST', a, { title: 'Jogo teste', kind: 'game', status: 'active', platform: 'PC', playtimeMinutes: 720 }); assert.equal(r.status, 201);
  const item = (await r.json()).item, itemId = new Types.ObjectId(item.id), path = '/library/' + item.id + '/game-estimate';
  assert.equal((await call(path)).status, 401); assert.equal((await call(path, 'GET', b)).status, 404); assert.equal(calls, 0);
  assert.equal((await (await call(path, 'GET', a)).json()).supported, false); assert.equal(calls, 0);
  await db.collection('library_items').updateOne({ _id: itemId }, { $set: { catalogId: 'igdb:game:42' } });
  const before = await db.collection('library_items').findOne({ _id: itemId });
  r = await call(path, 'GET', a); assert.equal(r.status, 200); const estimate = await r.json(); assert.equal(estimate.mainMinutes, 1800); assert.equal(estimate.sampleCount, 10);
  await call(path, 'GET', a); assert.equal(calls, 1);
  assert.deepEqual(await db.collection('library_items').findOne({ _id: itemId }), before);
  assert.equal(await db.collection('user_xp_credits').countDocuments(), 0);
  r = await call('/library', 'POST', a, { title: 'Filme', kind: 'movie', status: 'planned' }); const movie = (await r.json()).item;
  assert.equal((await call('/library/' + movie.id + '/game-estimate', 'GET', a)).status, 400);
  const spec = await (await call('/docs-json')).json();
  assert.ok(spec.paths['/api/library/{id}/game-estimate'].get.responses['200']);
  assert.equal(spec.components.schemas.GameEstimateDto.properties.mainMinutes.nullable, true);
});
