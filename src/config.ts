export function getConfig() {
  const production = process.env.NODE_ENV === 'production';
  const origin = new URL(process.env.CLIENT_ORIGIN || 'http://localhost:5174').origin;
  if (production && !origin.startsWith('https://')) throw new Error('CLIENT_ORIGIN deve usar HTTPS em produção.');
  const port = Number(process.env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
  return {
    port, host: process.env.HOST || '127.0.0.1', production, origin,
    mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nextplay',
    registration: process.env.ALLOW_REGISTRATION === 'true' || (!production && process.env.ALLOW_REGISTRATION !== 'false'),
    cookieName: production ? '__Host-nextplay_session' : 'nextplay_session',
  };
}
