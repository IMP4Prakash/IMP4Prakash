import {ask,privacySettings,roomAgreement} from './ui-support.js';
import {icon} from './icons.js';
import {preferences,t,localize,savePreferences,resetPreferences} from './settings.js';
import {youtubeId, targetPosition, correction} from './sync.js';
const $ = id => document.getElementById(id);
const MAX_FILE = 250 * 1024 * 1024;
let base = (window.XPARTY_CONFIG?.backendUrl || location.origin).replace(/\/$/,'');
let suspended=false,localPaused=false;
let switching=false;const attachmentUrls=new Set();
let socket, me, token, room, preview = false, intentionalClose = false, reconnectTimer, connectTimer;
let iceServers=[], peers=new Map(), localStream=new MediaStream(), yt, ytReady=false, ytPromise;
let sourceId=null, pendingFile=null, ownedFile=null, ownedFileId=null, objectUrl=null, activePlayback;
let suppressUntil=0, lastCorrected=0, appliedRevision=-1, clockOffset=0, bestRTT=Infinity, lastAnchor=0, lastSeek=0;
let audioContext, movieGain, movieAudio, callVolume=1, movieVolume=.7, busyMedia=false;
let bufferTimer,bufferReported=false,autoDriftSince=0,lastPlayAttempt=0;let cameraFacing='user';let speakerOn=true,viewMode='default',joinLookup=0,lookupTimer;const observedMessages=new Set();
let recipient=null,unread=0,typingTimer,lastTyping=0;const typingPeople=new Map();let vcVisible=true,chatVisible=true,buffering=false,settleUntil=0;
let fileJob=null,loadedFileId=null,downloadId=null,readySent=null;
const SESSION='xparty-session-v2';
const filePlayer=$('file-player');
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500); }
function status(text) {$('sync-status').lastChild.textContent=' '+t(text);}
function notice(text) {$('connection-notice').textContent=text||'Connected. Share the room code privately.';}
function send(type, fields={}) {if(['playback','source','next','previous','party-mode'].includes(type))fields.eventId??=crypto.randomUUID();if(type==='playback'&&!fields.intent)fields.intent=Math.abs((fields.position||0)-currentTime())>1?'seek':fields.playing?'play':'pause';if(preview) {toast('This is a design preview. Create a room to connect.');return false;}if(socket?.readyState!==WebSocket.OPEN){toast('Room connection is offline. Reconnecting…');return false;}socket.send(JSON.stringify({type,...fields}));return true;}
function ping() {if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'ping',sent:Date.now()}));}
function connect(action) {
  preview=false;intentionalClose=false;clearTimeout(reconnectTimer);clearTimeout(connectTimer);
  $('create').disabled=true;$('join-form').querySelector('button').disabled=true;
  let url;try{url=new URL(base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/ws';url.search='';}catch{toast('The room service address is invalid.');return;}
  if(switching)return;
  const oldSocket=socket, switchingRoom=!!room&&['create','join'].includes(action.type);
  switching=switchingRoom;
  if(!switchingRoom&&socket?.readyState<2)socket.close();
  const ws=new WebSocket(url);if(!switchingRoom)socket=ws;
  connectTimer=setTimeout(()=>{if(ws.readyState===WebSocket.CONNECTING)ws.close();toast('The room service did not respond. Check deployment and try again.');},15000);
  ws.onopen=()=>{clearTimeout(connectTimer);ws.send(JSON.stringify(action));ping();};
  ws.onmessage=e=>{try{const message=JSON.parse(e.data);
    if(switchingRoom&&ws!==socket){
      if(message.type==='welcome'){socket=oldSocket;leave(true);socket=ws;intentionalClose=false;switching=false;}
      else if(message.type==='error'||message.type==='resume-failed'){switching=false;clearTimeout(connectTimer);ws.close();toast(message.message||'Unable to join this room.');$('create').disabled=false;$('join-button').disabled=false;return;}
      else return;
    }
    handle(message);}catch(error){console.error('Room event failed',error);toast('An action failed. Please retry.');}};
  ws.onerror=()=>{if(!room){$('setup-notice').hidden=false;toast('Unable to reach the room service. The portal needs a live backend.');}};
  ws.onclose=e=>{
    clearTimeout(connectTimer);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
    if(ws!==socket){switching=false;return;}
    if(e.code===4000){const saved=readSession();leave(false);if(saved)try{localStorage.setItem(SESSION,JSON.stringify(saved));}catch{}toast("This session was opened in another connection.");return;}
    if(!intentionalClose && !suspended && token){notice('Connection interrupted. Reconnecting to your room…');reconnectTimer=setTimeout(()=>connect({type:'resume',token}),1800);}
    else if(!intentionalClose&&!suspended){$('setup-notice').hidden=false;}
  };
}
function handle(m) {
  if(m.type==='request-status'){toast(m.request.status==='HOST_REVIEW'?'Request sent to the host.':m.request.status+': '+m.request.reason);return;}
  if(m.type==='error'){toast(m.message);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;return;}
  if(m.type==='pong') {const rtt=Date.now()-m.sent;if(rtt<bestRTT+20){bestRTT=Math.min(bestRTT,rtt);clockOffset=m.serverTime-(m.sent+rtt/2);}return;}
  if(m.type==='typing'){if(m.active)typingPeople.set(m.from,{name:m.name,until:Date.now()+4500});else typingPeople.delete(m.from);renderTyping();return;}
  if(m.type==='resume-failed' || m.type==='ended' || m.type==='kicked'){sessionStorage.removeItem('xparty-owner-return');const msg=m.message||'This room expired. Create or join a room again.';leave(false);toast(msg);return;}
  if(m.type==='moderation'){toast(({mute:'The host muted your microphone.','allow-mic':'You can turn on your microphone again.','camera-off':'The host turned off your camera.','approve-camera':'Camera approved. Tap Camera to turn it on.','deny-camera':'Your camera request was declined.'})[m.action]);return;}
  if(m.type==='welcome') {
    for(const p of peers.values())closePeer(p);peers.clear();me=m.id;token=m.token;iceServers=m.iceServers;room=m.room;saveSession({token,base,code:m.room.code,id:m.id});$('active-room-banner').hidden=true;
    $('lobby').hidden=true;$('room').hidden=false;$('return-room').hidden=true;$('demo-banner').hidden=true;
    $('setup-notice').hidden=true;$('network').lastChild.textContent=' Room connected';
    notice(m.hasRelay?'':'Direct calls are available. A relay is not configured, so calls may fail across some networks.');
    $('youtube-input').placeholder=m.searchEnabled?'Paste a YouTube link or search for a video':'Paste a YouTube video link';
    $('messages').innerHTML='<div class="chat-welcome"><span>✧</span><strong>A little space for you.</strong><p>Say hello. This conversation stays in this room.</p></div>';
    unread=0;updateUnread();updateRoom(m.room);for(const message of m.history||[])addMessage(message,false);if(room.source?.type==='file'&&loadedFileId===sourceId&&filePlayer.readyState>=1){readySent=null;fileReady();}return;
  }
  if(m.type==='state') {updateRoom(m.room);return;}
  if(m.type==='playback' || m.type==='anchor') {
    if(!room || m.sourceId!==room.source?.id)return;
    const newCommand=m.playback.revision!==activePlayback?.revision;room.playback=m.playback;activePlayback=m.playback;if(newCommand&&!localPaused&&room.source?.type==='youtube'){clearTimeout(bufferTimer);bufferReported=false;if(m.playback.playing){if(!ytReady)reportBuffer(true);else if(yt.getPlayerState()===3)bufferTimer=setTimeout(()=>reportBuffer(true),1200);}}applyPlayback(newCommand||m.resync===true);return;
  }
  if(m.type==='reaction'){toast(m.name+' '+m.emoji);return;}
  if(m.type==='chat'){addMessage(m);return;}
  if(m.type==='read'){const node=document.querySelector('[data-message-id="'+CSS.escape(m.id)+'"] .read-receipt');if(node){node.textContent='◉';node.setAttribute('aria-label','Read by '+m.name);node.title='Read by '+m.name;notifySound('read');}return;}
  if(m.type==='signal'){const peer=ensurePeer(m.from);if(peer) peer.queue=peer.queue.then(()=>receiveSignal(peer,m.signal)).catch(error=>{console.warn(error);toast('Call negotiation failed. Use reconnect ↻.');});}
}
function updateRoom(next) {
  const previous=room;room=next;activePlayback=room.playback;document.body.classList.toggle('in-room',!$('room').hidden);if(previous&&previous!==next){const before=previous.people.filter(p=>p.online).length,after=room.people.filter(p=>p.online).length;if(after!==before)notifySound(after>before?'join':'leave');} $('autoplay').checked=room.autoplay!==false;$('autoplay').disabled=room.hostId!==me;$('queue-mode-label').textContent=room.autoplay===false?'Votes':'Auto';$('guest-themes').checked=!!room.guestThemes;$('guest-themes').disabled=room.hostId!==me;renderCapacity();
  $('room-code').textContent=room.code;$('people-count').textContent=`${room.people.filter(p=>p.online).length}/${room.capacity}`;
  $('lock').hidden=room.hostId!==me;$('lock').textContent=t(room.locked?'Unlock room':'Lock room');$('lock').setAttribute('aria-checked',room.locked);$('lock-toggle').checked=room.locked;$('lock-switch').hidden=room.hostId!==me;$('capacity-control').hidden=room.hostId!==me;if(!$('room-settings-dialog').open)$('room-capacity').value=String(room.capacity);renderCapacity();
  const host=room.hostId===me;if(localPaused&&(host||room.mode!=='HOST_APPROVAL'))localPaused=false;document.documentElement.dataset.theme=room.theme||preferences.theme;$('room-theme').value=room.theme||'';$('room-theme').disabled=!host&&!room.guestThemes;$('theme-select').disabled=!host&&!room.guestThemes;
  $('youtube-input').disabled=false;$('load-video').disabled=false;$('end-room').hidden=!host;$('next-video').hidden=!host;$('file-input').disabled=!host;
  $('host-note').textContent=room.hostId===me?'You control this party. Change modes from the key menu.':'Playback follows the mode selected by your host.';
  const self=room.people.find(p=>p.id===me);$('message-input').disabled=!!self?.chatBlocked;$('message-input').placeholder=self?.chatBlocked?'Chat paused by the host':'Write a message…';let removed=false;for(const track of localStream.getTracks()){if(!self?.inCall||(track.kind==='audio'&&self?.micBlocked)||(track.kind==='video'&&!host&&!self?.cameraAllowed)){track.stop();localStream.removeTrack(track);removed=true;}}if(removed)updateMedia();
  renderQueue();renderPartyControls();
  for(const [id,p]of peers) {const person=room.people.find(x=>x.id===id);if(!self?.inCall||!person?.inCall||!person?.online||p.session!==person.session){closePeer(p);peers.delete(id);}}
  if(!preview)for(const person of room.people)if(self?.inCall&&person.inCall&&person.id!==me && person.online)ensurePeer(person.id);
  renderPeople();renderMembers();$('call-seat').textContent=t(self?.inCall?'Leave call':'Join call');$('call-seats').textContent=room.people.filter(p=>p.inCall&&p.online).length+'/4 call seats';$('mic').disabled=!self?.inCall;$('camera').disabled=!self?.inCall;if(recipient&&!room.people.some(p=>p.id===recipient.id))setRecipient(null);
  if(room.source?.id!==sourceId) applySource(room.source);
  else if(room.source) applyPlayback(false);
  if(room.source?.type==='file')ensureFile();
  if(room.source?.type==='file' && room.source.uploaded && room.people.filter(p=>p.online).every(p=>p.ready)){$('transfer-label').textContent='Everyone has the file. Ready to play together.';status('Ready together');}
}
function renderPeople() {
  const people=(room?.people||[]).filter(p=>p.inCall||p.id===me);const container=$('participants');
  for(const child of [...container.children])if(!people.some(p=>child.dataset.id===p.id))child.remove();
  for(const person of people) {
    let tile=[...container.children].find(el=>el.dataset.id===person.id);
    if(!tile){tile=document.createElement('div');tile.className='participant';tile.dataset.id=person.id;tile.innerHTML='<span class="avatar"></span><video autoplay playsinline muted hidden></video><div class="person-label"><span></span><small></small></div>';container.append(tile);}
    tile.querySelector('.avatar').textContent=person.name.charAt(0).toUpperCase();
    tile.querySelector('.person-label>span').textContent=person.name+(person.id===me?' · You':'')+(person.id===room.hostId?' · Host':'');
    const p=peers.get(person.id), local=person.id===me;
    const state=local?'Here':!person.online?'Reconnecting':p?.pc.connectionState==='connected'?'Connected':preview?'Preview':'Connecting';
    tile.querySelector('.person-label small').textContent=state+' · '+(t(person.mic?'Mic on':'Mic off'));
    const video=tile.querySelector('video');const stream=local?localStream:p?.stream;
    if(stream && video.srcObject!==stream){video.srcObject=stream;video.play().catch(()=>{});}
    video.muted=true;video.hidden=!person.camera; // Audio is mixed independently through Web Audio.
    if(!local && p)attachRemoteAudio(p,video);
    if(local){let controls=tile.querySelector('.local-controls');if(!controls){controls=document.createElement('div');controls.className='local-controls';tile.append(controls);}controls.append($('mic'),$('camera'),$('camera-flip'));tile.classList.add('self');tile.dataset.facing=cameraFacing;}
    tile.classList.toggle('camera-active',person.camera);
    tile.querySelector('.moderation')?.remove();
    if(room.source?.type==='file')tile.querySelector('.person-label small').textContent+=' · '+(person.ready?'Video ready':person.loadStatus||'Loading');
  }
  if(people.length===1){let empty=container.querySelector('[data-id="waiting"]');if(!empty){empty=document.createElement('div');empty.className='participant';empty.dataset.id='waiting';empty.innerHTML='<span class="avatar">+</span><div class="person-label"><span>Your person goes here</span><small>Share the room code</small></div>';container.append(empty);}}
  container.dataset.active=String(people.filter(p=>p.camera).length);container.dataset.count=String(people.length);container.classList.toggle('duo',people.length===2);$('camera-flip').disabled=!localStream.getVideoTracks().some(t=>t.readyState==='live');
  const connected=[...peers.values()].filter(p=>p.pc.connectionState==='connected').length;
  $('call-status').textContent=preview?'Design preview — no camera or microphone is active.':peers.size?`${connected}/${peers.size} peer connections ready · Your mic ${localStream.getAudioTracks().some(t=>t.enabled)?'is on':'is off'}`:'Share the code, then turn on your mic or camera.';
}
function ensurePeer(id) {
  if(preview || id===me || !room?.people.some(p=>p.id===id&&p.inCall)||!room?.people.some(p=>p.id===me&&p.inCall))return;
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection({iceServers});
  const p={id,pc,session:room.people.find(x=>x.id===id)?.session,stream:new MediaStream(),queue:Promise.resolve(),candidates:[],initiator:me.localeCompare(id)<0,sending:null,receive:null};peers.set(id,p);
  pc.onicecandidate=e=>{if(e.candidate)send('signal',{to:id,signal:{candidate:e.candidate}});};
  pc.ontrack=e=>{if(!p.stream.getTracks().some(t=>t.id===e.track.id))p.stream.addTrack(e.track);if(e.track.kind==='audio')e.track.onunmute=()=>attachRemoteAudio(p);renderPeople();};
  pc.onconnectionstatechange=()=>{renderPeople();if(pc.connectionState==='failed')toast('Call connection failed. Use reconnect ↻. A TURN relay may be required on this network.');};
  pc.ondatachannel=e=>setupChannel(p,e.channel);
  if(p.initiator) {
    pc.addTransceiver('audio',{direction:'sendrecv'});pc.addTransceiver('video',{direction:'sendrecv'});
    setupChannel(p,pc.createDataChannel('xparty-file',{ordered:true}));
    pc.onnegotiationneeded=()=>{p.queue=p.queue.then(async()=>{await replaceTracks(p);await pc.setLocalDescription(await pc.createOffer());send('signal',{to:id,signal:{description:pc.localDescription}});}).catch(()=>{});};
  }
  return p;
}
async function replaceTracks(p) {
  for(const t of p.pc.getTransceivers()) {
    const kind=t.receiver.track.kind;const track=localStream.getTracks().find(x=>x.kind===kind)||null;
    await t.sender.replaceTrack(track);
    if(kind==='video' && track){try{const params=t.sender.getParameters();params.encodings??=[{}];params.encodings[0].maxBitrate=preferences.quality==='saver'?140000:300000;await t.sender.setParameters(params);}catch{}}
  }
}
async function receiveSignal(p,signal) {
  if(signal.restart){if(p.initiator)p.pc.restartIce();return;}
  if(signal.description){const d=signal.description;if(!['offer','answer'].includes(d.type))return;
    await p.pc.setRemoteDescription(d);
    for(const c of p.candidates)await p.pc.addIceCandidate(c);p.candidates=[];
    if(d.type==='offer'){for(const t of p.pc.getTransceivers())t.direction='sendrecv';await replaceTracks(p);await p.pc.setLocalDescription(await p.pc.createAnswer());send('signal',{to:p.id,signal:{description:p.pc.localDescription}});}
  }else if(signal.candidate){if(p.pc.remoteDescription)await p.pc.addIceCandidate(signal.candidate);else p.candidates.push(signal.candidate);}
}
function closePeer(p) {p.sending=null;p.receive=null;p.gain?.disconnect();p.audioSource?.disconnect();p.fallbackAudio?.remove();p.pc.close();}
async function unlockAudio() {
  try{
    audioContext??=new (window.AudioContext||window.webkitAudioContext)();await audioContext.resume();
    for(const p of peers.values())attachRemoteAudio(p);
    if(!movieAudio){movieAudio=audioContext.createMediaElementSource(filePlayer);movieGain=audioContext.createGain();movieAudio.connect(movieGain).connect(audioContext.destination);}
    movieGain.gain.value=movieVolume;filePlayer.volume=1;filePlayer.muted=false;if(ytReady){yt.unMute?.();yt.setVolume(movieVolume*100);}for(const p of peers.values()){p.fallbackAudio?.play().catch(()=>{});}
    $('enable-audio').textContent=t('Sound enabled');$('enable-audio').setAttribute('aria-pressed','true');$('settings-enable-audio').textContent=t('Sound enabled');
  }catch{filePlayer.volume=movieVolume;toast('Use your device sound controls if the volume sliders are restricted.');}
}
function attachRemoteAudio(p) {
  if(!p.stream.getAudioTracks().length)return;
  // One native audio element per peer: avoids duplicate output and allows browser call processing.
  p.gain?.disconnect();p.audioSource?.disconnect();p.gain=null;p.audioSource=null;
  if(!p.fallbackAudio){const audio=document.createElement('audio');audio.autoplay=true;audio.playsInline=true;p.fallbackAudio=audio;document.body.append(audio);}
  const audio=p.fallbackAudio;if(audio.srcObject!==p.stream)audio.srcObject=p.stream;
  audio.volume=callVolume;audio.muted=!speakerOn||!room?.people.find(x=>x.id===p.id)?.mic;
  audio.play().then(()=>{p.audioBlocked=false;}).catch(()=>{p.audioBlocked=true;$('speaker').classList.add('audio-needs-tap');$('speaker').setAttribute('aria-label','Tap to enable call audio');});
}
async function toggleMedia(kind) {
  if(preview)return toast('Create a room to start a call.');if(busyMedia)return;
  const self=room?.people.find(p=>p.id===me);if(!self?.inCall)return toast('Join a call seat first. Up to four people can call.');if(kind==='audio'&&self?.micBlocked)return toast('The host has muted your microphone.');if(kind==='video'&&room?.hostId!==me&&!self?.cameraAllowed){send('request-camera');return toast('Camera request sent to the host.');}
  busyMedia=true;$('mic').disabled=true;$('camera').disabled=true;
  try {
    let track=localStream.getTracks().find(t=>t.kind===kind);
    if(track){track.enabled=false;track.stop();localStream.removeTrack(track);send('media',{mic:localStream.getAudioTracks().some(t=>t.enabled&&t.readyState==='live'),camera:localStream.getVideoTracks().some(t=>t.enabled&&t.readyState==='live')});}else{
      await unlockAudio();
      const stream=await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:preferences.echo,noiseSuppression:preferences.noise,autoGainControl:true,channelCount:1,latency:{ideal:.02}},video:false}:{video:{width:{ideal:preferences.quality==='saver'?240:360},height:{ideal:preferences.quality==='saver'?320:480},frameRate:{ideal:15,max:15},facingMode:'user'},audio:false});
      track=stream.getTracks()[0];localStream.addTrack(track);track.onended=()=>{localStream.removeTrack(track);updateMedia();};
    }
    await updateMedia();
  }catch(e){console.warn('Media permission or track error', e.name, e.message);toast(e.name==='NotAllowedError'?'Allow camera/microphone access in your browser, then try again.':'Camera or microphone is unavailable. Check permissions and whether another app is using it.');}
  finally{busyMedia=false;$('mic').disabled=false;$('camera').disabled=false;}
}
async function updateMedia(){
  await Promise.all([...peers.values()].map(replaceTracks));
  const mic=localStream.getAudioTracks().some(t=>t.enabled&&t.readyState==='live'),camera=localStream.getVideoTracks().some(t=>t.enabled&&t.readyState==='live');
  $('mic').textContent=t(mic?'Mic on':'Mic off');$('mic').setAttribute('aria-pressed',mic);$('camera').textContent=t(camera?'Camera on':'Camera off');$('camera').setAttribute('aria-pressed',camera);
  send('media',{mic,camera});renderPeople();audioDiagnostics();
}
function setupChannel(p,dc){p.dc=dc;dc.onopen=()=>renderPeople();}
function transfer(text,percent){$('transfer').hidden=false;$('transfer-label').textContent=text;$('transfer-progress').value=percent;}
function fileReady(){if(room?.source?.type!=='file'||filePlayer.readyState<1||readySent===sourceId)return;readySent=sourceId;send('ready',{sourceId,ready:true,status:'Ready'});applyPlayback(true);}
async function uploadFile(file,id){
 const controller=fileJob=new AbortController();
 try{for(let offset=0;offset<file.size;){const chunk=file.slice(offset,offset+2*1024*1024);const res=await fetch(base+'/api/file/'+id,{method:'PUT',headers:{Authorization:'Bearer '+token,'X-File-Offset':String(offset)},body:chunk,signal:controller.signal});const data=await res.json();if(!res.ok)throw new Error(data.error);offset=data.offset;transfer('Uploading video · '+Math.round(offset*100/file.size)+'%',offset*100/file.size);}transfer('Uploaded. Guests are loading the video…',100);}catch(e){if(e.name!=='AbortError'){transfer('Upload interrupted. Select the file again to retry.',0);toast(e.message);}}
}
async function ensureFile(){
 const source=room?.source;if(source?.type!=='file'||!source.uploaded||loadedFileId===source.id||downloadId===source.id)return;
 const id=source.id;downloadId=id;const controller=fileJob=new AbortController();
 try{transfer('Receiving '+source.title,0);const res=await fetch(base+'/api/file/'+id,{headers:{Authorization:'Bearer '+token},signal:controller.signal});if(!res.ok)throw new Error((await res.json()).error);const reader=res.body.getReader(),parts=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;parts.push(value);size+=value.length;transfer('Receiving video · '+Math.round(size*100/source.size)+'%',size*100/source.size);}if(id!==sourceId)return;if(size!==source.size)throw new Error('Incomplete download. Tap Resync to retry.');loadedFileId=id;setFileBlob(new Blob(parts,{type:source.mime}));transfer('Received. Loading video…',100);}catch(e){if(e.name!=='AbortError'){transfer('Could not receive video. Tap Resync to retry.',0);toast(e.message);}}finally{if(downloadId===id)downloadId=null;}
}
function setFileBlob(blob) {if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);filePlayer.src=objectUrl;filePlayer.load();}
async function applySource(source) {
  localPaused=false;clearTimeout(bufferTimer);bufferReported=false;buffering=false;settleUntil=0;autoDriftSince=0;fileJob?.abort();downloadId=null;loadedFileId=null;readySent=null;sourceId=source?.id||null;appliedRevision=-1;suppressUntil=Date.now()+1400;lastCorrected=0;
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();
  
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  $('transfer').hidden=true;$('empty-player').hidden=!!source;$('youtube-wrap').hidden=source?.type!=='youtube';filePlayer.hidden=source?.type!=='file';
  $('stage-title').hidden=!source;$('stage-title').textContent=source?.title||'';if(!source){$('video-title').textContent='';status('Waiting for a video');return;}
  $('video-title').textContent=source.title;
  if(source.type==='youtube') {
    ownedFile=null;ownedFileId=null;pendingFile=null;status('Loading YouTube');
    try{await loadYouTube();if(sourceId!==source.id)return;yt.cueVideoById(source.videoId);yt.setVolume(movieVolume*100);send('ready',{sourceId,ready:true});setTimeout(()=>applyPlayback(true),800);}catch{toast('YouTube could not load. Check your connection or content blocker.');status('YouTube unavailable');}
  }else {
    status('Preparing shared file');
    if(me===source.owner && pendingFile){const file=pendingFile;pendingFile=null;loadedFileId=source.id;setFileBlob(file);uploadFile(file,source.id);}else if(source.uploaded)ensureFile();else transfer('Waiting for the host to finish uploading…',0);
  }
}
function loadYouTube() {
  if(ytReady)return Promise.resolve();if(ytPromise)return ytPromise;
  ytPromise=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('YouTube timed out')),20000);
    function init(){yt=new YT.Player('youtube-player',{width:'100%',height:'100%',playerVars:{playsinline:1,controls:0,disablekb:1,fs:0,rel:0,origin:location.origin},events:{onReady:()=>{clearTimeout(timeout);ytReady=true;yt.getIframe?.().setAttribute('tabindex','-1');resolve();},onStateChange:youtubeEvent,onError:e=>{reportBuffer(false);status('Video unavailable');toast('YouTube cannot embed this video ('+e.data+'). Try another video.');},onAutoplayBlocked:()=>{reportBuffer(true);$('unlock-playback').hidden=false;toast('Tap the playback button on this device to enable sound and video.');}}});}
    if(window.YT?.Player)init();else{window.onYouTubeIframeAPIReady=init;const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timeout);reject(new Error('YouTube blocked'));};document.head.append(script);}
  });ytPromise.catch(()=>{ytPromise=null;});return ytPromise;
}
function currentTime(){return room?.source?.type==='youtube'?(ytReady?yt.getCurrentTime()||0:0):filePlayer.currentTime||0;}
function duration(){return room?.source?.type==='youtube'?(ytReady?yt.getDuration()||0:0):(Number.isFinite(filePlayer.duration)?filePlayer.duration:0);}
function isPlaying(){return room?.source?.type==='youtube'?ytReady&&yt.getPlayerState()===1:!filePlayer.paused&&!filePlayer.ended;}
function reportBuffer(value){clearTimeout(bufferTimer);if(bufferReported===value)return;bufferReported=value;send('buffering',{sourceId,buffering:value});}
function youtubeEvent(e){
 if(room?.source?.type!=='youtube')return;
 if(e.data===3){if(localPaused)return;buffering=true;status('Buffering locally');clearTimeout(bufferTimer);bufferTimer=setTimeout(()=>{if(ytReady&&yt.getPlayerState()===3&&activePlayback?.playing)reportBuffer(true);},1200);return;}
 if(e.data===1){$('unlock-playback').hidden=true;buffering=false;reportBuffer(false);settleUntil=Date.now()+1000;return;}
 if(e.data===0){reportBuffer(false);if(room.hostId===me){if(room.queue?.length)send('next');else command(false,currentTime());}}
 // Native pause/play events never write back to the room timeline. Only app controls do.
}
function command(playing, position=currentTime()) {
  if(!room?.source || preview)return toast('Add a video in a live room first.');
  suppressUntil=Date.now()+1100;lastSeek=Date.now();send('playback',{sourceId,playing,intent:arguments.length>1?'seek':playing?'play':'pause',position:Math.max(0,position)});
}
function applyPlayback(force=false) {
  if(localPaused){setPlayIcon(false);status('Paused on this device · Play rejoins the host');return;}
  if(!room?.source || !activePlayback || preview)return;
  if(room.source.type==='youtube' && !ytReady)return;
  if(room.source.type==='file' && filePlayer.readyState<1)return;
  const p=activePlayback;let target=targetPosition(p,Date.now()+clockOffset);const total=duration();if(total>0)target=Math.min(target,total);
  const commandChanged=p.revision!==appliedRevision;
  if(commandChanged){suppressUntil=Date.now()+1000;appliedRevision=p.revision;}
  setPlayIcon(p.playing);$('play').title=t(p.playing?'Pause':'Play');$('play').setAttribute('aria-label',t(p.playing?'Pause':'Play'));
  if(p.playing&&p.waitingFor?.length){const mine=p.waitingFor.includes(me);if(mine&&room.source.type==='youtube'&&ytReady&&![1,3].includes(yt.getPlayerState())&&$('unlock-playback').hidden&&Date.now()-lastPlayAttempt>1500){lastPlayAttempt=Date.now();yt.playVideo();}if(!mine&&isPlaying()){if(room.source.type==='youtube')yt.pauseVideo();else filePlayer.pause();}status('Waiting for '+p.waitingFor.map(id=>room.people.find(x=>x.id===id)?.name||'a device').join(', '));return;}
  const diff=target-currentTime();
  // Seeking during YouTube buffering restarts loading. Preserve explicit commands,
  // but defer automatic corrections until the player has resumed and settled.
  if(room.source.type==='youtube'&&p.playing&&!commandChanged&&!force&&(yt.getPlayerState()===3||Date.now()<settleUntil))return;
  const mode=correction(diff,commandChanged || force,Date.now()-lastCorrected);
  if(Math.abs(diff)>.65){autoDriftSince||=Date.now();}else autoDriftSince=0;
  const shouldSeek=mode==='seek'&&(commandChanged||force||room.source.type==='file'||(Date.now()-autoDriftSince>=750&&Date.now()-lastCorrected>2500));
  if(shouldSeek){ suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.seekTo(target,true);else filePlayer.currentTime=target;lastCorrected=Date.now();}
  if(room.source.type==='file')filePlayer.playbackRate=p.playing&&mode==='rate'?Math.max(.95,Math.min(1.05,1+diff*.025)):1;
  if(p.playing && !isPlaying()){
    // A buffering YouTube player must finish buffering without repeated play/seek commands.
    if(room.source.type==='youtube'){if(yt.getPlayerState()!==3&&Date.now()-lastPlayAttempt>1500){lastPlayAttempt=Date.now();suppressUntil=Date.now()+700;yt.playVideo();}}
    else{suppressUntil=Date.now()+1000;filePlayer.play().catch(()=>toast('Tap Play or Enable sound to allow playback.'));}
  }else if(!p.playing && isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.pauseVideo();else filePlayer.pause();}
  setPlayIcon(p.playing);status(p.playing?(Math.abs(diff)<.75?'Playing together':'Aligning playback'):'Paused together');
}
function tick(){
  if(!room?.source || preview)return;
  const cur=currentTime(),total=duration();$('time').textContent=formatTime(cur)+' / '+formatTime(total);
  if(document.activeElement!==$('seek'))$('seek').value=total?cur/total*1000:0;
  
  if(Date.now()>suppressUntil){
    applyPlayback(false);
  }
  tick.previous=cur;tick.at=Date.now();tick.source=sourceId;
}
function formatTime(s){s=Math.floor(s||0);return (s>=3600?Math.floor(s/3600)+':':'')+String(Math.floor(s/60)%60).padStart(s>=3600?2:1,'0')+':'+String(s%60).padStart(2,'0');}
function chatIsVisible(){const rect=$('messages').getBoundingClientRect();return !document.hidden&&!$('room').hidden&&chatVisible&&rect.top<innerHeight&&rect.bottom>0;}
function updateUnread(){$('panel-unread').hidden=!unread;$('panel-unread').textContent=String(unread);$('chat-unread').hidden=!unread;$('chat-unread').textContent=unread>99?'99+':String(unread);}
function addMessage(m,live=true){typingPeople.delete(m.from);renderTyping();const welcome=$('messages').querySelector('.chat-welcome');welcome?.remove();const el=document.createElement('div');el.dataset.messageId=m.id;el.className='message'+(m.from===me?' mine':'')+(m.to?' private':'');const name=document.createElement('small');name.textContent=m.name+(m.to?' → '+m.toName+' · Private':'')+' · '+new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});const text=document.createElement('p');text.textContent=m.text;el.append(name);if(m.text)el.append(text);if(m.attachment)renderAttachment(el,m.attachment);if(m.from===me){const receipt=document.createElement('span');receipt.className='read-receipt';receipt.textContent=m.readBy?.length?'◉':'✓';receipt.setAttribute('aria-label',m.readBy?.length?'Read':'Sent');el.append(receipt);}else if(m.id){el.dataset.unread='true';} $('messages').append(el);if(live)notifySound(m.from===me?'sent':'message');requestAnimationFrame(markVisibleRead);while($('messages').children.length>200)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;if(live&&m.from!==me&&!chatIsVisible()){unread++;updateUnread();}}
function renderTyping(){for(const[id,p]of typingPeople)if(p.until<Date.now())typingPeople.delete(id);const names=[...typingPeople.values()].map(p=>p.name);$('typing').hidden=!names.length;$('typing').querySelector('span').textContent=names.slice(0,2).join(', ')+(names.length>2?' +'+(names.length-2):'')+(preferences.language==='hi'?' लिख रहे हैं':preferences.language==='kn'?' ಟೈಪ್ ಮಾಡುತ್ತಿದ್ದಾರೆ':' typing');}
function setRecipient(person){if(recipient)send('typing',{active:false,to:recipient.id});recipient=person;$('recipient-chip').hidden=!person;$('recipient-chip').querySelector('span').textContent=person?'Private → '+person.name:'';$('mentions').hidden=true;$('message-input').placeholder=person?'Message '+person.name:'Message everyone · @ for private';}
function showMentions(){const value=$('message-input').value;const match=value.match(/(?:^|\s)@([^@]*)$/);if(!match){$('mentions').hidden=true;return;}const list=(room?.people||[]).filter(p=>p.id!==me&&p.name.toLowerCase().includes(match[1].toLowerCase()));$('mentions').replaceChildren();for(const p of list){const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.textContent=p.name;button.onclick=()=>{send('typing',{active:false,to:recipient?.id});setRecipient(p);$('message-input').value=value.slice(0,match.index).trim();$('message-input').focus();};$('mentions').append(button);}$('mentions').hidden=!list.length;}
function actionIcon(label,shape,action){const b=document.createElement('button');b.type='button';b.className='icon-control';icon(b,shape,label);b.onclick=action;return b;}
function renderMembers(){const container=$('member-list');container.replaceChildren();for(const person of room.people){
  const row=document.createElement('div');row.className='member-row';const label=document.createElement('span');label.textContent=person.name+(person.id===room.hostId?' · Host':'')+(person.online?'':' · Away');row.append(label);
  if(person.id!==me){row.append(actionIcon('Message '+person.name,'message',()=>{setRecipient(person);conversation('both');$('return-room').click();members.open=false;$('message-input').focus();}));
    if(me===room.hostId){const tools=document.createElement('div');tools.className='member-permissions';tools.hidden=true;
      row.append(actionIcon('Permissions for '+person.name,'settings',()=>{tools.hidden=!tools.hidden;keepMembers();}));
      for(const [title,on,yes,no]of [['Chat',!person.chatBlocked,'allow-chat','block-chat'],['Mic',!person.micBlocked,'allow-mic','mute'],['Camera',!!person.cameraAllowed,'approve-camera','camera-off']]){const label=document.createElement('label');label.className='switch-row';label.textContent=title;const input=document.createElement('input');input.type='checkbox';input.setAttribute('role','switch');input.checked=on;input.onchange=()=>send('moderate',{target:person.id,action:input.checked?yes:no});label.append(input);tools.append(label);}
      if(person.online)tools.append(actionIcon('Transfer host to '+person.name,'key',()=>send('transfer-host',{target:person.id})));
      if(person.id!==room.ownerId)tools.append(actionIcon('Remove '+person.name,'leave',async()=>{if(await ask('Remove '+person.name+' from this room?'))send('kick',{target:person.id});}));row.append(tools);
    }
    if(me===room.hostId&&person.cameraRequested){const request=document.createElement('div');request.className='member-actions';request.textContent='Camera';request.append(actionIcon('Approve camera for '+person.name,'check',()=>send('moderate',{target:person.id,action:'approve-camera'})),actionIcon('Decline camera for '+person.name,'close',()=>send('moderate',{target:person.id,action:'deny-camera'})));row.append(request);}
  }container.append(row);
}renderRequestNotices();}
function updateTheatre(){$('panel-both').setAttribute('aria-pressed',vcVisible&&chatVisible);document.body.dataset.conversation=vcVisible&&chatVisible?'both':chatVisible?'chat':'call';requestAnimationFrame(markVisibleRead);$('panel-call').setAttribute('aria-pressed',vcVisible&&!chatVisible);$('panel-chat').setAttribute('aria-pressed',chatVisible&&!vcVisible);document.body.classList.toggle('show-vc',vcVisible);document.body.classList.toggle('show-chat',chatVisible);$('toggle-vc').setAttribute('aria-pressed',vcVisible);$('toggle-chat').setAttribute('aria-pressed',chatVisible);if(chatVisible){unread=0;updateUnread();requestAnimationFrame(()=>$('messages').scrollTop=$('messages').scrollHeight);}}
function setTheatre(enabled){document.body.dataset.view=viewMode;document.body.classList.toggle('cinema',enabled);document.body.classList.remove('browsing');if(enabled){vcVisible=true;chatVisible=false;}$('room-menu').open=false;updateTheatre();if(!enabled){unread=0;updateUnread();}}
function leave(notify=true){
  localPaused=false;
  $('room-menu').open=false;document.querySelector('.member-list').open=false;
  if(notify&&room?.ownerId===me)sessionStorage.setItem('xparty-owner-return',JSON.stringify({code:room.code,token,base}));else if(!notify)sessionStorage.removeItem('xparty-owner-return');
  intentionalClose=true;clearTimeout(reconnectTimer);clearTimeout(connectTimer);if(notify&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'leave'}));socket?.close();
  clearSession();fileJob?.abort();loadedFileId=null;downloadId=null;readySent=null;token=null;for(const p of peers.values())closePeer(p);peers.clear();localStream.getTracks().forEach(t=>t.stop());localStream=new MediaStream();
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();if(objectUrl)URL.revokeObjectURL(objectUrl);for(const url of attachmentUrls)URL.revokeObjectURL(url);attachmentUrls.clear();objectUrl=null;ownedFile=null;pendingFile=null;ownedFileId=null;
  recipient=null;typingPeople.clear();renderTyping();unread=0;updateUnread();$('recipient-chip').hidden=true;$('return-room').hidden=true;document.querySelector('.entry-card').hidden=false;room=null;me=null;sourceId=null;activePlayback=null;preview=false;$('room').hidden=true;$('lobby').hidden=false;$('demo-banner').hidden=true;document.querySelector('.call-controls').append($('mic'),$('camera'),$('camera-flip'));document.body.classList.remove('in-room','call-expanded','focus-call');$('focus-call').textContent='Focus call';observedMessages.clear();$('theme-select').disabled=false;$('participants').replaceChildren();document.documentElement.dataset.theme=preferences.theme;
  $('mic').textContent=t('Mic off');$('mic').setAttribute('aria-pressed',false);$('camera').textContent=t('Camera off');$('camera').setAttribute('aria-pressed',false);$('network').lastChild.textContent=' Private watch rooms';document.body.classList.remove('cinema');$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
}
$('create-toggle').onclick=()=>{$('create-details').hidden=false;$('create-toggle').setAttribute('aria-expanded','true');$('create-toggle').classList.add('dimmed');$('create-toggle').disabled=true;$('name').focus();};
$('end-room').onclick=async()=>{if(await ask('End this room for everyone?'))send('end-room');};
$('stop').onclick=()=>{if(room?.hostId===me)send('playback',{sourceId,playing:false,position:0,intent:'stop'});};
$('resync').onclick=()=>{if(room?.hostId!==me&&room?.mode!=='SHARED_CONTROL'){localPaused=false;lastPlayAttempt=0;applyPlayback(true);return;}if(ytReady&&room?.source?.type==='youtube'){reportBuffer(false);buffering=false;settleUntil=0;autoDriftSince=0;lastPlayAttempt=0;}send('resync');if(room?.source?.type==='file'){if(filePlayer.readyState>=1){readySent=null;fileReady();}else ensureFile();}toast('Aligning with room playback…');};
$('browse').onclick=()=>{document.body.classList.add('browsing');$('source-panel').scrollIntoView({behavior:'smooth',block:'start'});$('youtube-input').focus({preventScroll:true});};
$('back-video').onclick=()=>{document.body.classList.remove('browsing');$('watch-stage').scrollIntoView({behavior:'smooth'});};
$('next-video').onclick=()=>send('next');
$('create').onclick=async()=>{if(await roomAgreement('create'))connect({type:'create',name:$('name').value,capacity:2});};
$('join-form').onsubmit=async e=>{e.preventDefault();if(!await roomAgreement('join'))return;const code=$('code').value.trim().toUpperCase();if(room?.code===code){$('return-room').click();return;}let owner;try{owner=JSON.parse(sessionStorage.getItem('xparty-owner-return')||'null');}catch{}const saved=readSession();connect(saved?.code===code&&saved.base===base?{type:'resume',token:saved.token}:owner?.code===code&&owner.base===base?{type:'resume',token:owner.token}:{type:'join',name:$('join-nickname').value,code});};
$('code').oninput=()=>{$('code').value=$('code').value.toUpperCase().replace(/[^A-Z2-9]/g,'');scheduleRoomLookup();};
$('leave').onclick=()=>leave();$('lock').onclick=()=>send('lock',{locked:!room.locked});
$('copy').onclick=async()=>{if(preview)return toast('Preview code only. Create a live room for an invitation.');try{await navigator.clipboard.writeText(room.code);toast('Room code copied. Share it privately.');}catch{toast('Your room code: '+room.code);}};
$('mic').onclick=()=>toggleMedia('audio');$('camera').onclick=()=>toggleMedia('video');
$('retry-call').onclick=()=>{for(const p of peers.values()){if(p.initiator)p.pc.restartIce();else send('signal',{to:p.id,signal:{restart:true}});}toast('Reconnecting peer connections…');};
$('enable-audio').onclick=async()=>{await unlockAudio();if(activePlayback?.playing)applyPlayback(true);};
$('movie-volume').oninput=e=>{movieVolume=Number(e.target.value)/100;$('movie-level').textContent=e.target.value+'%';if(movieGain)movieGain.gain.value=movieVolume;else filePlayer.volume=movieVolume;if(ytReady)yt.setVolume(movieVolume*100);};
$('call-volume').oninput=e=>{callVolume=Number(e.target.value)/100;$('call-level').textContent=e.target.value+'%';for(const p of peers.values()){if(p.gain)p.gain.gain.value=callVolume;if(p.fallbackAudio)p.fallbackAudio.volume=callVolume;}};
$('chat-form').onsubmit=e=>{e.preventDefault();const text=$('message-input').value.trim();if(!text)return;if(!recipient&&/(?:^|\s)@/.test(text)){showMentions();return toast('Choose a participant from the @ list, or remove @ to message everyone.');}if(send('chat',{text,to:recipient?.id})){send('typing',{active:false,to:recipient?.id});$('message-input').value='';$('mentions').hidden=true;clearTimeout(typingTimer);}};
$('play').onclick=async()=>{await unlockAudio();if(!room?.source)return toast('Add a video first.');if(room.hostId!==me&&room.mode==='HOST_ONLY')return;if(room.hostId!==me&&room.mode==='HOST_APPROVAL'){localPaused=!localPaused;if(localPaused){reportBuffer(false);if(room.source.type==='youtube')ytReady&&yt.pauseVideo();else filePlayer.pause();setPlayIcon(false);status('Paused on this device · Play rejoins the host');}else{lastPlayAttempt=0;applyPlayback(true);}return;}if(activePlayback?.playing&&!isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')ytReady&&yt.playVideo();else filePlayer.play().catch(()=>toast('Unable to play this file on this device.'));applyPlayback(true);}else command(!activePlayback?.playing);};
$('back10').onclick=()=>command(activePlayback?.playing||false,currentTime()-10);$('forward10').onclick=()=>command(activePlayback?.playing||false,Math.min(duration(),currentTime()+10));
$('seek').onchange=()=>command(activePlayback?.playing||false,Number($('seek').value)/1000*duration());
$('theater').onclick=()=>setTheatre(!document.body.classList.contains('cinema'));$('exit-theatre').onclick=()=>setTheatre(false);$('toggle-vc').onclick=()=>{vcVisible=!vcVisible;updateTheatre();};$('toggle-chat').onclick=()=>{chatVisible=!chatVisible;updateTheatre();};
$('youtube-tab').onclick=()=>{$('youtube-form').hidden=false;$('file-form').hidden=true;$('youtube-tab').classList.add('active');$('file-tab').classList.remove('active');};
$('file-tab').onclick=()=>{$('youtube-form').hidden=true;$('file-form').hidden=false;$('file-tab').classList.add('active');$('youtube-tab').classList.remove('active');$('search-results').replaceChildren();};
function renderQueue(){const container=$('queue');container.replaceChildren();for(const item of room?.queue||[]){const row=document.createElement('div');row.className='queue-item';const title=document.createElement('span');title.textContent=item.title;row.append(title);const vote=document.createElement('button');vote.className='secondary';vote.hidden=room.autoplay!==false;vote.textContent='♡ '+(item.votes?.length||0);vote.setAttribute('aria-label','Vote for '+item.title);vote.setAttribute('aria-pressed',!!item.votes?.includes(me));vote.onclick=()=>send('queue-vote',{id:item.id});row.append(vote);if(room.hostId===me)for(const[label,type]of [['Play','queue-play'],['Remove','queue-remove']]){const b=document.createElement('button');b.className='secondary';b.textContent=label;b.onclick=()=>send(type,{id:item.id});row.append(b);}container.append(row);}if(!container.children.length)container.textContent='';}

function searchResult(item){const row=document.createElement('div');row.className='result';const img=document.createElement('img');img.src=item.thumbnail||'https://i.ytimg.com/vi/'+item.id+'/mqdefault.jpg';img.alt='';const title=document.createElement('span');title.textContent=item.title+(item.channel?' · '+item.channel:'')+(item.duration?' · '+item.duration:'');row.append(img,title);const actions=document.createElement('div');if(room.hostId===me||room.mode!=='HOST_ONLY'){const play=document.createElement('button');play.className='primary';play.textContent=room.hostId===me?t('Play now'):'Request video';play.onclick=()=>{send('source',{source:{type:'youtube',videoId:item.id,title:item.title}});$('watch-stage').scrollIntoView({behavior:'smooth'});};actions.append(play);}const add=document.createElement('button');add.className='secondary';add.textContent=t('+ Queue');add.onclick=()=>{send('queue-add',{videoId:item.id,title:item.title});if(room.hostId===me)toast('Added to the room playlist.');};actions.append(add);row.append(actions);$('search-results').append(row);}
let searchTimer,searchHideTimer,searchAbort,searchSequence=0;
function keepSearchVisible(){clearTimeout(searchHideTimer);searchHideTimer=setTimeout(()=>{if(!document.querySelector('#youtube-form:focus-within, #search-results:focus-within'))$('search-results').hidden=true;else keepSearchVisible();},30000);}
async function searchVideos(explicit=false){
 clearTimeout(searchTimer);const sequence=++searchSequence;searchAbort?.abort();searchAbort=new AbortController();
 if(preview){if(explicit)toast('Create a room to add a video.');return;}
 const value=$('youtube-input').value.trim(),id=youtubeId(value);$('search-results').replaceChildren();$('search-results').hidden=false;$('search-results').setAttribute('aria-busy','false');$('search-status').classList.remove('searching');$('load-video').disabled=false;
 if(id){searchResult({id,title:'YouTube · '+id});$('search-status').textContent='Play this link now or add it to the playlist.';keepSearchVisible();return;}
 if(value.length<2){$('search-status').textContent='';return;}
 $('search-status').classList.add('searching');$('search-status').textContent='Searching YouTube…';$('search-results').setAttribute('aria-busy','true');
 try{const res=await fetch(base+'/api/search?q='+encodeURIComponent(value),{signal:searchAbort.signal,headers:{Authorization:'Bearer '+token}});const data=await res.json();if(sequence!==searchSequence)return;if(!res.ok)throw new Error(data.error||'Search unavailable.');for(const item of data.items)searchResult(item);$('search-status').textContent=data.items.length?'Choose a video or keep browsing while it plays.':'No videos found. Try another search.';keepSearchVisible();}catch(e){if(e.name!=='AbortError'&&sequence===searchSequence)$('search-status').textContent=e.message;}finally{if(sequence===searchSequence){$('search-status').classList.remove('searching');$('search-results').setAttribute('aria-busy','false');}}
}
$('youtube-form').onsubmit=e=>{e.preventDefault();searchVideos(true);};
$('youtube-input').addEventListener('input',()=>{clearTimeout(searchTimer);searchAbort?.abort();searchSequence++;searchTimer=setTimeout(()=>searchVideos(),450);});
$('youtube-input').addEventListener('keydown',e=>{if(e.key==='ArrowDown'){const b=$('search-results').querySelector('button');if(b){e.preventDefault();$('search-results').hidden=false;b.focus();}}if(e.key==='Escape')$('search-results').hidden=true;});
$('search-results').addEventListener('keydown',e=>{const buttons=[...$('search-results').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const next=i+(e.key==='ArrowDown'?1:-1);if(next<0)$('youtube-input').focus();else buttons[Math.min(next,buttons.length-1)]?.focus();}if(e.key==='Escape'){$('search-results').hidden=true;$('youtube-input').focus();}});
$('file-input').onchange=()=>{const f=$('file-input').files[0];if(!f)return;if(preview)return toast('Create a room to share a file.');if(f.size>MAX_FILE || !f.size){$('file-input').value='';return toast('Choose a video smaller than 250 MB. Large movie transfer is not included in this first build.');}const mime=f.type||(/\.mp4$/i.test(f.name)?'video/mp4':/\.webm$/i.test(f.name)?'video/webm':'');if(!mime.startsWith('video/'))return toast('Choose a supported video file such as MP4 or WebM.');pendingFile=f;send('source',{source:{type:'file',title:f.name,size:f.size,mime}});$('file-input').value='';};
filePlayer.onloadedmetadata=fileReady;filePlayer.oncanplay=fileReady;
filePlayer.onerror=()=>{if(room?.source?.type==='file' && filePlayer.getAttribute('src')){readySent=null;send('ready',{sourceId,ready:false,status:'Unsupported video format'});toast('This device cannot decode the file. Try an MP4 with H.264 video and AAC audio.');}};
filePlayer.onended=()=>{if(room?.source?.type==='file'&&me===room.hostId){if(room.queue?.length)send('next');else command(false,currentTime());}};
$('preview').onclick=()=>{preview=true;me='preview-host';$('lobby').hidden=true;$('room').hidden=false;$('demo-banner').hidden=false;notice('');updateRoom({code:'PREVIEW',hostId:me,capacity:2,locked:false,source:null,playback:{position:0,playing:false,updatedAt:Date.now(),revision:0},people:[{id:me,name:'You',online:true,mic:false,camera:false},{id:'preview-guest',name:'Your friend',online:true,mic:false,camera:false}]});};
setInterval(tick,200);setInterval(ping,3000);
window.addEventListener('pagehide',()=>{suspended=true;clearTimeout(reconnectTimer);if(socket?.readyState===WebSocket.OPEN)socket.close();localStream.getTracks().forEach(t=>t.stop());});
window.addEventListener('pageshow',e=>{suspended=false;if(e.persisted){localStream=new MediaStream();const saved=readSession();if(saved?.base===base)connect({type:'resume',token:saved.token});}});
if(location.hostname.endsWith('github.io')&&!window.XPARTY_CONFIG?.backendUrl)$('setup-notice').hidden=false;

const initialSession=readSession();if(initialSession?.base===base){if(performance.getEntriesByType('navigation')[0]?.type==='reload'){token=initialSession.token;connect({type:'resume',token});}else $('active-room-banner').hidden=false;}

$('clear-recipient').onclick=()=>setRecipient(null);
$('message-input').oninput=()=>{showMentions();const active=!!$('message-input').value.trim();if(Date.now()-lastTyping>1500||!active){send('typing',{active,to:recipient?.id});lastTyping=Date.now();}clearTimeout(typingTimer);typingTimer=setTimeout(()=>send('typing',{active:false,to:recipient?.id}),2500);};
$('message-input').onkeydown=e=>{if(e.key==='Escape'){$('mentions').hidden=true;}if(e.key==='ArrowDown'&&!$('mentions').hidden){e.preventDefault();$('mentions').querySelector('button')?.focus();}};
$('room-capacity').onchange=renderCapacity;
$('call-seat').onclick=()=>send(room?.people.find(p=>p.id===me)?.inCall?'call-leave':'call-join');
$('nav-home').onclick=()=>{document.body.classList.remove('in-room','focus-call');$('focus-call').textContent='Focus call';setTheatre(false);$('room').hidden=true;$('lobby').hidden=false;document.querySelector('.entry-card').hidden=false;$('create-details').hidden=true;$('create-toggle').disabled=false;$('create-toggle').classList.remove('dimmed');$('create-toggle').setAttribute('aria-expanded','false');$('return-room').hidden=!room;};
$('return-room').onclick=()=>{document.body.classList.add('in-room');$('lobby').hidden=true;$('room').hidden=false;$('return-room').hidden=true;unread=0;updateUnread();};
for(const [button,dialog]of [['nav-settings','settings-dialog'],['theatre-settings','settings-dialog'],['nav-about','about-dialog']])$(button).onclick=()=>$(dialog).showModal();
for(const dialog of document.querySelectorAll('dialog'))dialog.querySelector('.close-dialog')?.addEventListener('click',()=>dialog.close());
function populateSettings(){for(const key of ['join','leave','message','sent','read'])$('notify-'+key).checked=preferences['notify_'+key]===true;$('theme-select').value=preferences.theme;$('language-select').value=preferences.language;$('noise-setting').checked=preferences.noise;$('echo-setting').checked=preferences.echo;$('quality-select').value=preferences.quality;}
async function applyCallSettings(){for(const track of localStream.getAudioTracks())try{await track.applyConstraints({noiseSuppression:preferences.noise,echoCancellation:preferences.echo,autoGainControl:true,channelCount:1,latency:{ideal:.02}});}catch{toast('This browser could not change audio processing during the call. Toggle your mic to retry.');}for(const track of localStream.getVideoTracks())try{await track.applyConstraints({width:{ideal:preferences.quality==='saver'?240:360},height:{ideal:preferences.quality==='saver'?320:480},frameRate:{ideal:15,max:15}});}catch{}await Promise.all([...peers.values()].map(replaceTracks));}
$('save-settings').onclick=async()=>{for(const[id,key]of [['theme-select','theme'],['language-select','language'],['noise-setting','noise'],['echo-setting','echo'],['quality-select','quality']])preferences[key]=$(id).type==='checkbox'?$(id).checked:$(id).value;for(const key of ['join','leave','message','sent','read'])preferences['notify_'+key]=$('notify-'+key).checked;savePreferences();if(room)updateRoom(room);await applyCallSettings();audioDiagnostics();$('settings-dialog').close();toast('Settings saved on this device.');};
$('reset-settings').onclick=()=>{resetPreferences();populateSettings();if(room)updateRoom(room);applyCallSettings();};populateSettings();
setInterval(renderTyping,1000);

for(const kind of ['movie','call']){$('settings-'+kind+'-volume').oninput=e=>{$(kind+'-volume').value=e.target.value;$(kind+'-volume').dispatchEvent(new Event('input'));};$(kind+'-volume').addEventListener('input',e=>$('settings-'+kind+'-volume').value=e.target.value);}$('settings-enable-audio').onclick=()=>$('enable-audio').click();

$('room-settings-button').onclick=()=>{$('room-capacity').value=String(room.capacity);$('room-theme').value=room.theme||'';$('guest-themes').checked=!!room.guestThemes;renderCapacity();$('room-settings-dialog').showModal();};
$('room-theme').onchange=()=>{};
$('panel-call').onclick=()=>conversation('call');$('panel-chat').onclick=()=>conversation('chat');$('panel-both').onclick=()=>conversation('both');
$('camera-power').onclick=()=>{$('camera-menu').hidden=true;toggleMedia('video');};
$('camera-flip').onclick=async()=>{if(busyMedia)return;busyMedia=true;$('camera-menu').hidden=true;const old=localStream.getVideoTracks()[0];if(!old){busyMedia=false;return;}const previous=cameraFacing;cameraFacing=previous==='user'?'environment':'user';old.onended=null;old.stop();localStream.removeTrack(old);try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:cameraFacing},width:{ideal:360},height:{ideal:480},frameRate:{ideal:15,max:15}},audio:false});const track=stream.getVideoTracks()[0];localStream.addTrack(track);track.onended=()=>{localStream.removeTrack(track);updateMedia();};}catch{cameraFacing=previous;toast('Camera switching is unavailable on this device. Tap Camera to restart it.');}finally{await updateMedia();busyMedia=false;}};
$('unlock-playback').onclick=async()=>{await unlockAudio();lastPlayAttempt=0;if(ytReady&&room?.source?.type==='youtube')yt.playVideo();else filePlayer.play().catch(()=>{});};
for(const[id,name,label]of [['mic','mic','Microphone'],['camera','camera','Camera options'],['retry-call','refresh','Reconnect call'],['room-settings-button','settings','Room settings'],['stop','stop','Stop for everyone'],['back10','back','Back 10 seconds'],['forward10','forward','Forward 10 seconds'],['resync','refresh','Resync this device'],['browse','search','Browse videos'],['theater','sofa','Theatre'],['enable-audio','volume','Enable sound']])icon($(id),name,label);
function movieSize(value){value=Math.max(24,Math.min(75,value));document.documentElement.style.setProperty('--movie-size',value+'dvh');$('movie-resizer').setAttribute('aria-valuenow',Math.round(value));}
$('movie-resizer').onpointerdown=e=>{e.preventDefault();$('movie-resizer').setPointerCapture(e.pointerId);const start=e.clientY,height=$('watch-stage').getBoundingClientRect().height;const move=ev=>movieSize((height+ev.clientY-start)/innerHeight*100);$('movie-resizer').onpointermove=move;$('movie-resizer').onpointerup=$('movie-resizer').onpointercancel=()=>{$('movie-resizer').onpointermove=null;};};
$('movie-resizer').onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();movieSize(Number($('movie-resizer').getAttribute('aria-valuenow'))+(e.key==='ArrowDown'?3:-3));}};

