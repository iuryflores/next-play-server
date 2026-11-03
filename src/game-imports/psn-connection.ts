import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import * as psn from "psn-api";
import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { getConfig } from "../config";
export function psnMinutes(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m || !m.slice(1).some((v) => v !== undefined)) return undefined;
  const minutes = Math.floor(
    Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60,
  );
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 6000000 ? minutes : undefined;
}
// O SDK não expõe AbortSignal; após o timeout, nenhum retorno tardio pode mudar a conexão.
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PSN timeout")), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
@Injectable()
export class PsnGateway {
  async authenticate(npsso: string) {
    const code = await bounded(psn.exchangeNpssoForAccessCode(npsso));
    const tokens = await bounded(psn.exchangeAccessCodeForAuthTokens(code));
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }
  profile(accessToken: string) {
    return bounded(psn.getProfileFromAccountId({ accessToken }, "me"));
  }
  games(accessToken: string, offset: number) {
    return bounded(psn.getUserPlayedGames({ accessToken }, "me", { offset, limit: 100 }));
  }
  trophies(accessToken: string, id: string) {
    return bounded(psn.getUserTrophiesForSpecificTitle({ accessToken }, "me", { npTitleIds: id }));
  }
}
type Slot = {
  id: string;
  session: string;
  accessToken?: string;
  onlineId?: string;
  expiresAt: number;
  busy?: boolean;
  timer?: NodeJS.Timeout;
};
@Injectable()
export class PsnConnectionService {
  private slots = new Map<string, Slot>();
  constructor(private readonly gateway: PsnGateway) {}
  private session(req: Request) {
    const token = req.cookies?.[getConfig().cookieName];
    if (typeof token !== "string" || !token) throw new UnauthorizedException();
    return createHash("sha256").update(token).digest("hex");
  }
  private slot(owner: string, req: Request) {
    this.purge();
    const row = this.slots.get(owner);
    if (!row?.accessToken || row.session !== this.session(req) || row.expiresAt <= Date.now())
      throw new BadRequestException(
        "Reconecte a PSN: a sessão experimental expirou ou foi encerrada.",
      );
    return row;
  }
  private purge() {
    for (const [owner, row] of this.slots) if (row.expiresAt <= Date.now()) this.disconnect(owner);
  }
  status(owner: string, req: Request) {
    this.purge();
    const row = this.slots.get(owner);
    const connected = Boolean(row?.accessToken && row.session === this.session(req));
    return {
      experimental: true,
      connected,
      onlineId: connected ? row!.onlineId : null,
      expiresAt: connected ? new Date(row!.expiresAt).toISOString() : null,
    };
  }
  async connect(owner: string, req: Request, npsso: string) {
    this.purge();
    this.disconnect(owner);
    const row: Slot = {
      id: randomUUID(),
      session: this.session(req),
      expiresAt: Date.now() + 60000,
    };
    this.slots.set(owner, row);
    try {
      const tokens = await this.gateway.authenticate(npsso);
      if (
        typeof tokens.accessToken !== "string" ||
        tokens.accessToken.length < 10 ||
        tokens.accessToken.length > 16000 ||
        !Number.isFinite(tokens.expiresIn) ||
        tokens.expiresIn < 60
      )
        throw Error();
      const profile = await this.gateway.profile(tokens.accessToken);
      if (
        profile.isMe !== true ||
        typeof profile.onlineId !== "string" ||
        !/^[A-Za-z0-9_-]{3,16}$/.test(profile.onlineId)
      )
        throw Error();
      if (this.slots.get(owner) !== row) throw Error();
      // NPSSO e refresh token nunca são persistidos. Só o token de leitura vive nesta sessão em memória.
      row.accessToken = tokens.accessToken;
      row.onlineId = profile.onlineId;
      row.expiresAt = Date.now() + Math.min(tokens.expiresIn - 30, 3600) * 1000;
      row.timer = setTimeout(
        () => {
          if (this.slots.get(owner) === row) this.slots.delete(owner);
        },
        Math.max(0, row.expiresAt - Date.now()),
      );
      row.timer.unref();
      return this.status(owner, req);
    } catch {
      if (this.slots.get(owner) === row) this.slots.delete(owner);
      throw new BadGatewayException(
        "Não foi possível conectar a PSN. Confira o código NPSSO ou tente novamente mais tarde.",
      );
    }
  }
  disconnect(owner: string) {
    const row = this.slots.get(owner);
    if (row?.timer) clearTimeout(row.timer);
    this.slots.delete(owner);
  }
  current(owner: string, req: Request, id: string) {
    try {
      return this.slot(owner, req).id === id;
    } catch {
      return false;
    }
  }
  async games(owner: string, req: Request) {
    const row = this.slot(owner, req);
    if (row.busy) throw new BadRequestException("Uma consulta PSN já está em andamento.");
    row.busy = true;
    const games = new Map<
      string,
      { externalId: string; title: string; platform: string; playtimeMinutes?: number }
    >();
    let offset = 0;
    const deadline = Date.now() + 60000;
    try {
      for (let page = 0; page < 100; page++) {
        const data = await this.gateway.games(row.accessToken!, offset);
        if (!this.current(owner, req, row.id) || Date.now() > deadline || req.res?.destroyed)
          throw Error();
        if (
          !Array.isArray(data.titles) ||
          !Number.isSafeInteger(data.totalItemCount) ||
          data.totalItemCount < 0 ||
          data.totalItemCount > 10000
        )
          throw Error();
        for (const game of data.titles) {
          if (
            typeof game.titleId !== "string" ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(game.titleId) ||
            typeof game.name !== "string" ||
            !game.name.trim() ||
            game.name.length > 200
          )
            throw Error();
          const minutes = psnMinutes(game.playDuration);
          games.set(game.titleId, {
            externalId: game.titleId,
            title: game.name,
            platform:
              game.category === "ps5_native_game"
                ? "PS5"
                : game.category === "ps4_game"
                  ? "PS4"
                  : game.category === "pspc_game"
                    ? "PC"
                    : "PlayStation",
            ...(minutes !== undefined ? { playtimeMinutes: minutes } : {}),
          });
        }
        if (offset + data.titles.length >= data.totalItemCount)
          return { games: [...games.values()], onlineId: row.onlineId!, connectionId: row.id };
        if (
          !data.titles.length ||
          !Number.isSafeInteger(data.nextOffset) ||
          data.nextOffset <= offset
        )
          throw Error();
        offset = data.nextOffset;
      }
      throw Error();
    } catch {
      throw new BadGatewayException(
        "Não foi possível consultar todo o histórico PSN. A sessão pode ter expirado ou o serviço está indisponível.",
      );
    } finally {
      row.busy = false;
    }
  }
  async trophies(owner: string, req: Request, id: string, onlineId: string) {
    const row = this.slot(owner, req);
    if (row.onlineId !== onlineId)
      throw new BadRequestException("Esta prévia pertence a outra conta PSN. Consulte novamente.");
    try {
      const result = await this.gateway.trophies(row.accessToken!, id);
      if (!this.current(owner, req, row.id)) throw Error();
      const sets = result.titles?.find((title) => title.npTitleId === id)?.trophyTitles;
      if (!Array.isArray(sets) || !sets.length) throw Error();
      let unlocked = 0,
        total = 0;
      const seen = new Set<string>();
      for (const set of sets) {
        if (!set.npCommunicationId || seen.has(set.npCommunicationId)) continue;
        seen.add(set.npCommunicationId);
        const sum = (counts: unknown) => {
          const row = counts as Record<string, number>;
          const values = ["bronze", "silver", "gold", "platinum"].map((key) => row?.[key]);
          if (values.some((v) => !Number.isSafeInteger(v) || v < 0 || v > 100000)) throw Error();
          return values.reduce((a, b) => a + b, 0);
        };
        unlocked += sum(set.earnedTrophies);
        total += sum(set.definedTrophies);
      }
      if (total > 100000 || unlocked > total) throw Error();
      return { achievementsUnlocked: unlocked, achievementsTotal: total };
    } catch {
      throw new BadGatewayException(
        "Troféus não disponíveis para este jogo ou conta. Nenhuma contagem foi alterada.",
      );
    }
  }
}
