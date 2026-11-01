import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from './auth.schemas';
import { RecoveryMailer } from './password-recovery';
import { hashToken, randomToken } from './password';
import { getConfig } from '../config';

@Injectable()
export class EmailConfirmation {
  private readonly logger = new Logger(EmailConfirmation.name);
  constructor(@InjectModel(User.name) private readonly users: Model<User>, private readonly mailer: RecoveryMailer) {}
  async request(email: string) {
    const token = randomToken(), now = new Date();
    // Links anteriores são substituídos; limite por conta evita envios repetidos.
    const user = await this.users.findOneAndUpdate({ email, verificationRequired: true, emailVerifiedAt: { $exists: false }, $or: [{ verificationRequestedAt: { $exists: false } }, { verificationRequestedAt: { $lt: new Date(now.getTime() - 60000) } }] }, { $set: { verificationTokenHash: hashToken(token), verificationExpiresAt: new Date(now.getTime() + 86400000), verificationRequestedAt: now } }).exec();
    if (user) {
      try { await this.mailer.send(email, `${getConfig().origin}/#verify-email=${token}`, 'verification'); }
      catch {
        await this.users.updateOne({ _id: user._id, verificationTokenHash: hashToken(token) }, { $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } });
        this.logger.warn('Falha no envio de confirmação. Confira a configuração SMTP.');
      }
    }
    return { message: 'Se houver uma conta aguardando confirmação, enviaremos um novo link.' };
  }
  async confirm(token: string) {
    // A validação e o consumo acontecem juntos para impedir reutilização do token.
    const user = await this.users.findOneAndUpdate({ verificationTokenHash: hashToken(token), verificationExpiresAt: { $gt: new Date() }, verificationRequired: true, emailVerifiedAt: { $exists: false } }, { $set: { emailVerifiedAt: new Date() }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } }).exec();
    if (!user) throw new BadRequestException('Link de confirmação inválido ou expirado. Solicite um novo link.');
    return { message: 'E-mail confirmado. Você já pode entrar na sua conta.' };
  }
}
