import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function deploymentEnv(input, booksKey = '', rotten = {}) {
  if (!input?.trim()) throw new Error('APP_ENV_FILE ausente.');
  const overrides = {};
  if (booksKey) {
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(booksKey)) throw new Error('GOOGLE_BOOKS_API_KEY inválida.');
    overrides.GOOGLE_BOOKS_API_KEY = booksKey;
  }
  if (rotten.appId || rotten.apiKey || rotten.index) {
    // Uma configuração dedicada incompleta não pode apagar a configuração funcional existente.
    if (!/^[A-Z0-9]{10}$/.test(rotten.appId || '') || !/^[A-Za-z0-9+/=_-]{16,2048}$/.test(rotten.apiKey || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(rotten.index || 'content_rt'))
      throw new Error('Configuração dedicada do Rotten Tomatoes incompleta ou inválida.');
    Object.assign(overrides, {ROTTEN_TOMATOES_ENABLED:'true',ROTTEN_TOMATOES_ALGOLIA_APP_ID:rotten.appId,ROTTEN_TOMATOES_ALGOLIA_API_KEY:rotten.apiKey,ROTTEN_TOMATOES_ALGOLIA_INDEX:rotten.index || 'content_rt'});
  }
  // Preserva linhas e aspas de todos os outros secrets; os valores dedicados nunca aparecem no log.
  const lines = input.replace(/\r\n/g, '\n').split('\n').filter(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/)?.[1];
    return !Object.hasOwn(overrides,key);
  });
  const base=lines.join('\n').replace(/\n*$/, '\n');
  return base+Object.entries(overrides).map(([key,value])=>`${key}=${value}\n`).join('');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Arquivo de destino ausente.');
  writeFileSync(process.argv[2], deploymentEnv(process.env.APP_ENV_FILE, process.env.GOOGLE_BOOKS_API_KEY, {appId:process.env.ROTTEN_TOMATOES_ALGOLIA_APP_ID,apiKey:process.env.ROTTEN_TOMATOES_ALGOLIA_API_KEY,index:process.env.ROTTEN_TOMATOES_ALGOLIA_INDEX}), { mode: 0o600 });
}
