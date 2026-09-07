import { Controller, Get, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { getConfig } from './config';

@Controller('health')
class HealthController { @Get() health() { return { status: 'ok' }; } }

@Module({
  imports: [MongooseModule.forRootAsync({ useFactory: () => ({ uri: getConfig().mongoUri, serverSelectionTimeoutMS: 5000, retryAttempts: 0 }) }), AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
