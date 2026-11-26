import { PAGE_STYLE } from './document-page'
import { escAttr, escText } from './page-html'

/**
 * The therapist's video room (English, like the rest of her app). A separate server-rendered page, not
 * part of the single-page app, because the app's strict Content-Security-Policy would block the call's
 * media hosts. It is opened from the agenda's Join button (new tab) and sits behind her sign-in:
 * everything it does goes to the signed-in video routes for this appointment.
 */

/** `/api/loc/<loc>/video/appointments/<id>/room`: the one signed-in page that needs its own CSP. */
export const isVideoRoomPath = (path: string): boolean => /^\/api\/loc\/[^/]+\/video\/appointments\/[^/]+\/room$/.test(path)

const STYLE = `
.call{position:relative;background:#0f172a;border-radius:14px;overflow:hidden;aspect-ratio:16/10;max-height:68vh}
#remote{width:100%;height:100%;object-fit:cover;background:#0f172a}
#local{position:absolute;right:10px;bottom:10px;width:22%;max-width:200px;border-radius:10px;border:2px solid #fff;background:#1e293b;object-fit:cover;transform:scaleX(-1)}
.peerwait{position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;color:#cbd5e1;font-size:.95rem;pointer-events:none}
.ctl{display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap}
.btn.leave{background:#be123c}
dl.conf{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:.6em 0}dl.conf dt{color:#475569}dl.conf dd{margin:0;font-weight:600}
`

