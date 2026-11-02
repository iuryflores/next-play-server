const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
// Só este banco descartável é criado e removido pela suíte; não usa o .env da conta.
const databaseName = `nextplay_request_auth_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${databaseName}`;
process.env.CLIENT_ORIGIN = 'http://localhost:5174';
process.env.NODE_ENV = 'test';
process.env.ALLOW_REGISTRATION = 'true';
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const {createApp} = require('../dist/bootstrap');
const {getConnectionToken} = require('@nestjs/mongoose');
const {AuthService} = require('../dist/auth/auth.service');

test('listagem HTTP reutiliza autenticação só dentro da requisição e rejeita sessão revogada', async t => {
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const connection = app.get(getConnectionToken());
  t.after(async () => {
    try {
      assert.match(databaseName, /^nextplay_request_auth_test_[a-f0-9]{32}$/);
      assert.equal(connection.name, databaseName);
      await connection.dropDatabase();
    } finally { await app.close(); }
  });
  const base = await app.getUrl();
  const registered = await fetch(base + '/api/auth/register', {method:'POST', headers:{origin:process.env.CLIENT_ORIGIN,'Content-Type':'application/json'}, body:JSON.stringify({email:'performance@example.test',password:'Test-password-long-123!'})});
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const auth = app.get(AuthService);
  const original = auth.me.bind(auth);
  let calls = 0;
  auth.me = (...args) => { calls++; return original(...args); };
  for (let i=0;i<2;i++) {
    calls = 0;
    const response = await fetch(base + '/api/library', {headers:{cookie}});
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, []);
    assert.equal(calls, 1, 'dono e idioma não repetem consulta da sessão');
  }
  await fetch(base + '/api/auth/logout', {method:'POST',headers:{cookie,origin:process.env.CLIENT_ORIGIN}});
  const expired = await fetch(base + '/api/library', {headers:{cookie}});
  assert.equal(expired.status, 401);
});
