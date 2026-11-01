import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function deploymentEnv(input, booksKey = '') {
  if (!input?.trim()) throw new Error('APP_ENV_FILE ausente.');
  if (!booksKey) return input.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(booksKey)) throw new Error('GOOGLE_BOOKS_API_KEY inválida.');
  // A chave dedicada pode ser rotacionada sem reescrever todos os secrets do APP_ENV_FILE.
  const lines = input.replace(/\r\n/g, '\n').split('\n').filter(line => !/^\s*(?:export\s+)?GOOGLE_BOOKS_API_KEY\s*=/.test(line));
  return lines.join('\n').replace(/\n*$/, '\n') + `GOOGLE_BOOKS_API_KEY=${booksKey}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Arquivo de destino ausente.');
  writeFileSync(process.argv[2], deploymentEnv(process.env.APP_ENV_FILE, process.env.GOOGLE_BOOKS_API_KEY), { mode: 0o600 });
}