updateTheatre();

window.addEventListener('xparty:queue',e=>{if(!room)return toast('Join a room before adding a playlist.');send('queue-add',e.detail);});
window.addEventListener('xparty:share-file',e=>{if(!room||room.hostId!==me)return toast('Create a room as host before sharing a Drive video.');const file=e.detail;if(!file||file.size>MAX_FILE)return toast('The video exceeds the file limit.');pendingFile=file;send('source',{source:{type:'file',title:file.name,size:file.size,mime:file.type}});});

window.XPARTY_SESSION_STATE=()=>({inRoom:!!room,isHost:!!room&&room.hostId===me});

// Interface and call controls intentionally separate from playback timing.
function audioDiagnostics(){const settings=localStream.getAudioTracks()[0]?.getSettings();$('audio-diagnostics').textContent=settings?'Microphone processing reported by this browser — echo cancellation: '+(settings.echoCancellation===true?'on':settings.echoCancellation===false?'off':'not reported')+' · noise suppression: '+(settings.noiseSuppression===true?'on':settings.noiseSuppression===false?'off':'not reported'):'Microphone is off. Audio processing depends on your browser and device.';}
function notifySound(event){if(!preferences['notify_'+event]||!audioContext||audioContext.state!=='running')return;const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();oscillator.frequency.value={join:660,leave:330,message:780,sent:520,read:920}[event]||600;gain.gain.setValueAtTime(.025,audioContext.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.12);oscillator.connect(gain).connect(audioContext.destination);oscillator.start();oscillator.stop(audioContext.currentTime+.13);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};}
function markVisibleRead(){if(!chatIsVisible())return;const box=$('messages').getBoundingClientRect(),ids=[];for(const el of $('messages').querySelectorAll('[data-unread]')){const rect=el.getBoundingClientRect();if(rect.bottom>Math.max(0,box.top)&&rect.top<Math.min(innerHeight,box.bottom)&&!observedMessages.has(el.dataset.messageId)){ids.push(el.dataset.messageId);observedMessages.add(el.dataset.messageId);delete el.dataset.unread;}}if(ids.length)send('read',{ids});}
$('messages').addEventListener('scroll',markVisibleRead,{passive:true});document.addEventListener('visibilitychange',markVisibleRead);
function conversation(mode){vcVisible=mode!=='chat';chatVisible=mode!=='call';updateTheatre();}
let swipeStart;document.querySelector('.together-column').addEventListener('touchstart',e=>{if(e.target.closest('input,button,video,select'))return;swipeStart=e.touches[0].clientX;},{passive:true});document.querySelector('.together-column').addEventListener('touchend',e=>{if(swipeStart==null)return;const delta=e.changedTouches[0].clientX-swipeStart;swipeStart=null;if(Math.abs(delta)>70)conversation(delta<0?'chat':'call');},{passive:true});
$('speaker').onclick=async()=>{const blocked=[...peers.values()].some(p=>p.audioBlocked);if(blocked){speakerOn=true;await unlockAudio();$('speaker').classList.remove('audio-needs-tap');}else speakerOn=!speakerOn;$('speaker').setAttribute('aria-pressed',speakerOn);for(const p of peers.values())attachRemoteAudio(p);};
$('expand-call').onclick=()=>{const expanded=document.body.classList.toggle('call-expanded');$('expand-call').setAttribute('aria-pressed',expanded);if(expanded)conversation('call');};
$('theatre-view').onchange=()=>{viewMode=$('theatre-view').value;document.body.dataset.view=viewMode;if(viewMode==='call')conversation('call');else conversation('both');};
$('autoplay').onchange=()=>send('autoplay',{enabled:$('autoplay').checked});
$('nickname-toggle').onclick=()=>{$('join-nickname').hidden=!$('join-nickname').hidden;if(!$('join-nickname').hidden)$('join-nickname').focus();};
function scheduleRoomLookup(){clearTimeout(lookupTimer);const request=++joinLookup,code=$('code').value;const button=$('join-button');const saved=readSession();if(saved?.base===base&&saved.code===code){button.disabled=false;button.dataset.state='available';$('join-status').textContent='Return to your existing room seat';return;}button.disabled=true;button.dataset.state='pending';$('join-status').textContent=code.length<7?'Enter a room code':'Checking room…';if(!/^[A-Z2-9]{7,8}$/.test(code))return;lookupTimer=setTimeout(async()=>{try{const response=await fetch(base+'/api/room-status?code='+encodeURIComponent(code));const data=await response.json();if(request!==joinLookup)return;button.disabled=data.status!=='available';button.dataset.state=data.status==='available'?'available':'blocked';$('join-status').textContent=({available:'Room available · ready to join',full:'Room is full · ask the host for another seat',locked:'Room is locked · ask the host to unlock',limited:'Please wait before checking again'})[data.status]||'Room unavailable · check the code';}catch{if(request===joinLookup){button.disabled=false;button.dataset.state='pending';$('join-status').textContent='Could not check availability. You can still try joining.';}}},350);}
$('code').addEventListener('focus',scheduleRoomLookup);
function renderCapacity(){const box=$('capacity-options');if(!box.children.length)for(let n=2;n<=10;n++){const b=document.createElement('button');b.type='button';b.textContent=String(n);b.onclick=()=>{$('room-capacity').value=String(n);renderCapacity();};box.append(b);}for(const b of box.children){b.setAttribute('aria-pressed',b.textContent===$('room-capacity').value);b.disabled=room?.hostId!==me;}}
$('save-room-settings').onclick=()=>{if(room?.hostId===me){send('capacity',{capacity:Number($('room-capacity').value)});send('theme-access',{enabled:$('guest-themes').checked});}if(room?.hostId===me||room?.guestThemes)send('room-theme',{theme:$('room-theme').value});$('room-settings-dialog').close();};
$('reset-room-settings').onclick=()=>{$('room-theme').value='';$('guest-themes').checked=false;$('room-capacity').value=String(Math.max(2,room.people.filter(p=>p.online||p.id===room.ownerId).length));renderCapacity();};
$('room-notifications').onclick=()=>{$('room-settings-dialog').close();populateSettings();$('settings-dialog').showModal();$('notification-settings').scrollIntoView({block:'nearest'});};
$('test-sound').onclick=async()=>{await unlockAudio();const previous=preferences.notify_message;preferences.notify_message=true;notifySound('message');preferences.notify_message=previous;};
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
document.querySelector('.brand').onclick=e=>{e.preventDefault();$('nav-home').click();};
$('new-room').onclick=()=>{$('nav-home').click();$('create-toggle').click();};
$('privacy-open').onclick=()=>$('privacy-dialog').showModal();
for(const[id,name,label]of [['nav-home','home','Home'],['nav-settings','settings','Settings'],['nav-about','info','About'],['control-key','key','Room controls'],['people-button','people','Participants'],['new-room','plus','Create room'],['camera-flip','flip','Switch front / rear camera'],['speaker','volume','Call speaker on / off'],['expand-call','expand','Expand video call'],['nickname-toggle','person','Optional nickname']])icon($(id),name,label);
for(const details of document.querySelectorAll('.room-tools details'))details.addEventListener('toggle',()=>{if(!details.open)return;for(const other of document.querySelectorAll('.room-tools details'))if(other!==details)other.open=false;const panel=details.querySelector('.room-menu-content,#member-list,p');if(!panel)return;const rect=details.getBoundingClientRect();Object.assign(panel.style,{position:'fixed',top:Math.min(rect.bottom+6,innerHeight-150)+'px',left:Math.max(8,Math.min(rect.left,innerWidth-290))+'px',width:'min(280px, calc(100vw - 16px))',maxHeight:'min(360px, calc(100dvh - 80px))',overflow:'auto',zIndex:80});});
document.addEventListener('click',e=>{for(const d of document.querySelectorAll('.room-tools details[open]'))if(!d.contains(e.target))d.open=false;});
audioDiagnostics();

