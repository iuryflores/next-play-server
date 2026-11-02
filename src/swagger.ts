import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getConfig } from './config';

/** Mantém a documentação próxima das rotas e dos DTOs, sem duplicar a API. */
export function setupSwagger(app: INestApplication) {
  // A documentação fica disponível em desenvolvimento; produção exige opt-in.
  if (process.env.SWAGGER_ENABLED === 'false' || (getConfig().production && process.env.SWAGGER_ENABLED !== 'true')) return;
  const config = new DocumentBuilder()
    .setTitle('NextPlay API')
    .setDescription('Acompanhamento pessoal, acervo de cópias possuídas, episódios, conquistas e comunidade. O acervo é independente do consumo. Para testar pelo navegador, abra /api/docs na origem do frontend, execute POST /api/auth/login e use o cookie HttpOnly recebido automaticamente. Mutações exigem Origin igual a CLIENT_ORIGIN; não é necessário JWT nem copiar cookies para Authorize.')
    .setVersion('0.1.0')
    .addCookieAuth(getConfig().cookieName, { type: 'apiKey', in: 'cookie' }, 'session')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: '/api/docs-json',
    swaggerOptions: { withCredentials: true, persistAuthorization: false, displayRequestDuration: true, docExpansion: 'none' },
  });
}
