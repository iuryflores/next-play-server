import { createHash } from 'node:crypto';
// O pseudônimo permanece igual por título, sem expor perfil ou identidade de quem comenta.
export const commentAuthor = (key: string, owner: string) => 'Pessoa ' + createHash('sha256').update(key + owner).digest('hex').slice(0, 6);
