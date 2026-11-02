// Proteção conservadora: padrão protegido e heurística explícita; não promete reconhecimento semântico.
export function protectSpoilers(text: string, explicit?: boolean) {
  return (
    explicit !== false ||
    /\b(spoilers?|morre|morte|assassino|final|revela[cç][aã]o|dies|ending|killer|plot twist)\b/i.test(
      text,
    )
  );
}
