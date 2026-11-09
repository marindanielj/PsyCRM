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
