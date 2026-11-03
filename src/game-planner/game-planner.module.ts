import { Controller, Get, Injectable, Module, Query, Req } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { ApiCookieAuth, ApiOperation, ApiProperty, ApiTags, ApiResponse } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";
import type { Request } from "express";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { CatalogModule, CatalogService } from "../catalog/catalog.module";
class PlannerQuery {
  @ApiProperty({
    required: false,
    pattern: "^[a-f0-9]{24}$",
    description: "Cursor exclusivo da página anterior; vinte jogos por página.",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{24}$/)
  after?: string;
}
@Injectable()
export class GamePlannerService {
  constructor(
    @InjectConnection() private readonly db: Connection,
    private readonly catalog: CatalogService,
  ) {}
  async page(owner: string, after?: string) {
    const scope = {
      ownerId: new Types.ObjectId(owner),
      kind: "game",
      status: { $in: ["planned", "active"] },
      archived: { $ne: true },
    };
    const rows = await this.db
      .collection("library_items")
      .find(
        { ...scope, ...(after ? { _id: { $gt: new Types.ObjectId(after) } } : {}) },
        {
          projection: {
            title: 1,
            status: 1,
            priority: 1,
            platform: 1,
            catalogId: 1,
            parentGameCatalogId: 1,
            playtimeMinutes: 1,
            genres: 1,
            unreleased: 1,
            releaseDate: 1,
            coverUrl: 1,
          },
        },
      )
      .sort({ _id: 1 })
      .limit(21)
      .toArray();
    const items: any[] = [];
    // Poucas consultas simultâneas protegem o catálogo; falha por jogo não vira estimativa zero.
    for (let start = 0; start < Math.min(20, rows.length); start += 4) {
      items.push(
        ...(await Promise.all(
          rows.slice(start, Math.min(start + 4, 20)).map(async (row) => {
            try {
              return {
                ...row,
                id: row._id.toString(),
                _id: undefined,
                estimate: await this.catalog.gameEstimate(row.catalogId),
                estimateFailed: false,
              };
            } catch {
              return {
                ...row,
                id: row._id.toString(),
                _id: undefined,
                estimate: null,
                estimateFailed: true,
              };
            }
          }),
        )),
      );
    }
    return {
      items,
      total: await this.db.collection("library_items").countDocuments(scope),
      nextAfter: rows.length > 20 ? rows[19]._id.toString() : null,
    };
  }
}
@ApiTags("game-planner")
@ApiCookieAuth("session")
@Controller("game-planner")
@ApiResponse({ status: 401, description: "Sessão ausente ou expirada." })
class GamePlannerController {
  constructor(
    private readonly service: GamePlannerService,
    private readonly auth: AuthService,
  ) {}
  @Get()
  @ApiOperation({
    summary: "Estimar backlog privado de jogos",
    description:
      "Até vinte jogos planejados/em andamento não arquivados por página, inclusive DLCs como partes separadas sem somar horas do principal. Retorna items com id, metadados, horas da parte, estimate IGDB ou null e estimateFailed, total e nextAfter. Consulta não altera status, horas, posse ou XP. Ausências e falhas são distintas; o cliente agrega páginas e aplica objetivo/filtros.",
  })
  async page(@Req() request: Request, @Query() query: PlannerQuery) {
    return this.service.page((await this.auth.forRequest(request)).id, query.after);
  }
}
@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [GamePlannerController],
  providers: [GamePlannerService],
})
export class GamePlannerModule {}
