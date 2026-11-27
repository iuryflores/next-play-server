import {
  BadGatewayException, BadRequestException, Controller, ForbiddenException,
  Get, Header, Injectable, Module, OnModuleInit, Query, Redirect, Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Connection } from 'mongoose';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { getConfig } from '../config';

const route = 'integrations/mercado-livre';
const callbackPath = '/api/' + route + '/callback';
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

type Attempt = {
  state: string;
  owner: string;
  session: string;
  verifier: string;
  expiresAt: Date;
};

interface ProviderToken {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

@Injectable()
class MercadoLivreOAuth implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private attempts() {
    return this.connection.collection<Attempt>('mercado_livre_oauth_attempts');
  }

  private grants() {
    return this.connection.collection('mercado_livre_oauth_grants');
  }

  async onModuleInit() {
    if (process.env.MELI_CLIENT_ID) {
      await Promise.all([
        this.attempts().createIndex({ state: 1 }, { unique: true }),
        this.attempts().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        this.grants().createIndex({ owner: 1 }, { unique: true }),
      ]);
    }
  }

  config() {
    const clientId = process.env.MELI_CLIENT_ID;
    const clientSecret = process.env.MELI_CLIENT_SECRET;
    const owner = process.env.MELI_PILOT_OWNER_ID;
    const redirect = process.env.MELI_REDIRECT_URI;
    const encryptionKey = process.env.MELI_TOKEN_ENCRYPTION_KEY;
    // O piloto usa o mesmo domínio da sessão NextPlay para validar o retorno do navegador.
    if (!clientId || !clientSecret || !owner || !/^[a-f0-9]{24}$/i.test(owner) ||
        !redirect?.startsWith('https://') || redirect !== getConfig().origin + callbackPath ||
        !encryptionKey || !/^[a-f0-9]{64}$/i.test(encryptionKey)) {
      throw new ServiceUnavailableException('OAuth do Mercado Livre não configurado.');
    }
    return { clientId, clientSecret, owner: owner.toLowerCase(), redirect, key: Buffer.from(encryptionKey, 'hex') };
  }

  async start(owner: string, session: string) {
    const { clientId, redirect } = this.config();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await this.attempts().insertOne({
      state: hash(state), owner, session: hash(session), verifier,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const url = new URL('https://auth.mercadolivre.com.br/authorization');
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirect,
      state, code_challenge: hash(verifier), code_challenge_method: 'S256',
      scope: 'read offline_access',
    }).toString();
    return url.toString();
  }

  async complete(owner: string, session: string, state: unknown, code: unknown, error: unknown) {
    const config = this.config();
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      throw new BadRequestException('Estado OAuth inválido.');
    }
    // Consome o estado atomicamente antes da troca, inclusive quando o usuário recusa o acesso.
    const attempt = await this.attempts().findOneAndDelete({
      state: hash(state), owner, session: hash(session), expiresAt: { $gt: new Date() },
    });
    if (!attempt) throw new BadRequestException('Autorização inválida, expirada ou já usada.');
    if (error !== undefined || typeof code !== 'string' || !code.trim() || code.length > 1024) {
      throw new BadRequestException('O Mercado Livre não retornou um código de autorização válido.');
    }

    let token: ProviderToken;
    try {
      const response = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        redirect: 'error',
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: config.clientId,
          client_secret: config.clientSecret, code, redirect_uri: config.redirect,
          code_verifier: attempt.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      token = await response.json() as ProviderToken;
    } catch {
      throw new BadGatewayException('Falha ao obter a autorização do Mercado Livre. Inicie novamente.');
    }
    if (!token || typeof token.access_token !== 'string' || !token.access_token ||
        typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) ||
        token.expires_in <= 0 || token.expires_in > 365 * 86400) {
      throw new BadGatewayException('O Mercado Livre retornou uma autorização inválida.');
    }
    // O MongoDB recebe apenas o envelope cifrado. A chave é configurada fora do banco.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.key, iv);
    cipher.setAAD(Buffer.from(owner + ':' + config.clientId));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    })), cipher.final()]);
    await this.grants().updateOne({ owner }, { $set: {
      clientId: config.clientId,
      credentials: { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') },
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    } }, { upsert: true });
  }

  async status(owner: string) {
    const { clientId } = this.config();
    const grant = await this.grants().findOne({ owner, clientId }, { projection: { expiresAt: 1 } });
    return { connected: Boolean(grant), expiresAt: grant?.expiresAt ?? null };
  }
}

@ApiTags('Mercado Livre')
@ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão NextPlay ausente ou expirada.' })
@ApiResponse({ status: 403, description: 'Conta sem acesso ao piloto.' })
@ApiResponse({ status: 503, description: 'OAuth do Mercado Livre não configurado.' })
@Controller(route)
class MercadoLivreController {
  constructor(private readonly auth: AuthService, private readonly oauth: MercadoLivreOAuth) {}

  private async pilot(request: Request) {
    const user = await this.auth.forRequest(request);
    if (user.id !== this.oauth.config().owner) throw new ForbiddenException('Conta sem acesso ao piloto.');
    return { owner: user.id, session: request.cookies[getConfig().cookieName] as string };
  }

  @Get('authorize')
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Iniciar a autorização do piloto do Mercado Livre com PKCE S256' })
  @ApiResponse({ status: 302, description: 'Redireciona para o consentimento no Mercado Livre.' })
  async authorize(@Req() request: Request) {
    const { owner, session } = await this.pilot(request);
    return { url: await this.oauth.start(owner, session) };
  }

  @Get('callback')
  @Header('Referrer-Policy', 'no-referrer')
  @Redirect(undefined, 303)
  @ApiOperation({ summary: 'Validar o retorno OAuth e salvar a autorização cifrada do piloto' })
  @ApiQuery({ name: 'state', required: true, type: String })
  @ApiQuery({ name: 'code', required: false, type: String, description: 'Obrigatório quando o consentimento é concedido.' })
  @ApiQuery({ name: 'error', required: false, type: String, description: 'Presente quando o provedor recusa ou cancela a autorização.' })
  @ApiResponse({ status: 303, description: 'Redireciona para o status sem código OAuth na URL.' })
  @ApiResponse({ status: 400, description: 'Estado, sessão de origem ou código inválido, expirado ou reutilizado.' })
  @ApiResponse({ status: 502, description: 'Falha na troca do código por token.' })
  async callback(@Req() request: Request, @Query('state') state: unknown, @Query('code') code: unknown, @Query('error') error: unknown) {
    const { owner, session } = await this.pilot(request);
    await this.oauth.complete(owner, session, state, code, error);
    return { url: '/api/' + route + '/status' };
  }

  @Get('status')
  @ApiOperation({ summary: 'Consultar se existe uma autorização armazenada e a expiração do token' })
  @ApiResponse({ status: 200, description: 'Presença da autorização armazenada e expiração do token.',
    schema: { type: 'object', required: ['connected', 'expiresAt'], properties: {
      connected: { type: 'boolean' },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
    } },
  })
  async status(@Req() request: Request) {
    const { owner } = await this.pilot(request);
    return this.oauth.status(owner);
  }
}

@Module({ imports: [AuthModule], controllers: [MercadoLivreController], providers: [MercadoLivreOAuth] })
export class MercadoLivreModule {}
