import {
  CRISIS_LINES,
  DAY_LABEL,
  type PublicPageConfig,
  MAX_MESSAGE,
  MODE_LABEL,
  NOT_SURE,
  NO_PLAN,
  SLOT_LABEL,
  asksInsurance,
  requiredAcknowledgements,
} from './public-page'
import { escAttr, escText, jsonForScript, safeColor } from './page-html'
import type { PracticeProfile } from '../repos/practice-repo'

/**
 * A practice's public page, rendered on the server in Spanish and mobile-first: a banner, the answers people would
 * otherwise ask by phone (fees, insurance, hours, FAQ), and a form to ask for information or an appointment.
 * Everything the practice wrote is plain text and goes through escText/escAttr; the only script is the form's,
 * and it carries the request's nonce.
 */

const STYLE = `
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:#f8fafc;font:17px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
a{color:var(--brand)}
.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);border-bottom:1px solid #e2e8f0}
.top>div{max-width:980px;margin:0 auto;padding:10px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.name{display:inline-flex;align-items:center;gap:10px;font-weight:700;color:#0f172a;text-decoration:none}
.name img{height:34px;width:auto;max-width:150px;object-fit:contain}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border:0;border-radius:12px;background:var(--brand);color:#fff;font:600 1rem system-ui,sans-serif;text-decoration:none;cursor:pointer}
.btn.sm{min-height:40px;padding:0 16px;font-size:.92rem}
.btn:disabled{opacity:.55;cursor:default}
.hero{position:relative;color:#fff;background:linear-gradient(135deg,var(--brand),#0f172a);overflow:hidden}
.hero img.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hero .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.45),rgba(15,23,42,.72))}
.hero .in{position:relative;max-width:980px;margin:0 auto;padding:72px 18px 64px}
.hero h1{font-size:clamp(1.9rem,5vw,3rem);line-height:1.12;margin:0 0 .4em;max-width:18em}
.hero p{font-size:clamp(1.05rem,2.4vw,1.3rem);margin:0 0 1.4em;max-width:34em;opacity:.95}
.hero .btn{background:#fff;color:#0f172a}
.who{margin-top:1.6em;font-size:.95rem;opacity:.92}
.crisis{background:#fff7ed;border-bottom:1px solid #fed7aa;color:#7c2d12;font-size:.95rem}
.crisis>div{max-width:980px;margin:0 auto;padding:10px 18px}
main{max-width:980px;margin:0 auto;padding:8px 18px 56px}
section{margin:44px 0}
h2{font-size:1.5rem;margin:0 0 .6em}
.lead{color:#334155;max-width:46em}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px}
.card h3{margin:0 0 .3em;font-size:1.1rem}
.card p{margin:0;color:#334155}
.fees{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.fee{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:16px 18px}
.fee b{display:block;font-size:1.5rem;color:var(--brand)}
.fee span{color:#475569;font-size:.95rem}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:.6em 0}
.chip{background:#eef2ff;color:#312e81;border-radius:99px;padding:6px 14px;font-size:.95rem}
.note{background:#fff;border-left:4px solid var(--brand);border-radius:8px;padding:12px 16px;color:#334155;margin:.8em 0}
details{background:#fff;border:1px solid #e2e8f0;border-radius:14px;margin:10px 0;overflow:hidden}
summary{cursor:pointer;padding:16px 20px;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:12px;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";font-size:1.4rem;line-height:1;color:var(--brand);flex:none}
details[open] summary::after{content:"\\2212"}
details .a{padding:0 20px 18px;color:#334155}
.formcard{background:#fff;border:1px solid #cbd5e1;border-radius:20px;padding:26px;box-shadow:0 10px 30px -18px rgba(15,23,42,.35)}
label.l,legend.l{display:block;font-weight:600;margin:1em 0 .35em}
.t{width:100%;padding:12px;border:1px solid #94a3b8;border-radius:10px;font:inherit;background:#fff}
.t:focus,.btn:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--brand) 45%,white);outline-offset:2px}
fieldset{border:0;padding:0;margin:0}
.opts{display:flex;flex-wrap:wrap;gap:10px}
.opt{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;cursor:pointer;font-weight:500}
.opt input{width:20px;height:20px;accent-color:var(--brand)}
.opt:has(input:checked){border-color:var(--brand);background:color-mix(in srgb,var(--brand) 10%,white)}
.ack{display:flex;gap:10px;align-items:flex-start;margin:.7em 0;font-weight:400}
.ack input{width:22px;height:22px;margin-top:2px;flex:none;accent-color:var(--brand)}
.hint{color:#475569;font-size:.92rem;margin:.3em 0}
.msg{margin:1em 0;padding:12px 14px;border-radius:10px;font-size:.97rem}
.msg.err{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3}
.msg.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
.msg.pv{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
footer{border-top:1px solid #e2e8f0;background:#fff;color:#475569;font-size:.92rem}
footer>div{max-width:980px;margin:0 auto;padding:22px 18px}
.pvbar{background:#fef3c7;color:#78350f;text-align:center;padding:8px 12px;font-size:.92rem;font-weight:600}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`

