import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const settings = JSON.parse(readFileSync(new URL('./deploy-settings.json', import.meta.url)));
export function validateInputs({ releaseId, bucket, region, user, name, checksum }) {
  if (!/^[a-f0-9]{40}-\d+-\d+$/.test(releaseId ?? '') ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
      !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region ?? '') ||
      !/^[a-z_][a-z0-9_-]*$/.test(user ?? '') || user === 'root' ||
      !/^nextplay-[a-z0-9_-]+$/.test(name ?? '') ||
      !/^[a-f0-9]{64}$/.test(checksum ?? '')) throw new Error('Configuração SSM inválida.');
}
export function ssmParameters(input) {
  validateInputs(input);
  const { releaseId, bucket, region, user, name, checksum } = input;
  const staging = `/tmp/nextplay-${settings.kind}-${releaseId}`;
  // Só caminhos e identificadores entram no histórico SSM. O .env viaja no
  // pacote temporário privado e criptografado, nunca na linha de comando.
  const script = `set -Eeuo pipefail
umask 077
exec 9>/var/lock/nextplay-deploy.lock
flock -w 600 9
staging='${staging}'
mkdir -- "$staging"
trap 'rm -rf -- "$staging"' EXIT
aws s3 cp 's3://${bucket}/nextplay/${settings.kind}/deployments/${releaseId}/deploy.tar.gz' "$staging/deploy.tar.gz" --region '${region}' --only-show-errors
echo '${checksum}  '"$staging/deploy.tar.gz" | sha256sum --check --status
tar -tzf "$staging/deploy.tar.gz" | awk '/^\\// || /(^|\\/)\\.\\.(\\/|$)/ || $0 !~ /^(application.tar.gz|app.env|deploy-ec2.sh|deploy-config.mjs|deploy-settings.json|configure-nginx.sh|nginx-http.conf|nginx-https.conf|serve-frontend.mjs)$/ {bad=1} END {exit bad}'
tar -tvzf "$staging/deploy.tar.gz" | awk '$1 ~ /^[hl]/ {bad=1} END {exit bad}'
tar -xzf "$staging/deploy.tar.gz" -C "$staging" --no-same-owner
chown -R '${user}' "$staging"
runuser -l '${user}' -c "bash '$staging/deploy-ec2.sh' '${releaseId}' '$staging' '${name}'"
bash "$staging/configure-nginx.sh" '${settings.domain}' '${settings.clientPort}' '${settings.apiPort}' '${settings.kind}' '${releaseId}'
`;
  return { commands: [`bash -c '${script.replaceAll("'", "'\\''")}'`], executionTimeout: ['900'] };
}
export function previousConfig(processes, name, appRoot) {
  const matches = processes.filter(p => p.name === name);
  if (matches.length > 1 || matches.some(p => p.pm2_env.exec_mode !== 'fork_mode' || !p.pm2_env.pm_cwd?.startsWith(`${appRoot}/releases/`))) throw new Error('Processo PM2 fora do projeto ou em modo incompatível.');
  if (!matches.length) return { apps: [] };
  const old = matches[0].pm2_env;
  return { apps: [{ name, script: old.pm_exec_path, cwd: old.pm_cwd, interpreter: old.exec_interpreter,
    node_args: old.node_args, args: old.args, env: old.env ?? {}, exec_mode: 'fork', instances: 1,
    watch: false, autorestart: true, restart_delay: 2000 }] };
}
export function assertPortOwner(listeners, processes, name) {
  if (!listeners.trim()) return;
  const process = processes.find(p => p.name === name);
  const pids = [...listeners.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
  if (!process || !pids.length || pids.some(pid => pid !== process.pid)) throw new Error('Porta ocupada por outro serviço; deploy interrompido.');
}
export function releaseConfig(release, name, releaseId) {
  const environment = { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(settings.port), DEPLOY_RELEASE_ID: releaseId };
  if (settings.kind === 'server') {
    const env = parseEnv(readFileSync(`${release}/.env`, 'utf8'));
    // Recusa um .env de desenvolvimento antes de parar a versão em execução.
    if (env.NODE_ENV !== 'production' || env.CLIENT_ORIGIN !== `https://${settings.domain}` ||
        !env.MONGODB_URI || (env.PORT && env.PORT !== String(settings.port)) ||
        (env.HOST && env.HOST !== '127.0.0.1')) throw new Error('APP_ENV_FILE não corresponde ao ambiente de produção documentado.');
  }
  return { apps: [{ name, script: `${release}/${settings.kind === 'server' ? 'dist/main.js' : 'serve-frontend.mjs'}`,
    cwd: release, interpreter: process.execPath, exec_mode: 'fork', instances: 1,
    // O .env é lido pelo Node. Segredos não são duplicados no ecosystem.json.
    node_args: settings.kind === 'server' ? [`--env-file=${release}/.env`] : [],
    env: environment, watch: false, autorestart: true, restart_delay: 2000 }] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, a, b, c, d, e] = process.argv.slice(2);
  try {
    if (mode === 'ssm') writeFileSync(a, JSON.stringify(ssmParameters({ releaseId: process.env.RELEASE_ID, bucket: process.env.DEPLOY_BUCKET, region: process.env.AWS_REGION, user: process.env.EC2_USER, name: process.env.PM2_APP_NAME, checksum: process.env.DEPLOY_CHECKSUM })), { mode: 0o600 });
    else if (mode === 'create') writeFileSync(c, JSON.stringify(releaseConfig(a, b, d)), { mode: 0o600 });
    else if (mode === 'snapshot') {
      const processes = JSON.parse(readFileSync(a, 'utf8'));
      const config = previousConfig(processes, b, e);
      assertPortOwner(readFileSync(d, 'utf8'), processes, b);
      writeFileSync(c, JSON.stringify(config), { mode: 0o600 });
      console.log(config.apps.length ? 'yes' : 'no');
    } else if (mode === 'check') {
      const processes = JSON.parse(readFileSync(0, 'utf8')).filter(p => p.name === a);
      if (processes.length !== 1 || processes[0].pm2_env.status !== 'online' || processes[0].pm2_env.pm_cwd !== b) process.exitCode = 1;
    } else if (mode === 'health') {
      const body = JSON.parse(readFileSync(0, 'utf8'));
      if (body.releaseId !== a) process.exitCode = 1;
    } else throw new Error('Modo inválido.');
  } catch {
    // Snapshots e configuração contêm dados privados; nunca imprimir a causa bruta.
    console.error('[nextplay] Falha na configuração, porta ou validação do deploy. Confira a documentação.'); process.exitCode = 1;
  }
}
