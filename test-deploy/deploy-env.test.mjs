import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentEnv } from '../scripts/prepare-deploy-env.mjs';

test('chave dedicada de livros substitui somente a configuração de Books e preserva os demais segredos', () => {
  const result = deploymentEnv('PORT=3111\r\nSMTP_PASS="ficticio # teste"\r\nGOOGLE_BOOKS_API_KEY=old\r\nexport GOOGLE_BOOKS_API_KEY=duplicate\r\n', 'test-books-key-123');
  assert.equal(result, 'PORT=3111\nSMTP_PASS="ficticio # teste"\nGOOGLE_BOOKS_API_KEY=test-books-key-123\n');
  assert.equal(deploymentEnv('GOOGLE_BOOKS_API_KEY=existing'), 'GOOGLE_BOOKS_API_KEY=existing\n');
  assert.throws(() => deploymentEnv('', 'test-books-key-123'));
  assert.throws(() => deploymentEnv('PORT=3111', 'key\nHOST=evil'));
});

test('Rotten Tomatoes dedicado habilita a consulta e preserva banco, SMTP e demais credenciais',()=>{
  const input='NODE_ENV=production\nMONGODB_URI="mongodb://user:senha@host/db"\nSMTP_PASS="ficticio # teste"\nROTTEN_TOMATOES_ENABLED=false\nexport ROTTEN_TOMATOES_ALGOLIA_API_KEY=old\n';
  const result=deploymentEnv(input,'',{appId:'ABCDEFGHIJ',apiKey:'search-key-test-123456'});
  assert.ok(result.includes('MONGODB_URI="mongodb://user:senha@host/db"\n'));
  assert.ok(result.includes('SMTP_PASS="ficticio # teste"\n'));
  assert.ok(result.includes('ROTTEN_TOMATOES_ENABLED=true\n'));
  assert.ok(result.includes('ROTTEN_TOMATOES_ALGOLIA_INDEX=content_rt\n'));
  assert.equal((result.match(/ROTTEN_TOMATOES_ALGOLIA_API_KEY=/g)||[]).length,1);
  assert.equal(deploymentEnv(input),input);
  for(const rotten of [{appId:'ABCDEFGHIJ'},{apiKey:'search-key-test-123456'},{appId:'ABCDEFGHIJ',apiKey:'bad\nHOST=evil'},{appId:'ABCDEFGHIJ',apiKey:'search-key-test-123456',index:'bad\nHOST=evil'}])assert.throws(()=>deploymentEnv(input,'',rotten));
});
