#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
domain=${1:?}; client_port=${2:?}; api_port=${3:?}; kind=${4:?}; release_id=${5:?}
[[ "$domain" == nextplay.imjsistemas.com.br && "$client_port" == 3110 && "$api_port" == 3111 ]] || exit 1
[[ "$kind" == client || "$kind" == server ]] || exit 1
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 1
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target=/etc/nginx/conf.d/nextplay.conf
[[ ! -L "$target" ]] || exit 1
nginx -t
systemctl is-active --quiet nginx
inventory=$(mktemp)
backup=$(mktemp -d /var/backups/nextplay-nginx.XXXXXXXX)
trap 'rm -f -- "$inventory"' EXIT
nginx -T > "$inventory" 2>/dev/null
grep -Eq '^[[:space:]]*include[[:space:]]+/etc/nginx/conf\.d/\*\.conf;' "$inventory" || { echo '[nextplay] Nginx não inclui conf.d/*.conf.' >&2; exit 1; }
# Evita sobrescrever um domínio configurado manualmente ou por outro aplicativo.
if awk -v target="$target" -v domain="$domain" '
  /^# configuration file / {file=$4; sub(/:$/,"",file)}
  /^[[:space:]]*server_name[[:space:]]/ {for(i=2;i<=NF;i++){item=$i;gsub(/;/,"",item);if(item==domain&&file!=target)found=1}}
  END {exit !found}
' "$inventory"; then echo '[nextplay] Domínio já configurado fora de nextplay.conf. Revise antes de publicar.' >&2; exit 1; fi
had_config=false
if [[ -f "$target" ]]; then cp -p "$target" "$backup/previous.conf"; had_config=true; fi
rollback() {
  trap - ERR TERM INT
  if [[ "$had_config" == true ]]; then cp -p "$backup/previous.conf" "$target"; else rm -f "$target"; fi
  if nginx -t; then systemctl reload nginx || true; fi
  echo '[nextplay] Falha no roteamento; configuração anterior do Nginx restaurada.' >&2
  exit 1
}
trap rollback ERR TERM INT
# O worker www-data precisa ler os desafios HTTP do Certbot.
install -d -m 755 /var/www/nextplay-acme
scheme=http
if [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" && -f "/etc/letsencrypt/live/$domain/privkey.pem" ]]; then
  install -m 644 "$source_dir/nginx-https.conf" "$target"; scheme=https
else
  install -m 644 "$source_dir/nginx-http.conf" "$target"
  echo '[nextplay] HTTP preparado. Falta emitir o certificado após configurar DNS; login exige HTTPS.'
fi
nginx -t
systemctl reload nginx
if [[ "$kind" == client ]]; then endpoint=/deploy-meta.json; else endpoint=/api/health; fi
# --resolve permite validar o host localmente, mesmo antes da propagação DNS.
if [[ "$scheme" == https ]]; then destination="https://$domain$endpoint"; resolution="$domain:443:127.0.0.1";
else destination="http://$domain$endpoint"; resolution="$domain:80:127.0.0.1"; fi
# O reload é assíncrono: os workers antigos podem atender a primeira requisição.
# Aguarda a nova configuração e ignora proxies de ambiente na consulta local.
verified=false
for attempt in {1..15}; do
  if curl --noproxy '*' --fail --silent --max-time 4 --resolve "$resolution" "$destination" | grep -Fq "\"releaseId\":\"$release_id\""; then
    verified=true; break
  fi
  sleep 1
done
[[ "$verified" == true ]]
trap - ERR TERM INT
echo '[nextplay] Roteamento da release validado no Nginx.'
