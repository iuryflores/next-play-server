import { randomUUID } from 'node:crypto';
export type GameStatusEvent = { id: string; type: 'added' | 'status' | 'archived' | 'restored'; fromStatus: string | null; toStatus: string; source: 'manual' | 'session' | 'time-adjustment'; recordedAt: Date };
export function gameStatusEvent(type: GameStatusEvent['type'], fromStatus: string | null, toStatus: string, source: GameStatusEvent['source'] = 'manual'): GameStatusEvent {
  // Momento da alteração no sistema, nunca a data de consumo informada ou uma data antiga inferida.
  return { id: randomUUID(), type, fromStatus, toStatus, source, recordedAt: new Date() };
}