for(const node of document.querySelectorAll('[title]')){if(!node.hasAttribute('aria-label'))node.setAttribute('aria-label',node.title);node.removeAttribute('title');}

function readSession(){try{return JSON.parse(sessionStorage.getItem(SESSION)||localStorage.getItem(SESSION)||'null');}catch{return null;}}
function saveSession(saved){try{const text=JSON.stringify(saved);sessionStorage.setItem(SESSION,text);localStorage.setItem(SESSION,text);}catch{toast('This browser could not save your rejoin session. Keep this tab open.');}}
function clearSession(){try{sessionStorage.removeItem(SESSION);localStorage.removeItem(SESSION);}catch{}$('active-room-banner').hidden=true;}
$('resume-saved').onclick=()=>{const saved=readSession();if(saved?.base===base)connect({type:'resume',token:saved.token});};
$('leave-saved').onclick=()=>{const saved=readSession();if(!saved)return;const url=new URL(base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/ws';const ws=new WebSocket(url);ws.onopen=()=>ws.send(JSON.stringify({type:'resume',token:saved.token}));ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='welcome')ws.send(JSON.stringify({type:'leave'}));if(['welcome','resume-failed'].includes(m.type)){clearSession();ws.close();}};setTimeout(()=>ws.close(),10000);};
function renderPartyControls(){if(!room)return;const host=room.hostId===me,mode=room.mode||'HOST_APPROVAL';$('party-mode').value=mode;if(!host)$('approval-settings').hidden=true;$('participant-settings-button').hidden=!host;$('approval-policy').value=room.approvalPolicy||'manual';$('auto-approve-requests').checked=room.approvalPolicy==='approve';$('auto-decline-requests').checked=room.approvalPolicy==='reject';$('auto-sync').checked=!!room.autoSync;$('auto-pause').checked=!!room.autoPause;$('request-control').hidden=host||mode!=='SHARED_CONTROL';$('control-status').textContent=room.hostReconnecting?'Host reconnecting · seat reserved for 2 minutes':room.controller?((room.people.find(p=>p.id===room.controller.id)?.name||'Participant')+' has control · host can override'):host?'You can change modes at any time.':mode==='HOST_APPROVAL'?'Pause is local. Play catches up to the host. Video changes need approval.':mode==='HOST_ONLY'?'The host controls playback.':'Shared playback · 10-second control turns.';$('stop').hidden=!host;for(const id of ['seek','back10','forward10','previous-video'])$(id).disabled=!host&&mode!=='SHARED_CONTROL';for(const id of ['back10','forward10','previous-video'])$(id).hidden=!host&&mode!=='SHARED_CONTROL';$('play').disabled=!host&&mode==='HOST_ONLY';$('play').setAttribute('aria-label',!host&&mode==='HOST_APPROVAL'?'Pause or resume on this device':'Play or pause for everyone');$('party-actions').hidden=host||mode!=='HOST_APPROVAL';$('resync').disabled=false;const requests=(room.requests||[]).filter(q=>host||q.by===me);$('request-count').textContent=requests.filter(q=>q.status==='HOST_REVIEW').length;const box=$('request-list');document.querySelector('.member-list').classList.toggle('has-requests',room.people.some(p=>p.cameraRequested)||requests.some(q=>q.status==='HOST_REVIEW'));box.replaceChildren();const priority=q=>q.action.type==='resync'?0:q.action.type==='playback'?1:q.action.type==='party-mode'?3:2;for(const q of [...requests].sort((a,b)=>priority(a)-priority(b)||a.createdAt-b.createdAt).slice(-50)){const row=document.createElement('div');row.className='request-card';const text=document.createElement('p');text.textContent=q.name+' · '+(q.action.intent||q.action.type)+' · '+q.status;row.append(text);if(q.status==='HOST_REVIEW'){for(const [label,type,fields]of host?[['Approve','review-request',{approve:true}],['Reject','review-request',{approve:false}]]:[['Cancel','cancel-request',{}]]){const b=document.createElement('button');b.className='secondary';icon(b,label==='Approve'?'check':'close',label+' request');b.onclick=()=>send(type,{id:q.id,...fields});row.append(b);}}box.append(row);}if(!requests.length)box.textContent='';renderRequestNotices();}
$('party-mode').onchange=()=>send('party-mode',{mode:$('party-mode').value});$('request-control').onclick=()=>send('request-control');$('open-requests').onclick=e=>{e.stopPropagation();$('room-menu').open=false;document.querySelector('.member-list').open=true;};$('save-approval').onclick=()=>send('approval-settings',{policy:$('approval-policy').value,autoSync:$('auto-sync').checked,autoPause:$('auto-pause').checked});$('previous-video').onclick=()=>send('previous');
$('rename').onclick=()=>{$('rename-input').value=room?.people.find(p=>p.id===me)?.name||'';$('rename-dialog').showModal();};$('save-name').onclick=()=>{send('rename',{name:$('rename-input').value});$('rename-dialog').close();};
$('privacy-settings').onclick=privacySettings;
$('focus-call').onclick=()=>{const focused=document.body.classList.toggle('focus-call');$('focus-call').textContent=focused?'Exit focus':'Focus call';conversation('call');document.body.classList.remove('browsing');};
let callHeight=460;function resizeCall(value){callHeight=Math.max(220,Math.min(900,value));document.documentElement.style.setProperty('--call-height',callHeight+'px');document.documentElement.style.setProperty('--focus-height',callHeight+'px');$('call-resizer').setAttribute('aria-valuenow',Math.round(callHeight));}
$('call-resizer').onpointerdown=e=>{e.preventDefault();const start=e.clientY,height=callHeight;$('call-resizer').setPointerCapture(e.pointerId);$('call-resizer').onpointermove=ev=>resizeCall(height+ev.clientY-start);$('call-resizer').onpointerup=$('call-resizer').onpointercancel=()=>{$('call-resizer').onpointermove=null;};};$('call-resizer').onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();resizeCall(callHeight+(e.key==='ArrowDown'?20:-20));}};

