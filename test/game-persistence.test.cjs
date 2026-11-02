const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { LibraryService } = require('../dist/library/library.module');
const { Types } = require('mongoose');

test('game service saves platform, preserves it on quick updates and allows clearing it', async () => {
  let saved;
  const key = 'igdb:game:1';
  const items = {
    exists: async () => false,
    create: async value => (saved = { ...value, _id: new Types.ObjectId() }),
    findOne: () => ({ exec: async () => saved }),
    findOneAndUpdate: (_filter, update) => ({ exec: async () => (saved = { ...saved, ...update.$set }) }),
  };
  const titles = { findOne: () => ({ exec: async () => null }), updateOne: async () => {} };
  // O jogo deste cenário não é uma dependência de outro título.
  const catalog = { cachedGameParent: async id => { assert.equal(id, key); return undefined; }, detail: async () => ({ title: 'Game', kind: 'game', catalogId: key, genres: ['Fighting'] }) };
  const service = new LibraryService(items, catalog, titles, {}, {}, {});
  service.remember = async () => key;
  const dto = { title: 'Game', kind: 'game', status: 'planned', catalogId: key, platform: ' PS1 ', genres: ['Luta', 'Aventura'], playtimeMinutes: 123 };
  const created = await service.create(new Types.ObjectId().toString(), dto);
  assert.equal(created.platform, 'PS1');
  assert.equal(created.playtimeMinutes,123);
  assert.deepEqual(created.genres, ['Luta', 'Aventura']);
  const owner = saved.ownerId;
  const updated = await service.update(owner, created.id, { title: 'Game', kind: 'game', status: 'active' });
  assert.equal(updated.platform, 'PS1');
  assert.equal(updated.playtimeMinutes,123);
  const completed=await service.update(owner,created.id,{title:'Game',kind:'game',status:'completed'});
  assert.equal(completed.playtimeMinutes,123);
  assert.deepEqual(updated.genres, ['Luta', 'Aventura']);
  const cleared = await service.update(owner, created.id, { title: 'Game', kind: 'game', status: 'active', platform: '', playtimeMinutes:0 });
  assert.equal(cleared.playtimeMinutes,0);
  assert.equal(cleared.platform, '');
  const fromCatalog = await service.create(owner, { ...dto, genres: undefined });
  assert.deepEqual(fromCatalog.genres, ['Fighting']);
});
