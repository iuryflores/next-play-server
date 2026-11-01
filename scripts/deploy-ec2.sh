#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release_id=${1:?Release ausente}
staging=${2:?Staging ausente}
name=${3:?Nome PM2 ausente}
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ && "$name" =~ ^nextplay-[a-z0-9_-]+$ ]] || exit 1
[[ $(id -u) != 0 ]] || exit 1
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then source "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==22||b<13)process.exit(1)' || { echo '[nextplay] Instale Node 22.13+ da linha 22.' >&2; exit 1; }
command -v pm2 >/dev/null
kind=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).kind' "$staging/deploy-settings.json")
[[ "$kind" == client || "$kind" == server ]] || exit 1
[[ "$staging" == "/tmp/nextplay-$kind-$release_id" ]] || exit 1
port=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).port' "$staging/deploy-settings.json")
app_root="$HOME/nextplay/nextplay-$kind"
release="$app_root/releases/$release_id"
helper="$staging/deploy-config.mjs"
mkdir -p "$app_root/releases"
previous=$(readlink -f "$app_root/current" || true)
if [[ -e "$app_root/current" || -L "$app_root/current" ]]; then
  [[ -L "$app_root/current" && "$previous" == "$app_root/releases/"* && -d "$previous" ]] || exit 1
fi
pm2 ping >/dev/null
pm2 jlist > "$staging/processes.json"
ss -H -ltnp "sport = :$port" > "$staging/listeners.txt"
had_process=$(node "$helper" snapshot "$staging/processes.json" "$name" "$staging/previous.config.json" "$staging/listeners.txt" "$app_root")
mkdir -- "$release"
# A lista explícita exclui fontes, ferramentas de diagnóstico, backups e .env locais.
tar -tzf "$staging/application.tar.gz" | awk '
  /^\// || /(^|\/)\.\.(\/|$)/ || $0 !~ /^(dist(\/|$)|package.json$|package-lock.json$)/ {bad=1}
  END {exit bad}
'
tar -tvzf "$staging/application.tar.gz" | awk '$1 ~ /^[hl]/ {bad=1} END {exit bad}'
tar -xzf "$staging/application.tar.gz" -C "$release" --no-same-owner
if [[ "$kind" == server ]]; then
  install -m 600 "$staging/app.env" "$release/.env"
  (cd "$release" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) || { echo '[nextplay] Falha ao instalar dependências de produção.' >&2; exit 1; }
else
  install -m 600 "$staging/serve-frontend.mjs" "$release/serve-frontend.mjs"
  # Reexecutar só o job de deploy aumenta run_attempt sem recompilar o artifact.
  # Atualiza apenas o marcador público, mantendo o build validado intacto.
  node -e 'const fs=require("fs"),p=process.argv[1],m=JSON.parse(fs.readFileSync(p));if(!m.version)process.exit(1);m.releaseId=process.argv[2];fs.writeFileSync(p,JSON.stringify(m))' "$release/dist/deploy-meta.json" "$release_id"
  # Preserva chunks antigos para abas abertas antes da troca da versão.
  mkdir -p "$app_root/shared/assets"
  if [[ -d "$release/dist/assets" ]]; then
    cp -a -n "$release/dist/assets/." "$app_root/shared/assets/"
    [[ "$release/dist/assets" == "$app_root/releases/$release_id/dist/assets" ]] || exit 1
    rm -rf -- "$release/dist/assets"
    ln -s "$app_root/shared/assets" "$release/dist/assets"
  fi
fi
node "$helper" create "$release" "$name" "$release/ecosystem.config.json" "$release_id"
activate() { rm -f -- "$app_root/.current-$release_id"; ln -s "$1" "$app_root/.current-$release_id"; mv -Tf "$app_root/.current-$release_id" "$app_root/current"; }
rollback() {
  trap - ERR TERM INT
  echo '[nextplay] Falha na ativação; restaurando a versão anterior deste aplicativo.' >&2
  pm2 delete "$name" >/dev/null 2>&1 || true
  if [[ -d "$previous" && "$previous" == "$app_root/releases/"* ]]; then activate "$previous"; else rm -f "$app_root/current"; fi
  if [[ "$had_process" == yes ]]; then pm2 start "$staging/previous.config.json" --only "$name" >/dev/null 2>&1 && pm2 save >/dev/null 2>&1 || echo '[nextplay] Rollback PM2 precisa de intervenção.' >&2; fi
  exit 1
}
trap rollback ERR TERM INT
activate "$release"
if [[ "$had_process" == yes ]]; then pm2 delete "$name" >/dev/null; fi
pm2 start "$release/ecosystem.config.json" --only "$name" >/dev/null 2>&1
if [[ "$kind" == server ]]; then endpoint=/api/health; else endpoint=/deploy-meta.json; fi
for attempt in {1..30}; do
  if pm2 jlist | node "$helper" check "$name" "$release" && curl --fail --silent --max-time 4 "http://127.0.0.1:$port$endpoint" | node "$helper" health "$release_id"; then
    pm2 save >/dev/null
    trap - ERR TERM INT
    printf '[nextplay] %s: release %s validada na porta %s.\n' "$kind" "$release_id" "$port"
    exit 0
  fi
  sleep 2
done
echo '[nextplay] Aplicação não respondeu com a release esperada.' >&2
false
