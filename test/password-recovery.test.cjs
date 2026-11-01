// Este cenário testa o fluxo legado; confirmação obrigatória tem suíte própria.
process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const database = 'nextplay_recovery_test_' + randomUUID().replaceAll('-', '');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/' + database;
process.env.CLIENT_ORIGIN = 'http://localhost:5174'; process.env.NODE_ENV = 'test'; process.env.ALLOW_REGISTRATION = 'true';
const { createApp } = require('../dist/bootstrap');
const { RecoveryMailer, PasswordRecovery } = require('../dist/auth/password-recovery');
const { hashToken } = require('../dist/auth/password');
const { getConnectionToken } = require('@nestjs/mongoose');

test('recovery validates origin, hides accounts, expires and consumes tokens once, and revokes sessions', async t => {
  const app = await createApp(); await app.listen(0, '127.0.0.1');
  const db = app.get(getConnectionToken()), base = await app.getUrl();
  t.after(async () => { try { assert.equal(db.name, database); assert.match(database, /^nextplay_recovery_test_[a-f0-9]{32}$/); await db.dropDatabase(); } finally { await app.close(); } });
  const mails = []; app.get(RecoveryMailer).send = async (to, link) => mails.push({ to, link });
  // O teste usa o mesmo controle de origem do frontend real.
  const call = (route, body, cookie, origin = process.env.CLIENT_ORIGIN) => fetch(base + '/api/auth/' + route, { method: body ? 'POST' : 'GET', headers: { origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const email = 'owner@example.test', password = 'Original-password-123!';
  let r = await call('register', { email, password }); assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('forgot-password', { email }, undefined, 'https://evil.test')).status, 403);
  assert.equal((await call('forgot-password', { email: 'bad' })).status, 400);
  const absent = await (await call('forgot-password', { email: 'absent@example.test' })).json();
  r = await call('forgot-password', { email: ' OWNER@example.test ' }); assert.equal(r.status, 200); assert.deepEqual(await r.json(), absent);
  assert.equal(mails.length, 1);
  let token = new URLSearchParams(new URL(mails[0].link).hash.slice(1)).get('reset-password');
  const user = await db.collection('users').findOne({ email });
  assert.equal(user.resetTokenHash, hashToken(token)); assert.notEqual(user.resetTokenHash, token);
  assert.equal(new URL(mails[0].link).origin, process.env.CLIENT_ORIGIN);
  await call('forgot-password', { email }); assert.equal(mails.length, 1);
  assert.equal((await call('reset-password', { token, password: 'short' })).status, 400);
  await db.collection('users').updateOne({ email }, { $set: { resetExpiresAt: new Date(0) } });
  assert.equal((await call('reset-password', { token, password })).status, 400);
  // Reabilita o token só no banco isolado para testar uso único concorrente.
  await db.collection('users').updateOne({ email }, { $set: { resetExpiresAt: new Date(Date.now() + 60000) } });
  const newPassword = 'Changed-password-456!';
  const attempts = await Promise.all([call('reset-password', { token, password: newPassword }), call('reset-password', { token, password: newPassword })]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]);
  assert.equal((await call('me', undefined, cookie)).status, 401);
  assert.equal((await call('login', { email, password })).status, 401);
  assert.equal((await call('login', { email, password: newPassword })).status, 200);
  assert.equal(await db.collection('users').countDocuments({ resetTokenHash: { $exists: true } }), 0);
  // Falha SMTP mantém a resposta genérica e invalida o link não entregue.
  await db.collection('users').updateOne({ email }, { $unset: { resetRequestedAt: 1 } });
  app.get(RecoveryMailer).send = async () => { throw new Error('SMTP offline'); };
  assert.deepEqual(await app.get(PasswordRecovery).request(email), absent);
  assert.equal(await db.collection('users').countDocuments({ resetTokenHash: { $exists: true } }), 0);
});
