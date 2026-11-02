import { ApiCookieAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, PreferencesDto, ProfileDto } from './auth.dto';
import { AuthRequestGuard } from './auth.guard';
import { getConfig } from '../config';
import { PasswordRecovery } from './password-recovery';
import { EmailConfirmation } from './email-confirmation';
import { ConfirmEmailDto } from './auth.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './auth.dto';

@ApiTags('auth')
@Controller('auth')
@UseGuards(AuthRequestGuard)
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly recovery: PasswordRecovery, private readonly confirmation: EmailConfirmation) {}

  @ApiOperation({ summary: 'Confirmar e-mail com token de uso único', description: 'Link válido por 24 horas. Não inicia uma sessão automaticamente.' })
  @ApiResponse({ status: 400, description: 'Token inválido, expirado ou já utilizado.' })
  @Post('confirm-email') @HttpCode(200)
  confirmEmail(@Body() dto: ConfirmEmailDto) { return this.confirmation.confirm(dto.token); }

  @ApiOperation({ summary: 'Reenviar confirmação de e-mail', description: 'Resposta genérica e intervalo mínimo de um minuto por conta.' })
  @Post('resend-confirmation') @HttpCode(200)
  resendConfirmation(@Body() dto: ForgotPasswordDto) { return this.confirmation.request(dto.email); }

  @ApiOperation({ summary: 'Solicitar link de recuperação por e-mail', description: 'Resposta genérica para contas existentes ou não. Link de uso único, válido por 15 minutos.' })
  @Post('forgot-password') @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto) { return this.recovery.request(dto.email); }

  @ApiOperation({ summary: 'Redefinir senha e revogar sessões anteriores' })
  @ApiResponse({ status: 400, description: 'Token inválido, expirado ou senha fora dos limites.' })
  @Post('reset-password') @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) { return this.recovery.reset(dto.token, dto.password); }
  private cookie(request: Request): string | undefined {
    const value: unknown = request.cookies?.[getConfig().cookieName];
    return typeof value === 'string' ? value : undefined;
  }
  private cookieOptions(): CookieOptions { return { path: '/', httpOnly: true, sameSite: 'lax', secure: getConfig().production }; }
  // O navegador recebe o token somente em cookie HttpOnly; ele nunca vai no JSON.
  private setCookie(response: Response, token: string) { response.cookie(getConfig().cookieName, token, { ...this.cookieOptions(), maxAge: 7 * 86400000 }); }

  @ApiOperation({ summary: 'Consultar métodos de acesso disponíveis' })
  @Get('providers') providers() { return { email: true, google: false, phone: false, registration: getConfig().registration }; }
  @ApiOperation({ summary: 'Consultar a conta da sessão atual' })
  @ApiCookieAuth('session')
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @Get('me') async me(@Req() request: Request) { return { user: await this.auth.me(this.cookie(request)) }; }
  @ApiOperation({ summary: 'Obter redirecionamento para a foto privada' })
  @ApiCookieAuth('session')
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @ApiResponse({ status: 302, description: 'URL S3 assinada, válida por cinco minutos.' })
  @Get('avatar') async avatar(@Req() request: Request, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, await this.auth.avatarUrl(this.cookie(request)));
  }
  @ApiOperation({ summary: 'Salvar preferências da conta', description: 'Atualiza parcialmente idioma, tema e densidade da visão geral no banco da sessão. Campos ausentes são preservados; corpo vazio apenas retorna o usuário atual. Respostas de sessão incluem theme e collectionDensity.' })
  @ApiCookieAuth('session')
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @Post('preferences') @HttpCode(200) async preferences(@Body() dto: PreferencesDto, @Req() request: Request) { return { user: await this.auth.preferences(this.cookie(request), dto) }; }
  @ApiOperation({ summary: 'Atualizar perfil e foto no S3' })
  @ApiCookieAuth('session')
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @Post('profile') @HttpCode(200) async profile(@Body() dto: ProfileDto, @Req() request: Request) { return { user: await this.auth.profile(this.cookie(request), dto) }; }
  @ApiOperation({ summary: 'Criar conta e enviar confirmação de e-mail', description: 'Por padrão não cria sessão. Confirme o link enviado por e-mail e faça login.' })
  @Post('register') async register(@Body() dto: RegisterDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.register(dto, this.cookie(request));
    if ('requiresVerification' in result) return result;
    this.setCookie(response, result.token); return { user: result.user };
  }
  @ApiOperation({ summary: 'Entrar com e-mail e senha' })
  @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto, this.cookie(request)); this.setCookie(response, result.token); return { user: result.user };
  }
  @ApiOperation({ summary: 'Revogar a sessão atual' })
  @ApiCookieAuth('session')
  @ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
  @Post('logout') @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.cookie(request)); response.clearCookie(getConfig().cookieName, this.cookieOptions());
  }
  @ApiOperation({ summary: 'Google ainda indisponível' })
  @ApiResponse({ status: 503, description: 'Integração ainda não configurada.' })
  @Post('google/start') google() { throw new ServiceUnavailableException('O acesso com Google será configurado depois. Use e-mail por enquanto.'); }
  @ApiOperation({ summary: 'SMS ainda indisponível' })
  @ApiResponse({ status: 503, description: 'Integração ainda não configurada.' })
  @Post('phone/start') phone() { throw new ServiceUnavailableException('O acesso por SMS ainda não está configurado. Use e-mail por enquanto.'); }
}
