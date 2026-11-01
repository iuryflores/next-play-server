export interface OwnedBook {
  title?: string;
  catalogId?: string;
  authors?: string[];
  isbn?: string;
  publisher?: string;
  genres?: string[];
  language?: string;
  bookMetadataVersion?: number;
}
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const categoryKeys = (value: string) => value.split('/').map(normalize).filter(Boolean);
const publisherKey = (value: string) => normalize(value).replace(/^(editora|edicoes|editorial) /, '');
const authorKey = (value: string) => {
  const tokens = normalize(value).split(' ');
  const names = tokens.filter(token => token.length > 1);
  // Pontuação, ordem e iniciais não separam "George R. R. Martin" de "George Martin".
  return (names.length >= 2 ? names : tokens).sort().join(' ');
};
const titleStopWords = new Set('a o as os de da do das dos e em um uma para por com the of and an to book livro volume vol edicao edition'.split(' '));
const titleTokens = (value: string) => [...new Set(normalize(value).split(' ').filter(token => token.length >= 3 && !titleStopWords.has(token) && !/^\d+$/.test(token)))];

export function bookPreferences(owned: OwnedBook[]) {
  const unique = new Map<string, OwnedBook>();
  // Várias cópias/edições não transformam uma única obra em vários votos de preferência.
  for (const book of owned) {
    const title = normalize(book.title || '');
    const key = title ? title + ':' + (book.authors || []).map(authorKey).sort().join('|') : book.catalogId || book.isbn;
    if (!key) continue;
    const previous = unique.get(key);
    unique.set(key, previous ? { ...previous, genres: [...new Set([...(previous.genres || []), ...(book.genres || [])])], publisher: previous.publisher || book.publisher } : book);
  }
  function frequent(values: string[], keyOf = normalize) {
    const counts = new Map<string, { value: string; count: number }>();
    for (const value of values.filter(v => typeof v === 'string' && v.trim())) {
      const key = keyOf(value); if (!key) continue;
      const entry = counts.get(key) || { value: value.trim(), count: 0 }; entry.count++; counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }
  return {
    titles: frequent([...unique.values()].map(book => book.title || '')),
    authors: frequent([...unique.values()].flatMap(book => book.authors || []), authorKey),
    genres: frequent([...unique.values()].flatMap(book => book.genres || [])),
    publishers: frequent([...unique.values()].map(book => book.publisher || ''), publisherKey),
    language: frequent([...unique.values()].map(book => book.language?.slice(0, 2).toLowerCase() || '').filter(v => /^[a-z]{2}$/.test(v)))[0]?.value || 'pt',
  };
}

export function alreadyOwned(candidate: OwnedBook, owned: OwnedBook[]) {
  const title = normalize(candidate.title || '');
  const authors = (candidate.authors || []).map(authorKey);
  return owned.some(book => {
    if (candidate.catalogId && candidate.catalogId === book.catalogId) return true;
    if (candidate.isbn && candidate.isbn.replace(/[\s-]/g, '') === book.isbn?.replace(/[\s-]/g, '')) return true;
    if (!title || title !== normalize(book.title || '')) return false;
    // Quando ambos informam autoria, títulos genéricos iguais de autores distintos continuam válidos.
    return !authors.length || !book.authors?.length || book.authors.some(author => authors.includes(authorKey(author)));
  });
}

export function bookAffinity(candidate: OwnedBook, profile: ReturnType<typeof bookPreferences>) {
  const authors = new Set((candidate.authors || []).map(authorKey));
  const authorScore = profile.authors.reduce((sum, author) => sum + (authors.has(authorKey(author.value)) ? author.count : 0), 0);
  const tokens = titleTokens(candidate.title || '');
  const titleScore = profile.titles.reduce((best, title) => {
    const reference = titleTokens(title.value);
    const shared = tokens.filter(token => reference.includes(token));
    // Afinidade textual é uma heurística, não uma identificação oficial de franquia.
    // Evitamos promover títulos que só compartilham palavras comuns ou um número de volume.
    const related = shared.length >= 2 && shared.length / Math.min(tokens.length, reference.length) >= 0.5;
    return Math.max(best, related ? shared.length : 0);
  }, 0);
  const genres = new Set((candidate.genres || []).flatMap(categoryKeys));
  const exact = new Set((candidate.genres || []).map(normalize));
  const genreScore = profile.genres.reduce((sum, genre) => {
    if (exact.has(normalize(genre.value))) return sum + genre.count * 8;
    const keys = categoryKeys(genre.value);
    // Em categorias hierárquicas, compartilhar só "Fiction" não equivale a compartilhar "Horror".
    return sum + ((keys.length > 1 ? keys.slice(1) : keys).some(key => genres.has(key)) ? genre.count * 4 : 0);
  }, 0);
  const publisherScore = profile.publishers.find(p => publisherKey(p.value) === publisherKey(candidate.publisher || ''))?.count || 0;
  const tier = titleScore ? 3 : authorScore ? 2 : publisherScore ? 1 : genreScore ? 0.5 : 0;
  if (!tier) return 0;
  // A prioridade é estrita: quantidade de livros da editora nunca supera título/autor.
  const language = candidate.language?.slice(0, 2).toLowerCase() === profile.language ? 10000 : 0;
  return tier * 1000000 + language + Math.min(titleScore, 99) * 100 + Math.min(authorScore, 99) * 10 + Math.min(genreScore, 99) + Math.min(publisherScore, 99);
}
