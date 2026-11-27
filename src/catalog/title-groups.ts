import { BadRequestException } from '@nestjs/common';

export type GroupFilters = { franchise?: string; universe?: string };

export function parseGroupFilters(franchise: unknown, universe: unknown): GroupFilters {
  const term = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 100 || value.trim().length < 2 || !groupName(value) || /[\u0000-\u001f]/.test(value))
      throw new BadRequestException('Informe uma franquia ou universo entre 2 e 100 caracteres.');
    return value.trim();
  };
  return { franchise: term(franchise), universe: term(universe) };
}

export const groupName = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function catalogGroupName(value: string) {
  // Estes nomes localizados devem resolver o mesmo vínculo, inclusive no modo Filmes e séries.
  const aliases: Record<string, string> = {
    ucm: 'Marvel Cinematic Universe',
    mcu: 'Marvel Cinematic Universe',
    'marvel cinematic universe mcu': 'Marvel Cinematic Universe',
    'universo cinematografico marvel': 'Marvel Cinematic Universe',
    'universo cinematografico da marvel': 'Marvel Cinematic Universe',
    'guerra nas estrelas': 'Star Wars',
    'mundo bruxo': 'Wizarding World',
  };
  const key = groupName(value);
  return Object.hasOwn(aliases, key) ? aliases[key] : value;
}
