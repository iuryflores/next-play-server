import { HubModule } from './community/hub.module';
import { InsightsModule } from './social/insights.module';
import { SocialModule } from './social/social.module';
import { ListsModule } from './social/lists.module';
import { ChallengesModule } from './challenges/challenges.module';
import { ApiTags } from '@nestjs/swagger';
import { RottenTomatoesModule } from './rotten-tomatoes/rotten-tomatoes.module';
import { FriendsModule } from './friends/friends.module';
import { EpisodesModule } from './episodes/episodes.module';
import { LibraryModule } from './library/library.module';
import { CatalogModule } from './catalog/catalog.module';
import { Controller, Get, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { CollectorModule } from './collector/collector.module';
import { getConfig } from './config';
import { AchievementsModule } from './achievements/achievements.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ProgressionModule } from './progression/progression.module';
import { GameSessionsModule } from './game-sessions/game-sessions.module';

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
  }) }), AuthModule, LibraryModule, CatalogModule, EpisodesModule, FriendsModule, RottenTomatoesModule, CollectorModule, AchievementsModule, NotificationsModule, ProgressionModule, GameSessionsModule, ChallengesModule, SocialModule, ListsModule, InsightsModule, HubModule],
  controllers: [HealthController],
})
export class AppModule {}
