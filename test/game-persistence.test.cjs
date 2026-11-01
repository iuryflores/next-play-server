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
  const catalog = { detail: async () => ({ title: 'Game', kind: 'game', catalogId: key, genres: ['Fighting'] }) };
  const service = new LibraryService(items, catalog, titles, {}, {}, {});
  service.remember = async () => key;
  const dto = { title: 'Game', kind: 'game', status: 'planned', catalogId: key, platform: ' PS1 ', genres: ['Luta', 'Aventura'] };
  const created = await service.create(new Types.ObjectId().toString(), dto);
  assert.equal(created.platform, 'PS1');
  assert.deepEqual(created.genres, ['Luta', 'Aventura']);
  const owner = saved.ownerId;
  const updated = await service.update(owner, created.id, { title: 'Game', kind: 'game', status: 'active' });
  assert.equal(updated.platform, 'PS1');
  assert.deepEqual(updated.genres, ['Luta', 'Aventura']);
  const cleared = await service.update(owner, created.id, { title: 'Game', kind: 'game', status: 'active', platform: '' });
  assert.equal(cleared.platform, '');
  const fromCatalog = await service.create(owner, { ...dto, genres: undefined });
  assert.deepEqual(fromCatalog.genres, ['Fighting']);
});
