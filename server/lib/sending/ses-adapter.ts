import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2'
import type { EmailMessage, EmailSender, SendResult } from './provider'

/** The one SES call this adapter makes; injectable so tests need no AWS. */
export type SesSend = (input: SendEmailCommandInput) => Promise<{ MessageId?: string }>

export interface SesAdapterConfig {
  /** A sender identity verified in SES (an address or a whole domain). */
  fromEmail: string
  fromName?: string
  region: string
  /** An SES configuration set (bounce and complaint tracking), if one was created. */
  configurationSet?: string
  /** An alternative endpoint (a local SES emulator, or a test server). Production leaves it unset. */
  endpoint?: string
  /** Injectable for tests. Default: a real client using the task role's credentials. */
  send?: SesSend
}

const ADDRESS = /^[^\s<>",;:\\()[\]]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}$/

export function isSafeAddress(a: string): boolean {
  return a.length <= 320 && ADDRESS.test(a)
}

/**
 * A display name safe to put in a header: no line breaks, quotes or angle brackets (they could end the
 * name and inject another header or recipient), and non-ASCII text as an RFC 2047 encoded word.
 */
export function displayName(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!clean) return ''
  return /^[\x20-\x7e]+$/.test(clean) ? `"${clean}"` : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** `Name <address>`, or just the address. */
export function mailbox(address: string, name?: string): string {
  const n = name ? displayName(name) : ''
  return n ? `${n} <${address}>` : address
}

/**
 * Amazon SES (v2) email adapter. In production the task runs under an IAM role that may only
 * `ses:SendEmail` from the practice's verified identity, so there is no API key to store or leak.
 */
export function createSesAdapter(config: SesAdapterConfig): EmailSender {
  if (!isSafeAddress(config.fromEmail)) throw new Error('ses: the sender address is not valid')
  const send: SesSend =
    config.send ??
    (() => {
      const client = new SESv2Client({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}) })
      return (input) => client.send(new SendEmailCommand(input))
    })()

  return {
    name: 'ses',

    async sendEmail(msg: EmailMessage): Promise<SendResult> {
      // The address and the subject come from records and templates: refuse anything that could break out of a header.
      if (!isSafeAddress(msg.to)) throw new Error('ses send refused: the recipient address is not valid')
      const subject = msg.subject.replace(/[\r\n]+/g, ' ').trim()
      try {
        const out = await send({
          FromEmailAddress: mailbox(config.fromEmail, config.fromName),
          Destination: { ToAddresses: [mailbox(msg.to, msg.toName)] },
          Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: msg.text, Charset: 'UTF-8' } } } },
          ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
        })
        if (!out.MessageId) throw new Error('ses send response missing MessageId')
        return { externalId: out.MessageId, provider: 'ses' }
      } catch (err) {
        // The SDK's message can echo the recipient: only the error's NAME (e.g. MessageRejected) is kept.
        const name = (err as { name?: unknown } | null)?.name
        throw new Error(`ses send failed: ${typeof name === 'string' ? name : 'error'}`)
      }
    },
  }
}
