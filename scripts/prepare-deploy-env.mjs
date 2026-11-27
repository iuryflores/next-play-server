import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const meliKeys = ['MELI_CLIENT_ID', 'MELI_CLIENT_SECRET', 'MELI_PILOT_OWNER_ID', 'MELI_REDIRECT_URI', 'MELI_TOKEN_ENCRYPTION_KEY'];

export function deploymentEnv(input, booksKey = '', rotten = {}, meliEnv = '') {
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
  if (meliEnv) {
    const meli = parseEnv(meliEnv);
    const origin = URL.parse(parseEnv(input).CLIENT_ORIGIN || '')?.origin;
    // O secret dedicado só pode atualizar as cinco chaves desta integração.
    if (Object.keys(meli).length !== meliKeys.length || !meliKeys.every(key => Object.hasOwn(meli, key)) ||
        !/^\d+$/.test(meli.MELI_CLIENT_ID) ||
        !/^[A-Za-z0-9._~+=/-]+$/.test(meli.MELI_CLIENT_SECRET) ||
        !/^[a-f0-9]{24}$/i.test(meli.MELI_PILOT_OWNER_ID) ||
        !/^[a-f0-9]{64}$/i.test(meli.MELI_TOKEN_ENCRYPTION_KEY) ||
        !origin?.startsWith('https://') ||
        meli.MELI_REDIRECT_URI !== origin + '/api/integrations/mercado-livre/callback') {
      throw new Error('MELI_ENV_FILE incompleto ou inválido. Confira as cinco chaves e o domínio do callback.');
    }
    for (const key of meliKeys) overrides[key] = meli[key];
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
  writeFileSync(process.argv[2], deploymentEnv(process.env.APP_ENV_FILE, process.env.GOOGLE_BOOKS_API_KEY, {appId:process.env.ROTTEN_TOMATOES_ALGOLIA_APP_ID,apiKey:process.env.ROTTEN_TOMATOES_ALGOLIA_API_KEY,index:process.env.ROTTEN_TOMATOES_ALGOLIA_INDEX}, process.env.MELI_ENV_FILE), { mode: 0o600 });
}
