import { ApiTags } from '@nestjs/swagger';
import { RottenTomatoesModule } from './rotten-tomatoes/rotten-tomatoes.module';
import { FriendsModule } from './friends/friends.module';
import { EpisodesModule } from './episodes/episodes.module';
import { LibraryModule } from './library/library.module';
import { CatalogModule } from './catalog/catalog.module';
import { Controller, Get, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { getConfig } from './config';

@ApiTags('health')
@Controller('health')
class HealthController {
  // O identificador comprova que o HTTP responde pela release recém-ativada.
  @Get() health() { return { status: 'ok', releaseId: process.env.DEPLOY_RELEASE_ID || null }; }
}

@Module({
  imports: [MongooseModule.forRootAsync({ useFactory: () => ({
    uri: getConfig().mongoUri, serverSelectionTimeoutMS: 5000, retryAttempts: 0,
    onConnectionCreate: (connection) => {
      const environment = getConfig().mongoUri.startsWith('mongodb+srv://') ? 'Atlas' : 'MongoDB';
      connection.on('connected', () => console.info(`[MongoDB] Conectado (${environment}) · banco: ${connection.name}`));
      connection.on('disconnected', () => console.warn('[MongoDB] Conexão interrompida. Aguardando reconexão.'));
      connection.on('reconnected', () => console.info('[MongoDB] Conexão restabelecida.'));
      connection.on('error', (error: Error & { code?: string | number }) => console.error(`[MongoDB] Erro de conexão: ${error.name}${error.code ? ` (${error.code})` : ''}`));
      return connection;
    },
  }) }), AuthModule, LibraryModule, CatalogModule, EpisodesModule, FriendsModule, RottenTomatoesModule],
  controllers: [HealthController],
})
export class AppModule {}
