import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(`[nextplay] Código remoto: ${Number.isInteger(result.code) ? result.code : 'indisponível'}`);
console.log(`[nextplay] Tamanho da saída: stdout=${String(result.stdout ?? '').length}, stderr=${String(result.stderr ?? '').length}`);
// Remove os valores conhecidos do ambiente antes de publicar erros de sistema; nunca publica stdout bruto ou logs PM2.
let secrets = [];
try { secrets = Object.values(parseEnv(process.env.APP_ENV_FILE || '')).filter(value => value.length >= 3); } catch {}
secrets.push(...Object.entries(process.env).filter(([key]) => /SECRET|TOKEN|PASSWORD|ACCESS_KEY/.test(key)).map(([, value]) => value).filter(Boolean));
const redact = line => secrets.sort((a, b) => b.length - a.length).reduce((text, value) => text.replaceAll(value, '[oculto]'), line);
for (const line of `${result.stdout || ''}\n${result.stderr || ''}`.split(/\r?\n/)) {
  if (line.includes('[nextplay]')) console.log(redact(line.slice(line.indexOf('[nextplay]'))));
}
for (const line of String(result.stderr || '').split(/\r?\n/).slice(0, 12)) {
  if (!line.trim() || line.includes('[nextplay]') || /[=]|password|secret|token|mongodb|smtp|https?:\/\//i.test(line)) continue;
  console.log(`[nextplay] Erro de sistema remoto: ${redact(line).slice(0, 500)}`);
}
