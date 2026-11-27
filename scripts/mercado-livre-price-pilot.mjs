import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';

const api = 'https://api.mercadolibre.com';
const input = new URL('./mercado-livre-500-games.txt', import.meta.url);
const platforms = new Map(Object.entries({
  PS5: /\b(?:ps ?5|play ?station ?5)\b/g,
  PS4: /\b(?:ps ?4|play ?station ?4)\b/g,
  PS3: /\b(?:ps ?3|play ?station ?3)\b/g,
  PS2: /\b(?:ps ?2|play ?station ?2)\b/g,
  PS1: /\b(?:ps ?1|psx|play ?station ?1)\b/g,
  'Xbox 360': /\bxbox ?360\b/g,
  'Xbox One': /\bxbox ?one\b/g,
  Switch: /\b(?:nintendo )?switch(?: ?2)?\b/g,
  Wii: /\b(?:nintendo )?wii(?: ?u)?\b/g,
  '3DS': /\b(?:nintendo )?3ds\b/g,
}));

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function loadGames() {
  const [, ...lines] = (await readFile(input, 'utf8')).trim().split(/\r?\n/);
  const games = lines.map(line => {
    const [title, platform, edition] = line.split('\t');
    if (!title || !platforms.has(platform) || !['standard', 'named'].includes(edition)) {
      throw new Error('Linha inválida na lista de jogos.');
    }
    return { title, platform, edition };
  });
  if (games.length !== 500 || new Set(games.map(game => normalize(game.title))).size !== 500) {
    throw new Error('A lista precisa conter 500 títulos distintos.');
  }
  const groups = Object.values(Object.groupBy(games, game => game.platform));
  if (groups.length !== 10 || groups.some(group => group.length !== 50)) {
    throw new Error('A amostra precisa conter 50 jogos por plataforma.');
  }
  // Intercala os consoles para que o primeiro lote também exercite plataformas diferentes.
  return groups[0].flatMap((_, index) => groups.map(group => group[index]));
}

export function summarize(game, listings) {
  const title = normalize(game.title);
  const bySeller = new Map();
  const seen = new Set();
  for (const item of listings) {
    const name = normalize(item.title);
    const dimensions = normalize((item.attributes ?? [])
      .filter(attribute => /console|plataforma|platform|formato|format/i.test(attribute.name ?? ''))
      .map(attribute => attribute.value_name).join(' '));
    const label = name + ' ' + dimensions;
    if (item.condition !== 'used' || item.currency_id !== 'BRL' ||
        !Number.isFinite(item.price) || item.price <= 0 ||
        !/^MLB\d+$/.test(item.id ?? '') || !Number.isSafeInteger(item.seller?.id) ||
        seen.has(item.id)) continue;
    // Títulos ambíguos, consoles misturados e mídia sem confirmação ficam fora do subtotal.
    if (!(' ' + name + ' ').includes(' ' + title + ' ') ||
        !/\b(?:fisic[ao]|cartucho|disco|blu ray|dvd)\b/.test(label) ||
        /\b(?:digital|codigo|conta|lote|kit|replica|repro|reproducao|paralelo|lacrado|recondicionado|so o disco|somente disco|apenas disco|sem caixa|sem capa|capa avulsa|caixa vazia|so a caixa)\b/.test(name)) continue;
    const matched = [...platforms].filter(([, pattern]) => [...label.matchAll(pattern)].length);
    if (matched.length !== 1 || matched[0][0] !== game.platform ||
        /\b(?:switch ?2|wii ?u)\b/.test(label)) continue;
    // Só aceita complementos usuais de anúncio; um subtítulo desconhecido pode ser outro jogo.
    const remaining = name.replace(title, '').replace(platforms.get(game.platform), '')
      .replace(/\b(?:jogos?|games?|midia|fisic[ao]|original|usad[oa]|seminov[oa]|cartucho|cd|dvd|disco|blu ray|edicao padrao|standard edition|standard|completo|completa|portugues|pt br|ptbr|legendado|dublado|com caixa|com manual|otimo estado|bom estado|console|sony|nintendo|microsoft|para|de|do|da|em)\b/g, '').trim();
    if (remaining) continue;
    seen.add(item.id);
    if (bySeller.has(item.seller.id)) continue;
    bySeller.set(item.seller.id, { id: item.id, title: item.title, cents: Math.round(item.price * 100) });
  }
  const comparable = [...bySeller.values()].sort((a, b) => a.cents - b.cents);
  const count = comparable.length;
  return {
    comparable,
    medianCents: count < 3 ? null : Math.round((
      comparable[Math.floor((count - 1) / 2)].cents + comparable[Math.floor(count / 2)].cents
    ) / 2),
  };
}

