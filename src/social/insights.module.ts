import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayUnique, IsArray, IsString, MaxLength, Matches } from "class-validator";
import { CatalogModule, CatalogService } from "../catalog/catalog.module";
import { getConfig } from "../config";
import { Connection, Types } from "mongoose";
import type { Request } from "express";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";

type Row = Record<string, any>;
class MetadataDto {
  @ApiProperty({
    type: [String],
    maxItems: 10,
    description:
      "Até dez títulos próprios por chamada. Atualiza créditos e coleção de filmes TMDB; falhas não inventam metadados.",
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @Matches(/^[a-f0-9]{24}$/, { each: true })
  ids!: string[];
}
class AnnotationDto {
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(/\S/, { each: true })
  actors!: string[];
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(/\S/, { each: true })
  directors!: string[];
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(/\S/, { each: true })
  authors!: string[];
  @ApiProperty({
    maxLength: 160,
    description:
      "Franquia declarada pelo usuário, para qualquer mídia. Vazio remove o agrupamento manual.",
  })
  @IsString()
  @MaxLength(160)
  franchise!: string;
}
export type HistoryEvent = {
  id: string;
  itemId: string;
  title: string;
  kind: string;
  type: string;
  date: string | null;
  minutes: number | null;
  season?: number;
  episode?: number;
};
function day(value: unknown, timeZone = "UTC"): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isFinite(value.getTime())) return null;
  const date = value instanceof Date ? value.toISOString() : String(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date))) return null;
  if (date.length === 10)
    return new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date ? date : null;
  // Timestamps respeitam o fuso da conta; datas explícitas não mudam de dia ao converter.
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(date));
    const part = (type: string) => parts.find((part) => part.type === type)!.value;
    return part("year") + "-" + part("month") + "-" + part("day");
  } catch {
    return date.slice(0, 10);
  }
}
export function consumptionHistory(
  items: Row[],
  episodes: Row[],
  seasons: Row[],
  timeZone = "UTC",
): HistoryEvent[] {
  const result: HistoryEvent[] = [];
  for (const item of items) {
    const itemId = String(item._id),
      base = { itemId, title: item.title, kind: item.kind };
    if (item.status === "completed")
      result.push({
        ...base,
        id: itemId + ":first",
        type: "completed",
        date: item.watchedDateUnknown ? null : day(item.completedOn || item.completedAt, timeZone),
        minutes: item.kind === "movie" && item.runtime > 0 ? item.runtime : null,
      });
    for (const cycle of item.rewatches || [])
      if (cycle.completedAt && item.kind === "movie")
        result.push({
          ...base,
          id: itemId + ":rewatch:" + cycle.id,
          type: "rewatch",
          date: cycle.watchedDateUnknown
            ? null
            : day(cycle.completedOn || cycle.completedAt, timeZone),
          minutes: item.runtime > 0 ? item.runtime : null,
        });
    for (const session of item.gameSessions || [])
      result.push({
        ...base,
        id: itemId + ":session:" + session.id,
        type: "session",
        date: day(session.playedOn),
        minutes: session.minutes,
      });
    const legacyGameTime =
      item.kind === "game"
        ? Math.max(
            0,
            (item.playtimeMinutes || 0) -
              (item.gameSessions || []).reduce(
                (total: number, session: Row) => total + (session.minutes || 0),
                0,
              ),
          )
        : 0;
    if (legacyGameTime)
      result.push({
        ...base,
        id: itemId + ":undated-time",
        type: "undated-game-time",
        date: null,
        minutes: legacyGameTime,
      });
    const progressIds = new Set([itemId, ...(item.rewatches || []).map((cycle: Row) => cycle.id)]);
    for (const episode of episodes.filter((row) => progressIds.has(String(row.itemId)))) {
      const season = seasons.find(
        (row) => row.catalogId === item.catalogId && row.number === episode.season,
      );
      const runtime = season?.episodes?.find((row: Row) => row.number === episode.episode)?.runtime;
      result.push({
        ...base,
        id: String(episode._id),
        type: String(episode.itemId) === itemId ? "episode" : "episode-rewatch",
        season: episode.season,
        episode: episode.episode,
        date: episode.watchedDateUnknown ? null : day(episode.watchedAt, timeZone),
        minutes: runtime > 0 ? runtime : null,
      });
    }
  }
  // Sem data fica separado do ano do cadastro; a ordenação usa um desempate estável.
  return result.sort(
    (a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id),
  );
}
export function annualInsights(items: Row[], events: HistoryEvent[]) {
  const years = [
    ...new Set(events.flatMap((event) => (event.date ? [event.date.slice(0, 4)] : []))),
  ]
    .sort()
    .reverse();
  const ranking = (rows: Row[]) =>
    rows
      .filter((row) => row.stars >= 1 && row.stars <= 5)
      .map((row) => ({
        id: String(row._id),
        title: row.title,
        kind: row.kind,
        stars: row.stars,
        coverUrl: row.coverUrl || "",
      }))
      .sort(
        (a, b) => b.stars - a.stars || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
      );
  return {
    unknownDates: events.filter((event) => !event.date).length,
    allTimeFavorites: ranking(items.filter((item) => item.status === "completed")),
    years: years.map((year) => {
      const rows = events.filter((event) => event.date?.startsWith(year));
      const completedIds = new Set(
        rows
          .filter((event) => event.type === "completed" || event.type === "episode")
          .map((event) => event.itemId),
      );
      const consumed = items.filter((item) => completedIds.has(String(item._id)));
      const genres = new Map<string, number>();
      for (const item of consumed)
        for (const genre of new Set<string>(item.genres || []))
          genres.set(genre, (genres.get(genre) || 0) + 1);
      const rated = consumed.filter((item) => item.stars >= 1 && item.stars <= 5);
      return {
        year,
        movies: rows.filter((row) => row.kind === "movie" && row.type === "completed").length,
        books: rows.filter((row) => row.kind === "book" && row.type === "completed").length,
        games: rows.filter((row) => row.kind === "game" && row.type === "completed").length,
        episodes: rows.filter((row) => row.type === "episode").length,
        rewatches: rows.filter((row) => row.type === "rewatch" || row.type === "episode-rewatch")
          .length,
        minutes: rows.reduce((total, row) => total + (row.minutes || 0), 0),
        gameMinutes: rows
          .filter((row) => row.type === "session")
          .reduce((total, row) => total + (row.minutes || 0), 0),
        missingRuntime: rows
          .filter(
            (row) =>
              ["episode", "episode-rewatch", "rewatch"].includes(row.type) || row.kind === "movie",
          )
          .filter((row) => row.minutes === null).length,
        average: rated.length
          ? rated.reduce((total, row) => total + row.stars, 0) / rated.length
          : null,
        genres: [...genres]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        ranking: ranking(consumed),
        activeDays: new Set(rows.map((row) => row.date)).size,
      };
    }),
  };
}
@Injectable()
class InsightsService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly catalog: CatalogService,
  ) {}
  async onModuleInit() {
    await this.db
      .collection("library_activity_history")
      .createIndex({ ownerId: 1, sourceKey: 1 }, { unique: true });
    await this.db.collection("library_activity_history").createIndex({ ownerId: 1, _id: -1 });
  }
  async activity(owner: string, before?: string) {
    if (before && !/^[a-f0-9]{24}$/i.test(before))
      throw new BadRequestException("Cursor inválido.");
    const rows = await this.db
      .collection("library_activity_history")
      .find({
        ownerId: new Types.ObjectId(owner),
        ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {}),
      })
      .sort({ _id: -1 })
      .limit(31)
      .toArray();
    return {
      events: rows.slice(0, 30).map((row) => ({
        id: String(row._id),
        title: row.title,
        kind: row.kind,
        type: row.type,
        recordedAt: row.recordedAt,
      })),
      nextBefore: rows.length > 30 ? String(rows[29]._id) : null,
    };
  }
  async annotate(owner: string, id: string, dto: AnnotationDto) {
    if (
      !/^[a-f0-9]{24}$/.test(id) ||
      !(await this.db
        .collection("library_items")
        .findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(owner) }))
    )
      throw new BadRequestException("Título próprio não encontrado.");
    await this.db
      .collection("insight_annotations")
      .updateOne(
        { _id: new Types.ObjectId(id) },
        { $set: { ...dto, ownerId: new Types.ObjectId(owner) } },
        { upsert: true },
      );
    return { saved: true };
  }
  async metadata(owner: string, ids: string[], language: string) {
    const items = await this.db
      .collection("library_items")
      .find({
        ownerId: new Types.ObjectId(owner),
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
      })
      .toArray();
    if (items.length !== ids.length)
      throw new BadRequestException("Título próprio não encontrado.");
    for (const _item of items) this.catalog.limit(owner);
    // O lote pequeno é paralelo e limitado por usuário, evitando dez timeouts em sequência.
    const results = await Promise.all(
      items.map(async (item) => {
        if (!/^tmdb:(movie|series):[1-9]\d{0,14}$/.test(item.catalogId || ""))
          return { id: item._id.toString(), unsupported: true };
        const [actors, directors, franchise] = await Promise.allSettled([
          this.catalog.cast(item.catalogId, language),
          this.catalog.directors(item.catalogId),
          this.catalog.franchise(item.catalogId),
        ]);
        const value = {
          actors:
            actors.status === "fulfilled"
              ? actors.value.map((row) => ({ id: row.id.split(":")[0], name: row.actor }))
              : null,
          directors: directors.status === "fulfilled" ? directors.value.directors : null,
          franchise: franchise.status === "fulfilled" ? franchise.value : null,
          partial: [actors, directors, franchise].some((row) => row.status === "rejected"),
        };
        await this.db.collection("catalog_insight_metadata").updateOne(
          { _id: item.catalogId as any },
          {
            $set: {
              value,
              expires: new Date(Date.now() + (value.partial ? 60000 : 7 * 86400000)),
            },
          },
          { upsert: true },
        );
        return { id: item._id.toString(), partial: value.partial };
      }),
    );
    return { results };
  }
  private async data(owner: string) {
    const items = await this.db
      .collection("library_items")
      .find({ ownerId: new Types.ObjectId(owner) }, { projection: { notes: 0 } })
      .toArray();
    const ids = items.flatMap((item) => [
      item._id,
      ...(item.rewatches || []).map((cycle: Row) => new Types.ObjectId(cycle.id)),
    ]);
    const [episodes, seasons] = await Promise.all([
      this.db
        .collection("episode_progress")
        .find(
          { itemId: { $in: ids } },
          { projection: { itemId: 1, season: 1, episode: 1, watchedAt: 1, watchedDateUnknown: 1 } },
        )
        .toArray(),
      this.db
        .collection("series_seasons")
        .find(
          { catalogId: { $in: items.map((item) => item.catalogId).filter(Boolean) } },
          { projection: { catalogId: 1, number: 1, "episodes.number": 1, "episodes.runtime": 1 } },
        )
        .toArray(),
    ]);
    const profile = await this.db
      .collection("achievement_profiles")
      .findOne({ ownerId: new Types.ObjectId(owner) }, { projection: { timeZone: 1 } });
    return {
      items,
      events: consumptionHistory(
        items,
        episodes,
        seasons,
        typeof profile?.timeZone === "string" ? profile.timeZone : "UTC",
      ),
    };
  }
  async summary(owner: string) {
    const { items, events } = await this.data(owner);
    const consumedIds = new Set(
      events
        .filter((event) => ["completed", "episode"].includes(event.type))
        .map((event) => event.itemId),
    );
    const consumed = items.filter((item) => consumedIds.has(String(item._id)));
    const cache = await this.db
      .collection("catalog_insight_metadata")
      .find({ _id: { $in: consumed.map((item) => item.catalogId).filter(Boolean) as any } })
      .toArray();
    const scores = await this.db
      .collection("catalog_critic_scores")
      .find({ _id: { $in: consumed.map((item) => item.catalogId).filter(Boolean) as any } })
      .toArray();
    const criticComparison = consumed
      .filter((item) => item.stars >= 1 && item.stars <= 5)
      .flatMap((item) => {
        const score = scores.find((row) => String(row._id) === item.catalogId);
        return score?.value?.tomatometer !== null && score?.value?.tomatometer !== undefined
          ? [
              {
                title: item.title,
                personal: item.stars * 20,
                critics: score.value.tomatometer,
                difference: item.stars * 20 - score.value.tomatometer,
                url: score.value.url,
                queriedAt: score.queriedAt,
              },
            ]
          : [];
      });
    const annotations = await this.db
      .collection("insight_annotations")
      .find({ ownerId: new Types.ObjectId(owner), _id: { $in: items.map((item) => item._id) } })
      .toArray();
    const creators = new Map<string, { role: string; name: string; count: number }>(),
      franchises = new Map<
        string,
        { name: string; count: number; ratingTotal: number; rated: number }
      >();
    let missingCredits = 0;
    for (const item of consumed) {
      const saved = cache.find((row) => String(row._id) === item.catalogId),
        value = saved?.value,
        manual = annotations.find((row) => row._id.equals(item._id));
      const add = (role: string, id: string, name: string) => {
        const key = role + ":" + id;
        const old = creators.get(key) || { role, name, count: 0 };
        old.count++;
        creators.set(key, old);
      };
      for (const author of new Set<string>(
        manual?.authors.length ? manual.authors : item.authors || [],
      ))
        add("author", author.toLocaleLowerCase(), author);
      if (["movie", "series"].includes(item.kind) && !manual && (!value || value.partial))
        missingCredits++;
      for (const role of ["actors", "directors"]) {
        const people = manual?.[role]?.length
          ? manual[role].map((name: string) => ({ id: "manual:" + name.toLocaleLowerCase(), name }))
          : value?.[role] || [];
        for (const person of [
          ...new Map<string, Row>(people.map((row: Row) => [String(row.id), row])).values(),
        ])
          add(role === "actors" ? "actor" : "director", String(person.id), person.name);
      }
      const franchise = manual?.franchise.trim()
        ? {
            id: "manual:" + manual.franchise.trim().toLocaleLowerCase(),
            name: manual.franchise.trim(),
          }
        : value?.franchise;
      if (franchise) {
        const key = String(franchise.id),
          row = franchises.get(key) || { name: franchise.name, count: 0, ratingTotal: 0, rated: 0 };
        row.count++;
        if (item.stars >= 1 && item.stars <= 5) {
          row.ratingTotal += item.stars;
          row.rated++;
        }
        franchises.set(key, row);
      }
    }
    return {
      ...annualInsights(items, events),
      annotations: annotations.map(({ _id, ownerId, ...row }) => ({ itemId: String(_id), ...row })),
      criticComparison,
      creators: [...creators.values()].sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      ),
      missingCredits,
      franchises: [...franchises.values()]
        .map((row) => ({
          name: row.name,
          count: row.count,
          average: row.rated ? row.ratingTotal / row.rated : null,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      pendingMetadataIds: consumed
        .filter(
          (item) =>
            /^tmdb:(movie|series):/.test(item.catalogId || "") &&
            !cache.some((row) => String(row._id) === item.catalogId && row.expires > new Date()),
        )
        .slice(0, 10)
        .map((item) => String(item._id)),
    };
  }
  async history(owner: string, before?: string) {
    let boundary: string[] | null = null;
    if (before) {
      try {
        boundary = JSON.parse(Buffer.from(before, "base64url").toString());
        if (
          !Array.isArray(boundary) ||
          boundary.length !== 2 ||
          boundary.some((value) => typeof value !== "string" || value.length > 150)
        )
          throw Error();
      } catch {
        throw new BadRequestException("Cursor inválido.");
      }
    }
    const { events } = await this.data(owner);
    const rows = boundary
      ? events.filter(
          (event) =>
            (event.date || "") < boundary![0] ||
            ((event.date || "") === boundary![0] && event.id < boundary![1]),
        )
      : events;
    const page = rows.slice(0, 30),
      last = page.at(-1);
    return {
      events: page,
      nextBefore:
        rows.length > 30 && last
          ? Buffer.from(JSON.stringify([last.date || "", last.id])).toString("base64url")
          : null,
    };
  }
}
@ApiTags("perfil-estatisticas")
@ApiCookieAuth("session")
@Controller("insights")
class InsightsController {
  constructor(
    private readonly service: InsightsService,
    private readonly auth: AuthService,
  ) {}
  @Get("activity")
  @ApiQuery({ name: "before", required: false })
  @ApiOperation({
    summary: "Histórico privado de ações registradas no app",
    description:
      "Até 30 registros por página, nextBefore. Cobertura inicia nesta atualização: adições/inícios/conclusões, edições de item, arquivo/restauração e exclusão; sem texto de notas. recordedAt indica registro, não consumo. Não reconstrói mudanças históricas nunca gravadas. Excluir acompanhamento preserva o retrato mínimo privado do evento.",
  })
  async activity(@Req() req: Request, @Query("before") before?: string) {
    return this.service.activity((await this.auth.forRequest(req)).id, before);
  }
  @Post("annotations/:id")
  @ApiOperation({
    summary: "Completar créditos e franquia privados de uma obra",
    description:
      "Somente título próprio. Até vinte nomes por categoria. Dados declarados, separados dos créditos do catálogo; não alteram metadados públicos, status ou XP. Nomes manuais não comprovam identidade de homônimos. Franquia manual suporta qualquer mídia.",
  })
  async annotate(@Req() req: Request, @Param("id") id: string, @Body() dto: AnnotationDto) {
    if (req.headers.origin !== getConfig().origin)
      throw new ForbiddenException("Origem não permitida.");
    return this.service.annotate((await this.auth.forRequest(req)).id, id, dto);
  }
  @Post("metadata")
  @ApiOperation({
    summary: "Atualizar créditos e franquias para rankings de consumo",
    description:
      "Lote de até dez IDs próprios. Usa elenco/direção TMDB e belongs_to_collection para franquias de filmes. Sem inventar elenco de obras manuais ou franquias de outras mídias. Cache compartilhado por catálogo; resumo indica cobertura parcial e próximos IDs. Não dispara chamadas externas durante leitura comum.",
  })
  async metadata(@Req() req: Request, @Body() dto: MetadataDto) {
    if (req.headers.origin !== getConfig().origin)
      throw new ForbiddenException("Origem não permitida.");
    const user = await this.auth.forRequest(req);
    return this.service.metadata(user.id, dto.ids, user.language);
  }
  @Get()
  @ApiOperation({
    summary: "Retrospectivas anuais, evolução de gêneros e rankings pessoais",
    description:
      "Privado. Inclui arquivados. Usa datas reais de conclusão, episódios e sessões; sem data entra em unknownDates, nunca no ano do cadastro. Notas são as avaliações atuais, não sua evolução histórica. Reassistidas separadas. Tempo pode ser parcial por falta de duração; horas antigas de jogos sem sessão não são atribuídas a um ano. years permite comparar todos os anos; ranking por estrelas atuais.",
  })
  async summary(@Req() req: Request) {
    return this.service.summary((await this.auth.forRequest(req)).id);
  }
  @Get("history")
  @ApiQuery({ name: "before", required: false, type: String })
  @ApiOperation({
    summary: "Linha do tempo privada de consumo, revisitas e sessões",
    description:
      "30 eventos por página e nextBefore. Datas desconhecidas ao final, date=null. Não fabrica eventos de consumo para datas de cadastro ou reconhecimento de XP. Exclusão de item remove seus eventos da visão; preservar arquivo mantém histórico.",
  })
  async history(@Req() req: Request, @Query("before") before?: string) {
    if (before && before.length > 500) throw new BadRequestException("Cursor inválido.");
    return this.service.history((await this.auth.forRequest(req)).id, before);
  }
}
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
