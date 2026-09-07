import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRequestGuard } from './auth.guard';
import { User, UserSchema, Session, SessionSchema, AuthAttempt, AuthAttemptSchema } from './auth.schemas';

@Module({
  imports: [MongooseModule.forFeature([
    { name: User.name, schema: UserSchema }, { name: Session.name, schema: SessionSchema }, { name: AuthAttempt.name, schema: AuthAttemptSchema },
  ])],
  controllers: [AuthController], providers: [AuthService, AuthRequestGuard], exports: [AuthService],
})
export class AuthModule {}
