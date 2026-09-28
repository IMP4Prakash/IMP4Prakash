import {youtubeId, targetPosition, correction} from './sync.js';
const $ = id => document.getElementById(id);
const MAX_FILE = 250 * 1024 * 1024;
let base = (window.XPARTY_CONFIG?.backendUrl || location.origin).replace(/\/$/,'');
let socket, me, token, room, preview = false, intentionalClose = false, reconnectTimer, connectTimer;
let iceServers=[], peers=new Map(), localStream=new MediaStream(), yt, ytReady=false, ytPromise;
let sourceId=null, pendingFile=null, ownedFile=null, ownedFileId=null, objectUrl=null, activePlayback;
let suppressUntil=0, lastCorrected=0, appliedRevision=-1, clockOffset=0, bestRTT=Infinity, lastAnchor=0, lastSeek=0;
let audioContext, movieGain, movieAudio, callVolume=1, movieVolume=.7, busyMedia=false;
const filePlayer=$('file-player');
function toast(text) { $('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500); }
function status(text) {$('sync-status').lastChild.textContent=' '+text;}
function notice(text) {$('connection-notice').textContent=text;$('connection-notice').hidden=!text;}
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
  ws.onclose=()=>{
    clearTimeout(connectTimer);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
    if(ws!==socket)return;
    if(!intentionalClose && token && room){notice('Connection interrupted. Reconnecting to your room…');reconnectTimer=setTimeout(()=>connect({type:'resume',token}),1800);}
    else if(!intentionalClose){$('setup-notice').hidden=false;}
  };
}
function handle(m) {
  if(m.type==='error'){toast(m.message);$('create').disabled=false;$('join-form').querySelector('button').disabled=false;return;}
  if(m.type==='pong') {const rtt=Date.now()-m.sent;if(rtt<bestRTT+20){bestRTT=Math.min(bestRTT,rtt);clockOffset=m.serverTime-(m.sent+rtt/2);}return;}
  if(m.type==='resume-failed' || m.type==='ended'){const msg=m.message||'This room expired. Create or join a room again.';leave(false);toast(msg);return;}
  if(m.type==='welcome') {
    for(const p of peers.values())closePeer(p);peers.clear();me=m.id;token=m.token;iceServers=m.iceServers;room=m.room;
    $('lobby').hidden=true;$('room').hidden=false;$('demo-banner').hidden=true;
    $('setup-notice').hidden=true;$('network').lastChild.textContent=' Room connected';
    notice(m.hasRelay?'':'Direct calls are available. A relay is not configured, so calls and file transfer may fail across some networks.');
    $('youtube-input').placeholder=m.searchEnabled?'Paste a YouTube link or search for a video':'Paste a YouTube video link';
    $('messages').innerHTML='<div class="chat-welcome"><span>✧</span><strong>A little space for you.</strong><p>Say hello. This conversation stays in this room.</p></div>';
    updateRoom(m.room);return;
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
  $('lock').hidden=room.hostId!==me;$('lock').textContent=room.locked?'Unlock room':'Lock room';
  const host=room.hostId===me;
  $('youtube-input').disabled=!host;$('load-video').disabled=!host;$('file-input').disabled=!host;
  $('host-note').textContent=host?'Host chooses the video · everyone can control playback':'Your host chooses the video · you can play, pause and seek';
  for(const [id,p]of peers) {const person=room.people.find(x=>x.id===id);if(!person?.online){closePeer(p);peers.delete(id);}}
  if(!preview)for(const person of room.people)if(person.id!==me && person.online)ensurePeer(person.id);
  renderPeople();
  if(room.source?.id!==sourceId) applySource(room.source);
  else if(room.source) applyPlayback(false);
  if(room.source?.type==='file' && room.people.every(p=>p.ready)){$('transfer-label').textContent='Everyone has the file. Ready to play together.';status('Ready together');}
}
function renderPeople() {
  const people=room?.people||[];const container=$('participants');
  for(const child of [...container.children])if(!people.some(p=>child.dataset.id===p.id))child.remove();
  for(const person of people) {
    let tile=[...container.children].find(el=>el.dataset.id===person.id);
    if(!tile){tile=document.createElement('div');tile.className='participant';tile.dataset.id=person.id;tile.innerHTML='<span class="avatar"></span><video autoplay playsinline muted hidden></video><div class="person-label"><span></span><small></small></div>';container.append(tile);}
    tile.querySelector('.avatar').textContent=person.name.charAt(0).toUpperCase();
    tile.querySelector('.person-label>span').textContent=person.name+(person.id===me?' · You':'')+(person.id===room.hostId?' · Host':'');
    const p=peers.get(person.id), local=person.id===me;
    const state=local?'Here':!person.online?'Reconnecting':p?.pc.connectionState==='connected'?'Connected':preview?'Preview':'Connecting';
    tile.querySelector('.person-label small').textContent=state+' · '+(person.mic?'Mic on':'Mic off');
    const video=tile.querySelector('video');const stream=local?localStream:p?.stream;
    if(stream && video.srcObject!==stream){video.srcObject=stream;video.play().catch(()=>{});}
    video.muted=true;video.hidden=!person.camera; // Audio is mixed independently through Web Audio.
    if(!local && p)attachRemoteAudio(p,video);
  }
  if(people.length===1){let empty=container.querySelector('[data-id="waiting"]');if(!empty){empty=document.createElement('div');empty.className='participant';empty.dataset.id='waiting';empty.innerHTML='<span class="avatar">+</span><div class="person-label"><span>Your person goes here</span><small>Share the room code</small></div>';container.append(empty);}}
  const connected=[...peers.values()].filter(p=>p.pc.connectionState==='connected').length;
  $('call-status').textContent=preview?'Design preview — no camera or microphone is active.':peers.size?`${connected}/${peers.size} peer connections ready · Your mic ${localStream.getAudioTracks().some(t=>t.enabled)?'is on':'is off'}`:'Share the code, then turn on your mic or camera.';
}
function ensurePeer(id) {
  if(preview || id===me || !room?.people.some(p=>p.id===id))return;
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection({iceServers});
  const p={id,pc,stream:new MediaStream(),queue:Promise.resolve(),candidates:[],initiator:me.localeCompare(id)<0,sending:null,receive:null};peers.set(id,p);
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
    if(kind==='video' && track){try{const params=t.sender.getParameters();params.encodings??=[{}];params.encodings[0].maxBitrate=450000;await t.sender.setParameters(params);}catch{}}
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
    $('enable-audio').textContent='Sound enabled';
  }catch{filePlayer.volume=movieVolume;toast('Use your device sound controls if the volume sliders are restricted.');}
}
function attachRemoteAudio(p,video) {
  if(!p.stream.getAudioTracks().length)return;
  if(audioContext && !p.audioSource){p.audioSource=audioContext.createMediaStreamSource(p.stream);p.gain=audioContext.createGain();p.gain.gain.value=callVolume;p.audioSource.connect(p.gain).connect(audioContext.destination);p.fallbackAudio?.remove();p.fallbackAudio=null;}
  else if(!audioContext && !p.fallbackAudio){const a=document.createElement('audio');a.srcObject=p.stream;a.autoplay=true;a.volume=callVolume;p.fallbackAudio=a;document.body.append(a);a.play().catch(()=>toast('Tap Enable sound to hear the call.'));}
}
async function toggleMedia(kind) {
  if(preview)return toast('Create a room to start a call.');if(busyMedia)return;
  busyMedia=true;$('mic').disabled=true;$('camera').disabled=true;
  try {
    await unlockAudio();let track=localStream.getTracks().find(t=>t.kind===kind);
    if(track){track.stop();localStream.removeTrack(track);}else{
      const stream=await navigator.mediaDevices.getUserMedia(kind==='audio'?{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}:{video:{width:{ideal:480},height:{ideal:270},frameRate:{ideal:15,max:24},facingMode:'user'},audio:false});
      track=stream.getTracks()[0];localStream.addTrack(track);track.onended=()=>{localStream.removeTrack(track);updateMedia();};
    }
    await updateMedia();
  }catch(e){console.warn('Media permission or track error', e.name, e.message);toast(e.name==='NotAllowedError'?'Allow camera/microphone access in your browser, then try again.':'Camera or microphone is unavailable. Check permissions and whether another app is using it.');}
  finally{busyMedia=false;$('mic').disabled=false;$('camera').disabled=false;}
}
async function updateMedia(){
  await Promise.all([...peers.values()].map(replaceTracks));
  const mic=localStream.getAudioTracks().length>0,camera=localStream.getVideoTracks().length>0;
  $('mic').textContent=mic?'Mic on':'Mic off';$('mic').setAttribute('aria-pressed',mic);$('camera').textContent=camera?'Camera on':'Camera off';$('camera').setAttribute('aria-pressed',camera);
  send('media',{mic,camera});renderPeople();
}
function setupChannel(p,dc) {
  p.dc=dc;dc.binaryType='arraybuffer';dc.bufferedAmountLowThreshold=65536;
  dc.onopen=()=>{renderPeople();if(room?.source?.type==='file')requestFile(p);};
  dc.onclose=()=>{p.receive=null;p.sending=null;};
  dc.onerror=()=>toast('The direct file connection failed. Try reconnecting.');
  dc.onmessage=e=>{
    if(typeof e.data==='string') {
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(m.type==='request-file'){if(me===room?.hostId && m.id===ownedFileId)sendFile(p);return;}
      if(m.type==='file-start') {
        const s=room?.source;
        if(p.id!==room?.hostId || s?.type!=='file' || m.id!==s.id || m.size!==s.size || m.size>MAX_FILE)return;
        p.receive={id:m.id,size:m.size,mime:s.mime,parts:[],bytes:0};transfer('Receiving '+s.title,0);return;
      }
      if(m.type==='file-end' && p.receive?.id===m.id) {
        const r=p.receive;p.receive=null;if(r.bytes!==r.size || r.id!==room?.source?.id)return toast('File transfer was incomplete. Ask the host to share it again.');
        setFileBlob(new Blob(r.parts,{type:r.mime}));transfer('File received. Loading video…',100);return;
      }
      if(m.type==='file-cancel')p.receive=null;
    }else if(p.receive){const r=p.receive;if(r.id!==room?.source?.id){p.receive=null;return;}r.bytes+=e.data.byteLength;if(r.bytes>r.size){p.receive=null;return;}r.parts.push(e.data);transfer('Receiving '+room.source.title,100*r.bytes/r.size);}
  };
}
function requestFile(p) {
  if(p.dc?.readyState!=='open' || room?.source?.type!=='file')return;
  if(me===room.hostId)sendFile(p);else if(p.id===room.hostId)p.dc.send(JSON.stringify({type:'request-file',id:sourceId}));
}
function transfer(text,percent){$('transfer').hidden=false;$('transfer-label').textContent=text;$('transfer-progress').value=percent;}
async function sendFile(p) {
  const file=ownedFile,id=ownedFileId,dc=p.dc;
  if(!file || id!==sourceId || dc?.readyState!=='open' || p.sending===id)return;
  p.sending=id;
  try{
    dc.send(JSON.stringify({type:'file-start',id,size:file.size}));
    for(let offset=0;offset<file.size;offset+=16384){
      if(p.sending!==id || id!==sourceId || dc.readyState!=='open')return;
      while(dc.bufferedAmount>262144){await new Promise(r=>setTimeout(r,30));if(p.sending!==id||id!==sourceId||dc.readyState!=='open')return;}
      const chunk=await file.slice(offset,offset+16384).arrayBuffer();if(id!==sourceId||p.sending!==id)return;
      dc.send(chunk);transfer('Sending to '+(room.people.find(x=>x.id===p.id)?.name||'guest'),Math.min(100,(offset+chunk.byteLength)*100/file.size));
    }
    dc.send(JSON.stringify({type:'file-end',id}));transfer('Sent. Waiting for guests to load the video…',100);
  }catch{toast('File transfer interrupted. Reconnect or select the file again.');}finally{if(p.sending===id)p.sending=null;}
}
function setFileBlob(blob) {if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);filePlayer.src=objectUrl;filePlayer.load();}
async function applySource(source) {
  sourceId=source?.id||null;appliedRevision=-1;suppressUntil=Date.now()+1400;lastCorrected=0;
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();
  for(const p of peers.values()){p.sending=null;p.receive=null;if(p.dc?.readyState==='open')p.dc.send(JSON.stringify({type:'file-cancel'}));}
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  $('transfer').hidden=true;$('empty-player').hidden=!!source;$('youtube-wrap').hidden=source?.type!=='youtube';filePlayer.hidden=source?.type!=='file';
  if(!source){$('video-title').textContent='Choose something you’ll both love';status('Waiting for a video');return;}
  $('video-title').textContent=source.title;
  if(source.type==='youtube') {
    ownedFile=null;ownedFileId=null;pendingFile=null;status('Loading YouTube');
    try{await loadYouTube();if(sourceId!==source.id)return;yt.cueVideoById(source.videoId);yt.setVolume(movieVolume*100);send('ready',{sourceId,ready:true});setTimeout(()=>applyPlayback(true),800);}catch{toast('YouTube could not load. Check your connection or content blocker.');status('YouTube unavailable');}
  }else {
    status('Preparing shared file');
    if(me===source.owner && pendingFile){ownedFile=pendingFile;pendingFile=null;ownedFileId=source.id;setFileBlob(ownedFile);for(const p of peers.values())requestFile(p);}
    else if(me===source.owner){toast('Select the file again to restore sharing after a reload.');}
    else for(const p of peers.values())requestFile(p);
  }
}
function loadYouTube() {
  if(ytReady)return Promise.resolve();if(ytPromise)return ytPromise;
  ytPromise=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('YouTube timed out')),20000);
    function init(){yt=new YT.Player('youtube-player',{width:'100%',height:'100%',playerVars:{playsinline:1,controls:1,rel:0,origin:location.origin},events:{onReady:()=>{clearTimeout(timeout);ytReady=true;resolve();},onStateChange:youtubeEvent,onError:e=>{status('Video unavailable');toast('YouTube cannot embed this video ('+e.data+'). Try another video.');},onAutoplayBlocked:()=>{toast('Tap Play to allow video and sound on this device.');}}});}
    if(window.YT?.Player)init();else{window.onYouTubeIframeAPIReady=init;const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timeout);reject(new Error('YouTube blocked'));};document.head.append(script);}
  });return ytPromise;
}
function currentTime(){return room?.source?.type==='youtube'?(ytReady?yt.getCurrentTime()||0:0):filePlayer.currentTime||0;}
function duration(){return room?.source?.type==='youtube'?(ytReady?yt.getDuration()||0:0):(Number.isFinite(filePlayer.duration)?filePlayer.duration:0);}
function isPlaying(){return room?.source?.type==='youtube'?ytReady&&yt.getPlayerState()===1:!filePlayer.paused&&!filePlayer.ended;}
function youtubeEvent(e){
  if(room?.source?.type!=='youtube')return;
  if(e.data===3){status('Buffering locally');return;}
  if(Date.now()<suppressUntil)return;
  if(e.data===1 || e.data===2 || e.data===0){const playing=e.data===1;if(activePlayback?.playing!==playing)command(playing,currentTime());}
}
function command(playing, position=currentTime()) {
  if(!room?.source || preview)return toast('Add a video in a live room first.');
  suppressUntil=Date.now()+1100;lastSeek=Date.now();send('playback',{sourceId,playing,position:Math.max(0,position)});
}
function applyPlayback(force=false) {
  if(!room?.source || !activePlayback || preview)return;
  if(room.source.type==='youtube' && !ytReady)return;
  if(room.source.type==='file' && filePlayer.readyState<2)return;
  const p=activePlayback;let target=targetPosition(p,Date.now()+clockOffset);const total=duration();if(total>0)target=Math.min(target,total);
  const commandChanged=p.revision!==appliedRevision;
  if(commandChanged){suppressUntil=Date.now()+1000;appliedRevision=p.revision;}
  const diff=target-currentTime();
  const mode=correction(diff,commandChanged || force,Date.now()-lastCorrected);
  if(mode==='seek'){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.seekTo(target,true);else filePlayer.currentTime=target;lastCorrected=Date.now();}
  if(room.source.type==='file')filePlayer.playbackRate=p.playing&&mode==='rate'?Math.max(.95,Math.min(1.05,1+diff*.025)):1;
  if(p.playing && !isPlaying()){
    // A buffering YouTube player must finish buffering without repeated play/seek commands.
    if(room.source.type==='youtube'){if(yt.getPlayerState()!==3){suppressUntil=Date.now()+1000;yt.playVideo();}}
    else{suppressUntil=Date.now()+1000;filePlayer.play().catch(()=>toast('Tap Play or Enable sound to allow playback.'));}
  }else if(!p.playing && isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')yt.pauseVideo();else filePlayer.pause();}
  $('play').textContent=p.playing?'Ⅱ':'▶';status(p.playing?(Math.abs(diff)<.75?'Playing together':'Aligning playback'):'Paused together');
}
function tick(){
  if(!room?.source || preview)return;
  const cur=currentTime(),total=duration();$('time').textContent=formatTime(cur)+' / '+formatTime(total);
  if(document.activeElement!==$('seek'))$('seek').value=total?cur/total*1000:0;
  if(me===room.hostId && isPlaying() && Date.now()-lastAnchor>5000 && Date.now()>suppressUntil){send('anchor',{sourceId,position:cur});lastAnchor=Date.now();}
  if(Date.now()>suppressUntil){
    // Capture native YouTube seek gestures without treating ordinary clock drift as user input.
    if(room.source.type==='youtube' && ytReady && tick.source===sourceId && tick.previous!=null && Date.now()-lastSeek>1500){const elapsed=(Date.now()-tick.at)/1000;const jump=cur-tick.previous-(isPlaying()?elapsed:0);if(Math.abs(jump)>2.5 && Date.now()-lastCorrected>2000 && yt.getPlayerState()!==3)command(isPlaying(),cur);}
    if(me!==room.hostId || !isPlaying())applyPlayback(false);
  }
  tick.previous=cur;tick.at=Date.now();tick.source=sourceId;
}
function formatTime(s){s=Math.floor(s||0);return (s>=3600?Math.floor(s/3600)+':':'')+String(Math.floor(s/60)%60).padStart(s>=3600?2:1,'0')+':'+String(s%60).padStart(2,'0');}
function addMessage(m){const welcome=$('messages').querySelector('.chat-welcome');welcome?.remove();const el=document.createElement('div');el.className='message'+(m.from===me?' mine':'');const name=document.createElement('small');name.textContent=m.name+' · '+new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});const text=document.createElement('p');text.textContent=m.text;el.append(name,text);$('messages').append(el);while($('messages').children.length>200)$('messages').firstChild.remove();$('messages').scrollTop=$('messages').scrollHeight;}
function leave(notify=true){
  intentionalClose=true;clearTimeout(reconnectTimer);clearTimeout(connectTimer);if(notify&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'leave'}));socket?.close();
  token=null;for(const p of peers.values())closePeer(p);peers.clear();localStream.getTracks().forEach(t=>t.stop());localStream=new MediaStream();
  filePlayer.pause();filePlayer.removeAttribute('src');filePlayer.load();if(ytReady)yt.stopVideo();if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;ownedFile=null;pendingFile=null;ownedFileId=null;
  room=null;me=null;sourceId=null;activePlayback=null;preview=false;$('room').hidden=true;$('lobby').hidden=false;$('demo-banner').hidden=true;$('participants').replaceChildren();
  $('mic').textContent='Mic off';$('mic').setAttribute('aria-pressed',false);$('camera').textContent='Camera off';$('camera').setAttribute('aria-pressed',false);$('network').lastChild.textContent=' Private watch rooms';document.body.classList.remove('cinema');$('create').disabled=false;$('join-form').querySelector('button').disabled=false;
}
$('create').onclick=()=>connect({type:'create',name:$('name').value,capacity:Number($('capacity').value)});
$('join-form').onsubmit=e=>{e.preventDefault();connect({type:'join',name:$('name').value,code:$('code').value.trim().toUpperCase()});};
$('code').oninput=()=>{$('code').value=$('code').value.toUpperCase().replace(/[^A-Z2-9]/g,'');};
$('leave').onclick=()=>leave();$('lock').onclick=()=>send('lock',{locked:!room.locked});
$('copy').onclick=async()=>{if(preview)return toast('Preview code only. Create a live room for an invitation.');try{await navigator.clipboard.writeText(room.code);toast('Room code copied. Share it privately.');}catch{toast('Your room code: '+room.code);}};
$('mic').onclick=()=>toggleMedia('audio');$('camera').onclick=()=>toggleMedia('video');
$('retry-call').onclick=()=>{for(const p of peers.values()){if(p.initiator)p.pc.restartIce();else send('signal',{to:p.id,signal:{restart:true}});}toast('Reconnecting peer connections…');};
$('enable-audio').onclick=async()=>{await unlockAudio();if(activePlayback?.playing)applyPlayback(true);};
$('movie-volume').oninput=e=>{movieVolume=Number(e.target.value)/100;$('movie-level').textContent=e.target.value+'%';if(movieGain)movieGain.gain.value=movieVolume;else filePlayer.volume=movieVolume;if(ytReady)yt.setVolume(movieVolume*100);};
$('call-volume').oninput=e=>{callVolume=Number(e.target.value)/100;$('call-level').textContent=e.target.value+'%';for(const p of peers.values()){if(p.gain)p.gain.gain.value=callVolume;if(p.fallbackAudio)p.fallbackAudio.volume=callVolume;}};
$('chat-form').onsubmit=e=>{e.preventDefault();const text=$('message-input').value.trim();if(text&&send('chat',{text}))$('message-input').value='';};
$('play').onclick=async()=>{await unlockAudio();if(!room?.source)return toast('Add a video first.');if(activePlayback?.playing&&!isPlaying()){suppressUntil=Date.now()+1000;if(room.source.type==='youtube')ytReady&&yt.playVideo();else filePlayer.play().catch(()=>toast('Unable to play this file on this device.'));applyPlayback(true);}else command(!activePlayback?.playing);};
$('back10').onclick=()=>command(activePlayback?.playing||false,currentTime()-10);$('forward10').onclick=()=>command(activePlayback?.playing||false,Math.min(duration(),currentTime()+10));
$('seek').onchange=()=>command(activePlayback?.playing||false,Number($('seek').value)/1000*duration());
$('theater').onclick=()=>{document.body.classList.toggle('cinema');};
$('youtube-tab').onclick=()=>{$('youtube-form').hidden=false;$('file-form').hidden=true;$('youtube-tab').classList.add('active');$('file-tab').classList.remove('active');};
$('file-tab').onclick=()=>{$('youtube-form').hidden=true;$('file-form').hidden=false;$('file-tab').classList.add('active');$('youtube-tab').classList.remove('active');$('search-results').replaceChildren();};
$('youtube-form').onsubmit=async e=>{
  e.preventDefault();if(preview)return toast('Create a room to add a video.');const value=$('youtube-input').value.trim(),id=youtubeId(value);
  if(id){send('source',{source:{type:'youtube',videoId:id,title:'YouTube · '+id}});$('search-results').replaceChildren();return;}
  if(value.length<2)return toast('Paste a YouTube link or enter a search.');
  $('load-video').disabled=true;
  try{const res=await fetch(base+'/api/search?q='+encodeURIComponent(value),{headers:{Authorization:'Bearer '+token}});const data=await res.json();if(!res.ok)throw new Error(data.error||'Search unavailable. Paste a video link.');$('search-results').replaceChildren();for(const item of data.items){const b=document.createElement('button');b.className='result';const image=document.createElement('img');image.src=item.thumbnail;image.alt='';const text=document.createElement('span');text.textContent=item.title+' · '+item.channel;b.append(image,text);b.onclick=()=>{send('source',{source:{type:'youtube',videoId:item.id,title:item.title}});$('search-results').replaceChildren();};$('search-results').append(b);}if(!data.items.length)toast('No playable videos found. Try another search.');}catch(err){toast(err.message);}finally{$('load-video').disabled=false;}
};
$('file-input').onchange=()=>{const f=$('file-input').files[0];if(!f)return;if(preview)return toast('Create a room to share a file.');if(f.size>MAX_FILE || !f.size){$('file-input').value='';return toast('Choose a video smaller than 250 MB. Large movie transfer is not included in this first build.');}const mime=f.type||(/\.mp4$/i.test(f.name)?'video/mp4':/\.webm$/i.test(f.name)?'video/webm':'');if(!mime.startsWith('video/'))return toast('Choose a supported video file such as MP4 or WebM.');pendingFile=f;send('source',{source:{type:'file',title:f.name,size:f.size,mime}});$('file-input').value='';};
filePlayer.onloadeddata=()=>{if(room?.source?.type==='file'){send('ready',{sourceId,ready:true});applyPlayback(true);}};
filePlayer.onerror=()=>{if(room?.source?.type==='file' && filePlayer.getAttribute('src')){send('ready',{sourceId,ready:false});toast('This device cannot decode the file. Try an MP4 with H.264 video and AAC audio.');}};
filePlayer.onended=()=>{if(room?.source?.type==='file' && me===room.hostId)command(false,currentTime());};
$('preview').onclick=()=>{preview=true;me='preview-host';$('lobby').hidden=true;$('room').hidden=false;$('demo-banner').hidden=false;notice('');updateRoom({code:'PREVIEW',hostId:me,capacity:2,locked:false,source:null,playback:{position:0,playing:false,updatedAt:Date.now(),revision:0},people:[{id:me,name:'You',online:true,mic:false,camera:false},{id:'preview-guest',name:'Your friend',online:true,mic:false,camera:false}]});};
setInterval(tick,500);setInterval(ping,10000);
window.addEventListener('pagehide',()=>{if(socket?.readyState===WebSocket.OPEN)socket.close();localStream.getTracks().forEach(t=>t.stop());});
if(location.hostname.endsWith('github.io')&&!window.XPARTY_CONFIG?.backendUrl)$('setup-notice').hidden=false;
