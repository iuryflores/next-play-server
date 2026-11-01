import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import nodemailer from 'nodemailer';
import { User, Session } from './auth.schemas';
import { hashPassword, hashToken, randomToken } from './password';
import { getConfig } from '../config';
import { recoveryEmail } from './recovery-email';

@Injectable()
export class RecoveryMailer {
  async send(to: string, link: string, purpose: 'recovery' | 'verification' = 'recovery') {
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    if (!user || !pass) throw new Error('SMTP não configurado.');
    const port = Number(process.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port,
      secure: port === 465, requireTLS: port !== 465, auth: { user, pass },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000 });
    try { await transport.sendMail({ from: { name: 'NextPlay', address: user }, to,
      ...recoveryEmail(link, purpose) });
    } finally { transport.close(); }
  }
}

@Injectable()
export class PasswordRecovery {
  private readonly logger = new Logger(PasswordRecovery.name);
  constructor(@InjectModel(User.name) private readonly users: Model<User>, @InjectModel(Session.name) private readonly sessions: Model<Session>, private readonly mailer: RecoveryMailer) {}
  async request(email: string) {
    const token = randomToken(), now = new Date();
    // O limite por conta complementa o limite por IP e evita inundar o Gmail.
    const user = await this.users.findOneAndUpdate({ email, $or: [{ resetRequestedAt: { $exists: false } }, { resetRequestedAt: { $lt: new Date(now.getTime() - 60000) } }] }, { $set: { resetTokenHash: hashToken(token), resetExpiresAt: new Date(now.getTime() + 15 * 60000), resetRequestedAt: now } }).exec();
    if (user) {
      // O fragmento não é enviado aos logs HTTP nem ao Referer do navegador.
      const link = `${getConfig().origin}/#reset-password=${token}`;
      try { await this.mailer.send(email, link); }
      catch {
        await this.users.updateOne({ _id: user._id, resetTokenHash: hashToken(token) }, { $unset: { resetTokenHash: 1, resetExpiresAt: 1 } });
        this.logger.warn('Falha no envio de recuperação. Confira as variáveis SMTP do servidor.');
      }
    }
    // Não revelar se o endereço pertence a uma conta, nem erros exclusivos dela.
    return { message: 'Se houver uma conta com esse e-mail, enviaremos um link de recuperação.' };
  }
  async reset(token: string, password: string) {
    const passwordHash = await hashPassword(password);
    // Consumo e alteração atômicos impedem a reutilização concorrente do link.
    const user = await this.users.findOneAndUpdate({ resetTokenHash: hashToken(token), resetExpiresAt: { $gt: new Date() } }, { $set: { passwordHash, passwordChangedAt: new Date() }, $unset: { resetTokenHash: 1, resetExpiresAt: 1 } }).exec();
    if (!user) throw new BadRequestException('Link inválido ou expirado. Solicite um novo link.');
    await this.sessions.deleteMany({ userId: user._id });
    return { message: 'Senha atualizada. Entre com sua nova senha.' };
  }
}
