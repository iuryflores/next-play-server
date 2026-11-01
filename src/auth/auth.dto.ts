import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsEmail, IsString, IsIn, MaxLength, MinLength, ValidateIf, Matches } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ format: 'email', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(254) email!: string;
}
export class ConfirmEmailDto {
  @ApiProperty({ minLength: 43, maxLength: 43 })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
export class ResetPasswordDto {
  @ApiProperty({ minLength: 43, maxLength: 43 })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
}
export class PreferencesDto { @ApiProperty({ type: String, required: true, enum: ['pt-BR', 'en-US', 'es-ES'] })
  @IsIn(['pt-BR', 'en-US', 'es-ES']) language!: string; }

export class LoginDto {
  @ApiProperty({ type: String, required: true, maxLength: 254, format: 'email' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1, { message: 'Informe sua senha.' })
  @MaxLength(128, { message: 'A senha deve ter no máximo 128 caracteres.' })
  password!: string;
}

export class RegisterDto extends LoginDto {
  @ApiProperty({ type: String, required: true, minLength: 12 })
  @MinLength(12, { message: 'Use uma senha com pelo menos 12 caracteres.' })
  declare password: string;
}

export class ProfileDto {
  @ApiProperty({ type: String, required: true, minLength: 1, maxLength: 40 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(40) displayName!: string;
  @ApiProperty({ type: String, required: true, maxLength: 254, format: 'email' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ type: String, required: false, maxLength: 100000 })
  @ValidateIf((_object, value) => value !== undefined) @IsString() @MaxLength(100000) avatar?: string;
  @ApiProperty({ type: String, required: false, maxLength: 128 })
  @IsOptional() @IsString() @MaxLength(128) currentPassword?: string;
}