/** Plain text → paragraphs: blank line = new paragraph, newline = line break. Never HTML. */
export function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escText(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

const BANNER_URL = /^\/p\/[a-z0-9-]{3,40}\/banner\?v=[0-9a-f]{8}$/
const LOGO_URL = /^\/brand\/[A-Za-z0-9_-]+\/logo\?v=[0-9a-f]{8}$/

export interface PublicPageView {
  nonce: string
  slug: string
  practice: PracticeProfile
  /** The name people see (the branding name, else the practice's). */
  displayName: string
  /** A colour that reads with white text on it (see lib/branding). */
  brand?: string
  logoUrl?: string | null
  page: PublicPageConfig
  /** The operator's preview: same page, form switched off, a bar says so. */
  preview?: boolean
}

function feesBlock(o: PublicPageView): string {
  const { fees, policy } = o.practice
  const items: [string, string][] = [
    ['Primera cita (evaluación inicial)', fees.intake],
    ['Sesión de seguimiento', fees.session],
    ['Cancelación tardía o no presentarse', fees.late_cancel],
  ]
  const shown = items.filter(([, v]) => v)
  if (!o.page.showFees || shown.length === 0) return ''
  const cancel = policy.cancel_hours ? `<p class="hint">Para cambiar o cancelar una cita se necesita aviso con ${escText(policy.cancel_hours)} horas de anticipación.</p>` : ''
  return `<section id="tarifas"><h2>Tarifas</h2><div class="fees">${shown.map(([label, v]) => `<div class="fee"><b>${escText(v)}</b><span>${escText(label)}</span></div>`).join('')}</div>${cancel}</section>`
}

function insuranceBlock(o: PublicPageView): string {
  const { insurance } = o.page
  const note = insurance.note ? `<div class="note">${paragraphs(insurance.note)}</div>` : ''
  if (insurance.accepted) {
    const plans = insurance.plans.length ? `<div class="chips" role="list">${insurance.plans.map((p) => `<span class="chip" role="listitem">${escText(p)}</span>`).join('')}</div>` : ''
    return `<section id="planes"><h2>Planes médicos</h2><p class="lead">Estos son los planes que aceptamos:</p>${plans}${note}</section>`
  }
  return `<section id="planes"><h2>Planes médicos</h2><p class="lead"><strong>Por ahora no aceptamos planes médicos.</strong> Las citas se pagan directamente según las tarifas de esta página.</p>${note}</section>`
}

function formBlock(o: PublicPageView): string {
  const c = o.page
  const f = c.form
  const radios = (name: string, items: { value: string; label: string }[], type: 'radio' | 'checkbox', checkedFirst = false) =>
    `<div class="opts">${items.map((it, i) => `<label class="opt"><input type="${type}" name="${name}" value="${escAttr(it.value)}"${type === 'radio' ? ' required' : ''}${checkedFirst && i === 0 ? ' checked' : ''}> ${escText(it.label)}</label>`).join('')}</div>`
  const insurance = asksInsurance(c)
    ? `<label class="l" for="insurance">¿Tiene plan médico?</label><select class="t" id="insurance" name="insurance" required><option value="">Seleccione…</option>${[...c.insurance.plans, NO_PLAN, NOT_SURE].map((p) => `<option value="${escAttr(p)}">${escText(p)}</option>`).join('')}</select>`
    : ''
  const acks = requiredAcknowledgements(c)
    .map((a, i) => `<label class="ack"><input type="checkbox" class="ackbox" data-ack="${escAttr(a)}" id="ack${i}" required> <span>${escText(a)}</span></label>`)
    .join('')
  const intro = f.intro ? `<p class="lead">${escText(f.intro)}</p>` : ''
  return `<section id="solicitar"><div class="formcard"><h2>Solicitar información o una cita</h2>${intro}
<p class="hint">Escriba solo lo necesario para contactarle. <strong>No incluya información médica ni de salud en este formulario.</strong> Esta página no es para emergencias.</p>
<form id="req" onsubmit="return false" novalidate>
<label class="l" for="name">Nombre completo</label><input class="t" id="name" name="name" required maxlength="120" autocomplete="name">
<label class="l" for="email">Correo electrónico</label><input class="t" id="email" name="email" type="email" required maxlength="200" autocomplete="email">
<label class="l" for="phone">Teléfono <span class="hint">(opcional)</span></label><input class="t" id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel">
<fieldset><legend class="l">¿Para quién es la cita?</legend>${radios('who', [{ value: 'adult', label: 'Para mí' }, { value: 'minor', label: 'Para mi hijo/a o un menor a mi cargo' }], 'radio')}</fieldset>
<fieldset><legend class="l">Modalidad</legend>${radios('mode', f.modes.map((m) => ({ value: m, label: MODE_LABEL[m] })), 'radio')}</fieldset>
<fieldset><legend class="l">¿Qué días le convienen?</legend>${radios('days', f.days.map((d) => ({ value: d, label: DAY_LABEL[d] })), 'checkbox')}<p class="hint">Puede marcar más de uno.</p></fieldset>
<fieldset><legend class="l">¿En qué horario?</legend>${radios('slots', f.slots.map((s) => ({ value: s, label: SLOT_LABEL[s] })), 'checkbox')}<p class="hint">Puede marcar los dos.</p></fieldset>
${insurance}
<label class="l" for="message">¿Algo que debamos saber para contactarle? <span class="hint">(opcional, máx. ${MAX_MESSAGE} caracteres)</span></label><textarea class="t" id="message" name="message" rows="3" maxlength="${MAX_MESSAGE}"></textarea>
<div style="margin-top:1.2em">${acks}<label class="ack"><input type="checkbox" id="consent" required> <span>Autorizo a ${escText(o.displayName || 'la consulta')} a contactarme con estos datos para responder a mi solicitud.</span></label></div>
<div class="hp" aria-hidden="true"><label>No llenar<input name="website" tabindex="-1" autocomplete="off"></label></div>
<div id="msg" class="msg" hidden role="status"></div>
${o.preview ? '<div class="msg pv">Vista previa: el formulario está desactivado.</div>' : ''}
<div style="margin-top:1.2em"><button class="btn" id="go" type="button"${o.preview ? ' disabled' : ''}>Enviar solicitud</button></div>
</form></div></section>`
}

const SCRIPT = (slug: string) => `const SLUG=${jsonForScript(slug)};
const form=document.getElementById('req'),msg=document.getElementById('msg'),btn=document.getElementById('go');
function show(t,c){msg.className='msg '+c;msg.textContent=t;msg.hidden=false;msg.scrollIntoView({block:'nearest'})}
const errs={invalid:'Revise los datos marcados.',mode_not_offered:'Esa modalidad no está disponible.',invalid_days:'Marque al menos un día.',invalid_slots:'Marque al menos un horario.',invalid_insurance:'Seleccione una opción de plan médico.',acknowledgement_required:'Marque las confirmaciones para continuar.',rate_limited:'Demasiados intentos. Espere unos minutos e inténtelo de nuevo.'};
const checked=n=>[...form.querySelectorAll('[name="'+n+'"]:checked')].map(i=>i.value);
const one=n=>{const e=form.querySelector('[name="'+n+'"]:checked');return e?e.value:''};
const val=n=>form.elements[n]?form.elements[n].value.trim():'';
btn&&btn.addEventListener('click',async()=>{
  msg.hidden=true;
  if(!checked('days').length){show(errs.invalid_days,'err');return}
  if(!checked('slots').length){show(errs.invalid_slots,'err');return}
  if(!form.reportValidity())return;
  btn.disabled=true;
  let r;try{r=await fetch('/p/'+SLUG+'/inquiry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:val('name'),email:val('email'),phone:val('phone'),who:one('who'),mode:one('mode'),days:checked('days'),slots:checked('slots'),insurance:val('insurance')||undefined,message:val('message'),acknowledged:[...form.querySelectorAll('.ackbox:checked')].map(i=>i.dataset.ack),consent:document.getElementById('consent').checked,website:val('website')})})}catch(e){btn.disabled=false;show('No pudimos enviar su solicitud. Inténtelo de nuevo.','err');return}
  let j={};try{j=await r.json()}catch(e){}
  if(r.status===200){form.hidden=true;msg.className='msg ok';msg.textContent='¡Gracias! Recibimos su solicitud y nos comunicaremos con usted.';msg.hidden=false;msg.scrollIntoView({block:'center'});return}
  btn.disabled=false;show(errs[j.error]||'No pudimos enviar su solicitud. Inténtelo de nuevo.','err');
});`

export function renderPublicPage(o: PublicPageView): string {
  const c = o.page
  const name = o.displayName || 'Consulta'
  const bannerUrl = c.bannerVersion ? `/p/${o.slug}/banner?v=${c.bannerVersion}` : null
  const banner = bannerUrl && BANNER_URL.test(bannerUrl) ? `<img class="bg" src="${escAttr(bannerUrl)}" alt=""><div class="shade"></div>` : ''
  const logo = o.logoUrl && LOGO_URL.test(o.logoUrl) ? `<img src="${escAttr(o.logoUrl)}" alt="">` : ''
  const therapist = c.showTherapist && (o.practice.therapist || o.practice.license)
    ? `<p class="who">${escText([o.practice.therapist, o.practice.license ? `Licencia ${o.practice.license}` : ''].filter(Boolean).join(' · '))}</p>`
    : ''
  const crisis = c.showCrisis
    ? `<div class="crisis" role="note"><div><strong>Si usted o alguien está en peligro inmediato, no espere una cita:</strong> ${CRISIS_LINES.map((l) => `${escText(l.name)}: <strong>${escText(l.detail)}</strong>`).join(' · ')}</div></div>`
    : ''
  const services = c.services.length
    ? `<section id="servicios"><h2>Servicios</h2><div class="grid">${c.services.map((s) => `<div class="card"><h3>${escText(s.title)}</h3>${s.text ? `<p>${escText(s.text)}</p>` : ''}</div>`).join('')}</div></section>`
    : ''
  const about = c.about ? `<section id="sobre"><h2>Sobre la consulta</h2><div class="lead">${paragraphs(c.about)}</div></section>` : ''
  const faq = c.faq.length
    ? `<section id="preguntas"><h2>Preguntas frecuentes</h2>${c.faq.map((f) => `<details><summary>${escText(f.q)}</summary><div class="a">${paragraphs(f.a)}</div></details>`).join('')}</section>`
    : ''
  const info = c.hours || c.location
    ? `<section id="info"><h2>Horario y ubicación</h2><div class="grid">${c.hours ? `<div class="card"><h3>Horario</h3><p>${escText(c.hours).replace(/\n/g, '<br>')}</p></div>` : ''}${c.location ? `<div class="card"><h3>Dónde</h3><p>${escText(c.location).replace(/\n/g, '<br>')}</p></div>` : ''}</div></section>`
    : ''
  const description = (c.subheadline || c.about || `Solicite información o una cita con ${name}.`).slice(0, 160)
  const body = `${o.preview ? '<div class="pvbar">Vista previa: así se verá su página. Todavía no es pública.</div>' : ''}
<header class="top"><div><a class="name" href="#top">${logo}${escText(name)}</a><a class="btn sm" href="#solicitar">Solicitar cita</a></div></header>
<div class="hero" id="top">${banner}<div class="in"><h1>${escText(c.headline || name)}</h1>${c.subheadline ? `<p>${escText(c.subheadline)}</p>` : ''}<a class="btn" href="#solicitar">Solicitar información o una cita</a>${therapist}</div></div>
${crisis}
<main>${about}${services}${feesBlock(o)}${insuranceBlock(o)}${faq}${info}${formBlock(o)}</main>
<footer><div>${escText(name)}. Esta página es informativa y no es para emergencias.</div></footer>`
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">${o.preview ? '<meta name="robots" content="noindex,nofollow">' : ''}<title>${escText(c.headline ? `${name}: ${c.headline}` : name)}</title><meta name="description" content="${escAttr(description)}"><meta property="og:title" content="${escAttr(name)}"><meta property="og:description" content="${escAttr(description)}"><meta property="og:type" content="website"><style>:root{--brand:${safeColor(o.brand)}}${STYLE}</style></head><body>${body}${o.preview ? '' : `<script nonce="${escAttr(o.nonce)}">${SCRIPT(o.slug)}</script>`}</body></html>`
}

export function renderPageNotFound(nonce: string): string {
  void nonce
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Página no disponible</title><style>body{margin:0;background:#f8fafc;font:17px/1.6 system-ui,sans-serif;color:#0f172a;display:grid;place-items:center;min-height:100vh;padding:20px}main{max-width:30em;text-align:center}</style></head><body><main><h1>Esta página no está disponible</h1><p>Es posible que el enlace sea incorrecto o que la página aún no esté publicada.</p></main></body></html>`
}
