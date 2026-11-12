import type { BillingInvoicesRepo, IssuerBlock, ReceiptRow } from '../repos/billing-documents-repo'
import { PAYMENT_METHOD_LABEL_ES, formatCents } from './billing-vocab'
import { header, shell } from './document-page'
import { escText } from './page-html'

/**
 * The page behind the emailed link: the invoice or receipt, in Spanish, as it was issued (an invoice's paid amount and
 * balance are live). Every value is escaped. It carries nothing clinical: no diagnosis, code, tax id or NPI.
 */
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
export function formatDateEs(ymd: string | Date | null | undefined): string {
  // A timestamp can arrive as a Date (straight from the database) or as text: read the calendar date either way.
  const text = ymd instanceof Date ? ymd.toISOString() : String(ymd ?? '')
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!m) return text
  return `${Number(m[3])} de ${MONTHS_ES[Number(m[2]) - 1] ?? m[2]} de ${m[1]}`
}

type InvoiceDetail = NonNullable<Awaited<ReturnType<BillingInvoicesRepo['get']>>>

const STYLE = `<style>
.bd h1{margin:0}.bd .top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-bottom:1px solid #cbd5e1;padding-bottom:10px}
.bd .num{font-family:ui-monospace,monospace;font-weight:700}.bd .r{text-align:right}
.bd .two{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-top:14px}
.bd h2{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:0 0 4px}
.bd p{margin:.15em 0}.bd table{width:100%;border-collapse:collapse;margin-top:16px;font-size:.92rem}
.bd th{font-size:.72rem;text-transform:uppercase;color:#475569;text-align:left;border-bottom:1px solid #94a3b8;padding:4px 6px 4px 0}
.bd td{border-bottom:1px solid #e2e8f0;padding:5px 6px 5px 0;vertical-align:top}.bd .n{text-align:right;font-variant-numeric:tabular-nums}
.bd tfoot td{border:0}.bd .big{font-weight:700;font-size:1.05rem}.bd .tag{font-weight:700}
.bd .void{color:#be123c}.bd .ok{color:#047857}
@media (max-width:520px){.bd table{font-size:.82rem}}
</style>`

const issuerBlock = (p: IssuerBlock, label: string) =>
  `<section><h2>${label}</h2><p><strong>${escText(p.name)}</strong></p>${p.practiceName && p.practiceName !== p.name ? `<p>${escText(p.practiceName)}</p>` : ''}<p style="white-space:pre-line">${escText(p.address)}</p><p>${escText([p.phone, p.email].filter(Boolean).join(' · '))}</p></section>`

const actions = `<div class="row noprint"><button class="btn" id="print" type="button">Imprimir / Guardar como PDF</button></div>`
const PRINT_SCRIPT = `document.getElementById('print').addEventListener('click',function(){window.print()});`

export function renderInvoiceSharePage(o: { practice: string; brand?: string; logoUrl?: string; nonce: string; invoice: InvoiceDetail }): string {
  const inv = o.invoice
  const s = inv.snapshot
  const voided = inv.status === 'void'
  const paidOf = (id: string) => (voided ? 0 : inv.paid_by_charge[id] ?? 0)
  const rows = s.lines.map((l) => {
    const p = paidOf(l.chargeId)
    return `<tr><td>${escText(formatDateEs(l.serviceDate))}</td><td>${escText(l.description)}</td><td class="n">${formatCents(l.feeCents)}</td><td class="n">${formatCents(p)}</td><td class="n">${formatCents(voided ? 0 : l.feeCents - p)}</td></tr>`
  }).join('')
  const body = `${header(o.practice, o.logoUrl)}<div class="card bd">
<div class="top"><div><h1>Factura</h1><p><strong>${escText(s.provider.practiceName || s.provider.name)}</strong></p></div>
<div class="r"><div class="num">${escText(inv.number)}</div><div>Emitida el ${escText(formatDateEs(inv.issued_at))}</div>${inv.due_on ? `<div>Vence el ${escText(formatDateEs(inv.due_on))}</div>` : ''}${voided ? '<div class="tag void">ANULADA</div>' : inv.status === 'paid' ? '<div class="tag ok">PAGADA</div>' : ''}</div></div>
<div class="two">${issuerBlock(s.provider, 'De')}<section><h2>Facturar a</h2><p><strong>${escText(s.client.name)}</strong></p>${s.client.address ? `<p style="white-space:pre-line">${escText(s.client.address)}</p>` : ''}</section></div>
<table><thead><tr><th>Fecha</th><th>Descripción</th><th class="n">Importe</th><th class="n">Pagado</th><th class="n">Saldo</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="2" class="n tag">Total de la factura</td><td class="n tag">${formatCents(s.totals.billedCents)}</td><td></td><td></td></tr>
<tr><td colspan="3" class="n">Pagado hasta hoy</td><td class="n">${formatCents(inv.paid_cents)}</td><td></td></tr>
<tr><td colspan="4" class="n big">Saldo pendiente</td><td class="n big">${formatCents(inv.balance_cents)}</td></tr></tfoot></table>
${s.note ? `<p style="white-space:pre-line;margin-top:14px">${escText(s.note)}</p>` : ''}</div>${actions}`
  return shell({ title: `${o.practice || 'Factura'}: factura`, brand: o.brand, body: STYLE + body, nonce: o.nonce, script: PRINT_SCRIPT })
}

export function renderReceiptSharePage(o: { practice: string; brand?: string; logoUrl?: string; nonce: string; receipt: ReceiptRow }): string {
  const r = o.receipt
  const s = r.snapshot
  const voided = Boolean(r.voided_at)
  const rows = s.lines.map((l) => `<tr><td>${escText(formatDateEs(l.serviceDate))}</td><td>${escText(l.description)}</td><td class="n">${formatCents(l.amountCents)}</td><td class="n">${formatCents(l.balanceAfterCents)}</td></tr>`).join('')
  const body = `${header(o.practice, o.logoUrl)}<div class="card bd">
<div class="top"><div><h1>Recibo de pago</h1><p><strong>${escText(s.provider.practiceName || s.provider.name)}</strong></p></div>
<div class="r"><div class="num">${escText(r.number)}</div><div>Pagado el ${escText(formatDateEs(r.paid_on))}</div>${voided ? '<div class="tag void">ANULADO</div>' : ''}</div></div>
<div class="two">${issuerBlock(s.provider, 'Recibido por')}<section><h2>Recibido de</h2><p><strong>${escText(s.client.name)}</strong></p><p>Forma de pago: ${escText(PAYMENT_METHOD_LABEL_ES[r.method] ?? r.method)}</p>${s.invoices.length > 0 ? `<p>${s.invoices.length === 1 ? 'Factura' : 'Facturas'}: <span class="num">${escText(s.invoices.join(', '))}</span></p>` : ''}</section></div>
<table><thead><tr><th>Fecha del servicio</th><th>Descripción</th><th class="n">Pagado</th><th class="n">Saldo restante</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="2" class="n big">Total recibido</td><td class="n big">${formatCents(s.totals.paidCents)}</td><td></td></tr></tfoot></table>
<p style="margin-top:16px">Gracias por su pago. Este recibo comprueba el pago de los servicios indicados.</p></div>${actions}`
  return shell({ title: `${o.practice || 'Recibo'}: recibo`, brand: o.brand, body: STYLE + body, nonce: o.nonce, script: PRINT_SCRIPT })
}

