const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AuthService} = require('../dist/auth/auth.service');
const {getConfig} = require('../dist/config');

test('dono e idioma validam a sessão uma vez por requisição, sem cache entre requisições', async () => {
  const auth = new AuthService();
  const calls = [];
  let revoked = false;
  auth.me = async token => {
    calls.push(token);
    if (revoked) throw new Error('revoked');
    return {id: token, language: 'pt-BR'};
  };
  const request = {cookies: {[getConfig().cookieName]: 'session-a'}};
  const first = auth.forRequest(request);
  assert.equal(auth.forRequest(request), first, 'compartilha também a consulta ainda em andamento');
  assert.deepEqual(await Promise.all([first, auth.forRequest(request)]), [
    {id: 'session-a', language: 'pt-BR'}, {id: 'session-a', language: 'pt-BR'},
  ]);
  await auth.forRequest(request);
  assert.deepEqual(calls, ['session-a']);
  const other = await auth.forRequest({cookies: {[getConfig().cookieName]: 'session-b'}});
  assert.equal(other.id, 'session-b', 'não mistura donos');
  revoked = true;
  const next = {cookies: request.cookies};
  const rejected = auth.forRequest(next);
  assert.equal(auth.forRequest(next), rejected);
  await assert.rejects(rejected, /revoked/, 'a mesma sessão é revalidada na próxima requisição');
  assert.deepEqual(calls, ['session-a', 'session-b', 'session-a']);
});
