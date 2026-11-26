import { PAGE_STYLE, header, shell } from './document-page'
import { escAttr, escText } from './page-html'

/**
 * The client's video session page (Spanish, phone first), served at /v/<token>. One small inline
 * script (carrying the request's nonce) drives it: confirm where you are -> wait to be admitted ->
 * enter the call. The call itself is the bundled Chime client (/video/chime-client.js).
 */

export type VideoPageState = 'lobby' | 'waiting' | 'admitted'

interface Base { practice: string; brand?: string; logoUrl?: string; nonce: string }

const STYLE = `
.call{position:relative;background:#0f172a;border-radius:14px;overflow:hidden;aspect-ratio:3/4;max-height:70vh}
@media(min-width:700px){.call{aspect-ratio:16/10}}
#remote{width:100%;height:100%;object-fit:cover;background:#0f172a}
#local{position:absolute;right:10px;bottom:10px;width:28%;max-width:160px;border-radius:10px;border:2px solid #fff;background:#1e293b;object-fit:cover;transform:scaleX(-1)}
.ctl{display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap}
.btn.leave{background:#be123c}
.peerwait{position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;color:#cbd5e1;font-size:.95rem;pointer-events:none}
.notice{margin:.6em 0;padding:10px 12px;border-radius:8px;background:#f1f5f9;color:#334155;font-size:.92rem}
`

const pageShell = (b: Base, title: string, body: string, script?: string) =>
  shell({ title, brand: b.brand, logoUrl: b.logoUrl, nonce: b.nonce, body: `${header(b.practice, b.logoUrl).replace('Documentos seguros', 'Sesión por video')}<style>${STYLE}</style>${body}`, script })

/** Same page for a link that never existed. */
export function renderVideoInvalidPage(nonce: string): string {
  return shell({ title: 'Enlace no válido', nonce, body: `<div class="card"><h1>Este enlace no es válido</h1><p class="muted">Comuníquese con su terapeuta para recibir uno nuevo.</p></div>` })
}

export function renderVideoClosedPage(b: Base, kind: 'not_yet' | 'ended' | 'cancelled', opensAtLabel?: string): string {
  const msg = {
    not_yet: ['Su sesión aún no está abierta', `Podrá entrar 15 minutos antes de la hora${opensAtLabel ? ` (desde las ${escText(opensAtLabel)})` : ''}. Vuelva a abrir este enlace entonces.`],
    ended: ['Esta sesión ya terminó', 'Si necesita otra cita, comuníquese con su terapeuta.'],
    cancelled: ['Esta cita no está activa', 'Comuníquese con su terapeuta para confirmar su cita.'],
  }[kind]
  return pageShell(b, msg[0]!, `<div class="card"><h1>${msg[0]}</h1><p class="muted">${msg[1]}</p></div>`)
}

