import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Request } from 'express';
import { AuthAttempt } from './auth.schemas';
import { hashToken } from './password';
import { getConfig } from '../config';

@Injectable()
export class AuthRequestGuard implements CanActivate {
  constructor(@InjectModel(AuthAttempt.name) private readonly attempts: Model<AuthAttempt>) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    const window = Math.floor(Date.now() / 60000);
    const key = hashToken(`${request.socket.remoteAddress}|${request.path}|${window}`);
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * 60000) } };
    let attempt;
    try { attempt = await this.attempts.findOneAndUpdate({ key }, update, { upsert: true, returnDocument: 'after' }).exec(); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      attempt = await this.attempts.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { returnDocument: 'after' }).exec();
    }
    const limit = /\/(register|forgot-password|reset-password|confirm-email|resend-confirmation)$/.test(request.path) ? 5 : 20;
    if (!attempt || attempt.count > limit) throw new HttpException('Muitas tentativas. Aguarde um minuto e tente novamente.', 429);
    return true;
  }
}
