import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongoSchema } from 'mongoose';

@Schema({ timestamps: true, collection: 'users', optimisticConcurrency: true })
export class User {
  // Só contas novas marcadas explicitamente exigem confirmação; contas antigas mantêm o acesso.
  @Prop() verificationRequired?: boolean;
  @Prop() emailVerifiedAt?: Date;
  @Prop({ select: false }) verificationTokenHash?: string;
  @Prop({ select: false }) verificationExpiresAt?: Date;
  @Prop({ select: false }) verificationRequestedAt?: Date;
  @Prop({ select: false }) resetTokenHash?: string;
  @Prop({ select: false }) resetExpiresAt?: Date;
  @Prop({ select: false }) resetRequestedAt?: Date;
  @Prop() passwordChangedAt?: Date;
  @Prop({ default: '', maxlength: 40 }) displayName!: string;
  @Prop({ default: '', maxlength: 100000 }) avatar!: string;
  @Prop({ default: '' }) avatarKey!: string;
  @Prop({ default: 'pt-BR', enum: ['pt-BR', 'en-US', 'es-ES'] }) language!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) email!: string;
  @Prop({ required: true, select: false }) passwordHash!: string;
}
export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

@Schema({ collection: 'sessions', timestamps: true })
export class Session {
  createdAt!: Date;
  @Prop({ required: true, unique: true }) tokenHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, ref: User.name, required: true, index: true }) userId!: Types.ObjectId;
  @Prop({ required: true }) expiresAt!: Date;
}
export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

@Schema({ collection: 'auth_attempts', versionKey: false })
export class AuthAttempt {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true }) count!: number;
  @Prop({ required: true }) expiresAt!: Date;
}
export const AuthAttemptSchema = SchemaFactory.createForClass(AuthAttempt);
AuthAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
