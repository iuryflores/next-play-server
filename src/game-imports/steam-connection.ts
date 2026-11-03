import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection, Types } from "mongoose";
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { getConfig } from "../config";
const endpoint = "https://steamcommunity.com/openid/login";
const namespace = "http://specs.openid.net/auth/2.0";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
@Injectable()
export class SteamConnectionService implements OnModuleInit {
  constructor(@InjectConnection() private readonly db: Connection) {}
  async onModuleInit() {
    await this.db
      .collection("steam_login_states")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.db
      .collection("steam_login_nonces")
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }
  private session(request: Request) {
    const token = request.cookies?.[getConfig().cookieName];
    if (typeof token !== "string" || !token) throw new ForbiddenException("Sessão não encontrada.");
    return hash(token);
  }
  private returnTo(state: string) {
    return getConfig().origin + "/api/game-imports/steam/callback?state=" + state;
  }
  async status(owner: string) {
    const row = await this.db
      .collection("steam_connections")
      .findOne({ _id: new Types.ObjectId(owner) });
    return {
      connected: Boolean(row?.steamId),
      steamId: row?.steamId || null,
      revision: row?.revision || 0,
      profileUrl: row?.steamId ? "https://steamcommunity.com/profiles/" + row.steamId : null,
      lastResult: row?.lastResult || null,
    };
  }
  async begin(owner: string, request: Request) {
    const state = randomBytes(32).toString("hex");
    const ownerId = new Types.ObjectId(owner);
    const connection = await this.db
      .collection("steam_connections")
      .findOneAndUpdate(
        { _id: ownerId },
        { $inc: { revision: 1 }, $set: { lastResult: null } },
        { upsert: true, returnDocument: "after" },
      );
    // Estado de uso único vinculado à sessão NextPlay; não confiamos só no SteamID do retorno.
    await this.db
      .collection("steam_login_states")
      .insertOne({
        _id: hash(state) as any,
        ownerId,
        revision: connection!.revision,
        sessionHash: this.session(request),
        expiresAt: new Date(Date.now() + 10 * 60000),
      });
    const params = new URLSearchParams({
      "openid.ns": namespace,
      "openid.mode": "checkid_setup",
      "openid.return_to": this.returnTo(state),
      "openid.realm": getConfig().origin + "/",
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    });
    return { url: endpoint + "?" + params };
  }
  async verify(params: URLSearchParams) {
    // A verificação vai sempre para o provedor fixo; nenhuma URL de callback controla o destino da rede.
    const body = new URLSearchParams();
    for (const [key, value] of params) if (key.startsWith("openid.")) body.set(key, value);
    body.set("openid.mode", "check_authentication");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw Error();
      const result = await response.text();
      if (result.length > 8192) throw Error();
      return (
        result.split(/\r?\n/).includes("ns:" + namespace) &&
        result.split(/\r?\n/).filter((line) => line === "is_valid:true").length === 1 &&
        !result.split(/\r?\n/).some((line) => line === "is_valid:false")
      );
    } catch {
      throw new BadGatewayException(
        "Não foi possível validar o login Steam. Tente conectar novamente.",
      );
    }
  }
  async complete(owner: string, request: Request) {
    if (request.originalUrl.length > 20000)
      throw new BadRequestException("Retorno Steam inválido.");
    const params = new URL(request.originalUrl, getConfig().origin).searchParams;
    for (const key of new Set(params.keys()))
      if (params.getAll(key).length !== 1)
        throw new BadRequestException("Retorno Steam duplicado.");
    const state = params.get("state") || "";
    if (!/^[a-f0-9]{64}$/.test(state))
      throw new BadRequestException("Conexão Steam expirada. Tente novamente.");
    const ownerId = new Types.ObjectId(owner);
    const attempt = await this.db
      .collection("steam_login_states")
      .findOneAndDelete({
        _id: hash(state) as any,
        ownerId,
        sessionHash: this.session(request),
        expiresAt: { $gt: new Date() },
      });
    if (!attempt)
      throw new BadRequestException("Conexão Steam expirada ou já utilizada. Tente novamente.");
    const result = async (lastResult: string) =>
      this.db
        .collection("steam_connections")
        .updateOne({ _id: ownerId, revision: attempt.revision }, { $set: { lastResult } });
    if (params.get("openid.mode") === "cancel") {
      await result("cancelled");
      return;
    }
    try {
      const steamId = params
        .get("openid.claimed_id")
        ?.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/)?.[1];
      const signed = new Set((params.get("openid.signed") || "").split(","));
      const nonce = params.get("openid.response_nonce") || "",
        time = Date.parse(nonce.slice(0, 20));
      if (
        params.get("openid.ns") !== namespace ||
        params.get("openid.mode") !== "id_res" ||
        params.get("openid.op_endpoint") !== endpoint ||
        !steamId ||
        params.get("openid.identity") !== params.get("openid.claimed_id") ||
        params.get("openid.return_to") !== this.returnTo(state) ||
        !params.get("openid.sig") ||
        !params.get("openid.assoc_handle") ||
        ![
          "op_endpoint",
          "claimed_id",
          "identity",
          "return_to",
          "response_nonce",
          "assoc_handle",
        ].every((field) => signed.has(field)) ||
        nonce.length > 256 ||
        nonce.length <= 20 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(nonce) ||
        !Number.isFinite(time) ||
        Math.abs(Date.now() - time) > 5 * 60000
      )
        throw new BadRequestException("O retorno não comprova uma conta Steam válida.");
      if (!(await this.verify(params)))
        throw new BadRequestException("A Steam não confirmou este login.");
      // O mesmo retorno assinado não pode conectar outra sessão, mesmo com outro estado.
      try {
        await this.db
          .collection("steam_login_nonces")
          .insertOne({ _id: hash(nonce) as any, expiresAt: new Date(Date.now() + 10 * 60000) });
      } catch (error) {
        if ((error as any).code === 11000)
          throw new BadRequestException("Retorno Steam já utilizado.");
        throw error;
      }
      const saved = await this.db
        .collection("steam_connections")
        .updateOne(
          { _id: ownerId, revision: attempt.revision },
          {
            $set: { steamId, connectedAt: new Date(), lastResult: "connected" },
            $inc: { revision: 1 },
          },
        );
      if (!saved.matchedCount)
        throw new BadRequestException(
          "Esta tentativa foi substituída ou a conta foi desconectada.",
        );
    } catch (error) {
      await result("error");
      throw error;
    }
  }
  async disconnect(owner: string) {
    const ownerId = new Types.ObjectId(owner);
    // A revisão invalida também callbacks que já estavam validando a assinatura quando houve desconexão.
    await this.db
      .collection("steam_connections")
      .updateOne(
        { _id: ownerId },
        {
          $inc: { revision: 1 },
          $unset: { steamId: "", connectedAt: "" },
          $set: { lastResult: null },
        },
        { upsert: true },
      );
    await this.db.collection("steam_login_states").deleteMany({ ownerId });
    // Desconectar encerra o vínculo e as prévias Steam; títulos já confirmados pertencem ao usuário.
    await this.db.collection("game_import_previews").deleteMany({ ownerId, source: "steam-api" });
  }
  async steamId(owner: string) {
    const row = await this.status(owner);
    if (!row.steamId) throw new BadRequestException("Conecte sua conta Steam primeiro.");
    return row.steamId as string;
  }
}
