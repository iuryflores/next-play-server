// Teste explícito de envio real: não imprime credenciais, e-mail completo ou token.
const nodemailer = require('nodemailer');
const { createApp } = require('../dist/bootstrap');
const { getConnectionToken } = require('@nestjs/mongoose');
const { RecoveryMailer } = require('../dist/auth/password-recovery');
const { getConfig } = require('../dist/config');
(async () => {
  let app, transport;
  try {
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    if (!user || !pass) throw Object.assign(new Error(), { code: 'SMTP_NOT_CONFIGURED' });
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    await transport.verify();
    console.log(JSON.stringify({ smtpConnection: 'authenticated' }));
    app = await createApp();
    const db = app.get(getConnectionToken());
    const users = await db.collection('users').find({}, { projection: { email: 1, resetRequestedAt: 1 } }).limit(2).toArray();
    const recipient = users.length === 1 ? users[0] : await db.collection('users').findOne({ email: user.toLowerCase() }, { projection: { email: 1, resetRequestedAt: 1 } });
    if (!recipient) throw Object.assign(new Error(), { code: 'RECIPIENT_REQUIRED' });
    if (recipient.resetRequestedAt && Date.now() - recipient.resetRequestedAt.getTime() < 60000) {
      console.log(JSON.stringify({ sent: false, reason: 'account_cooldown', retryAfterSeconds: Math.ceil((60000 - (Date.now() - recipient.resetRequestedAt.getTime())) / 1000) })); return;
    }
    const mailer = app.get(RecoveryMailer), original = mailer.send.bind(mailer);
    let sent = false, mailError;
    mailer.send = async (...args) => {
      try { await original(...args); sent = true; }
      catch (error) { mailError = { type: error.name, code: error.code, smtpStatus: error.responseCode }; throw error; }
    };
    await app.listen(0, '127.0.0.1');
    const response = await fetch((await app.getUrl()) + '/api/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: getConfig().origin }, body: JSON.stringify({ email: recipient.email }), signal: AbortSignal.timeout(30000) });
    await response.json();
    const stored = await db.collection('users').findOne({ _id: recipient._id }, { projection: { resetTokenHash: 1, resetExpiresAt: 1 } });
    console.log(JSON.stringify({ httpStatus: response.status, sent, tokenStoredAsHash: !!stored.resetTokenHash && /^[a-f0-9]{64}$/.test(stored.resetTokenHash), expiresInMinutes: stored.resetExpiresAt ? Math.round((stored.resetExpiresAt.getTime() - Date.now()) / 60000) : null, recipient: 'registered_account', mailError }));
    if (!sent || !response.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ failed: true, type: error.name, code: error.code, smtpStatus: error.responseCode })); process.exitCode = 1;
  } finally { transport?.close(); if (app) await app.close(); }
})();