export function renderVideoPage(b: Base & { token: string; state: VideoPageState }): string {
  const body = `
<div id="lobby" class="card" ${b.state === 'lobby' ? '' : 'hidden'}>
  <h1>Antes de entrar</h1>
  <p class="muted">Su terapeuta le verá en cuanto llegue. Confirme estos datos para comenzar.</p>
  <label class="field-label" for="loc">¿Dónde se encuentra ahora?</label>
  <input id="loc" class="text" maxlength="200" autocomplete="off" placeholder="Ciudad o pueblo">
  <div class="consent">
    <label><input type="checkbox" id="pr"> Estoy físicamente en Puerto Rico.</label>
    <label><input type="checkbox" id="priv"> Estoy en un lugar privado, donde nadie más puede escuchar.</label>
  </div>
  <div id="prwarn" class="msg warn" hidden>Si no está en Puerto Rico, avise a su terapeuta al entrar: puede afectar si la sesión se puede realizar.</div>
  <p class="notice">Esta sesión no se graba. Su navegador le pedirá permiso para usar la cámara y el micrófono.</p>
  <div class="row"><button class="btn" id="enter" disabled>Entrar a la sala de espera</button></div>
  <div id="e1" class="msg err" hidden></div>
</div>

<div id="waiting" class="card" ${b.state === 'waiting' ? '' : 'hidden'}>
  <h1>Esperando a su terapeuta</h1>
  <p class="muted">Ya avisamos que usted llegó. Mantenga esta página abierta; le dejaremos entrar en cuanto su terapeuta le admita.</p>
</div>

<div id="ready" class="card" ${b.state === 'admitted' ? '' : 'hidden'}>
  <h1>Su terapeuta le espera</h1>
  <div class="row"><button class="btn" id="join">Entrar a la sesión</button></div>
  <div id="e2" class="msg err" hidden></div>
</div>

<div id="incall" hidden>
  <p id="conn" class="notice">Conectando…</p>
  <div id="net" class="msg warn" hidden><span id="nettext"></span> <button class="btn ghost" id="netcam" hidden>Apagar mi video</button></div>
  <div class="call"><video id="remote" autoplay playsinline></video><video id="local" autoplay playsinline muted></video><div id="peer" class="peerwait">Esperando a su terapeuta…</div></div>
  <audio id="audio" autoplay></audio>
  <div class="ctl">
    <button class="btn ghost" id="mute">Silenciar</button>
    <button class="btn ghost" id="cam">Apagar cámara</button>
    <button class="btn leave" id="leave">Salir</button>
  </div>
  <div id="dev" class="msg warn" hidden></div>
</div>

<div id="over" class="card" hidden><h1>La sesión terminó</h1><p class="muted">Puede cerrar esta página. Gracias.</p></div>`
  const script = `
(function(){
var T=${JSON.stringify(b.token)},S=${JSON.stringify(b.state)};
var $=function(i){return document.getElementById(i)};
function show(id){['lobby','waiting','ready','incall','over'].forEach(function(x){$(x).hidden=x!==id})}
function post(p,body){return fetch('/v/'+T+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{}),credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._status=r.status;return j})})}
function err(id,m){var e=$(id);e.textContent=m;e.hidden=false}
function check(){var ok=$('loc').value.trim().length>1&&$('priv').checked;$('enter').disabled=!ok;$('prwarn').hidden=$('pr').checked||!$('loc').value}
['loc','pr','priv'].forEach(function(i){$(i).addEventListener(i==='loc'?'input':'change',check)});
var poll=null;
function watch(){if(poll)return;poll=setInterval(function(){fetch('/v/'+T+'/status',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){
 if(j.state!=='open'||j.ended){clearInterval(poll);poll=null;if(!call&&!busy)show('over');return}
 if(j.admitted&&!call&&!busy){show('ready')}}).catch(function(){})},3000)}
$('enter').addEventListener('click',function(){$('enter').disabled=true;post('/wait',{location:$('loc').value.trim(),inPuertoRico:$('pr').checked,privatePlace:$('priv').checked}).then(function(j){
 if(j._status!==200){err('e1','No pudimos continuar. Intente de nuevo.');$('enter').disabled=false;return}
 show(j.admitted?'ready':'waiting');watch()})});
// busy is true from pressing Entrar until the call is up or has failed. The 3-second status check must not touch the screen
// meanwhile: while the browser waits for the person to click Allow there is no call object yet, and the check used to
// flip the page back to the waiting card for good.
var call=null,busy=false,camOn=true;
function setCam(on){camOn=on;if(call)call.setCamera(on);$('cam').textContent=on?'Apagar cámara':'Encender cámara';if(!on)$('netcam').hidden=true}
var POOR='Su conexión está inestable. Si se corta el audio, apague su cámara.';
var NORMAL={OK:1,Left:1,MeetingEnded:1};
$('join').addEventListener('click',function(){busy=true;camOn=true;$('cam').textContent='Apagar cámara';$('net').hidden=true;$('netcam').hidden=true;$('join').disabled=true;$('e2').hidden=true;post('/join').then(function(j){
 if(j._status!==200||!window.PsyVideo){
  var m='No pudimos conectar la sesión. Intente de nuevo.';
  if(j._status===409)m='Su terapeuta aún no abrió la sala. Espere un momento e intente de nuevo.';
  else if(j._status===502)m='El servicio de video no está disponible ahora. Avise a su terapeuta.';
  else if(j._status===200)m='No se pudo cargar el video en este navegador. Recargue la página o pruebe con otro navegador.';
  err('e2',m);$('join').disabled=false;busy=false;return}
 show('incall');$('conn').hidden=false;$('peer').hidden=false;
 window.PsyVideo.join({meeting:j.meeting,attendee:j.attendee,audioEl:$('audio'),remoteVideoEl:$('remote'),localVideoEl:$('local'),
  onConnected:function(){$('conn').hidden=true},
  onPeer:function(p){$('peer').hidden=p},
  onConnection:function(st){var n=$('net');if(st==='good'){n.hidden=true;$('netcam').hidden=true;return}n.hidden=false;$('nettext').textContent=st==='reconnecting'?'Reconectando… su conexión se interrumpió un momento. Espere unos segundos.':POOR},
  onSuggestStopVideo:function(){if(!camOn)return;$('net').hidden=false;$('nettext').textContent=POOR;$('netcam').hidden=false},
  onEnd:function(why){call=null;
   if(NORMAL[why]){show('over');return}
   show('ready');$('join').disabled=false;busy=false;
   err('e2',why==='ConnectTimeout'?'No pudimos establecer la conexión de video. Revise su internet e intente de nuevo.':'La llamada se interrumpió (código: '+why+'). Intente entrar de nuevo.')},
  onDeviceProblem:function(w){var d=$('dev');d.textContent=w==='camera'?'No pudimos usar su cámara. Puede continuar solo con audio.':'No pudimos usar su micrófono. Revise los permisos de su navegador.';d.hidden=false}
 }).then(function(h){call=h;var muted=false;
  $('mute').onclick=function(){muted=!muted;h.setMuted(muted);$('mute').textContent=muted?'Activar micrófono':'Silenciar'};
  $('cam').onclick=function(){setCam(!camOn)};
  $('netcam').onclick=function(){setCam(false)};
  $('leave').onclick=function(){h.leave()}}).catch(function(e){show('ready');$('join').disabled=false;busy=false;err('e2','No pudimos iniciar la llamada. Revise los permisos de cámara y micrófono e intente de nuevo. ('+((e&&e.name)||'error')+')')})})});
window.addEventListener('pagehide',function(){if(call){try{navigator.sendBeacon('/v/'+T+'/left')}catch(e){}}});
if(S!=='lobby')watch();
})();`
  return shell({
    title: 'Sesión por video',
    brand: b.brand,
    logoUrl: b.logoUrl,
    nonce: b.nonce,
    body: `${header(b.practice, b.logoUrl).replace('Documentos seguros', 'Sesión por video')}<style>${STYLE}</style>${body}<script src="/video/chime-client.js" nonce="${escAttr(b.nonce)}"></script>`,
    script,
  })
}

export { PAGE_STYLE }
