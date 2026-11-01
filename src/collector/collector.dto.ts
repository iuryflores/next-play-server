import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export const collectorKinds = ['movie', 'series', 'game', 'book', 'other'] as const;
export const copyFormats = ['physical', 'digital'] as const;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CollectorCopyDto {
  @ApiPropertyOptional({ maxLength: 60, description: 'Obrigatória para kind=other. Ex.: Carrinhos, Action figures. Somente objetos manuais.' })
  @ValidateIf((object, value) => object.kind === 'other' || value !== undefined)
  @Transform(trim) @IsString() @Matches(/\S/) @MaxLength(60) category?: string;

  @ApiPropertyOptional({ maxLength: 600000, description: 'Somente kind=other: JPEG data URL (máx. 600000 caracteres). Omitir preserva foto ao editar; string vazia remove. Nunca enviar chave ou URL S3.' })
  @IsOptional() @IsString() @MaxLength(600000) photo?: string;
  @ApiProperty({ maxLength: 200, description: 'Nome da obra. Não é um status de consumo.' })
  @Transform(trim) @IsString() @Matches(/\S/) @MaxLength(200) title!: string;

  @ApiProperty({ enum: collectorKinds })
  @IsIn(collectorKinds) kind!: typeof collectorKinds[number];

  @ApiProperty({ enum: copyFormats, description: 'Formato desta cópia possuída.' })
  @IsIn(copyFormats) format!: typeof copyFormats[number];

  @ApiPropertyOptional({ maxLength: 100, description: 'Ex.: PlayStation 5, Steam ou Blu-ray.' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) platform?: string;

  @ApiPropertyOptional({ maxLength: 150, description: 'Ex.: edição de colecionador, steelbook ou capa dura.' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(150) edition?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Anotações privadas desta cópia.' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;

  @ApiPropertyOptional({ pattern: '^((tmdb:(movie|series)|igdb:game):[1-9]\\d{0,14}|googlebooks:book:[A-Za-z0-9_-]{1,100})$', description: 'Referência opcional do catálogo. Livros usam volume Google Books; cadastro manual continua disponível sem catalogId.' })
  @IsOptional() @IsString() @Matches(/^((tmdb:(movie|series)|igdb:game):[1-9]\d{0,14}|googlebooks:book:[A-Za-z0-9_-]{1,100})$/) catalogId?: string;
}

export class CollectorCopyResponseDto extends CollectorCopyDto {
  @ApiProperty({ description: 'ID único da cópia, mesmo quando a obra e a edição se repetem.' }) id!: string;
  @ApiPropertyOptional() coverUrl?: string;
  @ApiPropertyOptional() year?: string;
  @ApiPropertyOptional({ type: [String], description: 'Autores informados pelo Google Books.' }) authors?: string[];
  @ApiPropertyOptional({ description: 'ISBN da edição, resolvido pelo servidor.' }) isbn?: string;
  @ApiPropertyOptional() publisher?: string;
  @ApiPropertyOptional() language?: string;
  @ApiPropertyOptional({ type: [String], description: 'Categorias/gêneros do Google Books usados nas sugestões do acervo.' }) genres?: string[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}
export class CollectorCopyResultDto {
  @ApiProperty({ type: CollectorCopyResponseDto }) copy!: CollectorCopyResponseDto;
}
export class CollectorCopiesResultDto {
  @ApiProperty({ type: [CollectorCopyResponseDto] }) copies!: CollectorCopyResponseDto[];
}
