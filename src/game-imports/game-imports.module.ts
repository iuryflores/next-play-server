import { PsnConnectionService, PsnGateway } from "./psn-connection";
import { SteamConnectionService } from "./steam-connection";
import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Delete,
  Res,
  Injectable,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiTags, ApiResponse } from "@nestjs/swagger";
import {
  Equals,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { getConfig } from "../config";
const providers = ["steam", "xbox", "playstation", "epic", "gog", "nintendo"] as const;
class ImportGameDto {
  @ApiProperty({ maxLength: 100, description: "ID estável da obra na plataforma de origem." })
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,100}$/)
  externalId!: string;
  @ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ minimum: 0, maximum: 6000000, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6000000)
  playtimeMinutes?: number;
  @ApiProperty({
    required: false,
    maxLength: 60,
    description: "Plataforma do jogo; não confunde versão PS4 com PS5.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  platform?: string;
  @ApiProperty({
    minimum: 0,
    maximum: 100000,
    required: false,
    description: "Contagem externa, separada das conquistas NextPlay.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  achievementsUnlocked?: number;
  @ApiProperty({ minimum: 0, maximum: 100000, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  achievementsTotal?: number;
}
class FileDto {
  @ApiProperty({ enum: providers }) @IsIn(providers) provider!: (typeof providers)[number];
  @ApiProperty({ type: [ImportGameDto], maxItems: 200, minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportGameDto)
  games!: ImportGameDto[];
}
class SteamDto {
  @ApiProperty({
    pattern: "^7656119[0-9]{10}$",
    description: "SteamID64 do perfil público a importar. Não autentica/vincula a conta Steam.",
  })
  @Matches(/^7656119\d{10}$/)
  steamId!: string;
}
class PsnConnectDto {
  @ApiProperty({
    writeOnly: true,
    minLength: 64,
    maxLength: 64,
    description:
      "Código NPSSO sensível obtido pelo usuário na sessão Sony. Só usado na troca; nunca persistido ou retornado.",
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{64}$/)
  npsso!: string;
  @ApiProperty({
    type: Boolean,
    enum: [true],
    description:
      "Consentimento explícito à integração comunitária experimental, temporária e somente de leitura.",
  })
  @Equals(true)
  consent!: true;
}
class ApplyDto {
  @ApiProperty({
    type: Boolean,
    description: "Adicionar uma cópia digital ao acervo; não implica consumo.",
  })
  @IsBoolean()
  collection!: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      "Criar acompanhamento Para depois ou atualizar somente horas do jogo próprio selecionado. Nunca conclui automaticamente.",
  })
  @IsBoolean()
  tracking!: boolean;
  @ApiProperty({
    required: false,
    pattern: "^[a-f0-9]{24}$",
    description:
      "Jogo próprio escolhido explicitamente para evitar duplicação. Mantém status/notas/plataforma/sessões; total passa ao maior entre atual e importado.",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{24}$/)
  itemId?: string;
}
class PageQuery {
  @ApiProperty({ required: false, minimum: 0, maximum: 10000, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  offset?: number;
}
function cleanGame(game: ImportGameDto) {
  if (!game.title.trim()) throw new BadRequestException("Informe o título do jogo.");
  if (
    game.achievementsUnlocked !== undefined &&
    game.achievementsTotal !== undefined &&
    game.achievementsUnlocked > game.achievementsTotal
  )
    throw new BadRequestException("Conquistas desbloqueadas não podem superar o total.");
  return { ...game, title: game.title.trim() };
}
@Injectable()
export class GameImportsService implements OnModuleInit {
  private pending = new Set<string>();
  private requests = new Map<string, { at: number; count: number }>();
  limit(owner: string) {
    const now = Date.now();
    for (const [key, v] of this.requests) if (now - v.at > 60000) this.requests.delete(key);
    const row = this.requests.get(owner) || { at: now, count: 0 };
    if (++row.count > 60)
      throw new ConflictException("Aguarde um minuto antes de tentar novamente.");
    this.requests.set(owner, row);
  }
  constructor(@InjectConnection() private readonly db: Connection) {}
  async onModuleInit() {
    await this.db
      .collection("game_import_previews")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db.collection("external_game_data").createIndex({ ownerId: 1, itemId: 1 });
  }
  private async steam(path: string, params: Record<string, string>) {
    const key = process.env.STEAM_WEB_API_KEY?.trim();
    if (!key)
      throw new ServiceUnavailableException(
        "A integração Steam aguarda a chave do aplicativo no servidor.",
      );
    const url = new URL("https://api.steampowered.com/" + path);
    url.search = new URLSearchParams({ ...params, key }).toString();
    // Host fixo e erros genéricos impedem expor a chave ou aceitar URLs fornecidas pelo cliente.
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "error" });
      if (!response.ok) throw Error();
      const text = await response.text();
      if (text.length > 5000000) throw Error();
      return JSON.parse(text);
    } catch {
      throw new BadGatewayException(
        "Não foi possível consultar a Steam. Verifique a privacidade do perfil e tente novamente.",
      );
    }
  }
  status() {
    return {
      steamConfigured: Boolean(process.env.STEAM_WEB_API_KEY?.trim()),
      fileProviders: providers,
      automaticProviders: ["steam", "playstation-experimental"],
    };
  }
  private async stage(
    owner: string,
    provider: string,
    games: ImportGameDto[],
    source: string,
    steamId?: string,
    psnOnlineId?: string,
  ) {
    if (games.length > 10000 || new Set(games.map((g) => g.externalId)).size !== games.length)
      throw new BadRequestException("Lista duplicada ou acima de dez mil jogos.");
    const id = randomUUID();
    await this.db.collection("game_import_previews").insertOne({
      _id: id as any,
      ownerId: new Types.ObjectId(owner),
      provider,
      source,
      steamId,
      psnOnlineId,
      games: games.map(cleanGame),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });
    return this.preview(owner, id, 0);
  }
  async file(owner: string, dto: FileDto) {
    return this.stage(owner, dto.provider, dto.games, "file");
  }
  async fromSteam(owner: string, steamId: string) {
    if (this.pending.has(owner)) throw new ConflictException("Uma consulta já está em andamento.");
    this.pending.add(owner);
    try {
      const value = await this.steam("IPlayerService/GetOwnedGames/v1/", {
        steamid: steamId,
        include_appinfo: "1",
        include_played_free_games: "1",
      });
      const data = value.response;
      if (
        !data ||
        !Number.isSafeInteger(data.game_count) ||
        data.game_count < 0 ||
        data.game_count > 10000 ||
        (!Array.isArray(data.games) && data.game_count !== 0)
      )
        throw new BadGatewayException(
          "A biblioteca Steam não está visível. Torne os detalhes de jogos públicos e tente novamente.",
        );
      const games = (data.games || []).map((g: any) => {
        if (
          !Number.isSafeInteger(g.appid) ||
          g.appid <= 0 ||
          typeof g.name !== "string" ||
          !g.name.trim() ||
          g.name.length > 200 ||
          !Number.isSafeInteger(g.playtime_forever) ||
          g.playtime_forever < 0 ||
          g.playtime_forever > 6000000
        )
          throw new BadGatewayException("Dados inválidos recebidos da Steam.");
        return { externalId: String(g.appid), title: g.name, playtimeMinutes: g.playtime_forever };
      });
      if (games.length !== data.game_count)
        throw new BadGatewayException("Biblioteca Steam incompleta.");
      return this.stage(owner, "steam", games, "steam-api", steamId);
    } finally {
      this.pending.delete(owner);
    }
  }
  private async owned(owner: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException("Prévia não encontrada.");
    const row = await this.db.collection("game_import_previews").findOne({
      _id: id as any,
      ownerId: new Types.ObjectId(owner),
      expiresAt: { $gt: new Date() },
    });
    if (!row) throw new NotFoundException("Prévia expirada ou não encontrada.");
    return row;
  }
  async preview(owner: string, id: string, offset: number) {
    const row = await this.owned(owner, id);
    return {
      id,
      provider: row.provider,
      source: row.source,
      total: row.games.length,
      games: row.games.slice(offset, offset + 20),
      nextOffset: row.games.length > offset + 20 ? offset + 20 : null,
    };
  }
  async achievements(owner: string, id: string, externalId: string) {
    const row = await this.owned(owner, id);
    if (
      row.provider !== "steam" ||
      row.source !== "steam-api" ||
      !row.games.some((g: ImportGameDto) => g.externalId === externalId)
    )
      throw new BadRequestException(
        "Conquistas automáticas disponíveis apenas para jogos da prévia Steam.",
      );
    const result = await this.steam("ISteamUserStats/GetPlayerAchievements/v1/", {
      steamid: row.steamId,
      appid: externalId,
      l: "brazilian",
    });
    if (result.playerstats?.success !== true)
      throw new BadGatewayException("Conquistas não disponíveis para este jogo ou perfil.");
    const list = result.playerstats.achievements;
    if (
      !Array.isArray(list) ||
      list.length > 100000 ||
      list.some((a: any) => ![0, 1].includes(a.achieved))
    )
      throw new BadGatewayException("Este jogo não informou conquistas válidas.");
    const stats = {
      achievementsTotal: list.length,
      achievementsUnlocked: list.filter((a: any) => a.achieved === 1).length,
    };
    await this.db.collection("game_import_previews").updateOne(
      { _id: id as any, ownerId: row.ownerId, "games.externalId": externalId },
      {
        $set: {
          "games.$.achievementsTotal": stats.achievementsTotal,
          "games.$.achievementsUnlocked": stats.achievementsUnlocked,
        },
      },
    );
    return stats;
  }
  async apply(owner: string, id: string, externalId: string, dto: ApplyDto) {
    if (!dto.collection && !dto.tracking)
      throw new BadRequestException("Escolha acervo ou acompanhamento.");
    const preview = await this.owned(owner, id),
      game = preview.games.find((g: ImportGameDto) => g.externalId === externalId) as
        | ImportGameDto
        | undefined;
    if (!game) throw new NotFoundException("Jogo não encontrado.");
    const ownerId = new Types.ObjectId(owner),
      provider = preview.provider,
      now = new Date(),
      key = provider + ":" + externalId;
    const stable = (kind: string) =>
      new Types.ObjectId(
        createHash("sha256")
          .update(owner + ":" + kind + ":" + key)
          .digest("hex")
          .slice(0, 24),
      );
    const prior = await this.db
      .collection("external_game_data")
      .findOne({ ownerId, provider, externalId });
    let itemId = dto.itemId ? new Types.ObjectId(dto.itemId) : prior?.itemId || stable("tracking");
    let linked = dto.tracking
      ? await this.db.collection("library_items").findOne({ _id: itemId, ownerId, kind: "game" })
      : null;
    if (dto.itemId && !linked) throw new NotFoundException("Jogo próprio não encontrado.");
    if (prior?.itemId && dto.itemId && prior.itemId.toString() !== dto.itemId)
      throw new ConflictException("Esta origem já foi importada para outro acompanhamento.");
    if (dto.tracking) {
      // Reserva atômica por origem: duas confirmações não podem ligar o mesmo jogo a destinos diferentes.
      const sourceId = stable("source");
      try {
        await this.db
          .collection("external_game_data")
          .updateOne(
            { _id: sourceId },
            { $setOnInsert: { ownerId, provider, externalId, itemId } },
            { upsert: true },
          );
      } catch (e) {
        if ((e as any).code !== 11000) throw e;
      }
      const reserved = await this.db
        .collection("external_game_data")
        .findOne({ _id: sourceId, ownerId });
      if (reserved?.itemId && reserved.itemId.toString() !== itemId.toString())
        throw new ConflictException("Esta origem já foi vinculada a outro jogo.");
      if (!reserved?.itemId) {
        const reservation = await this.db
          .collection("external_game_data")
          .updateOne({ _id: sourceId, itemId: { $exists: false } }, { $set: { itemId } });
        if (!reservation.matchedCount)
          throw new ConflictException("A origem foi vinculada em outra solicitação.");
      }
      if (linked) {
        if (linked.archived)
          throw new BadRequestException("Restaure o jogo antes de importar horas.");
        // Horas externas são um total, nunca uma nova sessão. O maior total evita somar novamente a cada importação.
        const filter = {
          _id: itemId,
          ownerId,
          archived: { $ne: true },
          playtimeMinutes: linked.playtimeMinutes ?? { $exists: false },
        };
        const result = await this.db.collection("library_items").updateOne(filter, {
          $max: { playtimeMinutes: game.playtimeMinutes || 0 },
          $set: { updatedAt: now },
        });
        if (!result.matchedCount)
          throw new ConflictException("As horas mudaram. Atualize e tente novamente.");
      } else {
        // Importação não inventa início, conclusão, datas de sessões ou atividades sociais.
        try {
          await this.db.collection("library_items").updateOne(
            { _id: itemId, ownerId, kind: "game", archived: { $ne: true } },
            {
              $setOnInsert: {
                title: game.title,
                kind: "game",
                status: "planned",
                priority: "none",
                archived: false,
                notes: "",
                stars: 0,
                feeling: "",
                genres: [],
                platform: game.platform || (provider === "steam" ? "PC" : provider),
                catalogKey: "external:" + key,
                createdAt: now,
                updatedAt: now,
              },
              $max: { playtimeMinutes: game.playtimeMinutes || 0 },
            },
            { upsert: true },
          );
        } catch (e) {
          if ((e as any).code === 11000)
            throw new ConflictException("O acompanhamento mudou. Atualize e tente novamente.");
          throw e;
        }
      }
    }
    if (dto.collection)
      await this.db.collection("collector_copies").updateOne(
        { _id: stable("collection"), ownerId },
        {
          $setOnInsert: {
            title: game.title,
            kind: "game",
            format: "digital",
            platform: game.platform || (provider === "steam" ? "PC" : provider),
            edition: provider,
            notes: "",
            genres: [],
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    // Fonte e contagem permanecem privadas e separadas de conquistas/XP do NextPlay.
    await this.db.collection("external_game_data").updateOne(
      { _id: stable("source") },
      {
        $set: {
          ownerId,
          provider,
          externalId,
          title: game.title,
          playtimeMinutes: game.playtimeMinutes ?? null,
          achievementsUnlocked: game.achievementsUnlocked ?? null,
          achievementsTotal: game.achievementsTotal ?? null,
          source: preview.source,
          psnOnlineId:
            provider === "playstation" && preview.source === "psn-api" ? preview.psnOnlineId : null,
          steamAccountId:
            provider === "steam" &&
            preview.source === "steam-api" &&
            /^7656119\d{10}$/.test(preview.steamId || "")
              ? preview.steamId
              : null,
          checkedAt: now,
          ...(dto.tracking ? { itemId } : {}),
        },
      },
      { upsert: true },
    );
    if (dto.tracking && provider === "steam" && /^[1-9]\d{0,14}$/.test(externalId)) {
      // O selo só contém o identificador do jogo; a conta de origem fica na consulta privada dos detalhes.
      await this.db
        .collection("library_items")
        .updateOne({ _id: itemId, ownerId }, { $set: { steamImportAppId: externalId } });
    }
    return { imported: true, itemId: dto.tracking ? itemId.toString() : null };
  }
  async fromPsn(owner: string, games: ImportGameDto[], onlineId: string) {
    return this.stage(owner, "playstation", games, "psn-api", undefined, onlineId);
  }
  async psnTrophies(
    owner: string,
    id: string,
    externalId: string,
    request: Request,
    psn: PsnConnectionService,
  ) {
    const row = await this.owned(owner, id);
    if (
      row.source !== "psn-api" ||
      !row.psnOnlineId ||
      !row.games.some((game: ImportGameDto) => game.externalId === externalId)
    )
      throw new BadRequestException("Jogo não pertence à prévia PSN.");
    const stats = await psn.trophies(owner, request, externalId, row.psnOnlineId);
    await this.db
      .collection("game_import_previews")
      .updateOne(
        { _id: id as any, ownerId: row.ownerId, "games.externalId": externalId },
        {
          $set: {
            "games.$.achievementsUnlocked": stats.achievementsUnlocked,
            "games.$.achievementsTotal": stats.achievementsTotal,
          },
        },
      );
    return stats;
  }
  async disconnectPsn(owner: string) {
    await this.db
      .collection("game_import_previews")
      .deleteMany({ ownerId: new Types.ObjectId(owner), source: "psn-api" });
  }
  async discardPreview(owner: string, id: string) {
    await this.db
      .collection("game_import_previews")
      .deleteOne({ _id: id as any, ownerId: new Types.ObjectId(owner) });
  }
  async stats(owner: string, itemId: string) {
    if (!/^[a-f0-9]{24}$/.test(itemId)) throw new NotFoundException();
    const ownerId = new Types.ObjectId(owner);
    if (
      !(await this.db
        .collection("library_items")
        .findOne({ _id: new Types.ObjectId(itemId), ownerId, kind: "game" }))
    )
      throw new NotFoundException();
    return {
      sources: (
        await this.db
          .collection("external_game_data")
          .find(
            { ownerId, itemId: new Types.ObjectId(itemId) },
            { projection: { _id: 0, ownerId: 0, itemId: 0 } },
          )
          .toArray()
      ).map((row) => ({
        ...row,
        gameUrl:
          row.provider === "steam" && /^[1-9]\d{0,14}$/.test(row.externalId)
            ? "https://store.steampowered.com/app/" + row.externalId
            : null,
        accountUrl:
          row.provider === "steam" &&
          row.source === "steam-api" &&
          /^7656119\d{10}$/.test(row.steamAccountId || "")
            ? "https://steamcommunity.com/profiles/" + row.steamAccountId
            : null,
      })),
    };
  }
}
@ApiTags("game-imports")
@ApiCookieAuth("session")
@Controller("game-imports")
@ApiResponse({ status: 401, description: "Sessão ausente ou expirada." })
class GameImportsController {
  constructor(
    private readonly service: GameImportsService,
    private readonly auth: AuthService,
    private readonly steamConnection: SteamConnectionService,
    private readonly psnConnection: PsnConnectionService,
  ) {}
  private async owner(req: Request) {
    if (req.method !== "GET" && req.headers.origin !== getConfig().origin)
      throw new ForbiddenException("Origem não permitida.");
    const owner = (await this.auth.forRequest(req)).id;
    this.service.limit(owner);
    return owner;
  }
  @Get()
  @ApiOperation({
    summary: "Consultar integrações disponíveis",
    description:
      "Steam automática depende de STEAM_WEB_API_KEY no servidor e biblioteca pública. Login Steam por OpenID disponível; retorna steamConnection (connected, steamId, profileUrl, revision, lastResult). PSN experimental retorna psnConnection (connected, onlineId, expiresAt, experimental), token temporário só em memória. Arquivo interoperável aceita Steam/Xbox/PlayStation/Epic/GOG/Nintendo; não representa conexão automática com essas contas.",
  })
  async status(@Req() req: Request) {
    await this.owner(req);
    return {
      ...this.service.status(),
      steamConnection: await this.steamConnection.status((await this.auth.forRequest(req)).id),
      psnConnection: this.psnConnection.status((await this.auth.forRequest(req)).id, req),
    };
  }
  @Post("psn/connect")
  @ApiOperation({
    summary: "Conectar PSN experimental por NPSSO",
    description:
      "Exige sessão NextPlay, mesma origem e consentimento true. Consulta somente a conta autenticada (me). NPSSO nunca é salvo; token de acesso vive até uma hora em memória, vinculado à sessão NextPlay. Reinício do servidor/expiração exige reconexão. Retorna somente connected, onlineId, expiresAt e experimental. Integração comunitária não oficial.",
  })
  async connectPsn(@Req() req: Request, @Body() dto: PsnConnectDto) {
    return this.psnConnection.connect(await this.owner(req), req, dto.npsso);
  }
  @Delete("psn/connection")
  @ApiOperation({
    summary: "Desconectar PSN experimental",
    description:
      "Apaga token em memória e prévias PSN; mantém dados/jogos já importados. Invalida consultas/conexões pendentes.",
  })
  async disconnectPsn(@Req() req: Request) {
    const owner = await this.owner(req);
    this.psnConnection.disconnect(owner);
    await this.service.disconnectPsn(owner);
    return { disconnected: true };
  }
  @Post("psn/library")
  @ApiOperation({
    summary: "Consultar jogos jogados da própria PSN",
    description:
      "Histórico paginado consultado apenas como me; até dez mil jogos. Não equivale a biblioteca completa de compras/posse. Horas ausentes não são inventadas; versões PS4/PS5 permanecem distintas. Retorna prévia privada para revisão, sem importar/concluir ou criar sessões. 400 para sessão PSN expirada; 502 para indisponibilidade/resposta inválida.",
  })
  async psnLibrary(@Req() req: Request) {
    const owner = await this.owner(req),
      data = await this.psnConnection.games(owner, req);
    const preview = await this.service.fromPsn(owner, data.games, data.onlineId);
    if (!this.psnConnection.current(owner, req, data.connectionId)) {
      await this.service.discardPreview(owner, preview.id);
      throw new ConflictException("A conexão PSN mudou. Consulte novamente.");
    }
    return preview;
  }
  @Post("preview/:id/:externalId/psn-trophies")
  @ApiOperation({
    summary: "Consultar contagem de troféus PSN de jogo da prévia",
    description:
      "Apenas mesma conta da prévia, por ID exato da versão; deduplica conjuntos de troféus. Não compara nomes, não infere conclusão/platinado e não concede conquistas NextPlay. Falhas/ausência não viram zero.",
  })
  async psnTrophies(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("externalId") externalId: string,
  ) {
    return this.service.psnTrophies(await this.owner(req), id, externalId, req, this.psnConnection);
  }
  @Post("steam/connect")
  @ApiOperation({
    summary: "Iniciar conexão da conta Steam",
    description:
      "Exige sessão NextPlay e mesma origem. Retorna url oficial OpenID; estado aleatório, vinculado à sessão, uso único e validade de dez minutos. Não solicita senha ou chave do usuário e não importa jogos automaticamente.",
  })
  async connect(@Req() req: Request) {
    return this.steamConnection.begin(await this.owner(req), req);
  }
  @Get("steam/callback")
  @ApiOperation({
    summary: "Retorno do login oficial Steam",
    description:
      "Parâmetros OpenID assinados do provedor; valida estado/sessão, destino exato, identidade Steam, nonce recente/único e assinatura por verificação direta na Steam. Conecta conta ao usuário autenticado e redireciona para Minha conta/Integrações. Cancelamento/erro preservam conexão anterior. Não cria sessão NextPlay nem altera títulos.",
  })
  async callback(@Req() req: Request, @Res() res: Response) {
    const owner = await this.owner(req);
    try {
      await this.steamConnection.complete(owner, req);
    } catch {
      res.redirect(303, getConfig().origin + "/conta");
      return;
    }
    res.redirect(303, getConfig().origin + "/conta");
  }
  @Delete("steam/connection")
  @ApiOperation({
    summary: "Desconectar conta Steam",
    description:
      "Exige sessão e mesma origem. Apaga vínculo, tentativas pendentes e prévias Steam; preserva jogos/horas/conquistas externas já importados. Não revoga nem altera a conta Steam.",
  })
  async disconnect(@Req() req: Request) {
    await this.steamConnection.disconnect(await this.owner(req));
    return { disconnected: true };
  }
  @Post("steam/library")
  @ApiOperation({
    summary: "Consultar biblioteca da conta Steam conectada",
    description:
      "Obtém SteamID somente do vínculo validado no servidor. Requer STEAM_WEB_API_KEY e detalhes de jogos públicos; login não contorna privacidade. Retorna prévia sem aplicar importação; 400 sem conexão, 503 sem chave, 502 se consulta falhar.",
  })
  async connectedLibrary(@Req() req: Request) {
    const owner = await this.owner(req),
      connection = await this.steamConnection.status(owner);
    const preview = await this.service.fromSteam(owner, await this.steamConnection.steamId(owner));
    if ((await this.steamConnection.status(owner)).revision !== connection.revision) {
      await this.service.discardPreview(owner, preview.id);
      throw new ConflictException("A conexão Steam mudou. Consulte novamente.");
    }
    return preview;
  }
  @Post("steam")
  @ApiOperation({
    summary: "Pré-visualizar biblioteca pública Steam",
    description:
      "Somente consulta; nenhuma importação é aplicada. Prévia privada expira em uma hora, até dez mil jogos; resposta paginada vinte jogos. Não aceita credenciais de usuário. 503 sem chave do aplicativo; 502 se indisponível/privado.",
  })
  async steam(@Req() req: Request, @Body() dto: SteamDto) {
    return this.service.fromSteam(await this.owner(req), dto.steamId);
  }
  @Post("file")
  @ApiOperation({
    summary: "Pré-visualizar arquivo interoperável de jogos",
    description:
      "Até duzentos jogos por arquivo JSON (100 KiB). provider e games conforme DTO. Contagens de conquistas são externas e autodeclaradas. Não cria posse nem consumo até confirmar cada jogo.",
  })
  async file(@Req() req: Request, @Body() dto: FileDto) {
    return this.service.file(await this.owner(req), dto);
  }
  @Get("preview/:id")
  @ApiOperation({
    summary: "Paginar prévia privada",
    description:
      "Vinte jogos; offset 0..10000. Retorna id, provider, source, total, games e nextOffset. 404 para outra conta ou prévia expirada.",
  })
  async preview(@Req() req: Request, @Param("id") id: string, @Query() q: PageQuery) {
    return this.service.preview(await this.owner(req), id, q.offset || 0);
  }
  @Post("preview/:id/:externalId/achievements")
  @ApiOperation({
    summary: "Consultar conquistas externas de um jogo Steam da prévia",
    description:
      "Só contagens; não concede conquistas/XP NextPlay. 502 se privadas/ausentes; não converte ausência em zero. Não consulta todas as conquistas da biblioteca automaticamente.",
  })
  async achievements(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("externalId") externalId: string,
  ) {
    return this.service.achievements(await this.owner(req), id, externalId);
  }
  @Post("preview/:id/:externalId/apply")
  @ApiOperation({
    summary: "Confirmar importação de um jogo revisado",
    description:
      "Acervo e acompanhamento independentes; reenvios não duplicam por origem. Novo acompanhamento entra em Para depois, sem conclusão ou sessões inventadas. itemId vincula jogo próprio existente explicitamente, preservando status, notas, plataforma e sessões: horas passam ao maior total atual/importado. Conquistas externas ficam separadas. Não conecta contas nem importa automaticamente todo o arquivo. 409 se destino mudou/horas concorrentes; 404 se jogo alheio ou prévia expirada.",
  })
  async apply(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("externalId") externalId: string,
    @Body() dto: ApplyDto,
  ) {
    return this.service.apply(await this.owner(req), id, externalId, dto);
  }
  @Get("stats/:itemId")
  @ApiOperation({
    summary: "Consultar dados externos privados de um jogo próprio",
    description:
      "Retorna sources com plataforma, contagens externas, horas da origem, tipo de importação, checkedAt, gameUrl e accountUrl nulos quando não registrados. SteamAccountId é snapshot privado da conta consultada na importação; não usa a conta conectada atualmente para atribuir importações antigas. Não mistura com conquistas/XP NextPlay.",
  })
  async stats(@Req() req: Request, @Param("itemId") itemId: string) {
    return this.service.stats(await this.owner(req), itemId);
  }
}
@Module({
  imports: [AuthModule],
  controllers: [GameImportsController],
  providers: [GameImportsService, SteamConnectionService, PsnGateway, PsnConnectionService],
})
export class GameImportsModule {}
