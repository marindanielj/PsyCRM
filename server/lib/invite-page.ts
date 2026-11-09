import { header, shell } from './document-page'
import type { InviteField } from './invite-custom-fields'
import { escAttr, escText, jsonForScript } from './page-html'

/**
 * The invitation page (Spanish, mobile-first). The only thing it knows about the person is what the therapist
 * typed: a name and an email. Below the fixed questions it asks the practice's own custom fields, as they are
 * defined when the page is opened.
 */

const CF_TEXT_MAX = 500
const CF_TEXTAREA_MAX = 2000

function customFieldInput(f: InviteField, i: number): string {
  const id = `cf${i}`
  const ph = f.placeholder ? ` placeholder="${escAttr(f.placeholder)}"` : ''
  const label = `<label class="field-label" for="${id}">${escText(f.label)}</label>`
  switch (f.type) {
    case 'checkbox':
      return `<label class="consent"><input type="checkbox" id="${id}" data-cf="${escAttr(f.key)}"> <span>${escText(f.label)}</span></label>`
    case 'textarea':
      return `${label}<textarea class="text" id="${id}" data-cf="${escAttr(f.key)}" rows="3" maxlength="${CF_TEXTAREA_MAX}"${ph}></textarea>`
    case 'number':
      return `${label}<input class="text" id="${id}" data-cf="${escAttr(f.key)}" type="number" step="any" inputmode="decimal"${ph}>`
    case 'date':
      return `${label}<input class="text" id="${id}" data-cf="${escAttr(f.key)}" type="date">`
    case 'dropdown':
      return `${label}<select class="text" id="${id}" data-cf="${escAttr(f.key)}"><option value="">—</option>${f.options.map((o) => `<option value="${escAttr(o)}">${escText(o)}</option>`).join('')}</select>`
    default:
      return `${label}<input class="text" id="${id}" data-cf="${escAttr(f.key)}" type="text" maxlength="${CF_TEXT_MAX}"${ph}>`
  }
}

const HP_STYLE = '<style>.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}</style>'

