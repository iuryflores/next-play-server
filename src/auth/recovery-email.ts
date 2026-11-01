/** Escapa valores dinâmicos antes de usá-los em atributos ou texto do e-mail. */
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function recoveryEmail(link: string, purpose: 'recovery' | 'verification' = 'recovery') {
  const safeLink = escapeHtml(link);
  const verification = purpose === 'verification';
  const title = verification ? 'Confirme seu e-mail' : 'Redefina sua senha';
  const intro = verification ? 'Boas-vindas ao NextPlay! Confirme este endereço de e-mail para ativar sua conta.' : 'Recebemos um pedido para redefinir a senha da sua conta NextPlay.';
  const action = verification ? 'Confirmar meu e-mail' : 'Redefinir minha senha';
  const instructions = verification ? 'Clique no botão abaixo para confirmar seu e-mail e começar sua coleção.' : 'Clique no botão abaixo para escolher uma nova senha e voltar à sua coleção.';
  const duration = verification ? '24 horas' : '15 minutos';
  const safety = verification ? 'Se você não criou uma conta no NextPlay, ignore este e-mail. Nenhuma ação é necessária.' : 'Ignore este e-mail. Sua senha permanece igual até que uma nova seja definida. Por segurança, não compartilhe este link.';
  // Tabelas e estilos inline mantêm o layout nos clientes de e-mail, sem scripts,
  // fontes externas ou imagens remotas que precisem de permissão para carregar.
  return {
    subject: `${title} no NextPlay`,
    text: `${title} — NextPlay\n\n${intro}\n${instructions}\n\n${link}\n\nLink de uso único, válido por ${duration}.\n${safety}\n\nEquipe NextPlay`,
    html: `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — NextPlay</title></head>
<body style="margin:0;padding:0;background-color:#111018;color:#f5f3fa;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${title}. Link válido por ${duration}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111018" style="background-color:#111018;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="padding:0 8px 28px;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-1px;color:#f5f3fa;">Next<span style="color:#a899ff;">Play</span></td></tr>
        <tr><td bgcolor="#1d1b29" style="background-color:#1d1b29;border:1px solid #353143;border-top:4px solid #a899ff;border-radius:16px;padding:32px 24px;">
          <p style="margin:0 0 16px;color:#b9f5cc;font-size:11px;line-height:18px;font-weight:700;letter-spacing:2px;">SEGURANÇA DA CONTA</p>
          <h1 style="margin:0 0 20px;color:#f5f3fa;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.5px;">${title}</h1>
          <p style="margin:0 0 12px;color:#f5f3fa;font-size:16px;line-height:26px;">${intro}</p>
          <p style="margin:0 0 28px;color:#c5c1d2;font-size:15px;line-height:25px;">${instructions}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td align="center" bgcolor="#a899ff" style="background-color:#a899ff;border-radius:10px;mso-padding-alt:16px 24px;">
            <a href="${safeLink}" style="display:inline-block;padding:16px 24px;border:1px solid #a899ff;border-radius:10px;color:#111018;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;text-align:center;">${action}</a>
          </td></tr></table>
          <p style="margin:0 0 28px;color:#c5c1d2;font-size:13px;line-height:21px;">Este link é válido por <strong style="color:#f5f3fa;">${duration}</strong> e pode ser usado uma única vez.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #353143;padding-top:24px;">
            <p style="margin:0 0 8px;color:#f5f3fa;font-size:14px;line-height:23px;font-weight:700;">Não foi você?</p>
            <p style="margin:0;color:#c5c1d2;font-size:14px;line-height:23px;">${safety}</p>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:24px 8px 0;">
          <p style="margin:0 0 8px;color:#aaa6ba;font-size:12px;line-height:20px;">O botão não abriu? Copie e cole este endereço no navegador:</p>
          <p style="margin:0 0 28px;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere;"><a href="${safeLink}" style="color:#c5baff;text-decoration:underline;word-break:break-all;">${safeLink}</a></p>
          <p style="margin:0 0 6px;color:#f5f3fa;font-size:13px;line-height:21px;font-weight:700;">Qual é o seu próximo play?</p>
          <p style="margin:0;color:#aaa6ba;font-size:12px;line-height:20px;">Equipe NextPlay · Mensagem automática de segurança da conta.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
  };
}
