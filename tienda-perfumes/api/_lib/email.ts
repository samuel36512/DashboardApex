import { Resend } from "resend";

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

// Si no hay RESEND_API_KEY configurada, no rompemos el checkout ni el
// webhook de pago por un email que no pudo salir: solo lo salteamos. El
// pedido ya quedó guardado en la base con estado "pagado" de cualquier forma.
export async function enviarEmail(opts: { to: string; subject: string; html: string }): Promise<void> {
  const resend = getResend();
  const from = process.env.EMAIL_FROM;
  if (!resend || !from) return;
  try {
    await resend.emails.send({ from, to: opts.to, subject: opts.subject, html: opts.html });
  } catch {
    // No relanzamos: un email caído no debe hacer fallar el webhook de MP
    // (que reintenta si respondemos error) ni la confirmación al cliente.
  }
}
