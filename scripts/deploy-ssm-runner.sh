#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
for key in AWS_REGION EC2_INSTANCE_ID DEPLOY_BUCKET EC2_USER PM2_APP_NAME RUNNER_TEMP GITHUB_WORKSPACE GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT; do
  [[ -n "${!key:-}" ]] || { printf '[nextplay] Configuração ausente: %s\n' "$key" >&2; exit 1; }
done
[[ "$EC2_INSTANCE_ID" =~ ^i-([a-f0-9]{8}|[a-f0-9]{17})$ ]] || exit 1
kind=$(node -p 'JSON.parse(require("fs").readFileSync("scripts/deploy-settings.json")).kind')
export RELEASE_ID="$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
task_dir=$(mktemp -d "$RUNNER_TEMP/nextplay-ssm.XXXXXXXX")
uri="s3://$DEPLOY_BUCKET/nextplay/$kind/deployments/$RELEASE_ID/deploy.tar.gz"
finished=false
cleanup() {
  # Em caso de estado incerto, o lifecycle do bucket limpa o pacote posteriormente.
  if [[ "$finished" == true ]]; then aws s3 rm "$uri" --region "$AWS_REGION" --only-show-errors || true; fi
  rm -rf -- "$task_dir"
}
trap cleanup EXIT
cp "$RUNNER_TEMP/nextplay-artifact/application.tar.gz" "$task_dir/"
for file in deploy-ec2.sh deploy-config.mjs deploy-settings.json configure-nginx.sh serve-frontend.mjs; do cp "$GITHUB_WORKSPACE/scripts/$file" "$task_dir/"; done
cp "$GITHUB_WORKSPACE/deploy/nginx/"*.conf "$task_dir/"
if [[ "$kind" == server ]]; then
  [[ -n "${APP_ENV_FILE:-}" ]] || { echo '[nextplay] APP_ENV_FILE ausente.' >&2; exit 1; }
  printf '%s\n' "$APP_ENV_FILE" > "$task_dir/app.env"
fi
# O .env não entra no artifact do GitHub: só neste pacote privado SSE-S3.
files=(application.tar.gz deploy-ec2.sh deploy-config.mjs deploy-settings.json configure-nginx.sh serve-frontend.mjs nginx-http.conf nginx-https.conf)
if [[ "$kind" == server ]]; then files+=(app.env); fi
tar -czf "$task_dir/deploy.tar.gz" -C "$task_dir" "${files[@]}"
export DEPLOY_CHECKSUM=$(sha256sum "$task_dir/deploy.tar.gz" | cut -d ' ' -f 1)
node scripts/deploy-config.mjs ssm "$task_dir/parameters.json"
aws s3 cp "$task_dir/deploy.tar.gz" "$uri" --region "$AWS_REGION" --sse AES256 --only-show-errors
command_id=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$EC2_INSTANCE_ID" --document-name AWS-RunShellScript --parameters "file://$task_dir/parameters.json" --timeout-seconds 60 --comment "NextPlay $kind $RELEASE_ID" --query Command.CommandId --output text)
printf '[nextplay] Comando SSM: %s\n' "$command_id"
for attempt in {1..210}; do
  status=$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$EC2_INSTANCE_ID" --query Status --output text 2>"$task_dir/error") || {
    if grep -q InvocationDoesNotExist "$task_dir/error"; then status=Pending; else echo '[nextplay] Não foi possível acompanhar o SSM. Confira o console AWS antes de repetir.' >&2; exit 1; fi
  }
  case "$status" in
    Success) finished=true; echo '[nextplay] Deploy validado: PM2 e Nginx.'; exit 0 ;;
    Failed|Cancelled|TimedOut)
      finished=true
      echo '[nextplay] Deploy falhou. Diagnóstico restrito à aplicação:' >&2
      aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$EC2_INSTANCE_ID" --query '{stdout:StandardOutputContent,stderr:StandardErrorContent}' --output json > "$task_dir/result.json"
      # Só mensagens emitidas por nossos scripts; nunca publicar logs brutos/pm2_env.
      node -e 'const d=require(process.argv[1]);for(const l of `${d.stdout}\n${d.stderr}`.split(/\r?\n/))if(l.startsWith("[nextplay]"))console.log(l)' "$task_dir/result.json"
      exit 1 ;;
    Pending|InProgress|Delayed|Cancelling) sleep 5 ;;
    *) echo '[nextplay] Status SSM inesperado.' >&2; exit 1 ;;
  esac
done
echo '[nextplay] Tempo esgotado; o comando pode continuar na EC2. Consulte o SSM.' >&2
exit 1
