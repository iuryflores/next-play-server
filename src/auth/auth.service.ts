import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, Session, AuthAttempt, type UserDocument } from './auth.schemas';
import { hashPassword, hashToken, randomToken, verifyPassword } from './password';
import { getConfig } from '../config';
import type { LoginDto, RegisterDto, ProfileDto } from './auth.dto';
import { AvatarStorage } from './avatar-storage';
import { EmailConfirmation } from './email-confirmation';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(AuthAttempt.name) private readonly attempts: Model<AuthAttempt>,
    private readonly avatars: AvatarStorage,
    private readonly confirmation: EmailConfirmation,
  ) {}
  async onModuleInit() {
    await Promise.all([this.users.init(), this.sessions.init(), this.attempts.init()]);
    this.dummyHash = await hashPassword(randomToken());
  }
  private publicUser(user: UserDocument) { return { requiresVerification: Boolean(user.verificationRequired && !user.emailVerifiedAt), id: user.id as string, email: user.email, displayName: user.displayName || '', avatar: user.avatarKey ? `/api/auth/avatar?v=${encodeURIComponent(user.avatarKey.split('/').pop()!)}` : user.avatar || '', provider: 'email' as const, language: user.language || 'pt-BR' }; }
  async avatarUrl(token?: string) {
    const current = await this.me(token);
    const user = await this.users.findById(current.id).exec();
    if (!user?.avatarKey) throw new BadRequestException('Foto de perfil não encontrada.');
    return this.avatars.signedUrl(user.avatarKey);
  }
  async preferences(token: string | undefined, language: string) {
    const current = await this.me(token);
    const user = await this.users.findByIdAndUpdate(current.id, { $set: { language } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!user) throw new UnauthorizedException('Entre para continuar.');
    return this.publicUser(user);
  }
  async profile(token: string | undefined, dto: ProfileDto) {
    const current = await this.me(token);
    const user = await this.users.findById(current.id).select('+passwordHash').exec();
    if (!user) throw new UnauthorizedException('Entre para continuar.');
    if (dto.avatar) {
      if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dto.avatar)) throw new BadRequestException('Foto inválida. Escolha outra imagem.');
      const image = Buffer.from(dto.avatar.split(',')[1], 'base64');
      if (image.length < 4 || image[0] !== 255 || image[1] !== 216 || image[image.length - 2] !== 255 || image[image.length - 1] !== 217) throw new BadRequestException('Foto inválida. Escolha outra imagem.');
    }
    const changedEmail = dto.email !== user.email;
    if (changedEmail && !await verifyPassword(dto.currentPassword || '', user.passwordHash)) throw new BadRequestException('Senha atual incorreta.');
    const previousKey = user.avatarKey;
    let uploadedKey: string | undefined;
    if (dto.avatar !== undefined) {
      if (dto.avatar) {
        uploadedKey = await this.avatars.upload(current.id, Buffer.from(dto.avatar.split(',')[1], 'base64'));
        user.avatarKey = uploadedKey;
      } else user.avatarKey = '';
      user.avatar = '';
    }
    // Trocar e-mail invalida links enviados ao endereço anterior.
    if (changedEmail) {
      user.resetTokenHash = undefined; user.resetExpiresAt = undefined;
      user.verificationTokenHash = undefined; user.verificationExpiresAt = undefined;
      user.verificationRequestedAt = undefined;
      if (user.verificationRequired) user.emailVerifiedAt = undefined;
    }
    user.displayName = dto.displayName; user.email = dto.email;
    try { await user.save(); }
    catch (error) {
      if (uploadedKey) await this.avatars.remove(uploadedKey);
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Este e-mail já está em uso.');
      if ((error as Error).name === 'VersionError') throw new ConflictException('O perfil foi alterado. Atualize a página e tente novamente.');
      throw error;
    }
    if (previousKey && previousKey !== user.avatarKey) await this.avatars.remove(previousKey);
    if (changedEmail && user.verificationRequired) {
      await this.sessions.deleteMany({ userId: user._id });
      await this.confirmation.request(user.email);
    }
    return this.publicUser(user);
  }
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
    const verificationRequired = process.env.EMAIL_VERIFICATION_REQUIRED !== 'false';
    try { user = await this.users.create({ email: dto.email, passwordHash, verificationRequired }); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('Não foi possível cadastrar este e-mail. Tente entrar na sua conta.');
      throw error;
    }
    if (verificationRequired) {
      await this.confirmation.request(user.email);
      return { requiresVerification: true as const, message: 'Conta criada. Confirme seu e-mail para entrar.' };
    }
    return this.session(user, previous);
  }
  async login(dto: LoginDto, previous?: string) {
    const user = await this.users.findOne({ email: dto.email }).select('+passwordHash').exec();
    const matches = await verifyPassword(dto.password, user?.passwordHash || this.dummyHash);
    if (!matches || !user) throw new UnauthorizedException('E-mail ou senha incorretos.');
    if (user.verificationRequired && !user.emailVerifiedAt) throw new ForbiddenException('Confirme seu e-mail antes de entrar.');
    return this.session(user, previous);
  }
  async me(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException('Entre para continuar.');
    // Check expiry in the query: MongoDB TTL cleanup is asynchronous.
    const session = await this.sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).exec();
    const user = session ? await this.users.findById(session.userId).exec() : null;
    if (user?.verificationRequired && !user.emailVerifiedAt) throw new UnauthorizedException('Confirme seu e-mail antes de entrar.');
    // Mesmo se a limpeza falhar, sessões anteriores à troca de senha são inválidas.
    if (user?.passwordChangedAt && (!session?.createdAt || session.createdAt <= user.passwordChangedAt)) throw new UnauthorizedException('Entre para continuar.');
    if (!user) throw new UnauthorizedException('Entre para continuar.');
    return this.publicUser(user);
  }
  async logout(token?: string) { if (token) await this.sessions.deleteOne({ tokenHash: hashToken(token) }).exec(); }
}
