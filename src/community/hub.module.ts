import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { Connection, Types } from "mongoose";
import type { Request } from "express";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { getConfig } from "../config";
class TopicDto {
  @ApiProperty({ enum: ["discussion", "theory", "group-vote", "favorites-vote", "duel", "awards"] })
  @IsIn(["discussion", "theory", "group-vote", "favorites-vote", "duel", "awards"])
  type!: string;
  @ApiProperty({ enum: ["general", "work", "episode", "franchise", "universe"] })
  @IsIn(["general", "work", "episode", "franchise", "universe"])
  scope!: string;
  @ApiProperty({ minLength: 1, maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/)
  title!: string;
  @ApiProperty({ maxLength: 2000 }) @IsString() @MaxLength(2000) text!: string;
  @ApiProperty({
    required: false,
    description: "ID próprio obrigatório para work/episode; não é exposto a leitores.",
  })
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^[a-f0-9]{24}$/)
  itemId?: string;
  @ApiProperty({
    maxLength: 160,
    description:
      "Nome público do contexto; franquias/universos são organizados pela comunidade, sem alegar completude do catálogo.",
  })
  @IsString()
  @MaxLength(160)
  contextName!: string;
  @ApiProperty({ required: false, minimum: 0, maximum: 10000 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  season?: number;
  @ApiProperty({ required: false, minimum: 1, maximum: 100000 })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(100000)
  episode?: number;
  @ApiProperty({
    enum: ["community", "friends"],
    description: "group-vote exige friends. Demais tipos podem usar qualquer alcance.",
  })
  @IsIn(["community", "friends"])
  audience!: string;
  @ApiProperty({
    type: [String],
    maxItems: 20,
    description:
      "Votação: 2–20 opções únicas, até 100 caracteres. Duelo exige duas. Discussões/teorias exigem lista vazia.",
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(/\S/, { each: true })
  options!: string[];
  @ApiProperty({
    enum: ["title", "actor", "director", "character", "franchise", "episode", "game", "book"],
  })
  @IsIn(["title", "actor", "director", "character", "franchise", "episode", "game", "book"])
  optionType!: string;
  @ApiProperty({
    required: false,
    minimum: 1900,
    maximum: 2200,
    description:
      "Obrigatório para premiação anual. Premiação organizada pelo autor, não prêmio oficial do app.",
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1900)
  @Max(2200)
  year?: number;
  @ApiProperty({ format: "uuid", description: "Chave idempotente por autor." })
  @IsUUID()
  requestId!: string;
}
class PostDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/)
  text!: string;
  @ApiProperty({
    description:
      "true protege conteúdo. Ausente protege automaticamente; palavras como spoiler/morte/final/revelação mantêm proteção mesmo com false.",
    required: false,
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  spoiler?: boolean;
  @ApiProperty({
    required: false,
    description: "ID de mensagem raiz do mesmo tópico. Uma camada de respostas.",
  })
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^[a-f0-9]{24}$/)
  parentId?: string;
  @ApiProperty({ format: "uuid" }) @IsUUID() requestId!: string;
}
class VoteDto {
  @ApiProperty({
    minimum: 0,
    maximum: 19,
    description: "Índice da opção; reenviar substitui o voto anterior, não soma.",
  })
  @IsInt()
  @Min(0)
  @Max(19)
  option!: number;
}
class ClosedDto {
  @ApiProperty({ type: Boolean }) @IsBoolean() closed!: boolean;
}
export function protectSpoilers(text: string, explicit?: boolean) {
  return (
    explicit !== false ||
    /\b(spoilers?|morre|morte|assassino|final|revela[cç][aã]o|dies|ending|killer|plot twist)\b/i.test(
      text,
    )
  );
}
@Injectable()
class HubService implements OnModuleInit {
  constructor(@InjectConnection() private readonly db: Connection) {}
  async onModuleInit() {
    for (const name of ["community_topics", "community_posts"])
      await this.db.collection(name).createIndex({ ownerId: 1, requestId: 1 }, { unique: true });
    await this.db.collection("community_posts").createIndex({ topicId: 1, _id: 1 });
    await this.db
      .collection("community_votes")
      .createIndex({ topicId: 1, ownerId: 1 }, { unique: true });
  }
  private id(value: string) {
    if (!/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestException("Identificador inválido.");
    return new Types.ObjectId(value);
  }
  private async friendIds(viewer: string) {
    const rows = await this.db
      .collection("friendships")
      .find({ status: "accepted", $or: [{ sender: viewer }, { receiver: viewer }] })
      .toArray();
    return rows.map((row) => this.id(row.sender === viewer ? row.receiver : row.sender));
  }
  private async accessible(viewer: string, id: string) {
    const row = await this.db.collection("community_topics").findOne({ _id: this.id(id) });
    if (
      !row ||
      (row.audience === "friends" &&
        row.ownerId.toString() !== viewer &&
        !(await this.friendIds(viewer)).some((id) => id.equals(row.ownerId)))
    )
      throw new NotFoundException("Conversa não encontrada.");
    return row;
  }
  async index(viewer: string, before?: string, q = "") {
    if (typeof q !== "string" || q.length > 160) throw new BadRequestException("Busca inválida.");
    const friends = await this.friendIds(viewer),
      search = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rows = await this.db
      .collection("community_topics")
      .find({
        $or: [
          { audience: "community" },
          { ownerId: this.id(viewer) },
          { audience: "friends", ownerId: { $in: friends } },
        ],
        ...(search
          ? {
              $and: [
                {
                  $or: [
                    { title: { $regex: search, $options: "i" } },
                    { contextName: { $regex: search, $options: "i" } },
                  ],
                },
              ],
            }
          : {}),
        ...(before ? { _id: { $lt: this.id(before) } } : {}),
      })
      .sort({ _id: -1 })
      .limit(31)
      .toArray();
    return {
      topics: rows.slice(0, 30).map((row) => ({
        id: row._id.toString(),
        title: row.title,
        type: row.type,
        scope: row.scope,
        contextName: row.contextName,
        season: row.season,
        episode: row.episode,
        audience: row.audience,
        year: row.year,
        closed: row.closed,
      })),
      nextBefore: rows.length > 30 ? rows[29]._id.toString() : null,
    };
  }
  async create(viewer: string, dto: TopicDto) {
    const voting = !["discussion", "theory"].includes(dto.type);
    if (
      (voting && (dto.options.length < 2 || (dto.type === "duel" && dto.options.length !== 2))) ||
      (!voting && dto.options.length) ||
      (dto.type === "awards" && !dto.year) ||
      (dto.type === "group-vote" && dto.audience !== "friends")
    )
      throw new BadRequestException("Opções ou alcance incompatíveis com o tipo de tópico.");
    let contextKey = dto.scope + ":" + dto.contextName.trim().toLocaleLowerCase();
    if (["work", "episode"].includes(dto.scope)) {
      if (!dto.itemId) throw new BadRequestException("Escolha um título da biblioteca.");
      const item = await this.db
        .collection("library_items")
        .findOne({ _id: this.id(dto.itemId), ownerId: this.id(viewer) });
      if (!item) throw new BadRequestException("Título próprio não encontrado.");
      if (
        dto.scope === "episode" &&
        (item.kind !== "series" || dto.season === undefined || dto.episode === undefined)
      )
        throw new BadRequestException("Escolha série, temporada e episódio.");
      contextKey =
        item.catalogKey + (dto.scope === "episode" ? `:s${dto.season}:e${dto.episode}` : "");
    }
    if (["franchise", "universe"].includes(dto.scope) && !dto.contextName.trim())
      throw new BadRequestException("Informe o contexto.");
    const { requestId, itemId, ...fields } = dto;
    const signature = JSON.stringify({ ...dto, contextKey });
    const filter = { ownerId: this.id(viewer), requestId };
    try {
      await this.db.collection("community_topics").updateOne(
        filter,
        {
          $setOnInsert: {
            ...fields,
            _id: new Types.ObjectId(),
            contextKey,
            signature,
            createdAt: new Date(),
            closed: false,
            spoiler: true,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await this.db.collection("community_topics").findOne(filter);
    if (row!.signature !== signature)
      throw new BadRequestException("Envio já usado para outro tópico.");
    return this.get(viewer, row!._id.toString());
  }
  async get(viewer: string, id: string, after?: string) {
    const row = await this.accessible(viewer, id);
    const posts = await this.db
      .collection("community_posts")
      .find({ topicId: row._id, ...(after ? { _id: { $gt: this.id(after) } } : {}) })
      .sort({ _id: 1 })
      .limit(31)
      .toArray();
    const [votes, mine, users] = await Promise.all([
      Promise.resolve(
        (row.options as string[]).map((_, index) => ({
          _id: index,
          count: (row.votes || []).filter((vote: any) => vote.option === index).length,
        })),
      ),
      Promise.resolve((row.votes || []).find((vote: any) => vote.ownerId === viewer)),
      this.db
        .collection("users")
        .find(
          { _id: { $in: [row.ownerId, ...posts.map((post) => post.ownerId)] } },
          { projection: { displayName: 1 } },
        )
        .toArray(),
    ]);
    const name = (id: Types.ObjectId) =>
      users.find((user) => user._id.equals(id))?.displayName || "Player";
    return {
      id: row._id.toString(),
      title: row.title,
      text: row.text,
      spoiler: true,
      type: row.type,
      scope: row.scope,
      contextName: row.contextName,
      season: row.season,
      episode: row.episode,
      audience: row.audience,
      year: row.year,
      ownerName: name(row.ownerId),
      mine: row.ownerId.toString() === viewer,
      closed: row.closed,
      optionType: row.optionType,
      options: row.options.map((label: string, index: number) => ({
        label,
        count: votes.find((vote) => vote._id === index)?.count || 0,
      })),
      myVote: mine?.option ?? null,
      posts: posts.slice(0, 30).map((post) => ({
        id: post._id.toString(),
        text: post.text,
        spoiler: post.spoiler,
        parentId: post.parentId?.toString() || null,
        mine: post.ownerId.toString() === viewer,
        author: name(post.ownerId),
        createdAt: post.createdAt,
      })),
      nextAfter: posts.length > 30 ? posts[29]._id.toString() : null,
    };
  }
  async post(viewer: string, id: string, dto: PostDto) {
    const topic = await this.accessible(viewer, id);
    if (topic.closed) throw new BadRequestException("Conversa encerrada.");
    if (
      dto.parentId &&
      !(await this.db
        .collection("community_posts")
        .findOne({ _id: this.id(dto.parentId), topicId: topic._id, parentId: null }))
    )
      throw new BadRequestException("Resposta deve apontar para mensagem raiz do mesmo tópico.");
    const filter = { ownerId: this.id(viewer), requestId: dto.requestId };
    const signature = JSON.stringify({
      topic: id,
      text: dto.text,
      parentId: dto.parentId || null,
      spoiler: protectSpoilers(dto.text, dto.spoiler),
    });
    try {
      await this.db.collection("community_posts").updateOne(
        filter,
        {
          $setOnInsert: {
            _id: new Types.ObjectId(),
            topicId: topic._id,
            text: dto.text,
            parentId: dto.parentId ? this.id(dto.parentId) : null,
            spoiler: protectSpoilers(dto.text, dto.spoiler),
            signature,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const saved = await this.db.collection("community_posts").findOne(filter);
    if (saved!.signature !== signature)
      throw new BadRequestException("Envio já usado para outra mensagem.");
    const user = await this.db
      .collection("users")
      .findOne({ _id: this.id(viewer) }, { projection: { displayName: 1 } });
    // Confirma a mensagem criada mesmo quando ela ficou depois da primeira página.
    return {
      ...(await this.get(viewer, id)),
      posted: {
        id: String(saved!._id),
        text: saved!.text,
        spoiler: saved!.spoiler,
        parentId: saved!.parentId?.toString() || null,
        mine: true,
        author: user?.displayName || "Player",
        createdAt: saved!.createdAt,
      },
    };
  }
  async vote(viewer: string, id: string, option: number) {
    const topic = await this.accessible(viewer, id);
    if (!topic.options[option]) throw new BadRequestException("Opção inválida.");
    // Voto e estado aberto são verificados na mesma operação, inclusive durante encerramento concorrente.
    const updated = await this.db.collection("community_topics").findOneAndUpdate(
      {
        _id: topic._id,
        closed: false,
        $or: [{ "votes.ownerId": viewer }, { "votes.4999": { $exists: false } }],
      },
      [
        {
          $set: {
            votes: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ["$votes", []] },
                    as: "vote",
                    cond: { $ne: ["$$vote.ownerId", viewer] },
                  },
                },
                [{ ownerId: viewer, option }],
              ],
            },
          },
        },
      ],
      { returnDocument: "after" },
    );
    if (!updated)
      throw new BadRequestException("Votação encerrada ou limite de 5000 votos atingido.");
    return this.get(viewer, id);
  }
  async close(viewer: string, id: string, closed: boolean) {
    const topic = await this.accessible(viewer, id);
    if (topic.ownerId.toString() !== viewer)
      throw new ForbiddenException("Somente o autor encerra ou reabre.");
    await this.db
      .collection("community_topics")
      .updateOne({ _id: topic._id }, { $set: { closed } });
    return this.get(viewer, id);
  }
}
@ApiTags("comunidade")
@ApiCookieAuth("session")
@Controller("community")
class HubController {
  constructor(
    private readonly service: HubService,
    private readonly auth: AuthService,
  ) {}
  private async owner(req: Request) {
    if (req.method !== "GET" && req.headers.origin !== getConfig().origin)
      throw new ForbiddenException("Origem não permitida.");
    return (await this.auth.forRequest(req)).id;
  }
  @Get()
  @ApiQuery({ name: "before", required: false })
  @ApiQuery({
    name: "q",
    required: false,
    description: "Busca literal por título ou contexto, até 160 caracteres.",
  })
  @ApiOperation({
    summary: "Fóruns, teorias, votações, duelos e premiações",
    description:
      "30 tópicos por página; público para usuários autenticados ou amigos aceitos do autor. Publicações são explícitas e não importam notas privadas.",
  })
  async index(@Req() req: Request, @Query("before") before?: string, @Query("q") q?: string) {
    return this.service.index(await this.owner(req), before, q);
  }
  @Post()
  @ApiOperation({
    summary: "Criar discussão ou votação",
    description:
      "Contexto work/episode exige item próprio; episode exige série e números. Franquia/universo usam nome comunitário. Duelo exige 2 opções; demais votações 2–20. Premiação exige ano, é criada pelo autor e não representa prêmio oficial. Grupo exige friends. Texto inicial protegido como spoiler. requestId evita duplicação.",
  })
  async create(@Req() req: Request, @Body() dto: TopicDto) {
    return this.service.create(await this.owner(req), dto);
  }
  @Get(":id")
  @ApiQuery({ name: "after", required: false })
  @ApiOperation({
    summary: "Consultar tópico, mensagens e resultados",
    description:
      "30 mensagens por página em ordem crescente; nextAfter para próxima. Votos apenas agregados, myVote é exclusivo da sessão. Autores por nome público, nunca email, IDs de bibliotecas ou votos individuais alheios.",
  })
  async get(@Req() req: Request, @Param("id") id: string, @Query("after") after?: string) {
    return this.service.get(await this.owner(req), id, after);
  }
  @Post(":id/posts")
  @ApiOperation({
    summary: "Publicar mensagem ou resposta",
    description:
      "1–2000 caracteres. Uma camada de respostas, mesmo tópico. Proteção de spoilers automática por padrão; false permite texto comum salvo termos de risco. Heurística não garante detectar todo spoiler. requestId idempotente por autor; não permite publicar após encerramento. Resposta inclui posted com a mensagem confirmada, mesmo fora da primeira página.",
  })
  async post(@Req() req: Request, @Param("id") id: string, @Body() dto: PostDto) {
    return this.service.post(await this.owner(req), id, dto);
  }
  @Patch(":id/vote")
  @ApiOperation({
    summary: "Votar ou trocar voto",
    description:
      "Uma opção por conta; não publica quem votou. Só alcance autorizado e votação aberta. Reenvio não duplica contagem.",
  })
  async vote(@Req() req: Request, @Param("id") id: string, @Body() dto: VoteDto) {
    return this.service.vote(await this.owner(req), id, dto.option);
  }
  @Patch(":id/closed")
  @ApiOperation({ summary: "Encerrar/reabrir conversa ou votação própria" })
  async close(@Req() req: Request, @Param("id") id: string, @Body() dto: ClosedDto) {
    return this.service.close(await this.owner(req), id, dto.closed);
  }
}
export
@Module({ imports: [AuthModule], controllers: [HubController], providers: [HubService] })
class HubModule {}
