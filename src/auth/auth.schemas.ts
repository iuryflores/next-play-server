import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongoSchema } from 'mongoose';

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) email!: string;
  @Prop({ required: true, select: false }) passwordHash!: string;
}
export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

@Schema({ collection: 'sessions', timestamps: true })
export class Session {
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