// Floating movie uses the existing player; moving it never reloads media.
const pipBox=document.querySelector('.watch-column');let pipWidth=280;
function constrainPip(){if(!document.body.classList.contains('focus-call'))return;const r=pipBox.getBoundingClientRect();pipWidth=Math.min(Math.max(200,r.width),innerWidth-16);pipBox.style.setProperty('--pip-width',pipWidth+'px');pipBox.style.left=Math.max(8,Math.min(r.left,innerWidth-pipWidth-8))+'px';pipBox.style.top=Math.max(58,Math.min(r.top,innerHeight-r.height-8))+'px';pipBox.style.right='auto';pipBox.style.bottom='auto';}
for(const [id,resize] of [['pip-handle',false],['pip-resize',true]]){const h=$(id);h.onpointerdown=e=>{e.preventDefault();constrainPip();const r=pipBox.getBoundingClientRect(),x=e.clientX,y=e.clientY;h.setPointerCapture(e.pointerId);h.onpointermove=v=>{if(resize)pipBox.style.setProperty('--pip-width',Math.max(200,Math.min(innerWidth-16,r.width+v.clientX-x))+'px');else{pipBox.style.left=Math.max(8,Math.min(innerWidth-r.width-8,r.left+v.clientX-x))+'px';pipBox.style.top=Math.max(58,Math.min(innerHeight-r.height-8,r.top+v.clientY-y))+'px';}};h.onpointerup=h.onpointercancel=()=>{h.onpointermove=null;constrainPip();};};h.onkeydown=e=>{if(!e.key.startsWith('Arrow'))return;e.preventDefault();constrainPip();const r=pipBox.getBoundingClientRect();if(resize)pipBox.style.setProperty('--pip-width',(r.width+(e.key==='ArrowRight'?20:-20))+'px');else{pipBox.style.left=(r.left+(e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0))+'px';pipBox.style.top=(r.top+(e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0))+'px';}constrainPip();};}
window.addEventListener('resize',constrainPip);
const members=document.querySelector('.member-list');let memberTimer;function keepMembers(){clearTimeout(memberTimer);if(members.open)memberTimer=setTimeout(()=>{if(!members.querySelector('select:focus,input:focus'))members.open=false;else keepMembers();},12000);}members.addEventListener('toggle',()=>{$('people-button').setAttribute('aria-expanded',members.open);keepMembers();});$('people-button').onclick=()=>{members.open=!members.open;$('room-menu').open=false;};$('close-participants').onclick=()=>members.open=false;$('participant-settings-button').onclick=()=>{const box=$('approval-settings');box.hidden=!box.hidden;$('participant-settings-button').setAttribute('aria-expanded',!box.hidden);keepMembers();};members.addEventListener('pointerdown',keepMembers);members.addEventListener('keydown',keepMembers);

