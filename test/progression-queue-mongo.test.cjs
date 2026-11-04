const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const mongoose = require('mongoose');
const { ProgressionService } = require('../dist/progression/progression.module');
const { markXpDirty, XP_RULES_VERSION } = require('../dist/progression/progression-queue');

test('fila Mongo persiste, agrupa salvamentos, retoma após reinício e migra histórico fora da leitura', async t => {
  // Banco temporário local exclusivo: nenhum dado de usuários reais é acessado.
  const database = 'np_xp_queue_' + randomUUID().replaceAll('-', '');
  const db = await mongoose.createConnection('mongodb://127.0.0.1:27017/' + database, { serverSelectionTimeoutMS: 5000 }).asPromise();
  let service = new ProgressionService(db);
  t.after(async () => { service.onModuleDestroy(); try { assert.match(database, /^np_xp_queue_[a-f0-9]{32}$/); assert.equal(db.name, database); await db.dropDatabase(); } finally { await db.close(); } });
  await service.onModuleInit(); service.onModuleDestroy();
  const owner = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
  await db.collection('users').insertMany([{ _id: owner }, { _id: other }]);
  await db.collection('library_items').insertMany([
    { ownerId: owner, kind: 'movie', status: 'completed', title: 'Filme A', runtime: 120, catalogId: 'tmdb:movie:1' },
    { ownerId: other, kind: 'movie', status: 'completed', title: 'Filme B', runtime: 60, catalogId: 'tmdb:movie:2' },
  ]);
  let reads = 0;
  const original = service.recognize.bind(service);
  service.recognize = async id => { reads++; return original(id); };
  assert.equal((await service.state(owner.toString())).totalXp, 0);
  assert.equal(reads, 0);
  await Promise.all(Array.from({ length: 20 }, () => markXpDirty(db, owner.toString())));
  assert.equal(await db.collection('user_xp_sync').countDocuments({ _id: owner }), 1);
  assert.equal((await db.collection('user_xp_sync').findOne({ _id: owner })).revision, 20);
  assert.equal((await service.sync(owner.toString(), true)).totalXp, 30);
  assert.equal(reads, 1);
  assert.equal((await service.sync(owner.toString(), true)).totalXp, 30);
  assert.equal(reads, 1, 'conta limpa não relê a biblioteca');
  await markXpDirty(db, owner.toString());
  service.onModuleDestroy();
  service = new ProgressionService(db);
  await service.onModuleInit(); service.onModuleDestroy();
  // Um tick cria os trabalhos de migração e reconhece uma conta, sem depender de login.
  await service.tick(); await service.tick();
  assert.equal((await service.state(other.toString())).totalXp, 25);
  assert.equal((await db.collection('user_xp_sync').findOne({ _id: owner })).dirty, false);
  assert.equal((await db.collection('user_xp_sync').findOne({ _id: other })).version, XP_RULES_VERSION);
});
