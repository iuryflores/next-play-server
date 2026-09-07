const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

// Only this newly generated database can be removed by this test suite.
const databaseName = `nextplay_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${databaseName}`;
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.NODE_ENV = 'test';
process.env.ALLOW_REGISTRATION = 'true';
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken, getModelToken } = require('@nestjs/mongoose');

test('NestJS authentication with isolated MongoDB', async t => {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const connection = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(databaseName, /^nextplay_test_[a-f0-9]{32}$/);
      assert.equal(connection.name, databaseName);
      await connection.dropDatabase();
    } finally { await app.close(); }
  });
  const request = (path, method = 'GET', body, cookie, origin = process.env.CLIENT_ORIGIN) => fetch(`${url}/api${path}`, {
    method,
    headers: { ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookieFrom = response => { const value = response.headers.get('set-cookie'); assert.ok(value); return value.split(';')[0]; };
  const account = { email: 'person@example.test', password: 'Long-test-password-123!' };
  let firstCookie;
  let userId;

  await t.test('registration validates input and only returns public user data', async () => {
    assert.equal((await request('/auth/me')).status, 401);
    assert.equal((await request('/auth/register', 'POST', { email: 'bad', password: 'short' })).status, 400);
    assert.equal((await request('/auth/register', 'POST', { ...account, password: 'short' })).status, 400);
    const response = await request('/auth/register', 'POST', account);
    assert.equal(response.status, 201);
    const { user } = await response.json();
    assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'provider']); userId = user.id;
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    firstCookie = cookieFrom(response);
    const users = app.get(getModelToken('User'));
    const stored = await users.findById(userId).select('+passwordHash');
    assert.match(stored.passwordHash, /^scrypt:/); assert.notEqual(stored.passwordHash, account.password);
    assert.equal((await users.findById(userId)).passwordHash, undefined);
    const sessions = app.get(getModelToken('Session'));
    assert.notEqual((await sessions.findOne({ userId })).tokenHash, firstCookie.split('=')[1]);
  });
  await t.test('duplicate account and generic invalid credentials', async () => {
    assert.equal((await request('/auth/register', 'POST', account)).status, 409);
    const wrong = await request('/auth/login', 'POST', { ...account, password: 'wrong' });
    const unknown = await request('/auth/login', 'POST', { ...account, email: 'unknown@example.test' });
    assert.equal(wrong.status, 401); assert.deepEqual(await wrong.json(), await unknown.json());
  });
  await t.test('session lookup, normalization, rotation and logout', async () => {
    assert.equal((await (await request('/auth/me', 'GET', undefined, firstCookie)).json()).user.id, userId);
    const login = await request('/auth/login', 'POST', { ...account, email: ' PERSON@EXAMPLE.TEST ' }, firstCookie);
    assert.equal(login.status, 200); const nextCookie = cookieFrom(login);
    assert.equal((await request('/auth/me', 'GET', undefined, firstCookie)).status, 401);
    assert.equal((await request('/auth/me', 'GET', undefined, nextCookie)).status, 200);
    assert.equal((await request('/auth/logout', 'POST', {}, nextCookie)).status, 204);
    assert.equal((await request('/auth/me', 'GET', undefined, nextCookie)).status, 401);
  });
  await t.test('forged cookie, expired session, unexpected fields and CSRF are rejected', async () => {
    assert.equal((await request('/auth/me', 'GET', undefined, 'nextplay_session=forged')).status, 401);
    assert.equal((await request('/auth/login', 'POST', account, undefined, 'https://evil.example')).status, 403);
    assert.equal((await request('/auth/login', 'POST', account, undefined, '')).status, 403);
    assert.equal((await request('/auth/login', 'POST', { ...account, role: 'admin' })).status, 400);
    const login = await request('/auth/login', 'POST', account);
    const cookie = cookieFrom(login);
    await app.get(getModelToken('Session')).updateMany({}, { expiresAt: new Date(0) });
    assert.equal((await request('/auth/me', 'GET', undefined, cookie)).status, 401);
  });
  await t.test('Google and SMS remain unavailable and cannot create sessions', async () => {
    assert.deepEqual(await (await request('/auth/providers')).json(), { email: true, google: false, phone: false, registration: true });
    for (const path of ['/auth/google/start', '/auth/phone/start']) {
      const response = await request(path, 'POST', {}); assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
    }
  });
  await t.test('rate limits persist in MongoDB', async () => {
    let blocked = false;
    for (let index = 0; index < 25; index++) {
      const response = await request('/auth/login', 'POST', {});
      if (response.status === 429) { blocked = true; break; }
    }
    assert.equal(blocked, true);
    assert.ok(await app.get(getModelToken('AuthAttempt')).countDocuments());
  });
  await t.test('a new Nest application can read the same MongoDB user', async () => {
    const second = await createApp();
    try { assert.equal((await second.get(getModelToken('User')).findById(userId)).email, account.email); }
    finally { await second.close(); }
  });
});
