import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRequestGuard } from './auth.guard';
import { AvatarStorage } from './avatar-storage';
import { EmailConfirmation } from './email-confirmation';
import { PasswordRecovery, RecoveryMailer } from './password-recovery';
import { User, UserSchema, Session, SessionSchema, AuthAttempt, AuthAttemptSchema } from './auth.schemas';

@Module({
  imports: [MongooseModule.forFeature([
    { name: User.name, schema: UserSchema }, { name: Session.name, schema: SessionSchema }, { name: AuthAttempt.name, schema: AuthAttemptSchema },
  ])],
  controllers: [AuthController], providers: [AuthService, AuthRequestGuard, AvatarStorage, PasswordRecovery, RecoveryMailer, EmailConfirmation], exports: [AuthService, AvatarStorage],
})
export class AuthModule {}
