import { Controller, ForbiddenException, Get, HttpCode, Injectable, Module, OnModuleInit, Post, Req } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { achievements } from '../achievements/achievement-rules';
import { getConfig } from '../config';
import { levelFromXp, xpCandidates, xpRules, XpKind, XpItem, XpEpisode } from './progression-rules';

type Credit = { _id: string; ownerId: Types.ObjectId; kind: XpKind; label: string; units: number; rate: number; firstRecordedAt: Date; updatedAt: Date };
class XpBreakdownDto {
  @ApiProperty({ enum: Object.keys(xpRules) }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty() rate!: number;
  @ApiProperty() units!: number;
  @ApiProperty() xp!: number;
}
class XpRecentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: Object.keys(xpRules) }) kind!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: 'XP acumulado desta atividade, incluindo aumentos anteriores de horas.' }) xp!: number;
  @ApiProperty({ format: 'date-time', description: 'Quando o sistema registrou o último aumento de XP; não é a data de consumo. Importações antigas recebem a data da sincronização.' }) recordedAt!: string;
}
class ProgressionDto {
  @ApiProperty({ minimum: 1 }) level!: number;
  @ApiProperty({ minimum: 0 }) totalXp!: number;
  @ApiProperty({ description: 'XP obtido dentro do nível atual.' }) currentXp!: number;
  @ApiProperty({ description: 'XP necessário para avançar neste nível: 100 + 25*(level-1).' }) requiredXp!: number;
  @ApiProperty({ type: [XpBreakdownDto] }) breakdown!: XpBreakdownDto[];
  @ApiProperty({ type: [XpRecentDto], description: 'Até 20 atividades com crédito mais recente. Datas refletem o registro no XP, inclusive importações.' }) recent!: XpRecentDto[];
  @ApiProperty({ example: 100 }) gameHourCap!: number;
}
@Injectable()
export class ProgressionService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private credits() { return this.connection.collection<Credit>('user_xp_credits'); }
  async onModuleInit() { await this.credits().createIndex({ ownerId: 1, updatedAt: -1, _id: 1 }); }
  async sync(owner: string) {
    await this.recognize(owner);
    return this.state(owner);
  }
  async recognize(owner: string) {
    const ownerId = new Types.ObjectId(owner);
    const items = await this.connection.collection<XpItem & { ownerId: Types.ObjectId }>('library_items').find({ ownerId }, { projection: { kind: 1, status: 1, title: 1, catalogId: 1, catalogKey: 1, year: 1, stars: 1, feeling: 1, playtimeMinutes: 1 } }).toArray();
    const seriesIds = items.filter(item => item.kind === 'series').map(item => item._id);
    const [episodes, awards] = await Promise.all([
      seriesIds.length ? this.connection.collection<XpEpisode>('episode_progress').find({ itemId: { $in: seriesIds }, season: { $gt: 0 } }, { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchedDateUnknown: 1, stars: 1, feeling: 1 } }).toArray() : [],
      this.connection.collection('achievement_awards').find({ ownerId }, { projection: { key: 1 } }).toArray(),
    ]);
    const existing = await this.credits().find({ ownerId }, { projection: { units: 1 } }).toArray();
    const unitsById = new Map(existing.map(row => [row._id, row.units]));
    const creditId = (key: string) => `${owner}:${createHash('sha256').update(key).digest('hex')}`;
    // Leituras frequentes do ranking não regravam todo o histórico já reconhecido.
    const candidates = xpCandidates(items, episodes, awards.flatMap(row => {
      const definition = achievements.find(item => item.id === row.key);
      return definition ? [{ key: row.key, name: definition.name }] : [];
    })).filter(item => item.units > (unitsById.get(creditId(item.key)) || 0));
    // O identificador deriva da obra/episódio, não do registro removível da biblioteca.
    // O máximo persistido impede ganhar XP ao editar, desmarcar ou recadastrar a mesma obra.
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const operations = candidates.slice(offset, offset + 500).map(item => ({ updateOne: {
        filter: { _id: creditId(item.key), ownerId },
        update: [{ $set: {
          ownerId: { $literal: ownerId }, kind: { $literal: item.kind },
          label: { $ifNull: ['$label', { $literal: item.label }] },
          rate: xpRules[item.kind].rate,
          firstRecordedAt: { $ifNull: ['$firstRecordedAt', '$$NOW'] },
          updatedAt: { $cond: [{ $gt: [item.units, { $ifNull: ['$units', 0] }] }, '$$NOW', '$updatedAt'] },
          units: { $max: [item.units, { $ifNull: ['$units', 0] }] },
        } }], upsert: true,
      } }));
      try { await this.credits().bulkWrite(operations, { ordered: false }); }
      catch (error) {
        const errors = (error as { writeErrors?: { code: number }[] }).writeErrors;
        if (!errors?.length || errors.some(row => row.code !== 11000)) throw error;
        // Uma criação concorrente pode vencer o upsert; reaplicar também preserva o maior total.
        await this.credits().bulkWrite(operations, { ordered: false });
      }
    }
  }
  async state(owner: string) {
    const ownerId = new Types.ObjectId(owner);
    const [totals, recent] = await Promise.all([
      this.credits().aggregate<{ _id: XpKind; units: number; xp: number }>([
        { $match: { ownerId } }, { $group: { _id: '$kind', units: { $sum: '$units' }, xp: { $sum: { $multiply: ['$units', '$rate'] } } } },
      ]).toArray(),
      this.credits().find({ ownerId }).sort({ updatedAt: -1, _id: 1 }).limit(20).toArray(),
    ]);
    const breakdown = (Object.keys(xpRules) as XpKind[]).map(kind => ({ kind, ...xpRules[kind], units: totals.find(row => row._id === kind)?.units || 0, xp: totals.find(row => row._id === kind)?.xp || 0 }));
    return { ...levelFromXp(breakdown.reduce((sum, row) => sum + row.xp, 0)), breakdown, gameHourCap: 100, recent: recent.map(row => ({ id: row._id, kind: row.kind, label: row.label, xp: row.units * row.rate, recordedAt: row.updatedAt.toISOString() })) };
  }
}
@ApiTags('progression') @ApiCookieAuth('session')
@ApiResponse({ status: 401, description: 'Sessão ausente ou expirada.' })
@Controller('progression')
class ProgressionController {
  constructor(private readonly service: ProgressionService, private readonly auth: AuthService) {}
  @Get() @ApiOperation({ summary: 'Consultar o nível e os créditos privados de XP', description: 'Não sincroniza. Nível geral independente das conquistas e sem teto fixo. Nível 1 inicia em zero; primeiro avanço exige 100 XP e cada avanço seguinte exige mais 25 XP.' })
  @ApiOkResponse({ type: ProgressionDto })
  async get(@Req() request: Request) { return this.service.state((await this.auth.forRequest(request)).id); }
  @Post('sync') @HttpCode(200)
  @ApiOperation({ summary: 'Reconhecer atividades e histórico no XP', description: 'Idempotente. Não aceita XP do cliente. Filme 20, episódio regular 5, livro 50, jogo concluído 50, hora inteira jogada 2 (primeiras 100 por jogo), avaliação com nota ou sentimento 3 por obra concluída/episódio assistido e conquista concedida 25. Séries concluídas não dão bônus além dos episódios. Datas desconhecidas e arquivos contam; itens planejados não dão XP, exceto tempo jogado já informado. Alterações/exclusões não revogam créditos reconhecidos; recadastro da mesma identidade não duplica. Horas usam o maior total sincronizado por jogo. Sem histórico diário nem prêmios cosméticos nesta versão.' })
  @ApiOkResponse({ type: ProgressionDto })
  @ApiResponse({ status: 403, description: 'Origem não permitida.' })
  async sync(@Req() request: Request) {
    if (request.headers.origin !== getConfig().origin) throw new ForbiddenException('Origem da requisição não permitida.');
    return this.service.sync((await this.auth.forRequest(request)).id);
  }
}
@Module({ imports: [AuthModule], providers: [ProgressionService], controllers: [ProgressionController], exports: [ProgressionService] })
export class ProgressionModule {}
