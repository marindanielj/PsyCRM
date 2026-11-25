/**
 * The text a therapist pastes into WhatsApp, SMS or a chat when she sends a link herself.
 * Same wording as the emails the system sends (server/lib/document-mail.ts): the practice name and
 * the link, never a document title, a diagnosis or the word "psicoterapia".
 */
const first = (name: string) => name.trim().split(/\s+/)[0] ?? ''

export const LINK_DAYS = 14

export function inviteMessage(o: { practice: string; name: string; link: string; days?: number }): string {
  return `Hola ${first(o.name)}:\n\n${o.practice || 'Su terapeuta'} le invita a completar sus datos de registro. Use este enlace seguro (válido por ${o.days ?? LINK_DAYS} días):\n\n${o.link}`
}

export function documentsMessage(o: { practice: string; name: string; link: string; days?: number }): string {
  return `Hola ${first(o.name)}:\n\n${o.practice || 'Su terapeuta'} le envió documentos para completar antes de su primera cita. Use este enlace seguro (válido por ${o.days ?? LINK_DAYS} días):\n\n${o.link}\n\nPara abrirlos le pediremos un código que llegará a su correo.`
}

/** "jueves, 4 de junio, 3:00 p. m." in Puerto Rico time, the practice's. */
export function sessionWhen(startsAt: string): string {
  return new Date(startsAt).toLocaleString('es-PR', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Puerto_Rico' })
}

/** The text a therapist pastes to a client for a video session: when, and the link (open from 15 minutes before). */
export function videoMessage(o: { practice: string; name: string; link: string; startsAt: string }): string {
  return `Hola ${first(o.name)}:\n\n${o.practice || 'Su terapeuta'} le espera para su sesión por video el ${sessionWhen(o.startsAt)}\n\nEntre desde su teléfono o computadora con este enlace seguro (se abre 15 minutos antes de la hora):\n\n${o.link}\n\nBusque un lugar privado y tranquilo. La sesión no se graba.`
}