for(const button of document.querySelectorAll('[data-party-intent]'))button.onclick=()=>{if(!room?.source)return toast('Add a video first.');const intent=button.dataset.partyIntent;send('party-request',{intent,sourceId,playing:intent==='play',position:intent==='seek'?Number($('request-seek-position').value):currentTime()});};

for(const b of document.querySelectorAll('[data-reaction]'))b.onclick=()=>send('reaction',{emoji:b.dataset.reaction});
// Audio activity comes from existing WebRTC statistics; no extra audio output or capture.
let speakerScan=false;
setInterval(async()=>{if(speakerScan||document.hidden||!room||!localStream.getTracks().length&&!peers.size)return;speakerScan=true;const speaking=new Set();try{await Promise.all([...peers].map(async([id,p])=>{try{const stats=await p.pc.getStats();stats.forEach(s=>{if(s.kind!=='audio'&&s.mediaType!=='audio')return;if(s.type==='inbound-rtp'&&s.audioLevel>.035)speaking.add(id);if(s.type==='media-source'&&s.audioLevel>.035&&localStream.getAudioTracks().some(t=>t.enabled&&t.readyState==='live'))speaking.add(me);});}catch{}}));for(const tile of $('participants').children){const active=speaking.has(tile.dataset.id)&&room?.people.some(p=>p.id===tile.dataset.id&&p.mic);tile.classList.toggle('speaking',!!active);}}finally{speakerScan=false;}},650);
const callPip=document.querySelector('.call-panel');
function clampCallPip(){const r=callPip.getBoundingClientRect();callPip.style.setProperty('--vc-width',Math.min(Math.max(200,r.width),innerWidth-16)+'px');callPip.style.left=Math.max(8,Math.min(r.left,innerWidth-callPip.offsetWidth-8))+'px';callPip.style.top=Math.max(110,Math.min(r.top,innerHeight-callPip.offsetHeight-8))+'px';}
function snapCallPip(corner){clampCallPip();callPip.style.left=(corner.endsWith('r')?Math.max(8,innerWidth-callPip.offsetWidth-8):8)+'px';callPip.style.top=(corner.startsWith('b')?Math.max(110,innerHeight-callPip.offsetHeight-8):110)+'px';}
for(const b of document.querySelectorAll('[data-vc-corner]'))b.onclick=()=>snapCallPip(b.dataset.vcCorner);
for(const [id,resizing]of [['vc-pip-handle',false],['vc-pip-resize',true]]){const h=$(id);h.onpointerdown=e=>{e.preventDefault();clampCallPip();const r=callPip.getBoundingClientRect(),x=e.clientX,y=e.clientY;h.setPointerCapture(e.pointerId);h.onpointermove=v=>{if(resizing)callPip.style.setProperty('--vc-width',Math.max(200,Math.min(innerWidth-16,r.width+v.clientX-x))+'px');else{callPip.style.left=(r.left+v.clientX-x)+'px';callPip.style.top=(r.top+v.clientY-y)+'px';}clampCallPip();};h.onpointerup=h.onpointercancel=()=>h.onpointermove=null;};h.onkeydown=e=>{if(!e.key.startsWith('Arrow'))return;e.preventDefault();const r=callPip.getBoundingClientRect();if(resizing)callPip.style.setProperty('--vc-width',(r.width+(['ArrowRight','ArrowDown'].includes(e.key)?20:-20))+'px');else{callPip.style.left=(r.left+(e.key==='ArrowRight'?20:e.key==='ArrowLeft'?-20:0))+'px';callPip.style.top=(r.top+(e.key==='ArrowDown'?20:e.key==='ArrowUp'?-20:0))+'px';}clampCallPip();};}
addEventListener('resize',()=>{if(document.body.classList.contains('cinema')&&viewMode==='movie')clampCallPip();});

