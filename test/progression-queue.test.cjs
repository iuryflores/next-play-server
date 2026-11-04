const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { of, throwError, lastValueFrom } = require('rxjs');
const { Types } = require('mongoose');
const { XpActivityInterceptor, ProgressionService } = require('../dist/progression/progression.module');
const { markXpDirty } = require('../dist/progression/progression-queue');

test('somente mutações elegíveis concluídas invalidam o XP; leitura, comentário e falha não invalidam', async () => {
  let marks = 0;
  const owner = new Types.ObjectId().toString();
  const interceptor = new XpActivityInterceptor({ collection: name => { assert.equal(name, 'user_xp_sync'); return { updateOne: async () => { marks++; } }; } }, { forRequest: async () => ({ id: owner }) });
  const context = (method, path) => ({ switchToHttp: () => ({ getRequest: () => ({ method, path }) }) });
  for (const [method, path] of [['GET', '/api/library'], ['POST', '/api/catalog/browse'], ['POST', '/api/library/' + owner + '/comments'], ['PATCH', '/api/library/' + owner + '/priority'], ['POST', '/api/game-imports/steam/library']]) {
    await lastValueFrom(interceptor.intercept(context(method, path), { handle: () => of('ok') }));
  }
  assert.equal(marks, 0);
  for (const [method, path] of [['POST', '/api/collector'], ['POST', '/api/library'], ['PATCH', '/api/library/' + owner], ['POST', '/api/library/' + owner + '/rewatches'], ['PATCH', '/api/library/' + owner + '/episodes'], ['POST', '/api/library/' + owner + '/episodes/watch-many'], ['POST', '/api/game-imports/preview/x/y/apply']]) {
    assert.equal(await lastValueFrom(interceptor.intercept(context(method, path), { handle: () => of('saved') })), 'saved');
  }
  assert.equal(marks, 7);
  await assert.rejects(lastValueFrom(interceptor.intercept(context('POST', '/api/library'), { handle: () => throwError(() => Error('failed')) })), /failed/);
  assert.equal(marks, 7);
});

test('leitura de XP sem alterações pendentes não consulta histórico', async () => {
  const owner = new Types.ObjectId().toString();
  const jobs = { findOne: async () => ({ _id: new Types.ObjectId(owner) }), findOneAndUpdate: async () => null };
  const service = new ProgressionService({ collection: name => { assert.equal(name, 'user_xp_sync'); return jobs; } });
  service.recognize = async () => assert.fail('não deveria recalcular');
  service.state = async id => ({ owner: id, totalXp: 30 });
  assert.deepEqual(await service.sync(owner, true), { owner, totalXp: 30 });
});

test('marcação concorrente de conta nova recupera colisão do upsert', async () => {
  let calls = 0;
  await markXpDirty({ collection: () => ({ updateOne: async (_, update) => { calls++; assert.equal(update.$inc.revision, 1); if (calls === 1) throw Object.assign(Error(), { code: 11000 }); } }) }, new Types.ObjectId().toString());
  assert.equal(calls, 2);
});

test('mudança durante o processamento não é apagada e falha mantém a conta pendente para repetir', async () => {
  const owner = new Types.ObjectId();
  const job = { _id: owner, revision: 1, dirty: true, version: 0, leaseToken: 'mine', leaseUntil: new Date() };
  let revision = 1, acknowledged = false, released = false;
  const service = new ProgressionService({ collection: () => ({ updateOne: async (filter, update) => {
    if (filter.revision !== undefined) { if (filter.revision === revision) acknowledged = true; }
    else if (update.$unset?.leaseToken !== undefined) released = true;
  } }) });
  service.recognize = async () => { revision++; };
  await service.runJob(job);
  assert.equal(acknowledged, false);
  assert.equal(released, true);
  assert.equal(service.inFlight.size, 0);
  service.recognize = async () => { throw Error('db temporarily unavailable'); };
  await assert.rejects(service.runJob({ ...job, revision }), /temporarily/);
  assert.equal(acknowledged, false);
  assert.equal(service.inFlight.size, 0);
});