export function renderInviteForm(o: { practice: string; brand?: string; logoUrl?: string; token: string; nonce: string; kind: 'adult' | 'guardian'; name: string; email: string; fields?: InviteField[] }): string {
  const guardian = o.kind === 'guardian'
  const [first = '', ...rest] = o.name.trim().split(/\s+/)
  const script = `const T=${jsonForScript(o.token)},KIND=${jsonForScript(o.kind)};
const form=document.getElementById('reg'),msg=document.getElementById('msg'),btn=document.getElementById('go');
function show(t,c){msg.className='msg '+c;msg.textContent=t;msg.hidden=false}
const errs={age_mismatch_minor:'Según la fecha de nacimiento, el paciente es menor de 18 años. Comuníquese con su terapeuta para recibir la invitación correcta.',age_mismatch_adult:'Según la fecha de nacimiento, el paciente tiene 18 años o más. Comuníquese con su terapeuta para recibir la invitación correcta.',invalid_date_of_birth:'Revise la fecha de nacimiento.',guardian_name_required:'Escriba su nombre completo.',invalid:'Revise los datos marcados.',rate_limited:'Demasiados intentos. Espere unos minutos.'};
const cf=()=>{const o={};form.querySelectorAll('[data-cf]').forEach(el=>{o[el.dataset.cf]=el.type==='checkbox'?el.checked:el.value.trim()});return o};
btn.addEventListener('click',async()=>{
  msg.hidden=true;
  if(!form.reportValidity())return;
  const v=n=>(form.elements[n]?form.elements[n].value.trim():'');
  btn.disabled=true;
  let r;try{r=await fetch('/i/'+T+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({firstName:v('firstName'),lastName:v('lastName'),phone:v('phone'),dateOfBirth:v('dateOfBirth'),guardianName:v('guardianName'),guardianPhone:v('guardianPhone'),custom:cf(),website:v('website')})})}catch(e){btn.disabled=false;show('No pudimos enviar sus datos. Inténtelo de nuevo.','err');return}
  let j={};try{j=await r.json()}catch(e){}
  if(r.status===200){location.reload();return}
  if(r.status===404||j.error==='closed'){location.reload();return}
  btn.disabled=false;
  if(j.error==='invalid_custom_field'&&j.field){show('Revise el campo «'+j.field+'».','err');return}
  show(errs[j.error]||'No pudimos guardar sus datos. Inténtelo de nuevo.','err');
});`
  const today = new Date().toISOString().slice(0, 10)
  const patient = `<fieldset style="border:0;padding:0;margin:0"><legend class="field-label">${guardian ? 'Datos del paciente (menor de 18 años)' : 'Sus datos'}</legend>
<label class="field-label" for="firstName">Nombre</label><input class="text" id="firstName" name="firstName" required maxlength="80" autocomplete="${guardian ? 'off' : 'given-name'}" value="${guardian ? '' : escAttr(first)}">
<label class="field-label" for="lastName">Apellidos</label><input class="text" id="lastName" name="lastName" required maxlength="80" autocomplete="${guardian ? 'off' : 'family-name'}" value="${guardian ? '' : escAttr(rest.join(' '))}">
${guardian ? '' : '<label class="field-label" for="phone">Teléfono</label><input class="text" id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel">'}
<label class="field-label" for="dateOfBirth">Fecha de nacimiento</label><input class="text" id="dateOfBirth" name="dateOfBirth" type="date" required max="${today}" autocomplete="${guardian ? 'off' : 'bday'}">
</fieldset>`
  const parent = guardian
    ? `<fieldset style="border:0;padding:0;margin:1.2em 0 0"><legend class="field-label">Sus datos (padre, madre o tutor)</legend>
<label class="field-label" for="guardianName">Nombre completo</label><input class="text" id="guardianName" name="guardianName" required maxlength="120" autocomplete="name" value="${escAttr(o.name)}">
<label class="field-label" for="guardianPhone">Teléfono</label><input class="text" id="guardianPhone" name="guardianPhone" type="tel" maxlength="40" autocomplete="tel"></fieldset>`
    : ''
  const extra = (o.fields ?? []).length
    ? `<fieldset style="border:0;padding:0;margin:1.2em 0 0"><legend class="field-label">${guardian ? 'Información adicional del paciente' : 'Información adicional'}</legend>${(o.fields ?? []).map(customFieldInput).join('')}</fieldset>`
    : ''
  const body = `${HP_STYLE}${header(o.practice, o.logoUrl)}<div class="card"><h1>Complete su registro</h1>
<p>${escText(o.practice || 'Su terapeuta')} necesita unos datos para abrir su expediente. ${guardian ? 'Complete los datos del paciente y los suyos.' : 'Tardará menos de un minuto.'}</p>
<p class="muted">Correo: <strong>${escText(o.email)}</strong></p>
<form id="reg" onsubmit="return false" novalidate>${patient}${parent}${extra}
<div class="hp" aria-hidden="true"><label>No llenar<input name="website" tabindex="-1" autocomplete="off"></label></div></form>
<p class="muted" style="margin-top:1em">Usaremos esta información solo para su expediente. Luego recibirá un correo con los documentos por completar.</p>
<div id="msg" class="msg" hidden role="status"></div>
<div class="row"><button class="btn" id="go" type="button">Enviar mis datos</button></div></div>`
  return shell({ title: `${o.practice || 'Registro'}: registro`, brand: o.brand, body, nonce: o.nonce, script })
}

export function renderInviteDone(o: { practice: string; brand?: string; logoUrl?: string; nonce: string }): string {
  return shell({
    title: `${o.practice || 'Registro'}: gracias`,
    brand: o.brand,
    nonce: o.nonce,
    body: `${header(o.practice, o.logoUrl)}<div class="card"><h1>¡Gracias!</h1><p>Recibimos sus datos. Revise su correo: pronto le enviaremos los siguientes pasos.</p></div>`,
  })
}
