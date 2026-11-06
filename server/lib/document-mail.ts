import type { EmailSender } from './sending/provider'

/**
 * The three emails of the signing flow (Spanish). They carry a link or a code and the
 * practice name — never a document title, a diagnosis or the word "psicoterapia".
 */
export interface MailResult {
  sent: boolean
  /** Why nothing was sent (not a secret, safe to show the therapist). */
  reason?: string
}

async function send(sender: EmailSender | null, why: string | undefined, msg: { to: string; toName?: string; subject: string; text: string }): Promise<MailResult> {
  if (!sender) return { sent: false, reason: why ?? 'email is not configured' }
  try {
    await sender.sendEmail(msg)
    return { sent: true }
  } catch {
    // The provider's error can echo the address or body: it is not logged or returned.
    return { sent: false, reason: 'the email provider rejected the message' }
  }
}

const first = (name: string) => name.trim().split(/\s+/)[0] ?? ''

export const sendLinkEmail = (s: EmailSender | null, why: string | undefined, o: { practice: string; to: string; name: string; link: string; days: number }) =>
  send(s, why, {
    to: o.to,
    toName: o.name,
    subject: `${o.practice}: documentos pendientes`,
    text: `Hola ${first(o.name)}:\n\n${o.practice} le envió documentos para completar antes de su primera cita. Use este enlace seguro (válido por ${o.days} días):\n\n${o.link}\n\nSi no esperaba este mensaje, ignórelo.`,
  })

export const sendOtpEmail = (s: EmailSender | null, why: string | undefined, o: { practice: string; to: string; name: string; code: string }) =>
  send(s, why, {
    to: o.to,
    toName: o.name,
    subject: `${o.practice}: código de verificación`,
    text: `Hola ${first(o.name)}:\n\nSu código de verificación es ${o.code}. Vence en 10 minutos.\n\nSi usted no lo solicitó, ignore este mensaje.`,
  })

export const sendCopyEmail = (s: EmailSender | null, why: string | undefined, o: { practice: string; to: string; name: string; link: string }) =>
  send(s, why, {
    to: o.to,
    toName: o.name,
    subject: `${o.practice}: sus documentos firmados`,
    text: `Hola ${first(o.name)}:\n\nSus documentos firmados están disponibles en este enlace (válido por 30 días):\n\n${o.link}\n\nPara abrirlos tendrá que verificar su identidad con un código.`,
  })
