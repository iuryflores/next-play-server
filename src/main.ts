import { createApp } from './bootstrap';
import { getConfig } from './config';

async function bootstrap() {
  const config = getConfig();
  const app = await createApp();
  await app.listen(config.port, config.host);
  console.info(`NextPlay API (NestJS): http://${config.host}:${config.port}/api`);
}
void bootstrap().catch(() => { console.error('Não foi possível iniciar a API. Confira a configuração e a conexão com o MongoDB.'); process.exitCode = 1; });