export function renderVideoRoomPage(o: { title: string; base: string; nonce: string; startsLabel: string }): string {
  const body = `
<div class="wrap">
  <div class="head"><span class="brand">${escText(o.title)}</span><span>${escText(o.startsLabel)}</span></div>

  <div id="gate" class="card">
    <h1>Video session</h1>
    <p class="muted" id="state">Checking the room…</p>
    <div id="consent" class="msg warn" hidden>This client has no signed telepsychology consent on file. You can still hold the session; consider getting it signed.</div>
    <div class="row"><button class="btn" id="open">Open the room</button><button class="btn ghost" id="copy">Copy client link</button></div>
    <div id="err" class="msg err" hidden></div>
  </div>

  <div id="waiting" class="card" hidden>
    <h1>Your client is waiting</h1>
    <dl class="conf"><dt>Where the client is</dt><dd id="c-loc"></dd><dt>In Puerto Rico</dt><dd id="c-pr"></dd><dt>Somewhere private</dt><dd id="c-priv"></dd></dl>
    <div id="c-warn" class="msg warn" hidden></div>
    <div class="row"><button class="btn" id="admit">Admit to the session</button></div>
  </div>

  <div id="incall" hidden>
    <p id="conn" class="muted">Connecting…</p>
    <div class="call"><video id="remote" autoplay playsinline></video><video id="local" autoplay playsinline muted></video><div id="peer" class="peerwait">Waiting for the client to join…</div></div>
    <audio id="audio" autoplay></audio>
    <div class="ctl">
      <button class="btn ghost" id="mute">Mute</button>
      <button class="btn ghost" id="cam">Camera off</button>
      <button class="btn ghost" id="leave">Leave (keep the room open)</button>
      <button class="btn leave" id="end">End session for everyone</button>
    </div>
    <div id="dev" class="msg warn" hidden></div>
  </div>
</div>
<style>${STYLE}</style>
<script src="/video/chime-client.js" nonce="${escAttr(o.nonce)}"></script>`
  const script = `
(function(){
var B=${JSON.stringify(o.base)};
var $=function(i){return document.getElementById(i)};
var call=null,joining=false,link='',last=null;
function api(m,p){return fetch(B+p,{method:m,credentials:'same-origin'}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._status=r.status;return j})})}
function err(t){var e=$('err');e.textContent=t;e.hidden=!t}
function yn(v){return v===true?'Yes':v===false?'No':'—'}
function render(v){last=v;link=v.link;$('consent').hidden=v.consentSigned!==false;
 var s=$('state');
 if(v.ended)s.textContent='This session has ended.';
 else if(v.window.state==='not_yet')s.textContent='The room opens at '+new Date(v.window.opensAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.';
 else if(v.window.state==='ended')s.textContent='The window for this session has closed.';
 else s.textContent=v.admitted?'Your client has been admitted.':v.waiting?'Your client is waiting.':'Waiting for your client to arrive.';
 $('open').disabled=v.ended||v.window.state!=='open'||!!call||joining;
 var w=v.waiting&&v.clientConfirmation;$('waiting').hidden=!w;
 if(w){var c=v.clientConfirmation;$('c-loc').textContent=c.location||'—';$('c-pr').textContent=yn(c.inPuertoRico);$('c-priv').textContent=yn(c.privatePlace);
  var warn=[];if(c.inPuertoRico===false)warn.push('The client says they are not in Puerto Rico: check licensure before you begin.');if(c.privatePlace===false)warn.push('The client says they are not somewhere private.');
  $('c-warn').textContent=warn.join(' ');$('c-warn').hidden=!warn.length}}
function refresh(){return api('GET','/video').then(function(j){if(j.video)render(j.video)})}
setInterval(refresh,3000);refresh();
$('copy').onclick=function(){if(!link)return;var u=new URL(link,location.origin).href;navigator.clipboard.writeText(u).then(function(){$('copy').textContent='Copied';setTimeout(function(){$('copy').textContent='Copy client link'},1500)})};
$('admit').onclick=function(){$('admit').disabled=true;api('POST','/video/admit').then(function(j){$('admit').disabled=false;if(j._status===502)err('The video service is not available right now, so the client was not admitted. Try again in a moment.');else if(j._status!==200)err('Could not admit the client: '+(j.error||'try again'));else{err('');refresh()}})};
var NORMAL={OK:1,Left:1,MeetingEnded:1};
$('open').onclick=function(){joining=true;$('open').disabled=true;err('');api('POST','/video/join').then(function(j){
 if(j._status!==200||!window.PsyVideo){joining=false;$('open').disabled=false;
  err(j._status===502?'The video service is not available right now. Nothing was opened; try again in a moment.':j.error==='not open yet'?'It is not time yet.':j._status===200?'The video library did not load in this browser. Reload the page.':'Could not open the room: '+(j.error||'try again'));return}
 $('gate').hidden=true;$('incall').hidden=false;$('conn').hidden=false;$('peer').hidden=false;
 window.PsyVideo.join({meeting:j.meeting,attendee:j.attendee,audioEl:$('audio'),remoteVideoEl:$('remote'),localVideoEl:$('local'),
  onConnected:function(){$('conn').hidden=true},
  onPeer:function(p){$('peer').hidden=p},
  onEnd:function(why){call=null;joining=false;$('incall').hidden=true;$('gate').hidden=false;$('open').disabled=false;refresh();if(!NORMAL[why])err(why==='ConnectTimeout'?'The call could not connect. Check the internet connection and open the room again.':'The call was interrupted (code: '+why+'). Open the room again to reconnect.')},
  onDeviceProblem:function(w){var d=$('dev');d.textContent=w==='camera'?'Could not use your camera. You can continue with audio only.':'Could not use your microphone. Check the browser permission.';d.hidden=false}
 }).then(function(h){call=h;var m=false,c=true;
  $('mute').onclick=function(){m=!m;h.setMuted(m);$('mute').textContent=m?'Unmute':'Mute'};
  $('cam').onclick=function(){c=!c;h.setCamera(c);$('cam').textContent=c?'Camera off':'Camera on'};
  $('leave').onclick=function(){h.leave()};
  $('end').onclick=function(){if(!confirm('End the session for everyone? The client will not be able to rejoin.'))return;api('POST','/video/end').then(function(){h.leave()})}
 }).catch(function(e){joining=false;$('incall').hidden=true;$('gate').hidden=false;$('open').disabled=false;err('Could not start the call. Check the camera and microphone permissions and try again. ('+((e&&e.name)||'error')+')')})})};
})();`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escText(o.title)}</title><style>:root{--brand:#4f46e5}${PAGE_STYLE}</style></head><body>${body}<script nonce="${escAttr(o.nonce)}">${script}</script></body></html>`
}
