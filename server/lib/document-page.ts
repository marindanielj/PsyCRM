import { DOC_STYLE } from './document-render'
import { escAttr, escText, jsonForScript, safeColor } from './page-html'

/**
 * The public signing pages (Spanish, mobile-first, rendered on the server). One small
 * inline script per page talks to the JSON endpoints; every script carries the
 * request's nonce, so the page can run with a strict Content-Security-Policy.
 */

export const PAGE_STYLE = `
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:#f1f5f9;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
.wrap{max-width:760px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;margin:12px 0}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#475569;font-size:.9rem}
.brand{font-weight:700;color:var(--brand)}
h1{font-size:1.35rem;margin:.2em 0 .5em}
.muted{color:#475569;font-size:.92rem}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn:disabled{opacity:.5;cursor:default}
.btn.ghost{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.code{width:100%;max-width:240px;padding:12px;font:600 1.6rem/1 ui-monospace,monospace;letter-spacing:.35em;text-align:center;border:1px solid #94a3b8;border-radius:10px}
.msg{margin:.8em 0;padding:10px 12px;border-radius:8px;font-size:.95rem}
.msg.err{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3}
.msg.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
.msg.warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}
.bar{height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:8px 0 4px}.bar>i{display:block;height:100%;background:var(--brand)}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #e2e8f0}.list li:last-child{border:0}
.st{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-size:.85rem;border:2px solid #cbd5e1;color:#64748b}
.st.done{background:#059669;border-color:#059669;color:#fff}.st.prog{border-color:#d97706;color:#b45309}
.consent label{display:flex;gap:10px;align-items:flex-start;margin:.7em 0;font-weight:400}
.consent input[type=checkbox]{width:22px;height:22px;margin-top:2px;flex:none}
.field-label{display:block;font-weight:600;margin:.9em 0 .3em}
.text{width:100%;padding:12px;border:1px solid #94a3b8;border-radius:10px;font:inherit}
#sig{display:block;width:100%;height:170px;background:#fff;border:1px dashed #64748b;border-radius:10px;touch-action:none}
.doc-card .doc{padding:0}
.readonly .doc{padding:0}
@media print{body{background:#fff}.noprint{display:none!important}.card{border:0;padding:0}.copy-doc{break-after:page}}
`

export function shell(o: { title: string; brand?: string; logoUrl?: string; body: string; nonce: string; script?: string }): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escText(o.title)}</title><style>:root{--brand:${safeColor(o.brand)}}${DOC_STYLE}${PAGE_STYLE}</style></head><body><div class="wrap">${o.body}</div>${o.script ? `<script nonce="${escAttr(o.nonce)}">${o.script}</script>` : ''}</body></html>`
}

/** The page's top bar: the practice's logo (when it has one) and its name. The logo URL is one WE build (`/brand/<id>/logo?v=…`). */
export const header = (practice: string, logoUrl?: string | null) =>
  `<div class="head"><span class="brand" style="display:inline-flex;align-items:center;gap:8px">${logoUrl && /^\/brand\/[A-Za-z0-9_-]+\/logo\?v=[0-9a-f]{8}$/.test(logoUrl) ? `<img src="${escAttr(logoUrl)}" alt="" style="height:32px;width:auto;max-width:140px;object-fit:contain">` : ''}${escText(practice || 'Documentos')}</span><span>Documentos seguros</span></div>`

/** Same words and same shape for a link that never existed, expired, was voided or belongs to another practice. */
export function renderInvalidPage(nonce: string): string {
  return shell({
    title: 'Enlace no válido',
    nonce,
    body: `<div class="card"><h1>Este enlace no es válido o expiró</h1><p class="muted">Comuníquese con su terapeuta para recibir uno nuevo.</p></div>`,
  })
}

const CLIENT_COMMON = `
const T=__T__;
async function post(path,body){
  let r;
  try{r=await fetch('/d/'+T+path,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body||{})})}
  catch(e){return {status:0,json:{}}}
  let j={};try{j=await r.json()}catch(e){}
  return {status:r.status,json:j}
}
function show(el,text,cls){el.className='msg '+cls;el.textContent=text;el.hidden=false}
`

/** `therapistCode`: the therapist gave this person a code (read out, not emailed), so the box to type it is already open. */
export function renderVerifyPage(o: { practice: string; maskedEmail: string; token: string; nonce: string; brand?: string; logoUrl?: string; locked: boolean; therapistCode?: boolean }): string {
  const script = `${CLIENT_COMMON.replace('__T__', jsonForScript(o.token))}
