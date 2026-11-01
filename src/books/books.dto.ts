import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class BookSearchDto {
  @ApiProperty({ minLength: 2, maxLength: 100, description: 'Título, nome do autor ou ISBN, conforme field.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(2) @MaxLength(100) q!: string;
  @ApiPropertyOptional({ enum: ['title', 'author', 'isbn'], default: 'title' })
  @IsOptional() @IsIn(['title', 'author', 'isbn']) field: 'title' | 'author' | 'isbn' = 'title';
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) page = 1;
}
export class BookSuggestionsDto {
  @ApiPropertyOptional({ enum: ['collection', 'reading'], default: 'collection', description: 'collection usa exemplares possuídos; reading usa somente o acompanhamento de leitura da sessão.' })
  @IsOptional() @IsIn(['collection', 'reading']) context: 'collection' | 'reading' = 'collection';
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) page = 1;
}
export class BookTitleDto {
  @ApiProperty({ example: 'googlebooks:book:volume_id', description: 'Identificador do volume/edição no Google Books, não de uma cópia possuída.' }) catalogId!: string;
  @ApiProperty({ enum: ['book'] }) kind!: 'book';
  @ApiProperty() title!: string;
  @ApiProperty({ type: [String] }) authors!: string[];
  @ApiProperty({ description: 'ISBN-13 ou ISBN-10 da edição; vazio quando não informado pelo provedor.' }) isbn!: string;
  @ApiProperty() publisher!: string;
  @ApiProperty() language!: string;
  @ApiProperty({ type: [String], description: 'Categorias/gêneros informados pelo Google Books.' }) genres!: string[];
  @ApiProperty() year!: string;
  @ApiProperty() coverUrl!: string;
  @ApiProperty() overview!: string;
  @ApiProperty() sourceUrl!: string;
}
export class BookSearchResultDto {
  @ApiProperty({ type: [BookTitleDto] }) results!: BookTitleDto[];
  @ApiProperty({ type: Number, nullable: true }) nextPage!: number | null;
  @ApiPropertyOptional({ description: 'Nas sugestões, indica se foram usados os livros privados do contexto solicitado.' }) personalized?: boolean;
}
