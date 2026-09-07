import { ConflictException, ForbiddenException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, Session, AuthAttempt, type UserDocument } from './auth.schemas';
import { hashPassword, hashToken, randomToken, verifyPassword } from './password';
import { getConfig } from '../config';
import type { LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(AuthAttempt.name) private readonly attempts: Model<AuthAttempt>,
  ) {}
  async onModuleInit() {
    await Promise.all([this.users.init(), this.sessions.init(), this.attempts.init()]);
    this.dummyHash = await hashPassword(randomToken());
  }
  private publicUser(user: UserDocument) { return { id: user.id as string, email: user.email, provider: 'email' as const }; }
  private async session(user: UserDocument, previous?: string) {
    const token = randomToken();
    await this.sessions.create({ tokenHash: hashToken(token), userId: user._id, expiresAt: new Date(Date.now() + 7 * 86400000) });
    await this.logout(previous);
    return { user: this.publicUser(user), token };
  }
  async register(dto: RegisterDto, previous?: string) {
    if (!getConfig().registration) throw new ForbiddenException('O cadastro está desativado.');
    const passwordHash = await hashPassword(dto.password);
    let user: UserDocument;
    try { user = await this.users.create({ email: dto.email, passwordHash }); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Não foi possível cadastrar este e-mail. Tente entrar na sua conta.');
      throw error;
    }
    return this.session(user, previous);
  }
  async login(dto: LoginDto, previous?: string) {
    const user = await this.users.findOne({ email: dto.email }).select('+passwordHash').exec();
    const matches = await verifyPassword(dto.password, user?.passwordHash || this.dummyHash);
    if (!matches || !user) throw new UnauthorizedException('E-mail ou senha incorretos.');
    return this.session(user, previous);
  }
  async me(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException('Entre para continuar.');
    // Check expiry in the query: MongoDB TTL cleanup is asynchronous.
    const session = await this.sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).exec();
    const user = session ? await this.users.findById(session.userId).exec() : null;
    if (!user) throw new UnauthorizedException('Entre para continuar.');
    return this.publicUser(user);
  }
  async logout(token?: string) { if (token) await this.sessions.deleteOne({ tokenHash: hashToken(token) }).exec(); }
}
