import { Body, Controller, Get, HttpCode, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './auth.dto';
import { AuthRequestGuard } from './auth.guard';
import { getConfig } from '../config';

@Controller('auth')
@UseGuards(AuthRequestGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  private cookie(request: Request): string | undefined {
    const value: unknown = request.cookies?.[getConfig().cookieName];
    return typeof value === 'string' ? value : undefined;
  }
  private cookieOptions(): CookieOptions { return { path: '/', httpOnly: true, sameSite: 'lax', secure: getConfig().production }; }
  private setCookie(response: Response, token: string) { response.cookie(getConfig().cookieName, token, { ...this.cookieOptions(), maxAge: 7 * 86400000 }); }

  @Get('providers') providers() { return { email: true, google: false, phone: false, registration: getConfig().registration }; }
  @Get('me') async me(@Req() request: Request) { return { user: await this.auth.me(this.cookie(request)) }; }
  @Post('register') async register(@Body() dto: RegisterDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.register(dto, this.cookie(request)); this.setCookie(response, result.token); return { user: result.user };
  }
  @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto, this.cookie(request)); this.setCookie(response, result.token); return { user: result.user };
  }
  @Post('logout') @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(this.cookie(request)); response.clearCookie(getConfig().cookieName, this.cookieOptions());
  }
  @Post('google/start') google() { throw new ServiceUnavailableException('O acesso com Google será configurado depois. Use e-mail por enquanto.'); }
  @Post('phone/start') phone() { throw new ServiceUnavailableException('O acesso por SMS ainda não está configurado. Use e-mail por enquanto.'); }
}