const send=document.getElementById('send'),codeBox=document.getElementById('codebox'),verify=document.getElementById('verify'),code=document.getElementById('code'),msg=document.getElementById('msg');
send&&send.addEventListener('click',async()=>{
  send.disabled=true;
  const r=await post('/otp');
  if(r.status===200){show(msg,'Le enviamos un código. Revise su correo (y la carpeta de spam).','ok');codeBox.hidden=false;code.focus();setTimeout(()=>{send.disabled=false;send.textContent='Enviar otro código'},30000)}
  else if(r.status===429){show(msg,'Demasiados intentos. Espere unos minutos e inténtelo de nuevo.','err');send.disabled=false}
  else if(r.status===423){show(msg,'Este enlace quedó bloqueado por demasiados intentos. Pida a su terapeuta que le envíe uno nuevo.','err')}
  else {show(msg,'No pudimos enviar el código. Comuníquese con su terapeuta.','err');send.disabled=false}
});
verify&&verify.addEventListener('click',async()=>{
  const v=code.value.replace(/\\D/g,'');
  if(v.length!==6){show(msg,'Escriba los 6 dígitos del código.','err');return}
  verify.disabled=true;
  const r=await post('/verify',{code:v});
  if(r.status===200){location.reload();return}
  verify.disabled=false;
  if(r.status===423)show(msg,'Este enlace quedó bloqueado por demasiados intentos. Pida a su terapeuta que le envíe uno nuevo.','err');
  else if(r.status===401)show(msg,r.json.remaining!=null?'El código no es correcto. Intentos restantes: '+r.json.remaining+'.':'El código no es correcto o venció. Pida uno nuevo.','err');
  else show(msg,'No pudimos verificar el código. Inténtelo de nuevo.','err');
});`
  const body = `${header(o.practice, o.logoUrl)}<div class="card"><h1>Verifique su identidad</h1>
${o.therapistCode ? '<p>Su terapeuta le dio un código de 6 dígitos. Escríbalo aquí.</p>' : `<p>Para proteger su información, enviaremos un código de 6 dígitos a <strong>${escText(o.maskedEmail)}</strong>.</p>`}
${o.locked ? '<div class="msg err">Este enlace quedó bloqueado por demasiados intentos. Pida a su terapeuta que le envíe uno nuevo.</div>' : `<div class="row"><button class="btn${o.therapistCode ? ' ghost' : ''}" id="send" type="button">${o.therapistCode ? 'Prefiero recibirlo por correo' : 'Enviar código'}</button></div>
<div id="codebox"${o.therapistCode ? '' : ' hidden'}><label class="field-label" for="code">Código de 6 dígitos</label><input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"><div class="row"><button class="btn" id="verify" type="button">Verificar</button></div></div>`}
<div id="msg" class="msg" hidden role="status"></div></div>`
  return shell({ title: `${o.practice || 'Documentos'}: verificación`, brand: o.brand, body, nonce: o.nonce, script: o.locked ? undefined : script })
}

export interface ChecklistItem {
  title: string
  state: 'pending' | 'in_progress' | 'signed'
  href: string
}

export function renderChecklistPage(o: { practice: string; signerName: string; items: ChecklistItem[]; nonce: string; brand?: string; logoUrl?: string }): string {
  const signed = o.items.filter((i) => i.state === 'signed').length
  const next = o.items.find((i) => i.state !== 'signed')
  const mark = { pending: '', in_progress: '◐', signed: '✓' }
  const minutes = Math.max(5, (o.items.length - signed) * 3)
  const body = `${header(o.practice, o.logoUrl)}<div class="card"><h1>Hola, ${escText(o.signerName.split(/\s+/)[0] ?? '')}</h1>
<p>Tiene <strong>${o.items.length - signed}</strong> documento${o.items.length - signed === 1 ? '' : 's'} por completar (unos ${minutes} minutos). Puede guardar su avance y volver con este mismo enlace.</p>
<div class="bar" aria-hidden="true"><i style="width:${Math.round((signed / o.items.length) * 100)}%"></i></div>
<ol class="list">${o.items.map((i, n) => `<li><span class="st ${i.state === 'signed' ? 'done' : i.state === 'in_progress' ? 'prog' : ''}" aria-hidden="true">${mark[i.state] || n + 1}</span><span style="flex:1">${escText(i.title)}</span>${i.state === 'signed' ? `<a href="${escAttr(i.href)}" class="muted">Ver</a>` : ''}</li>`).join('')}</ol>
${next ? `<div class="row"><a class="btn" href="${escAttr(next.href)}">${signed === 0 && next.state === 'pending' ? 'Comenzar' : 'Continuar'}</a></div>` : ''}</div>`
  return shell({ title: `${o.practice || 'Documentos'}: sus documentos`, brand: o.brand, body, nonce: o.nonce })
}

export function renderDocumentPage(o: {
  practice: string
  token: string
  nonce: string
  brand?: string
  logoUrl?: string
  templateId: string
  index: number
  total: number
  title: string
  fillHtml: string
  signerName: string
  drawn: boolean
  nextHref: string
  checklistHref: string | null
}): string {
  const script = `${CLIENT_COMMON.replace('__T__', jsonForScript(o.token))}
