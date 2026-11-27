const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDecipheriv, createHash, randomBytes, randomUUID } = require('node:crypto');
const { getConnectionToken } = require('@nestjs/mongoose');

// O teste usa banco descartável e simula somente a troca externa de tokens.
const database = 'nextplay_meli_test_' + randomUUID().replaceAll('-', '');
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/' + database,
  NODE_ENV: 'test',
  CLIENT_ORIGIN: 'https://nextplay.example.test',
  ALLOW_REGISTRATION: 'true',
  EMAIL_VERIFICATION_REQUIRED: 'false',
  MELI_CLIENT_ID: '123',
  MELI_CLIENT_SECRET: 'segredo-de-teste',
  MELI_REDIRECT_URI: 'https://nextplay.example.test/api/integrations/mercado-livre/callback',
  MELI_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
});
const { createApp } = require('../dist/bootstrap');

test('OAuth Mercado Livre vincula PKCE à sessão, consome state e cifra tokens', async t => {
  const app = await createApp();
  const db = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.equal(db.name, database);
      await db.dropDatabase();
    } finally {
      await app.close();
    }
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const realFetch = global.fetch;
  const call = (path, cookie, body) => realFetch(base + '/api/' + path, {
    method: body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: {
      origin: process.env.CLIENT_ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body && JSON.stringify(body),
  });
  const credentials = { email: 'piloto@example.test', password: 'Long-test-password-123!' };
  const register = async email => {
    const response = await call('auth/register', undefined, { ...credentials, email });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await register(credentials.email);
  const other = await register('outra@example.test');
  const owner = await db.collection('users').findOne({ email: credentials.email });
  process.env.MELI_PILOT_OWNER_ID = owner._id.toString();
  const login = await call('auth/login', undefined, credentials);
  const secondSession = login.headers.get('set-cookie').split(';')[0];
  const prefix = 'integrations/mercado-livre/';
  assert.equal((await call(prefix + 'authorize')).status, 401);
  assert.equal((await call(prefix + 'authorize', other)).status, 403);

  const started = await call(prefix + 'authorize', cookie);
  assert.equal(started.status, 302);
  const authorization = new URL(started.headers.get('location'));
  assert.equal(authorization.origin, 'https://auth.mercadolivre.com.br');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('redirect_uri'), process.env.MELI_REDIRECT_URI);
  const state = authorization.searchParams.get('state');
  const returned = prefix + 'callback?code=codigo-teste&state=' + state;
  const tokenExchange = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.mercadolibre.com/oauth/token');
    assert.equal(options.body.get('code'), 'codigo-teste');
    assert.equal(options.body.get('redirect_uri'), process.env.MELI_REDIRECT_URI);
    const challenge = createHash('sha256').update(options.body.get('code_verifier')).digest('base64url');
    assert.equal(challenge, authorization.searchParams.get('code_challenge'));
    return Response.json({ access_token: 'token-teste', refresh_token: 'refresh-teste', expires_in: 3600 });
  });
  assert.equal((await call(returned, secondSession)).status, 400);
  assert.equal(tokenExchange.mock.callCount(), 0);
  const responses = await Promise.all([call(returned, cookie), call(returned, cookie)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 400]);
  assert.equal(responses.find(response => response.status === 303).headers.get('location'), '/api/' + prefix + 'status');
  assert.equal(tokenExchange.mock.callCount(), 1);
  const response = await call(prefix + 'status', cookie);
  const status = await response.json();
  assert.deepEqual(Object.keys(status).sort(), ['connected', 'expiresAt']);
  assert.equal(status.connected, true);
  const grant = await db.collection('mercado_livre_oauth_grants').findOne({ owner: owner._id.toString() });
  assert.doesNotMatch(JSON.stringify(grant), /token-teste|refresh-teste/);
  const { iv, tag, data } = grant.credentials;
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.MELI_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(grant.owner + ':123'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()])), {
    accessToken: 'token-teste', refreshToken: 'refresh-teste',
  });
});
