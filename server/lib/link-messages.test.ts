import { documentsMessage, inviteMessage } from '../../src/lib/link-messages'
import { sendInviteEmail, sendLinkEmail } from './document-mail'

const LINK = 'https://app.example.com/i/abc'

test('the invitation message greets by first name, names the practice, carries the link and the validity', () => {
  const m = inviteMessage({ practice: 'Consultorio Rivera', name: 'Marta Prueba Díaz', link: LINK })
  expect(m).toContain('Hola Marta:')
  expect(m).toContain('Consultorio Rivera le invita a completar sus datos de registro')
  expect(m).toContain('(válido por 14 días)')
  expect(m.trim().endsWith(LINK)).toBe(true)
})

test('the documents message says a code will arrive by email, and falls back to "Su terapeuta" with no practice name', () => {
  const m = documentsMessage({ practice: '', name: 'Ana', link: 'https://app.example.com/d/xyz' })
  expect(m).toContain('Su terapeuta le envió documentos')
  expect(m).toContain('código que llegará a su correo')
})

test('what a therapist pastes never carries clinical wording or a document title', () => {
  for (const m of [inviteMessage({ practice: 'Consultorio Rivera', name: 'Ana Rivera', link: LINK }), documentsMessage({ practice: 'Consultorio Rivera', name: 'Ana Rivera', link: LINK })]) {
    expect(m).not.toMatch(/psicoterapia|terapia|diagn|consentimiento|admisión/i)
  }
})

test('the pasted text is the same wording as the emails the system sends', async () => {
  const sent: string[] = []
  const sender = { name: 't', sendEmail: async (msg: { text: string }) => (sent.push(msg.text), { externalId: 'x', provider: 't' }) }
  const o = { practice: 'Consultorio Rivera', to: 'a@x.com', name: 'Marta Prueba', link: LINK, days: 14 }
  await sendInviteEmail(sender, undefined, o)
  await sendLinkEmail(sender, undefined, o)
  const stripTail = (t: string) => t.split('\n\nSi no esperaba')[0]!
  expect(stripTail(sent[0]!)).toBe(inviteMessage({ practice: o.practice, name: o.name, link: LINK }))
  expect(stripTail(sent[1]!)).toBe(documentsMessage({ practice: o.practice, name: o.name, link: LINK }).split('\n\nPara abrirlos')[0])
})