const TID=${jsonForScript(o.templateId)},NEXT=${jsonForScript(o.nextHref)},DRAWN=${o.drawn ? 'true' : 'false'},EXPECTED=${jsonForScript(o.signerName)};
const form=document.getElementById('docform'),msg=document.getElementById('msg');
const fold=s=>s.normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/\\s+/g,' ').trim();
function val(w){
  const ins=[...w.querySelectorAll('[name]')];if(!ins.length)return undefined;
  const el=ins[0];
  if(w.classList.contains('doc-checkbox'))return el.checked;
  if(w.classList.contains('doc-checkbox_group'))return ins.filter(i=>i.checked).map(i=>i.value);
  if(el.type==='radio'){const c=ins.find(i=>i.checked);return c?c.value:''}
  return el.value;
}
function collect(){const v={};form.querySelectorAll('.doc-field').forEach(w=>{if(w.hidden)return;const k=(w.querySelector('[name]')||{}).name;if(k)v[k]=val(w)});return v}
function applyShowIf(){
  const seen={};
  form.querySelectorAll('.doc-field').forEach(w=>{
    const k=w.getAttribute('data-show-if-key');
    let on=true;
    if(k){const want=w.getAttribute('data-show-if-equals');const cur=seen[k];on=(cur===want)||(cur===true&&want==='true')}
    w.hidden=!on;w.querySelectorAll('[name]').forEach(i=>{i.disabled=!on});
    const name=(w.querySelector('[name]')||{}).name;if(name&&on)seen[name]=val(w);
  });
}
form.addEventListener('input',applyShowIf);form.addEventListener('change',applyShowIf);applyShowIf();
// signature
const cv=document.getElementById('sig');let strokes=0,drawing=false,ctx=null;
if(cv){ctx=cv.getContext('2d');ctx.lineWidth=2.4;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#0f172a';
  const pos=e=>{const r=cv.getBoundingClientRect();return [(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height]};
  cv.addEventListener('pointerdown',e=>{drawing=true;cv.setPointerCapture(e.pointerId);const p=pos(e);ctx.beginPath();ctx.moveTo(p[0],p[1]);strokes++;e.preventDefault()});
  cv.addEventListener('pointermove',e=>{if(!drawing)return;const p=pos(e);ctx.lineTo(p[0],p[1]);ctx.stroke();strokes++;e.preventDefault()});
  const end=()=>{drawing=false};cv.addEventListener('pointerup',end);cv.addEventListener('pointercancel',end);cv.addEventListener('pointerleave',end);
  document.getElementById('clear').addEventListener('click',()=>{ctx.clearRect(0,0,cv.width,cv.height);strokes=0});
}
const errs={consent_required:'Marque las dos casillas para continuar.',signature_required:'Dibuje su firma en el recuadro.',signature_invalid:'La firma no es válida. Bórrela y vuelva a dibujarla.',name_required:'Escriba su nombre completo.',request_closed:'Este enlace ya no está activo. Comuníquese con su terapeuta.',invalid_answers:'Revise las respuestas marcadas: faltan datos o no son válidos.',template_not_assigned:'Este documento no le corresponde.'};
let warned=false;
document.getElementById('sign').addEventListener('click',async()=>{
  msg.hidden=true;
  if(!form.reportValidity())return;
  const name=document.getElementById('signer-name').value.trim();
  const agree=document.getElementById('agree').checked,esign=document.getElementById('esign').checked;
  if(!agree||!esign){show(msg,errs.consent_required,'err');return}
  if(!name){show(msg,errs.name_required,'err');return}
  if(DRAWN&&strokes<12){show(msg,errs.signature_required,'err');return}
  if(fold(name)!==fold(EXPECTED)&&!warned){warned=true;show(msg,'El nombre escrito no coincide con "'+EXPECTED+'". Si es correcto, presione "Firmar y continuar" otra vez.','warn');return}
  const btn=document.getElementById('sign');btn.disabled=true;
  const r=await post('/sign/'+encodeURIComponent(TID),{values:collect(),signerName:name,signaturePng:DRAWN?cv.toDataURL('image/png'):null,agreeTerms:agree,esignConsent:esign});
  if(r.status===200){location.href=r.json.next||NEXT;return}
  btn.disabled=false;
  if(r.status===401){location.reload();return}
  if(r.status===413){show(msg,errs.signature_invalid,'err');return}
  show(msg,errs[r.json.error]||'No pudimos guardar su firma. Inténtelo de nuevo.','err');
});
document.getElementById('save').addEventListener('click',async()=>{
  const r=await post('/draft',{templateId:TID,values:collect()});
  if(r.status===200)show(msg,'Guardado. Puede volver más tarde con el mismo enlace.','ok');else if(r.status===401)location.reload();else show(msg,'No pudimos guardar. Inténtelo de nuevo.','err');
});`
  const body = `${header(o.practice, o.logoUrl)}<div class="card doc-card">
<div class="muted">Documento ${o.index} de ${o.total}</div><div class="bar" aria-hidden="true"><i style="width:${Math.round(((o.index - 1) / o.total) * 100)}%"></i></div>
<form id="docform" onsubmit="return false" novalidate>${o.fillHtml}</form>
<div class="consent" style="margin-top:1.6em;padding-top:1em;border-top:1px solid #e2e8f0">
<label><input type="checkbox" id="agree"> He leído y entiendo este documento y acepto sus términos.</label>
<label><input type="checkbox" id="esign"> Acepto firmar electrónicamente y que mi firma electrónica tiene la misma validez que mi firma manuscrita.</label>
<label class="field-label" for="signer-name">Nombre completo</label><input class="text" id="signer-name" autocomplete="name" maxlength="120" value="">
${o.drawn ? `<span class="field-label">Firma</span><canvas id="sig" width="900" height="260" aria-label="Recuadro para dibujar su firma"></canvas><div class="row"><button class="btn ghost" type="button" id="clear">Borrar firma</button></div>` : ''}
</div>
<div id="msg" class="msg" hidden role="status"></div>
<div class="row"><button class="btn" type="button" id="sign">Firmar y continuar</button><button class="btn ghost" type="button" id="save">Guardar y continuar después</button>${o.checklistHref ? `<a class="btn ghost" href="${escAttr(o.checklistHref)}">Ver lista</a>` : ''}</div></div>`
  return shell({ title: `${o.practice || 'Documentos'}: ${o.title}`, brand: o.brand, body, nonce: o.nonce, script })
}

/** A document the signer already signed: read-only, with the stored snapshot. */
export function renderSignedViewPage(o: { practice: string; nonce: string; brand?: string; logoUrl?: string; index: number; total: number; bodyHtml: string; backHref: string; nextHref: string | null }): string {
  const body = `${header(o.practice, o.logoUrl)}<div class="card readonly"><div class="msg ok">Documento ${o.index} de ${o.total}: ya firmado. Solo puede leerlo.</div>${o.bodyHtml}<div class="row noprint"><a class="btn ghost" href="${escAttr(o.backHref)}">Volver a la lista</a>${o.nextHref ? `<a class="btn" href="${escAttr(o.nextHref)}">Siguiente</a>` : ''}</div></div>`
  return shell({ title: `${o.practice || 'Documentos'}: documento firmado`, brand: o.brand, body, nonce: o.nonce })
}

export function renderDonePage(o: { practice: string; nonce: string; brand?: string; logoUrl?: string; copyHref: string; waiting: boolean }): string {
  const body = `${header(o.practice, o.logoUrl)}<div class="card"><h1>¡Gracias!</h1>
<p>${o.waiting ? 'Ya completó todos sus documentos. Falta que las demás personas completen los suyos.' : 'Sus documentos quedaron firmados.'} Recibirá un correo con el enlace a su copia.</p>
<div class="row"><a class="btn" href="${escAttr(o.copyHref)}">Descargar mis documentos</a></div></div>`
  return shell({ title: `${o.practice || 'Documentos'}: listo`, brand: o.brand, body, nonce: o.nonce })
}

/** All the signer's signed documents on one printable page. */
export function renderCopyPage(o: { practice: string; nonce: string; brand?: string; logoUrl?: string; docs: { title: string; bodyHtml: string }[] }): string {
  const script = `document.getElementById('print').addEventListener('click',()=>window.print())`
  const body = `${header(o.practice, o.logoUrl)}<div class="card noprint"><h1>Sus documentos firmados</h1><p class="muted">Use “Imprimir” y elija “Guardar como PDF” para conservar una copia.</p><div class="row"><button class="btn" id="print" type="button">Imprimir / Guardar como PDF</button></div></div>${o.docs.map((d) => `<section class="card copy-doc" aria-label="${escAttr(d.title)}">${d.bodyHtml}</section>`).join('')}`
  return shell({ title: `${o.practice || 'Documentos'}: sus documentos`, brand: o.brand, body, nonce: o.nonce, script })
}

/** The inside of a stored snapshot (we wrote it ourselves, every value escaped): its <body> contents. */
export function snapshotBody(renderedHtml: string): string {
  const a = renderedHtml.indexOf('<body>')
  const b = renderedHtml.lastIndexOf('</body>')
  return a >= 0 && b > a ? renderedHtml.slice(a + 6, b) : ''
}