// Compact UI shares the existing room, player and call. No second media output.
for(const [id,shape,label]of [['load-video','search','Search YouTube'],['next-video','next','Play next'],['back-video','back','Back to video'],['participant-settings-button','settings','Participant review settings'],['close-participants','close','Close participants'],['controls-toggle','more','Show playback controls'],['attach-chat','attach','Share photo, GIF, video or file']])icon($(id),shape,label);
for(const id of ['noise-setting','echo-setting','auto-sync','auto-pause','guest-themes'])$(id).setAttribute('role','switch');
const shell=$('player-shell');let controlsTimer;
function showControls(){shell.classList.remove('controls-hidden');$('controls-toggle').setAttribute('aria-expanded','true');clearTimeout(controlsTimer);controlsTimer=setTimeout(()=>{if(!shell.querySelector('.player-bar :focus-visible')&&!shell.matches(':active')){shell.classList.add('controls-hidden');$('controls-toggle').setAttribute('aria-expanded','false');}},2800);}
shell.addEventListener('pointermove',e=>{if(!e.target.closest('#controls-toggle'))showControls();},{passive:true});shell.addEventListener('pointerdown',e=>{if(!e.target.closest('#controls-toggle'))showControls();},{passive:true});shell.addEventListener('keydown',e=>{if(!e.target.closest('#controls-toggle'))showControls();});shell.addEventListener('focusin',e=>{if(!e.target.closest('#controls-toggle'))showControls();});
$('controls-toggle').onclick=()=>{if(shell.classList.contains('controls-hidden'))showControls();else{clearTimeout(controlsTimer);shell.classList.add('controls-hidden');$('controls-toggle').setAttribute('aria-expanded','false');}};showControls();
const sections=[...$('settings-dialog').querySelectorAll('.settings-section')];let settingsTimer;
function settingsActivity(){clearTimeout(settingsTimer);if($('settings-dialog').open)settingsTimer=setTimeout(()=>{if(!$('settings-dialog').querySelector('input:focus,select:focus'))for(const d of sections)d.open=false;else settingsActivity();},18000);}
for(const d of sections)d.addEventListener('toggle',()=>{if(d.open)for(const other of sections)if(other!==d)other.open=false;settingsActivity();});
$('settings-dialog').addEventListener('pointerdown',settingsActivity);$('settings-dialog').addEventListener('keydown',settingsActivity);
$('room-notifications').addEventListener('click',()=>{$('notification-settings').closest('details').open=true;settingsActivity();});
document.addEventListener('pointerdown',e=>{if(members.open&&!members.contains(e.target)&&!$('people-button').contains(e.target)&&!e.target.closest('#toast,.approval-card'))members.open=false;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){members.open=false;$('room-menu').open=false;}});
const splitter=$('conversation-resizer');let conversationWidth=360;
function resizeConversation(delta){if(innerWidth<=760){resizeCall(Math.max(220,callHeight+delta));document.documentElement.style.setProperty('--focus-height',callHeight+'px');}else{conversationWidth=Math.max(270,Math.min(innerWidth*.65,conversationWidth-delta));document.documentElement.style.setProperty('--conversation-width',conversationWidth+'px');}}
splitter.onpointerdown=e=>{e.preventDefault();let previous=innerWidth<=760?e.clientY:e.clientX;splitter.setPointerCapture(e.pointerId);splitter.onpointermove=v=>{const current=innerWidth<=760?v.clientY:v.clientX;resizeConversation(current-previous);previous=current;};splitter.onpointerup=splitter.onpointercancel=()=>splitter.onpointermove=null;};
splitter.onkeydown=e=>{if(e.key.startsWith('Arrow')){e.preventDefault();resizeConversation(['ArrowRight','ArrowDown'].includes(e.key)?20:-20);}};
$('call-resizer').addEventListener('pointermove',()=>document.documentElement.style.setProperty('--focus-height',callHeight+'px'));
function describeRequest(q){const a=q.action;return a.type==='source'?'Change video: '+(a.source?.title||'YouTube'):a.type==='playback'?({pause:'Pause the party',play:'Play for everyone',seek:'Seek to '+Math.round(a.position)+'s'})[a.intent]||'Playback':a.type==='party-mode'?'Change mode to '+a.mode:a.type==='request-control'?'Take playback control':a.type==='resync'?'Resync':'Playlist: '+a.type.replace('queue-','');}
function renderRequestNotices(){if(!room)return;const host=room.hostId===me,visible=(room.requests||[]).filter(q=>host||q.by===me);const notices=visible.map(q=>({id:q.id,text:q.name+' · '+describeRequest(q),status:q.status,accept:()=>send('review-request',{id:q.id,approve:true}),decline:()=>send('review-request',{id:q.id,approve:false})}));
 if(host)for(const person of room.people.filter(p=>p.cameraRequested))notices.push({id:'camera-'+person.id,text:person.name+' · Enable camera',status:'HOST_REVIEW',accept:()=>send('moderate',{target:person.id,action:'approve-camera'}),decline:()=>send('moderate',{target:person.id,action:'deny-camera'})});
 for(const el of $('messages').querySelectorAll('[data-request]'))if(!notices.some(q=>q.id===el.dataset.request))el.remove();
 for(const q of notices){let el=[...$('messages').querySelectorAll('[data-request]')].find(e=>e.dataset.request===q.id);const fresh=!el;if(!el){el=document.createElement('div');el.dataset.request=q.id;el.className='message system';$('messages').querySelector('.chat-welcome')?.remove();$('messages').append(el);}el.replaceChildren();const card=document.createElement('div');card.className='approval-card';const text=document.createElement('span');text.textContent=q.text;card.append(text);
   if(host&&q.status==='HOST_REVIEW'){const actions=document.createElement('div');actions.className='request-actions';actions.append(actionIcon('Accept request','check',q.accept),actionIcon('Decline request','close',q.decline));card.append(actions);}else{const status=document.createElement('small');status.className='request-status';status.textContent=q.status==='HOST_REVIEW'?'Pending':q.status.toLowerCase().replaceAll('_',' ');card.append(status);}el.append(card);if(fresh&&host){if(!chatIsVisible()){unread++;updateUnread();}notifySound('message');}
 }
}
function renderAttachment(el,attachment){const card=document.createElement('div');card.className='attachment-card';const button=document.createElement('button');button.type='button';button.textContent=attachment.name+' · '+(attachment.size/1048576).toFixed(1)+' MB';button.setAttribute('aria-label','Open attachment '+attachment.name);card.append(button);el.append(card);let loaded=false;
 button.onclick=async()=>{if(loaded)return;button.disabled=true;button.textContent='Loading…';const currentToken=token;try{const res=await fetch(base+'/api/attachment/'+attachment.id,{headers:{Authorization:'Bearer '+currentToken}});if(!res.ok)throw Error('Attachment unavailable. It may have been removed or the room restarted.');const blob=await res.blob();if(token!==currentToken)return;const url=URL.createObjectURL(new Blob([blob],{type:attachment.mime}));attachmentUrls.add(url);loaded=true;
   if(/^image\/(png|jpeg|gif|webp)$/.test(attachment.mime)){const img=document.createElement('img');img.src=url;img.alt=attachment.name;card.append(img);}else if(/^video\/(mp4|webm)$/.test(attachment.mime)){const video=document.createElement('video');video.src=url;video.controls=true;video.playsInline=true;video.preload='metadata';card.append(video);}
   const link=document.createElement('a');link.href=url;link.download=attachment.name;link.textContent='Download '+attachment.name;card.append(link);button.remove();
 }catch(e){button.disabled=false;button.textContent='Retry · '+attachment.name;toast(e.message);}};
}
$('attach-chat').onclick=()=>{if(!room||preview)return toast('Join a live room to share files.');$('chat-file').click();};
$('chat-file').onchange=async()=>{const file=$('chat-file').files[0];$('chat-file').value='';if(!file)return;if(file.size>20*1048576||!file.size)return toast('Chat attachments must be between 1 byte and 20 MB. Use Local file for a longer shared movie.');const currentToken=token,to=recipient?.id||null;$('attach-chat').disabled=true;$('attachment-status').hidden=false;$('attachment-status').textContent='Uploading '+file.name+'…';try{const response=await fetch(base+'/api/attachment',{method:'POST',headers:{Authorization:'Bearer '+currentToken,'Content-Type':file.type||'application/octet-stream','X-Attachment-Name':encodeURIComponent(file.name),'X-Attachment-To':to||''},body:file});const result=await response.json();if(!response.ok)throw Error(result.error||'Upload failed');if(token!==currentToken)return;send('chat',{text:'',attachmentId:result.attachment.id,to});$('attachment-status').textContent='Shared '+file.name;}catch(e){$('attachment-status').textContent=e.message;toast(e.message);}finally{$('attach-chat').disabled=false;setTimeout(()=>$('attachment-status').hidden=true,5000);}};

function setPlayIcon(playing){const shape=playing?"pause":"play";if($("play").dataset.shape!==shape){icon($("play"),shape,playing?"Pause playback":"Play playback");$("play").dataset.shape=shape;}}
setPlayIcon(false);icon($("previous-video"),"back","Previous video");

$('lock-toggle').onchange=()=>send('lock',{locked:$('lock-toggle').checked});

for(const [id,value,other]of [['auto-approve-requests','approve','auto-decline-requests'],['auto-decline-requests','reject','auto-approve-requests']])$(id).onchange=()=>{if($(id).checked)$(other).checked=false;$('approval-policy').value=$(id).checked?value:'manual';};

let menuTimer;function menuActivity(){clearTimeout(menuTimer);if($('room-menu').open)menuTimer=setTimeout(()=>{if(!$('room-menu').querySelector('input:focus,select:focus'))$('room-menu').open=false;else menuActivity();},12000);}$('room-menu').addEventListener('toggle',menuActivity);$('room-menu').addEventListener('pointerdown',menuActivity);$('room-menu').addEventListener('keydown',menuActivity);
