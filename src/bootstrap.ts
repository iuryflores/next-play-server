import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn'], abortOnError: false });
  app.setGlobalPrefix('api');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const started = Date.now();
    response.on('finish', () => {
      const elapsed = Date.now() - started;
      if (response.statusCode >= 400 || elapsed >= 3000) {
        // Route templates omit user IDs; never log cookies, bodies or query strings.
        const route = request.route?.path || '(rota não encontrada)';
        console.warn(`[HTTP] ${request.method} ${route} → ${response.statusCode} (${elapsed} ms)`);
      }
    });
    next();
  });
  app.use(helmet());
  app.use(cookieParser());
  app.use('/api/auth/profile', express.json({ limit: '110kb' }));
  // Fotos de objetos são comprimidas pelo cliente; os demais endpoints mantêm o limite pequeno.
  app.use('/api/collector/copies', express.json({ limit: '650kb' }));
  app.use('/api/game-imports/file', express.json({ limit: '100kb' }));
  app.use(express.json({ limit: '8kb' }));
  app.use((_request: Request, response: Response, next: NextFunction) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  setupSwagger(app);
  await app.init();
  return app;
}
