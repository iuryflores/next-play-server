export type AchievementMetric = 'movies' | 'books' | 'copies' | 'seasons' | 'binge' | 'series' | 'episodes' | 'classics' | 'reviews' | 'daySeason' | 'loved' | 'favoriteActor' | 'favoriteCharacter';
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
  ...tiers('heart', 'De coração', 'Coração de fã', 'Marcar Amei em {0} avaliações distintas de obras concluídas ou episódios.', 'loved', [3, 5, 10, 25, 50]),
  ...tiers('actor-fan', 'Fã de carteirinha', 'Fã de carteirinha', 'Escolher o mesmo ator favorito em {0} avaliações distintas de obras concluídas ou episódios.', 'favoriteActor', [3, 5, 10, 25, 50]),
  ...tiers('character-fan', 'Personagem inesquecível', 'Fã fiel', 'Escolher o mesmo personagem da mesma obra ou série em {0} avaliações distintas de obras concluídas ou episódios.', 'favoriteCharacter', [3, 5, 10, 25, 50]),
];

export function continuousLevel(targets: number[], current: number) {
  // A última meta inicial vale uma estrela; cinco blocos completam um nível.
  const last = targets.at(-1)!;
  if (targets.length === 1) return { progressionLevel: 0, cycleStars: 0, nextLevelTarget: last };
  const cycle = last * 5;
  const progressionLevel = Math.floor(current / cycle);
  const remainder = current % cycle;
  return { progressionLevel, cycleStars: current > 0 && remainder === 0 ? 5 : remainder / last, nextLevelTarget: cycle * (progressionLevel + 1) };
}

export type AchievementReview = { key: string; scope: string; label: string; feeling?: string; favoriteActorId?: string; favoriteActorName?: string; favoriteCharacter?: string };
export function reviewMilestones(reviews: AchievementReview[]) {
  // A identidade da avaliação evita somar edições; personagens homônimos de obras diferentes não se misturam.
  const rows = [...new Map(reviews.map(row => [row.key, row])).values()];
  const groups = (identity: (row: AchievementReview) => string, label: (row: AchievementReview) => string) => {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const key = identity(row);
      if (key) grouped.set(key, [...(grouped.get(key) || []), `${label(row)} — ${row.label}`]);
    }
    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[1] || [];
  };
  const loved = rows.filter(row => row.feeling === 'loved').map(row => `Amei — ${row.label}`);
  // IDs de atores são validados ao salvar a avaliação; nomes livres não comprovam a mesma pessoa.
  const favoriteActor = groups(row => row.favoriteActorId?.trim() || '', row => row.favoriteActorName || row.favoriteActorId!);
  const favoriteCharacter = groups(row => {
    const name = row.favoriteCharacter?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
    return name ? `${row.scope}:${name}` : '';
  }, row => row.favoriteCharacter!.trim());
  return { loved, favoriteActor, favoriteCharacter };
}

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
