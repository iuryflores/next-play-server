const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../dist/auth/auth.service');
const { AvatarStorage } = require('../dist/auth/avatar-storage');

function fixture() {
  const persisted = { avatarKey: 'uploads/avatars/owner/old.jpg', avatar: '', email: 'a@example.test' };
  const events = [];
  const user = { ...persisted, id: 'owner', save: async () => { events.push('save'); Object.assign(persisted, user); } };
  const users = { findById: () => ({ select: () => ({ exec: async () => user }) }) };
  const storage = {
    upload: async () => { events.push('upload'); return 'uploads/avatars/owner/new.jpg'; },
    remove: async key => { events.push(`remove:${key}`); },
  };
  const auth = new AuthService(users, {}, {}, storage);
  auth.me = async () => ({ id: 'owner' });
  return { auth, user, persisted, events, storage };
}
const dto = { displayName: 'Alice', email: 'a@example.test', avatar: 'data:image/jpeg;base64,/9j/2Q==' };

test('S3 replacement saves the key before deleting the old image', async () => {
  const f = fixture();
  const result = await f.auth.profile('token', dto);
  assert.deepEqual(f.events, ['upload', 'save', 'remove:uploads/avatars/owner/old.jpg']);
  assert.equal(f.persisted.avatar, '');
  assert.equal(f.persisted.avatarKey, 'uploads/avatars/owner/new.jpg');
  assert.equal(result.avatar, '/api/auth/avatar?v=new.jpg');
  assert.equal(result.avatarKey, undefined);
});
test('database failure cleans up only the new upload', async () => {
  const f = fixture();
  f.user.save = async () => { throw Object.assign(new Error(), { code: 11000 }); };
  await assert.rejects(f.auth.profile('token', dto), { status: 409 });
  assert.equal(f.persisted.avatarKey, 'uploads/avatars/owner/old.jpg');
  assert.deepEqual(f.events, ['upload', 'remove:uploads/avatars/owner/new.jpg']);
});
test('upload failure leaves the persisted profile unchanged', async () => {
  const f = fixture(); f.storage.upload = async () => { throw new Error('offline'); };
  await assert.rejects(f.auth.profile('token', dto));
  assert.equal(f.persisted.avatarKey, 'uploads/avatars/owner/old.jpg');
  assert.deepEqual(f.events, []);
});
test('omission preserves the photo and empty string removes it', async () => {
  const f = fixture();
  const { avatar, ...withoutPhoto } = dto;
  await f.auth.profile('token', withoutPhoto);
  assert.deepEqual(f.events, ['save']);
  await f.auth.profile('token', { ...dto, avatar: '' });
  assert.equal(f.persisted.avatarKey, '');
  assert.deepEqual(f.events, ['save', 'save', 'remove:uploads/avatars/owner/old.jpg']);
});
test('invalid image is rejected before reaching storage', async () => {
  const f = fixture();
  await assert.rejects(f.auth.profile('token', { ...dto, avatar: 'https://attacker.test/photo' }), { status: 400 });
  assert.deepEqual(f.events, []);
});
test('storage sends private encrypted JPEGs to nextplay-ij', async () => {
  const storage = new AvatarStorage();
  const commands = [];
  storage.client = { send: async command => commands.push(command.input) };
  const previous = process.env.AWS_REGION;
  process.env.AWS_REGION = 'sa-east-1';
  try {
    const key = await storage.upload('owner', Buffer.from([255, 216, 255, 217]));
    assert.match(key, /^uploads\/avatars\/owner\/[\w-]+\.jpg$/);
    assert.equal(commands[0].Bucket, process.env.S3_BUCKET || 'nextplay-ij');
    assert.equal(commands[0].ContentType, 'image/jpeg');
    assert.equal(commands[0].ServerSideEncryption, 'AES256');
    assert.equal(commands[0].ACL, undefined);
    await storage.remove(key);
    assert.equal(commands[1].Key, key);
  } finally { if (previous === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = previous; }
});