export function searchClient(token, { fetchImpl = fetch, pause = sleep, interval = 1000 } = {}) {
  return async game => {
    const url = new URL('/sites/MLB/search', api);
    url.search = new URLSearchParams({
      q: game.title + ' ' + game.platform + ' físico',
      condition: 'used', limit: '50',
    }).toString();
    // O ritmo vale para cada chamada, inclusive tentativas de recuperação.
    for (let attempt = 0; attempt < 4; attempt++) {
      await pause(interval);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: 'Bearer ' + token },
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (attempt === 3) throw new Error('Falha de rede ao consultar o Mercado Livre.');
      }
      if (response?.ok) {
        const body = await response.json();
        if (!Array.isArray(body?.results)) throw new Error('Resposta da busca sem lista de anúncios.');
        return body.results;
      }
      const status = response?.status;
      if ((status && status !== 429 && status < 500) || attempt === 3) {
        throw new Error('Busca Mercado Livre indisponível (HTTP ' + (status ?? 'sem resposta') + ').');
      }
      const retryAfter = response?.headers.get('retry-after');
      const seconds = Number(retryAfter);
      const instructed = !retryAfter ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (instructed > 60_000) throw new Error('Mercado Livre pediu uma pausa maior que 60 s. Retome após o prazo indicado.');
      await pause(Math.max(instructed || 0, 2000 * 2 ** attempt + Math.random() * 500));
    }
  };
}

async function getToken() {
  if (process.env.MELI_ACCESS_TOKEN) return process.env.MELI_ACCESS_TOKEN;
  const { MONGODB_URI, MELI_PILOT_OWNER_ID, MELI_CLIENT_ID, MELI_TOKEN_ENCRYPTION_KEY } = process.env;
  if (!MONGODB_URI || !/^[a-f0-9]{24}$/i.test(MELI_PILOT_OWNER_ID ?? '') || !MELI_CLIENT_ID ||
      !/^[a-f0-9]{64}$/i.test(MELI_TOKEN_ENCRYPTION_KEY ?? '')) {
    throw new Error('Configure o acesso à concessão OAuth no ambiente do servidor.');
  }
  const connection = mongoose.createConnection(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  let grant;
  try {
    await connection.asPromise();
    grant = await connection.collection('mercado_livre_oauth_grants').findOne({
      owner: MELI_PILOT_OWNER_ID.toLowerCase(), clientId: MELI_CLIENT_ID,
    });
  } catch {
    throw new Error('Banco da autorização OAuth indisponível.');
  } finally {
    await connection.close();
  }
  if (!grant || !(grant.expiresAt > new Date())) throw new Error('Autorize novamente a conta do piloto antes de consultar.');
  try {
    const { iv, tag, data } = grant.credentials;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(MELI_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(grant.owner + ':' + grant.clientId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const { accessToken } = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]));
    if (!accessToken || typeof accessToken !== 'string') throw new Error();
    return accessToken;
  } catch {
    throw new Error('Não foi possível ler a credencial cifrada. Confira a chave de cifragem.');
  }
}

export async function runPilot(games, { search, output, batchSize, limit, log = console.log }) {
  const signature = createHash('sha256').update(JSON.stringify(games)).digest('hex');
  let report = { signature, sampleSize: games.length, rows: [] };
  try {
    report = JSON.parse(await readFile(output, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (report.signature !== signature || !Array.isArray(report.rows) || report.rows.length > games.length) {
    throw new Error('O arquivo de saída pertence a outra amostra. Informe outro caminho.');
  }
  const end = Math.min(limit, games.length);
  while (report.rows.length < end) {
    const batchEnd = Math.min(report.rows.length + batchSize, end);
    while (report.rows.length < batchEnd) {
      const game = games[report.rows.length];
      const listings = await search(game);
      report.rows.push({ ...game, checkedAt: new Date().toISOString(), inspected: listings.length, ...summarize(game, listings) });
      const priced = report.rows.filter(row => row.medianCents !== null);
      report.totals = {
        checked: report.rows.length,
        withComparable: report.rows.filter(row => row.comparable.length).length,
        priced: priced.length,
        subtotalCents: priced.reduce((sum, row) => sum + row.medianCents, 0),
      };
      // Salva a cada jogo para retomar no primeiro que ainda não recebeu resposta completa.
      const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        await rename(temporary, output);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    log(`Lote concluído: ${report.rows.length}/${end} jogos consultados.`);
  }
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    limit: { type: 'string', default: '10' },
    'batch-size': { type: 'string', default: '25' },
    'interval-ms': { type: 'string', default: '1000' },
    output: { type: 'string', default: 'mercado-livre-price-pilot.local.json' },
    'list-only': { type: 'boolean' },
  } });
  const games = await loadGames();
  if (values['list-only']) {
    console.log(JSON.stringify({ total: games.length, byPlatform: Object.groupBy(games, game => game.platform) },
      (key, value) => platforms.has(key) ? value.length : value, 2));
    return;
  }
  const limit = Number(values.limit);
  const batchSize = Number(values['batch-size']);
  const interval = Number(values['interval-ms']);
  if (!Number.isInteger(limit) || limit < 1 || limit > games.length ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50 ||
      !Number.isInteger(interval) || interval < 1000 || interval > 60_000) {
    throw new Error('Use --limit de 1 a 500, --batch-size de 1 a 50 e --interval-ms de 1000 a 60000.');
  }
  const search = searchClient(await getToken(), { interval });
  const report = await runPilot(games, { search, output: resolve(values.output), batchSize, limit });
  console.log(JSON.stringify(report.totals));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
