export type AchievementMetric = 'movies' | 'books' | 'copies' | 'seasons' | 'binge' | 'series' | 'episodes' | 'classics' | 'reviews' | 'daySeason';
export type AchievementDefinition = { id: string; family: string; name: string; title: string; description: string; metric: AchievementMetric; target: number; level: number; levels: number };

// IDs e metas são estáveis: mudar o nome de uma conquista não perde o histórico salvo.
const tiers = (family: string, name: string, title: string, description: string, metric: AchievementMetric, targets: number[]): AchievementDefinition[] =>
  targets.map((target, index) => ({ id: `${family}-${target}`, family, name, title, description, metric, target, level: index + 1, levels: targets.length }));
export const achievements: AchievementDefinition[] = [
  ...tiers('first-play', 'Primeiro play', 'Estreante', 'Assistir ao seu primeiro filme.', 'movies', [1]),
  ...tiers('binge', 'Só mais um episódio', 'Maratonista', 'Assistir a {0} episódios diferentes no mesmo dia.', 'binge', Array.from({ length: 20 }, (_, i) => (i + 1) * 5)),
  ...tiers('season', 'Temporada encerrada', 'Caçador de temporadas', 'Concluir {0} temporadas regulares diferentes.', 'seasons', [1, 5, 10, 25]),
  ...tiers('cinephile', 'Cinéfilo', 'Cinéfilo', 'Assistir a {0} filmes diferentes.', 'movies', [10, 25, 50, 100]),
  ...tiers('series-finale', 'Até o último episódio', 'Mestre dos finais', 'Marcar {0} séries diferentes como concluídas.', 'series', [1, 5, 10, 25]),
  ...tiers('episode-voyager', 'Universo em episódios', 'Viajante de episódios', 'Assistir a {0} episódios regulares diferentes.', 'episodes', [25, 100, 250, 500]),
  ...tiers('classics', 'De volta aos clássicos', 'Guardião dos clássicos', 'Assistir a {0} filmes diferentes lançados antes de 2000.', 'classics', [5, 10, 25, 50]),
  ...tiers('critic', 'Na cadeira do crítico', 'Crítico de cinema', 'Dar de 1 a 5 estrelas a {0} filmes diferentes já assistidos.', 'reviews', [5, 10, 25, 50]),
  ...tiers('day-season', 'Hoje tem final', 'Do piloto ao final', 'Assistir a todos os episódios de uma temporada regular no mesmo dia, com marcações individuais.', 'daySeason', [1]),
  ...tiers('reader', 'Devorador de páginas', 'Devorador de páginas', 'Ler {0} livros.', 'books', [5, 10, 25, 50]),
  ...tiers('collector', 'Colecionador', 'Colecionador', 'Possuir {0} itens na Minha Coleção.', 'copies', [10, 25, 50, 100]),
];

export function seasonInOneDay(rows: { key: string; watchedAt: Date; watchOrigin?: string }[], expected: string[], timeZone: string, now = new Date()) {
  // Só vale a temporada completa e comprovada: lotes e datas legadas não inventam uma maratona.
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.watchOrigin !== 'individual' || !(row.watchedAt instanceof Date) || !Number.isFinite(row.watchedAt.getTime()) || row.watchedAt > now) continue;
    const day = formatter.format(row.watchedAt);
    if (!days.has(day)) days.set(day, new Set());
    days.get(day)!.add(row.key);
  }
  return expected.length > 0 && [...days.values()].some(keys => expected.every(key => keys.has(key)));
}
export function validTimeZone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}

export function dailyEpisodeRecord(rows: { key: string; watchedAt: Date; watchOrigin?: string }[], timeZone: string, now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, Set<string>>();
  for (const row of rows) {
    // Datas legadas/lotes não comprovam uma sessão de maratona; não inferimos que tudo foi visto hoje.
    if (row.watchOrigin !== 'individual' || !(row.watchedAt instanceof Date) || !Number.isFinite(row.watchedAt.getTime()) || row.watchedAt > now) continue;
    const day = formatter.format(row.watchedAt);
    if (!days.has(day)) days.set(day, new Set());
    days.get(day)!.add(row.key);
  }
  return Math.max(0, ...[...days.values()].map(episodes => episodes.size));
}
