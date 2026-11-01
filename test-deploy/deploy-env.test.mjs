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
