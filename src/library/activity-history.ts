import { Connection, Types } from "mongoose";
import { randomUUID } from "node:crypto";
// Auditoria privada registra a ação no app, separada da data real de consumo.
// O retrato mínimo preserva a referência mesmo depois de excluir o acompanhamento.
export async function recordPrivateActivity(
  db: Connection,
  item: { _id: Types.ObjectId; ownerId: Types.ObjectId; title: string; kind: string },
  type: string,
  sourceKey: string = randomUUID(),
) {
  try {
    await db.collection("library_activity_history").updateOne(
      { ownerId: item.ownerId, sourceKey },
      {
        $setOnInsert: {
          _id: new Types.ObjectId(),
          itemId: item._id,
          title: item.title,
          kind: item.kind,
          type,
          recordedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch {
    console.warn("[Histórico] Falha ao registrar atividade privada.");
  }
}
