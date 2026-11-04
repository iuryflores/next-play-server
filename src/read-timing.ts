// Registra somente etapas e durações de leituras lentas, sem IDs, títulos ou dados da conta.
export function readTiming(name: string) {
  const start = performance.now();
  let last = start;
  const stages: Record<string, number> = {};
  return {
    mark(stage: string) {
      const now = performance.now();
      stages[stage] = Math.round(now - last);
      last = now;
    },
    finish() {
      const totalMs = Math.round(performance.now() - start);
      if (totalMs >= 3000) console.warn('[Leitura lenta]', JSON.stringify({ name, totalMs, stages }));
    },
  };
}
