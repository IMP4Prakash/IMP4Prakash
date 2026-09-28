import {preferences,t,localize,savePreferences,resetPreferences} from './settings.js';
import {youtubeId, targetPosition, correction} from './sync.js';
const $ = id => document.getElementById(id);
const MAX_FILE = 250 * 1024 * 1024;
let base = (window.XPARTY_CONFIG?.backendUrl || location.origin).replace(/\/$/,'');
let socket, me, token, room, preview = false, intentionalClose = false, reconnectTimer, connectTimer;
let iceServers=[], peers=new Map(), localStream=new MediaStream(), yt, ytReady=false, ytPromise;
let sourceId=null, pendingFile=null, ownedFile=null, ownedFileId=null, objectUrl=null, activePlayback;
let suppressUntil=0, lastCorrected=0, appliedRevision=-1, clockOffset=0, bestRTT=Infinity, lastAnchor=0, lastSeek=0;
let audioContext, movieGain, movieAudio, callVolume=1, movieVolume=.7, busyMedia=false;
let recipient=null,unread=0,typingTimer,lastTyping=0;const typingPeople=new Map();let vcVisible=false,chatVisible=false,buffering=false,settleUntil=0;
let fileJob=null,loadedFileId=null,downloadId=null,readySent=null;
const SESSION='xparty-session-v2';
const filePlayer=$('file-player');
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500); }
function status(text) {$('sync-status').lastChild.textContent=' '+t(text);}
function notice(text) {$('connection-notice').textContent=text||'Connected. Share the room code privately.';}
function send(type, fields={}) {if(preview) {toast('This is a design preview. Create a room to connect.');return false;}if(socket?.readyState!==WebSocket.OPEN){toast('Room connection is offline. Reconnecting…');return false;}socket.send(JSON.stringify({type,...fields}));return true;}
function ping() {if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'ping',sent:Date.now()}));}
function connect(action) {
  preview=false;intentionalClose=false;clearTimeout(reconnectTimer);clearTimeout(connectTimer);
  $('create').disabled=true;$('join-form').querySelector('button').disabled=true;
  let url;try{url=new URL(base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/ws';url.search='';}catch{toast('The room service address is invalid.');return;}
  if(socket?.readyState<2)socket.close();socket=new WebSocket(url);const ws=socket;
  connectTimer=setTimeout(()=>{if(ws.readyState===WebSocket.CONNECTING)ws.close();toast('The room service did not respond. Check deployment and try again.');},15000);
  ws.onopen=()=>{clearTimeout(connectTimer);ws.send(JSON.stringify(action));ping();};
  ws.onmessage=e=>{try{handle(JSON.parse(e.data));}catch(error){console.error('Room event failed',error);toast('An action failed. Please retry.');}};
  ws.onerror=()=>{if(!room){$('setup-notice').hidden=false;toast('Unable to reach the room service. The portal needs a live backend.');}};
  ws.onclose=e=>{
    clearTimeout(connectTimer);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
    if(ws!==socket)return;
    if(e.code===4000){leave(false);toast("This session was opened in another connection.");return;}
    if(!intentionalClose && token){notice('Connection interrupted. Reconnecting to your room…');reconnectTimer=setTimeout(()=>connect({type:'resume',token}),1800);}
    else if(!intentionalClose){$('setup-notice').hidden=false;}
  };
}
function handle(m) {
  if(m.type==='error'){toast(m.message);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;return;}
  if(m.type==='pong') {const rtt=Date.now()-m.sent;if(rtt<bestRTT+20){bestRTT=Math.min(bestRTT,rtt);clockOffset=m.serverTime-(m.sent+rtt/2);}return;}
  if(m.type==='typing'){if(m.active)typingPeople.set(m.from,{name:m.name,until:Date.now()+4500});else typingPeople.delete(m.from);renderTyping();return;}
  if(m.type==='resume-failed' || m.type==='ended' || m.type==='kicked'){sessionStorage.removeItem('xparty-owner-return');const msg=m.message||'This room expired. Create or join a room again.';leave(false);toast(msg);return;}
  if(m.type==='moderation'){toast(({mute:'The host muted your microphone.','allow-mic':'You can turn on your microphone again.','camera-off':'The host turned off your camera.','approve-camera':'Camera approved. Tap Camera to turn it on.','deny-camera':'Your camera request was declined.'})[m.action]);return;}
  if(m.type==='welcome') {
    for(const p of peers.values())closePeer(p);peers.clear();me=m.id;token=m.token;iceServers=m.iceServers;room=m.room;sessionStorage.setItem(SESSION,JSON.stringify({token,base}));
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
    room.playback=m.playback;activePlayback=m.playback;applyPlayback(m.type==='playback');return;
  }
  if(m.type==='chat'){addMessage(m);return;}
  if(m.type==='signal'){const peer=ensurePeer(m.from);if(peer) peer.queue=peer.queue.then(()=>receiveSignal(peer,m.signal)).catch(error=>{console.warn(error);toast('Call negotiation failed. Use reconnect ↻.');});}
}
function updateRoom(next) {
  const previous=room;room=next;activePlayback=room.playback;
  $('room-code').textContent=room.code;$('people-count').textContent=`${room.people.length}/${room.capacity}`;
  $('lock').hidden=room.hostId!==me;$('lock').textContent=t(room.locked?'Unlock room':'Lock room');$('lock').setAttribute('aria-checked',room.locked);$('capacity-control').hidden=room.hostId!==me;$('room-capacity').value=String(room.capacity);
  const host=room.hostId===me;
  $('youtube-input').disabled=false;$('load-video').disabled=false;$('end-room').hidden=!host;$('next-video').hidden=!host;$('file-input').disabled=!host;
  $('host-note').textContent='Search, queue and vote together · everyone can play, pause and seek';
  const self=room.people.find(p=>p.id===me);let removed=false;for(const track of localStream.getTracks()){if(!self?.inCall||(track.kind==='audio'&&self?.micBlocked)||(track.kind==='video'&&!host&&!self?.cameraAllowed)){track.stop();localStream.removeTrack(track);removed=true;}}if(removed)updateMedia();
  renderQueue();
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
    tile.querySelector('.moderation')?.remove();if(me===room.hostId&&!local){const menu=document.createElement('details');menu.className='moderation';const title=document.createElement('summary');title.textContent=person.cameraRequested?'Camera request ▾':'Manage ▾';menu.append(title);const action=(label,type,fields)=>{const b=document.createElement('button');b.textContent=t(label);b.onclick=()=>send(type,{target:person.id,...fields});menu.append(b);};action(person.micBlocked?'Allow mic':'Mute mic','moderate',{action:person.micBlocked?'allow-mic':'mute'});if(person.cameraRequested){action('Approve camera','moderate',{action:'approve-camera'});action('Deny camera','moderate',{action:'deny-camera'});}if(person.cameraAllowed)action('Turn camera off','moderate',{action:'camera-off'});if(person.online)action('Make host','transfer-host',{});if(person.id!==room.ownerId)action('Remove guest','kick',{});tile.append(menu);}
    if(room.source?.type==='file')tile.querySelector('.person-label small').textContent+=' · '+(person.ready?'Video ready':person.loadStatus||'Loading');
  }
  if(people.length===1){let empty=container.querySelector('[data-id="waiting"]');if(!empty){empty=document.createElement('div');empty.className='participant';empty.dataset.id='waiting';empty.innerHTML='<span class="avatar">+</span><div class="person-label"><span>Your person goes here</span><small>Share the room code</small></div>';container.append(empty);}}
  const connected=[...peers.values()].filter(p=>p.pc.connectionState==='connected').length;
  $('call-status').textContent=preview?'Design preview — no camera or microphone is active.':peers.size?`${connected}/${peers.size} peer connections ready · Your mic ${localStream.getAudioTracks().some(t=>t.enabled)?'is on':'is off'}`:'Share the code, then turn on your mic or camera.';
}
function ensurePeer(id) {
  if(preview || id===me || !room?.people.some(p=>p.id===id&&p.inCall)||!room?.people.some(p=>p.id===me&&p.inCall))return;
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection({iceServers});
  const p={id,pc,session:room.people.find(x=>x.id===id)?.session,stream:new MediaStream(),queue:Promise.resolve(),candidates:[],initiator:me.localeCompare(id)<0,sending:null,receive:null};peers.set(id,p);
  pc.onicecandidate=e=>{if(e.candidate)send('signal',{to:id,signal:{candidate:e.candidate}});};
  pc.ontrack=e=>{if(!p.stream.getTracks().some(t=>t.id===e.track.id))p.stream.addTrack(e.track);renderPeople();};
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
    movieGain.gain.value=movieVolume;filePlayer.volume=1;
    $('enable-audio').textContent=t('Sound enabled');
  }catch{filePlayer.volume=movieVolume;toast('Use your device sound controls if the volume sliders are restricted.');}
}
function attachRemoteAudio(p,video) {
  if(!p.stream.getAudioTracks().length)return;
  if(audioContext && !p.audioSource){p.audioSource=audioContext.createMediaStreamSource(p.stream);p.gain=audioContext.createGain();p.gain.gain.value=callVolume;p.audioSource.connect(p.gain).connect(audioContext.destination);p.fallbackAudio?.remove();p.fallbackAudio=null;}
  else if(!audioContext && !p.fallbackAudio){const a=document.createElement('audio');a.srcObject=p.stream;a.autoplay=true;a.volume=callVolume;p.fallbackAudio=a;document.body.append(a);a.play().catch(()=>toast('Tap Enable sound to hear the call.'));}
}
async function toggleMedia(kind) {
  if(preview)return toast('Create a room to start a call.');if(busyMedia)return;
  const self=room?.people.find(p=>p.id===me);if(!self?.inCall)return toast('Join a call seat first. Up to four people can call.');if(kind==='audio'&&self?.micBlocked)return toast('The host has muted your microphone.');if(kind==='video'&&room?.hostId!==me&&!self?.cameraAllowed){send('request-camera');return toast('Camera request sent to the host.');}
  busyMedia=true;$('mic').disabled=true;$('camera').disabled=true;
  try {
    await unlockAudio();let track=localStream.getTracks().find(t=>t.kind===kind);
    if(track){track.stop();localStream.removeTrack(track);}else{
      const stream=await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:preferences.echo,noiseSuppression:preferences.noise,autoGainControl:true},video:false}:{video:{width:{ideal:preferences.quality==='saver'?240:360},height:{ideal:preferences.quality==='saver'?320:480},frameRate:{ideal:15,max:15},facingMode:'user'},audio:false});
      track=stream.getTracks()[0];localStream.addTrack(track);track.onended=()=>{localStream.removeTrack(track);updateMedia();};
    }
    await updateMedia();
  }catch(e){console.warn('Media permission or track error', e.name, e.message);toast(e.name==='NotAllowedError'?'Allow camera/microphone access in your browser, then try again.':'Camera or microphone is unavailable. Check permissions and whether another app is using it.');}
  finally{busyMedia=false;$('mic').disabled=false;$('camera').disabled=false;}
}
async function updateMedia(){
  await Promise.all([...peers.values()].map(replaceTracks));
  const mic=localStream.getAudioTracks().length>0,camera=localStream.getVideoTracks().length>0;
  $('mic').textContent=t(mic?'Mic on':'Mic off');$('mic').setAttribute('aria-pressed',mic);$('camera').textContent=t(camera?'Camera on':'Camera off');$('camera').setAttribute('aria-pressed',camera);
  send('media',{mic,camera});renderPeople();
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
  buffering=false;settleUntil=0;fileJob?.abort();downloadId=null;loadedFileId=null;readySent=null;sourceId=source?.id||null;appliedRevision=-1;suppressUntil=Date.now()+1400;lastCorrected=0;
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();
  
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  $('transfer').hidden=true;$('empty-player').hidden=!!source;$('youtube-wrap').hidden=source?.type!=='youtube';filePlayer.hidden=source?.type!=='file';
  if(!source){$('video-title').textContent='Choose something you’ll both love';status('Waiting for a video');return;}
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
    function init(){yt=new YT.Player('youtube-player',{width:'100%',height:'100%',playerVars:{playsinline:1,controls:1,rel:0,origin:location.origin},events:{onReady:()=>{clearTimeout(timeout);ytReady=true;resolve();},onStateChange:youtubeEvent,onError:e=>{status('Video unavailable');toast('YouTube cannot embed this video ('+e.data+'). Try another video.');},onAutoplayBlocked:()=>{toast('Tap Play to allow video and sound on this device.');}}});}
    if(window.YT?.Player)init();else{window.onYouTubeIframeAPIReady=init;const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timeout);reject(new Error('YouTube blocked'));};document.head.append(script);}
  });ytPromise.catch(()=>{ytPromise=null;});return ytPromise;
}
function currentTime(){return room?.source?.type==='youtube'?(ytReady?yt.getCurrentTime()||0:0):filePlayer.currentTime||0;}
function duration(){return room?.source?.type==='youtube'?(ytReady?yt.getDuration()||0:0):(Number.isFinite(filePlayer.duration)?filePlayer.duration:0);}
function isPlaying(){return room?.source?.type==='youtube'?ytReady&&yt.getPlayerState()===1:!filePlayer.paused&&!filePlayer.ended;}
function youtubeEvent(e){
  if(room?.source?.type!=='youtube')return;
  if(e.data===3){buffering=true;status('Buffering locally');return;}
  if(buffering&&e.data===1){buffering=false;settleUntil=Date.now()+1800;suppressUntil=settleUntil;return;}
  if(Date.now()<suppressUntil)return;
  if(e.data===0&&room.hostId===me&&room.queue?.length){send('next');return;}
  if(e.data===1 || e.data===2 || e.data===0){const playing=e.data===1;if(activePlayback?.playing!==playing)command(playing,currentTime());}
}
function command(playing, position=currentTime()) {
  if(!room?.source || preview)return toast('Add a video in a live room first.');
  suppressUntil=Date.now()+1100;lastSeek=Date.now();send('playback',{sourceId,playing,position:Math.max(0,position)});
}
function applyPlayback(force=false) {
  if(!room?.source || !activePlayback || preview)return;
  if(room.source.type==='youtube' && !ytReady)return;
  if(room.source.type==='file' && filePlayer.readyState<1)return;
  const p=activePlayback;let target=targetPosition(p,Date.now()+clockOffset);const total=duration();if(total>0)target=Math.min(target,total);
  const commandChanged=p.revision!==appliedRevision;
  if(commandChanged){suppressUntil=Date.now()+1000;appliedRevision=p.revision;}
  const diff=target-currentTime();
  // Seeking during YouTube buffering restarts loading. Preserve explicit commands,
  // but defer automatic corrections until the player has resumed and settled.
  if(room.source.type==='youtube'&&p.playing&&!commandChanged&&!force&&(yt.getPlayerState()===3||Date.now()<settleUntil))return;
  const mode=correction(diff,commandChanged || force,Date.now()-lastCorrected);
  if(mode==='seek'){ suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.seekTo(target,true);else filePlayer.currentTime=target;lastCorrected=Date.now();}
  if(room.source.type==='file')filePlayer.playbackRate=p.playing&&mode==='rate'?Math.max(.95,Math.min(1.05,1+diff*.025)):1;
  if(p.playing && !isPlaying()){
    // A buffering YouTube player must finish buffering without repeated play/seek commands.
    if(room.source.type==='youtube'){if(yt.getPlayerState()!==3){suppressUntil=Date.now()+1000;yt.playVideo();}}
    else{suppressUntil=Date.now()+1000;filePlayer.play().catch(()=>toast('Tap Play or Enable sound to allow playback.'));}
  }else if(!p.playing && isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.pauseVideo();else filePlayer.pause();}
  $('play').textContent=t(p.playing?'Pause':'Play');status(p.playing?(Math.abs(diff)<.75?'Playing together':'Aligning playback'):'Paused together');
}
function tick(){
  if(!room?.source || preview)return;
  const cur=currentTime(),total=duration();$('time').textContent=formatTime(cur)+' / '+formatTime(total);
  if(document.activeElement!==$('seek'))$('seek').value=total?cur/total*1000:0;
  
  if(Date.now()>suppressUntil){
    // Capture native YouTube seek gestures without treating ordinary clock drift as user input.
    if(room.source.type==='youtube' && ytReady && tick.source===sourceId && tick.previous!=null && Date.now()-lastSeek>1500){const elapsed=(Date.now()-tick.at)/1000;const jump=cur-tick.previous-(isPlaying()?elapsed:0);if(Math.abs(jump)>2.5 && Date.now()-lastCorrected>2000 && yt.getPlayerState()!==3)command(isPlaying(),cur);}
    applyPlayback(false);
  }
  tick.previous=cur;tick.at=Date.now();tick.source=sourceId;
}
function formatTime(s){s=Math.floor(s||0);return (s>=3600?Math.floor(s/3600)+':':'')+String(Math.floor(s/60)%60).padStart(s>=3600?2:1,'0')+':'+String(s%60).padStart(2,'0');}
function chatIsVisible(){return !$('room').hidden&&(!document.body.classList.contains('cinema')||chatVisible);}
function updateUnread(){$('chat-unread').hidden=!unread;$('chat-unread').textContent=unread>99?'99+':String(unread);}
function addMessage(m,live=true){typingPeople.delete(m.from);renderTyping();const welcome=$('messages').querySelector('.chat-welcome');welcome?.remove();const el=document.createElement('div');el.className='message'+(m.from===me?' mine':'')+(m.to?' private':'');const name=document.createElement('small');name.textContent=m.name+(m.to?' → '+m.toName+' · Private':'')+' · '+new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});const text=document.createElement('p');text.textContent=m.text;el.append(name,text);$('messages').append(el);while($('messages').children.length>200)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;if(live&&m.from!==me&&!chatIsVisible()){unread++;updateUnread();}}
function renderTyping(){for(const[id,p]of typingPeople)if(p.until<Date.now())typingPeople.delete(id);const names=[...typingPeople.values()].map(p=>p.name);$('typing').hidden=!names.length;$('typing').querySelector('span').textContent=names.slice(0,2).join(', ')+(names.length>2?' +'+(names.length-2):'')+(preferences.language==='hi'?' लिख रहे हैं':preferences.language==='kn'?' ಟೈಪ್ ಮಾಡುತ್ತಿದ್ದಾರೆ':' typing');}
function setRecipient(person){if(recipient)send('typing',{active:false,to:recipient.id});recipient=person;$('recipient-chip').hidden=!person;$('recipient-chip').querySelector('span').textContent=person?'Private → '+person.name:'';$('mentions').hidden=true;$('message-input').placeholder=person?'Message '+person.name:'Message everyone · @ for private';}
function showMentions(){const value=$('message-input').value;const match=value.match(/(?:^|\s)@([^@]*)$/);if(!match){$('mentions').hidden=true;return;}const list=(room?.people||[]).filter(p=>p.id!==me&&p.name.toLowerCase().includes(match[1].toLowerCase()));$('mentions').replaceChildren();for(const p of list){const button=document.createElement('button');button.type='button';button.setAttribute('role','option');button.textContent=p.name;button.onclick=()=>{send('typing',{active:false,to:recipient?.id});setRecipient(p);$('message-input').value=value.slice(0,match.index).trim();$('message-input').focus();};$('mentions').append(button);}$('mentions').hidden=!list.length;}
function renderMembers(){const container=$('member-list');container.replaceChildren();for(const person of room.people){const row=document.createElement('div');row.className='member-row';const label=document.createElement('span');label.textContent=person.name+(person.id===room.hostId?' · Host':'')+(person.online?'':' · Away');row.append(label);if(person.id!==me){const dm=document.createElement('button');dm.textContent='@';dm.className='secondary';dm.title='Private message';dm.onclick=()=>{setRecipient(person);chatVisible=true;updateTheatre();$('room').hidden=false;$('lobby').hidden=true;$('message-input').focus();};row.append(dm);if(me===room.hostId){const menu=document.createElement('select');menu.setAttribute('aria-label','Manage '+person.name);menu.innerHTML='<option value="">Manage…</option>';const actions=[[person.micBlocked?'allow-mic':'mute',person.micBlocked?'Allow mic':'Mute mic'],['approve-camera','Approve camera'],['camera-off','Turn camera off']];if(person.online)actions.push(['transfer-host','Make host']);if(person.id!==room.ownerId)actions.push(['kick','Remove guest']);for(const[value,text]of actions){const option=document.createElement('option');option.value=value;option.textContent=t(text);menu.append(option);}menu.onchange=()=>{const action=menu.value;if(['kick','transfer-host'].includes(action))send(action,{target:person.id});else if(action)send('moderate',{target:person.id,action});menu.value='';};row.append(menu);}}container.append(row);}}
function updateTheatre(){document.body.classList.toggle('show-vc',vcVisible);document.body.classList.toggle('show-chat',chatVisible);$('toggle-vc').setAttribute('aria-pressed',vcVisible);$('toggle-chat').setAttribute('aria-pressed',chatVisible);if(chatVisible){unread=0;updateUnread();requestAnimationFrame(()=>$('messages').scrollTop=$('messages').scrollHeight);}}
function setTheatre(enabled){document.body.classList.toggle('cinema',enabled);document.body.classList.remove('browsing');if(enabled){vcVisible=false;chatVisible=false;}$('room-menu').open=false;updateTheatre();if(!enabled){unread=0;updateUnread();}}
function leave(notify=true){
  $('room-menu').open=false;
  if(notify&&room?.ownerId===me)sessionStorage.setItem('xparty-owner-return',JSON.stringify({code:room.code,token,base}));else if(!notify)sessionStorage.removeItem('xparty-owner-return');
  intentionalClose=true;clearTimeout(reconnectTimer);clearTimeout(connectTimer);if(notify&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'leave'}));socket?.close();
  sessionStorage.removeItem(SESSION);fileJob?.abort();loadedFileId=null;downloadId=null;readySent=null;token=null;for(const p of peers.values())closePeer(p);peers.clear();localStream.getTracks().forEach(t=>t.stop());localStream=new MediaStream();
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;ownedFile=null;pendingFile=null;ownedFileId=null;
  recipient=null;typingPeople.clear();renderTyping();unread=0;updateUnread();$('recipient-chip').hidden=true;$('return-room').hidden=true;document.querySelector('.entry-card').hidden=false;room=null;me=null;sourceId=null;activePlayback=null;preview=false;$('room').hidden=true;$('lobby').hidden=false;$('demo-banner').hidden=true;$('participants').replaceChildren();
  $('mic').textContent=t('Mic off');$('mic').setAttribute('aria-pressed',false);$('camera').textContent=t('Camera off');$('camera').setAttribute('aria-pressed',false);$('network').lastChild.textContent=' Private watch rooms';document.body.classList.remove('cinema');$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
}
$('create-toggle').onclick=()=>{$('create-details').hidden=false;$('create-toggle').setAttribute('aria-expanded','true');$('create-toggle').classList.add('dimmed');$('create-toggle').disabled=true;$('name').focus();};
$('end-room').onclick=()=>{if(confirm('End this room for everyone?'))send('end-room');};
$('stop').onclick=()=>command(false,0);
$('resync').onclick=()=>{send('resync');if(room?.source?.type==='file'){if(filePlayer.readyState>=1){readySent=null;fileReady();}else ensureFile();}toast('Aligning with room playback…');};
$('browse').onclick=()=>{document.body.classList.add('browsing');$('source-panel').scrollIntoView({behavior:'smooth',block:'start'});$('youtube-input').focus({preventScroll:true});};
$('back-video').onclick=()=>{document.body.classList.remove('browsing');$('watch-stage').scrollIntoView({behavior:'smooth'});};
$('next-video').onclick=()=>send('next');
$('create').onclick=()=>connect({type:'create',name:$('name').value,capacity:Number($('capacity').value)});
$('join-form').onsubmit=e=>{e.preventDefault();const code=$('code').value.trim().toUpperCase();let owner;try{owner=JSON.parse(sessionStorage.getItem('xparty-owner-return')||'null');}catch{}connect(owner?.code===code&&owner.base===base?{type:'resume',token:owner.token}:{type:'join',name:'',code});};
$('code').oninput=()=>{$('code').value=$('code').value.toUpperCase().replace(/[^A-Z2-9]/g,'');};
$('leave').onclick=()=>leave();$('lock').onclick=()=>send('lock',{locked:!room.locked});
$('copy').onclick=async()=>{if(preview)return toast('Preview code only. Create a live room for an invitation.');try{await navigator.clipboard.writeText(room.code);toast('Room code copied. Share it privately.');}catch{toast('Your room code: '+room.code);}};
$('mic').onclick=()=>toggleMedia('audio');$('camera').onclick=()=>toggleMedia('video');
$('retry-call').onclick=()=>{for(const p of peers.values()){if(p.initiator)p.pc.restartIce();else send('signal',{to:p.id,signal:{restart:true}});}toast('Reconnecting peer connections…');};
$('enable-audio').onclick=async()=>{await unlockAudio();if(activePlayback?.playing)applyPlayback(true);};
$('movie-volume').oninput=e=>{movieVolume=Number(e.target.value)/100;$('movie-level').textContent=e.target.value+'%';if(movieGain)movieGain.gain.value=movieVolume;else filePlayer.volume=movieVolume;if(ytReady)yt.setVolume(movieVolume*100);};
$('call-volume').oninput=e=>{callVolume=Number(e.target.value)/100;$('call-level').textContent=e.target.value+'%';for(const p of peers.values()){if(p.gain)p.gain.gain.value=callVolume;if(p.fallbackAudio)p.fallbackAudio.volume=callVolume;}};
$('chat-form').onsubmit=e=>{e.preventDefault();const text=$('message-input').value.trim();if(!text)return;if(!recipient&&/(?:^|\s)@/.test(text)){showMentions();return toast('Choose a participant from the @ list, or remove @ to message everyone.');}if(send('chat',{text,to:recipient?.id})){send('typing',{active:false,to:recipient?.id});$('message-input').value='';$('mentions').hidden=true;clearTimeout(typingTimer);}};
$('play').onclick=async()=>{await unlockAudio();if(!room?.source)return toast('Add a video first.');if(activePlayback?.playing&&!isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')ytReady&&yt.playVideo();else filePlayer.play().catch(()=>toast('Unable to play this file on this device.'));applyPlayback(true);}else command(!activePlayback?.playing);};
$('back10').onclick=()=>command(activePlayback?.playing||false,currentTime()-10);$('forward10').onclick=()=>command(activePlayback?.playing||false,Math.min(duration(),currentTime()+10));
$('seek').onchange=()=>command(activePlayback?.playing||false,Number($('seek').value)/1000*duration());
$('theater').onclick=()=>setTheatre(!document.body.classList.contains('cinema'));$('exit-theatre').onclick=()=>setTheatre(false);$('toggle-vc').onclick=()=>{vcVisible=!vcVisible;updateTheatre();};$('toggle-chat').onclick=()=>{chatVisible=!chatVisible;updateTheatre();};
$('youtube-tab').onclick=()=>{$('youtube-form').hidden=false;$('file-form').hidden=true;$('youtube-tab').classList.add('active');$('file-tab').classList.remove('active');};
$('file-tab').onclick=()=>{$('youtube-form').hidden=true;$('file-form').hidden=false;$('file-tab').classList.add('active');$('youtube-tab').classList.remove('active');$('search-results').replaceChildren();};
function renderQueue(){const container=$('queue');container.replaceChildren();const items=[...(room?.queue||[])].sort((a,b)=>b.votes.length-a.votes.length||a.createdAt-b.createdAt);if(!items.length){container.textContent='Add videos below or search above. The most-voted video plays next.';return;}for(const item of items){const row=document.createElement('div');row.className='queue-item';const title=document.createElement('span');title.textContent=item.title;row.append(title);const vote=document.createElement('button');vote.className='secondary';vote.textContent='▲ '+item.votes.length;vote.setAttribute('aria-pressed',item.votes.includes(me));vote.onclick=()=>send('vote',{id:item.id});row.append(vote);if(room.hostId===me){for(const [label,type]of [['Play','queue-play'],['×','queue-remove']]){const b=document.createElement('button');b.className='quiet';b.textContent=label;b.onclick=()=>send(type,{id:item.id});row.append(b);}}container.append(row);}}
function searchResult(item){const row=document.createElement('div');row.className='result';const img=document.createElement('img');img.src=item.thumbnail||'https://i.ytimg.com/vi/'+item.id+'/mqdefault.jpg';img.alt='';const title=document.createElement('span');title.textContent=item.title+(item.channel?' · '+item.channel:'');row.append(img,title);const actions=document.createElement('div');if(room.hostId===me){const play=document.createElement('button');play.className='primary';play.textContent=t('Play now');play.onclick=()=>{send('source',{source:{type:'youtube',videoId:item.id,title:item.title}});$('watch-stage').scrollIntoView({behavior:'smooth'});};actions.append(play);}const add=document.createElement('button');add.className='secondary';add.textContent=t('+ Queue');add.onclick=()=>{send('queue-add',{videoId:item.id,title:item.title});toast('Added to the room playlist.');};actions.append(add);row.append(actions);$('search-results').append(row);}
$('youtube-form').onsubmit=async e=>{
 e.preventDefault();if(preview)return toast('Create a room to add a video.');const value=$('youtube-input').value.trim(),id=youtubeId(value);$('search-results').replaceChildren();if(id){searchResult({id,title:'YouTube · '+id});$('search-status').textContent='Play this link now or add it to the playlist.';return;}if(value.length<2)return toast('Enter a video title or paste a YouTube link.');$('load-video').disabled=true;$('search-status').textContent='Searching YouTube…';
 try{const res=await fetch(base+'/api/search?q='+encodeURIComponent(value),{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Search unavailable.');for(const item of data.items)searchResult(item);$('search-status').textContent=data.items.length?'Choose a video or keep browsing while it plays.':'No videos found. Try another search.';}catch(e){$('search-status').textContent=e.message;}finally{$('load-video').disabled=false;}
};
$('file-input').onchange=()=>{const f=$('file-input').files[0];if(!f)return;if(preview)return toast('Create a room to share a file.');if(f.size>MAX_FILE || !f.size){$('file-input').value='';return toast('Choose a video smaller than 250 MB. Large movie transfer is not included in this first build.');}const mime=f.type||(/\.mp4$/i.test(f.name)?'video/mp4':/\.webm$/i.test(f.name)?'video/webm':'');if(!mime.startsWith('video/'))return toast('Choose a supported video file such as MP4 or WebM.');pendingFile=f;send('source',{source:{type:'file',title:f.name,size:f.size,mime}});$('file-input').value='';};
filePlayer.onloadedmetadata=fileReady;filePlayer.oncanplay=fileReady;
filePlayer.onerror=()=>{if(room?.source?.type==='file' && filePlayer.getAttribute('src')){readySent=null;send('ready',{sourceId,ready:false,status:'Unsupported video format'});toast('This device cannot decode the file. Try an MP4 with H.264 video and AAC audio.');}};
filePlayer.onended=()=>{if(room?.source?.type==='file' && me===room.hostId)command(false,currentTime());};
$('preview').onclick=()=>{preview=true;me='preview-host';$('lobby').hidden=true;$('room').hidden=false;$('demo-banner').hidden=false;notice('');updateRoom({code:'PREVIEW',hostId:me,capacity:2,locked:false,source:null,playback:{position:0,playing:false,updatedAt:Date.now(),revision:0},people:[{id:me,name:'You',online:true,mic:false,camera:false},{id:'preview-guest',name:'Your friend',online:true,mic:false,camera:false}]});};
setInterval(tick,250);setInterval(ping,5000);
window.addEventListener('pagehide',()=>{if(socket?.readyState===WebSocket.OPEN)socket.close();localStream.getTracks().forEach(t=>t.stop());});
if(location.hostname.endsWith('github.io')&&!window.XPARTY_CONFIG?.backendUrl)$('setup-notice').hidden=false;

try{const saved=JSON.parse(sessionStorage.getItem(SESSION)||'null');if(saved?.token&&saved.base===base){token=saved.token;$('setup-notice').hidden=false;$('setup-notice').textContent='Rejoining your room…';connect({type:'resume',token});}}catch{}

$('clear-recipient').onclick=()=>setRecipient(null);
$('message-input').oninput=()=>{showMentions();const active=!!$('message-input').value.trim();if(Date.now()-lastTyping>1500||!active){send('typing',{active,to:recipient?.id});lastTyping=Date.now();}clearTimeout(typingTimer);typingTimer=setTimeout(()=>send('typing',{active:false,to:recipient?.id}),2500);};
$('message-input').onkeydown=e=>{if(e.key==='Escape'){$('mentions').hidden=true;}if(e.key==='ArrowDown'&&!$('mentions').hidden){e.preventDefault();$('mentions').querySelector('button')?.focus();}};
$('room-capacity').onchange=()=>send('capacity',{capacity:Number($('room-capacity').value)});
$('call-seat').onclick=()=>send(room?.people.find(p=>p.id===me)?.inCall?'call-leave':'call-join');
$('nav-home').onclick=()=>{setTheatre(false);$('room').hidden=true;$('lobby').hidden=false;document.querySelector('.entry-card').hidden=!!room;$('return-room').hidden=!room;};
$('return-room').onclick=()=>{$('lobby').hidden=true;$('room').hidden=false;$('return-room').hidden=true;unread=0;updateUnread();};
for(const [button,dialog]of [['nav-settings','settings-dialog'],['theatre-settings','settings-dialog'],['nav-about','about-dialog']])$(button).onclick=()=>$(dialog).showModal();
for(const dialog of document.querySelectorAll('dialog'))dialog.querySelector('.close-dialog').onclick=()=>dialog.close();
function populateSettings(){$('theme-select').value=preferences.theme;$('language-select').value=preferences.language;$('noise-setting').checked=preferences.noise;$('echo-setting').checked=preferences.echo;$('quality-select').value=preferences.quality;}
async function applyCallSettings(){for(const track of localStream.getAudioTracks())try{await track.applyConstraints({noiseSuppression:preferences.noise,echoCancellation:preferences.echo,autoGainControl:true});}catch{toast('This browser could not change audio processing during the call. Toggle your mic to retry.');}for(const track of localStream.getVideoTracks())try{await track.applyConstraints({width:{ideal:preferences.quality==='saver'?240:360},height:{ideal:preferences.quality==='saver'?320:480},frameRate:{ideal:15,max:15}});}catch{}await Promise.all([...peers.values()].map(replaceTracks));}
for(const [id,key]of [['theme-select','theme'],['language-select','language'],['noise-setting','noise'],['echo-setting','echo'],['quality-select','quality']])$(id).onchange=()=>{preferences[key]=$(id).type==='checkbox'?$(id).checked:$(id).value;savePreferences();if(room)updateRoom(room);applyCallSettings();};
$('reset-settings').onclick=()=>{resetPreferences();populateSettings();if(room)updateRoom(room);applyCallSettings();};populateSettings();
setInterval(renderTyping,1000);

for(const kind of ['movie','call']){$('settings-'+kind+'-volume').oninput=e=>{$(kind+'-volume').value=e.target.value;$(kind+'-volume').dispatchEvent(new Event('input'));};$(kind+'-volume').addEventListener('input',e=>$('settings-'+kind+'-volume').value=e.target.value);}$('settings-enable-audio').onclick=()=>$('enable-audio').click();
