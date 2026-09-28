import http from 'node:http';
import {readFile,mkdtemp,rm,open} from 'node:fs/promises';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {searchYouTube} from './youtube-search.mjs';
const ROOT=fileURLToPath(new URL('./public',import.meta.url));
const MAX_FILE=250*1024*1024,CHUNK=2*1024*1024,MAX_STORAGE=1024*1024*1024;
const clean=(v,n)=>String(v??'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,n);
const finite=(v,max=604800)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
const code=()=>[...randomBytes(8)].map(x=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x%32]).join('');
const secret=()=>randomBytes(32).toString('base64url');
const randomName=()=>['Happy','Sunny','Lucky','Cosmic','Mint','Peach','Silver','Mellow'][randomBytes(1)[0]%8]+' '+['Panda','Fox','Otter','Owl','Koala','Tiger','Robin','Deer'][randomBytes(1)[0]%8];
export function createXparty(options={}) {
 const rooms=new Map(),clients=new Map(),buckets=new Map(),files=new Map(),searchCache=new Map();let storage=0;
 const publicAuthKey=(()=>{const key=process.env.SUPABASE_ANON_KEY||'';if(key.startsWith('sb_publishable_'))return key;try{if(JSON.parse(Buffer.from(key.split('.')[1],'base64url')).role==='anon')return key;}catch{}return null;})();
 const statePath=options.statePath??process.env.STATE_PATH;let saveTimer;
 const allowed=new Set((process.env.ALLOWED_ORIGINS||'https://pkx404.github.io,http://localhost:8787,http://127.0.0.1:8787').split(',').map(x=>x.trim()));
 if(process.env.RENDER_EXTERNAL_URL)allowed.add(process.env.RENDER_EXTERNAL_URL);
 const originOK=req=>allowed.has(req.headers.origin);
 function persist(){if(!statePath)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{const data=[...rooms.values()].map(r=>({...r,people:[...r.people.values()].map(({ws,...p})=>({...p,ready:false,mic:false,camera:false})),source:r.source?.type==='file'?null:r.source,playback:{...r.playback,playing:false}}));writeFileSync(statePath+'.tmp',JSON.stringify(data),{mode:0o600});renameSync(statePath+'.tmp',statePath);}catch(e){console.error('Room checkpoint failed:',e.code);}},150);}
 if(statePath)try{for(const r of JSON.parse(readFileSync(statePath,'utf8'))){r.people=new Map(r.people.map(p=>{p.ws=null;clients.set(p.token,p);return[p.id,p];}));rooms.set(r.code,r);}}catch{}
 function rate(key,limit,ms){const now=Date.now();let b=buckets.get(key);if(!b||b.until<now){b={count:0,until:now+ms};buckets.set(key,b);}return ++b.count<=limit;}
 const ip=req=>process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',').at(-1).trim():req.socket.remoteAddress;
 function send(ws,obj){if(ws?.readyState===WebSocket.OPEN){if(ws.bufferedAmount>1024*1024)return ws.close(1013,'Slow connection');ws.send(JSON.stringify(obj));}}
 const online=p=>p.ws?.readyState===WebSocket.OPEN;
 function broadcast(r,obj){for(const p of r.people.values())send(p.ws,obj);}
 function snapshot(r){return {code:r.code,hostId:r.hostId,ownerId:r.ownerId||r.hostId,theme:r.theme||null,capacity:r.capacity,locked:r.locked,source:r.source,playback:r.playback,queue:r.queue||[],people:[...r.people.values()].map(p=>({id:p.id,name:p.name,session:p.session||0,online:online(p),inCall:!!p.inCall,mic:p.mic,camera:p.camera,ready:p.ready,loadStatus:p.loadStatus||'',micBlocked:p.micBlocked,cameraAllowed:p.cameraAllowed,cameraRequested:p.cameraRequested})),serverTime:Date.now()};}
 function state(r){syncBuffering(r);broadcast(r,{type:'state',room:snapshot(r)});persist();}
 function ice(id){const out=[{urls:'stun:stun.l.google.com:19302'}];if(process.env.TURN_URLS&&process.env.TURN_SECRET){const username=`${Math.floor(Date.now()/1000)+86400}:${id}`;out.push({urls:process.env.TURN_URLS.split(','),username,credential:createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64')});}if(process.env.ICE_SERVERS_JSON)out.push(...JSON.parse(process.env.ICE_SERVERS_JSON));return out;}
 function welcome(p,r){const iceServers=ice(p.id);send(p.ws,{type:'welcome',id:p.id,token:p.token,room:snapshot(r),history:(r.history||[]).filter(m=>!m.to||m.from===p.id||m.to===p.id),iceServers,hasRelay:iceServers.some(s=>[s.urls].flat().some(u=>/^turns?:/.test(u))),searchEnabled:true});}
 function dropFile(id){const f=files.get(id);if(f){files.delete(id);storage-=f.size;rm(f.dir,{recursive:true,force:true}).catch(()=>{});}}
 function choose(r,p,s){if(!s||!['youtube','file'].includes(s.type))return false;if(s.type==='youtube'&&!/^[\w-]{11}$/.test(s.videoId))return false;if(s.type==='file'&&(!finite(s.size,MAX_FILE)||!s.size||!/^video\//.test(s.mime)))return false;
  if(s.type==='file'&&storage+s.size>MAX_STORAGE){send(p.ws,{type:'error',message:'Temporary video storage is busy. Try a smaller file or YouTube.'});return false;}
  if(r.source?.type==='file')dropFile(r.source.id);
  r.source={type:s.type,id:randomUUID(),title:clean(s.title,150)||'YouTube video',owner:p.id,...(s.type==='youtube'?{videoId:s.videoId}:{size:s.size,mime:clean(s.mime,80),uploaded:false})};
  if(s.type==='file'){storage+=s.size;files.set(r.source.id,{id:r.source.id,size:s.size,offset:0,busy:false,dir:null,path:null,code:r.code});}
  r.playback={position:0,playing:false,updatedAt:Date.now(),revision:r.playback.revision+1};for(const x of r.people.values()){x.ready=false;x.buffering=false;x.loadStatus=s.type==='file'?'Waiting for upload':'Loading';}state(r);return true;
 }
 function remove(p,kicked=false){const r=rooms.get(p.code);if(!r)return;clients.delete(p.token);r.people.delete(p.id);r.queue=(r.queue||[]).map(q=>({...q,votes:q.votes.filter(x=>x!==p.id)}));
  if(!r.people.size){if(r.source?.type==='file')dropFile(r.source.id);rooms.delete(r.code);persist();return;}
  if(r.hostId===p.id){r.hostId=([...r.people.values()].find(online)||r.people.values().next().value).id;const h=r.people.get(r.hostId);h.cameraAllowed=true;h.micBlocked=false;}
  if(r.source?.owner===p.id&&r.source.type==='file'&&!r.source.uploaded){dropFile(r.source.id);r.source=null;r.playback.playing=false;}
  state(r);
 }
 function occupied(r,except=null){return [...r.people.values()].filter(x=>x.id!==except&&(online(x)||x.id===r.ownerId)).length;}
 function syncBuffering(r){if(r.source?.type!=='youtube')return;const waiting=[...r.people.values()].filter(x=>online(x)&&x.buffering).map(x=>x.id);const old=r.playback.waitingFor||[];if(JSON.stringify(old)===JSON.stringify(waiting))return;const p=r.playback;const position=p.position+(p.playing&&!old.length?Math.max(0,Date.now()-p.updatedAt)/1000:0);r.playback={...p,position,updatedAt:Date.now(),waitingFor:waiting};broadcast(r,{type:'playback',sourceId:r.source.id,playback:r.playback,serverTime:Date.now()});}
 const authenticate=req=>{const p=clients.get(String(req.headers.authorization||'').replace(/^Bearer /,''));return p&&online(p)?p:null;};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');if(originOK(req)){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-File-Offset');res.setHeader('Access-Control-Allow-Methods','GET, PUT, OPTIONS');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.method==='OPTIONS'){res.writeHead(originOK(req)?204:403);return res.end();}
  if(url.pathname==='/health')return json(200,{ok:true,service:'Xparty',version:'0.4.0'});
  if(url.pathname==='/api/accounts/config')return json(200,{enabled:!!(process.env.SUPABASE_URL&&publicAuthKey),url:publicAuthKey?process.env.SUPABASE_URL||null:null,publicKey:publicAuthKey,phoneEnabled:process.env.SUPABASE_PHONE_ENABLED==='true'});
  if(url.pathname.startsWith('/api/')){
   if(req.headers.origin&&!originOK(req))return json(403,{error:'Origin not allowed'});const p=authenticate(req);if(!p)return json(401,{error:'Your room connection is offline. Reconnect and retry.'});const r=rooms.get(p.code);
   if(url.pathname==='/api/search'&&req.method==='GET'){
    if(!rate('search:'+p.id,12,60000))return json(429,{error:'Please wait a moment before searching again.'});const q=clean(url.searchParams.get('q'),100);if(q.length<2)return json(400,{error:'Enter at least two characters'});
    const cache=searchCache.get(q.toLowerCase());if(cache&&Date.now()-cache.at<300000)return json(200,{items:cache.items});
    try{const items=await (options.searchYouTube||searchYouTube)(q);if(searchCache.size>100)searchCache.clear();searchCache.set(q.toLowerCase(),{at:Date.now(),items});return json(200,{items});}catch(e){return json(503,{error:e.message});}
   }
   const match=url.pathname.match(/^\/api\/file\/([\w-]+)$/);
   if(match){const id=match[1],f=files.get(id);if(!f||f.code!==r.code||r.source?.id!==id)return json(404,{error:'This file is no longer in the room.'});
    if(req.method==='PUT'){
     if(p.id!==r.source.owner)return json(403,{error:'Only the person sharing the file can upload it.'});
     const offset=Number(req.headers['x-file-offset']);if(!Number.isSafeInteger(offset)||offset!==f.offset)return json(409,{error:'Upload offset changed',offset:f.offset});if(f.busy)return json(409,{error:'An upload chunk is in progress',offset:f.offset});
     f.busy=true;try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>CHUNK||offset+size>f.size){json(413,{error:'Upload chunk too large'});req.destroy();return;}chunks.push(chunk);}if(!size)return json(400,{error:'Empty upload chunk'});
      if(files.get(id)!==f)return json(409,{error:'Video changed during upload'});
      if(!f.path){f.dir=await mkdtemp(join(tmpdir(),'xparty-'));f.path=join(f.dir,'video');}
      const h=await open(f.path,offset?'r+':'w',0o600);try{const data=Buffer.concat(chunks);let written=0;while(written<data.length){const result=await h.write(data,written,data.length-written,offset+written);written+=result.bytesWritten;}}finally{await h.close();}
      if(files.get(id)!==f)return json(409,{error:'Video changed during upload'});f.offset+=size;if(f.offset===f.size){r.source.uploaded=true;state(r);}return json(200,{offset:f.offset,complete:f.offset===f.size});
     }catch(e){if(!res.headersSent)return json(500,{error:'Upload interrupted. Retry sharing the file.'});}finally{f.busy=false;}return;
    }
    if(req.method==='GET'){if(f.offset!==f.size)return json(409,{error:'The host is still uploading this video.'});res.writeHead(200,{'Content-Type':r.source.mime,'Content-Length':f.size,'Cache-Control':'no-store'});const h=await open(f.path,'r');const stream=h.createReadStream();stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;}
   }
   return json(404,{error:'Not found'});
  }
  if(req.method!=='GET')return json(405,{error:'Method not allowed'});
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return json(400,{error:'Invalid URL'});}
  // Serve the application at the short root URL, retaining old /xparty/ links.
  if(pathname==='/')pathname='/xparty/index.html';else if(!pathname.startsWith('/xparty/')&&/^\/(?:app.js|config.js|style.css|sync.js|settings.js|icons.js|accounts.js)$/.test(pathname))pathname='/xparty'+pathname;
  if(pathname.endsWith('/'))pathname+='index.html';const path=resolve(ROOT,'.'+pathname);if(!path.startsWith(ROOT+'/'))return json(403,{error:'Forbidden'});
  try{const data=await readFile(path);res.writeHead(200,{'Content-Type':({'.html':'text/html','.css':'text/css','.js':'text/javascript'})[extname(path)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{return json(404,{error:'Not found'});}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!originOK(req)||!rate('connect:'+ip(req),60,60000)||wss.clients.size>500){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');return socket.destroy();}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 wss.on('connection',(ws,req)=>{
  ws.alive=true;ws.on('pong',()=>ws.alive=true);ws.on('error',()=>{});const timeout=setTimeout(()=>{if(!ws.person)ws.close(1008,'Join timeout');},20000);
  ws.on('message',raw=>{try{
   if(!rate('message:'+(ws.person?.id||ip(req)),240,10000))return send(ws,{type:'error',message:'Too many actions. Wait a moment.'});const m=JSON.parse(raw);if(!m||typeof m!=='object')return;
   if(m.type==='ping')return send(ws,{type:'pong',sent:m.sent,serverTime:Date.now()});
   if(['create','join','resume'].includes(m.type)){
    if(ws.person)return;if(!rate('join:'+ip(req),30,60000))return send(ws,{type:'error',message:'Too many join attempts. Try again in one minute.'});let r,p;
    if(m.type==='resume'){
     p=clients.get(m.token);if(!p)return send(ws,{type:'resume-failed',message:'This room is no longer available. It may have been cleared by a server restart, or you may have been removed.'});r=rooms.get(p.code);if(!r)return send(ws,{type:'resume-failed'});
     if(!online(p)&&occupied(r,p.id)>=r.capacity)return send(ws,{type:'resume-failed',message:'All room seats are occupied. Ask the host to increase capacity, then join again.'});
     // A valid saved token may replace the old socket during an immediate page refresh.
     if(p.ws&&p.ws!==ws){p.ws.person=null;p.ws.close(4000,'Session resumed in another connection');}p.ready=false;p.buffering=false;p.mic=false;p.camera=false;
    }else{
     if(m.type==='create'){if(rooms.size>=100)return send(ws,{type:'error',message:'Room capacity reached. End unused rooms first.'});let c;do{c=code();}while(rooms.has(c));r={code:c,hostId:null,capacity:Number.isInteger(m.capacity)&&m.capacity>=2&&m.capacity<=10?m.capacity:2,locked:false,people:new Map(),source:null,queue:[],history:[],playback:{position:0,playing:false,updatedAt:Date.now(),revision:0}};rooms.set(c,r);}
     else{r=rooms.get(clean(m.code,12).toUpperCase());if(!r||r.locked)return send(ws,{type:'error',message:'Room unavailable. Check the code or ask the host to unlock it.'});if(occupied(r)>=r.capacity)return send(ws,{type:'error',message:'This room is full.'});}
     const host=!r.hostId;p={id:randomUUID(),token:secret(),name:clean(m.name,24)||randomName(),code:r.code,ws,mic:false,camera:false,ready:false,micBlocked:false,cameraAllowed:host,cameraRequested:false};r.people.set(p.id,p);clients.set(p.token,p);r.hostId??=p.id;r.ownerId??=p.id;
    }
    p.inCall=[...r.people.values()].filter(x=>x!==p&&online(x)&&x.inCall).length<4;if(r.ownerId===p.id){r.hostId=p.id;p.cameraAllowed=true;p.micBlocked=false;}p.session=(p.session||0)+1;p.ws=ws;ws.person=p;clearTimeout(timeout);welcome(p,r);state(r);return;
   }
   const p=ws.person,r=p&&rooms.get(p.code);if(!r||r.people.get(p.id)!==p||p.ws!==ws)return;const host=p.id===r.hostId;
   if(m.type==='leave'){if(r.ownerId!==p.id){remove(p);}else{p.ws=null;p.buffering=false;p.inCall=false;p.mic=false;p.camera=false;p.ready=false;if(r.hostId===p.id){const next=[...r.people.values()].find(x=>x!==p&&online(x));if(next){r.hostId=next.id;next.cameraAllowed=true;next.micBlocked=false;}}state(r);}ws.person=null;return ws.close(1000,'Left');}
   if(m.type==='end-room'&&host){for(const x of r.people.values()){clients.delete(x.token);send(x.ws,{type:'ended',message:'The host ended the room.'});x.ws?.close(1000,'Ended');}if(r.source?.type==='file')dropFile(r.source.id);rooms.delete(r.code);persist();return;}
   if(m.type==='kick'&&host){const target=r.people.get(m.target);if(target&&target!==p&&target.id!==r.ownerId){send(target.ws,{type:'kicked',message:'The host removed you from the room.'});remove(target,true);target.ws?.close(4003,'Removed');}return;}
   if(m.type==='transfer-host'&&host){const target=r.people.get(m.target);if(target&&target!==p&&online(target)){r.hostId=target.id;r.ownerId=target.id;target.cameraAllowed=true;target.micBlocked=false;state(r);}return;}
   if(m.type==='moderate'&&host){const target=r.people.get(m.target);if(!target||target===p)return;
    if(m.action==='mute'){target.micBlocked=true;target.mic=false;}else if(m.action==='allow-mic')target.micBlocked=false;else if(m.action==='camera-off'){target.cameraAllowed=false;target.cameraRequested=false;target.camera=false;}else if(m.action==='approve-camera'){target.cameraAllowed=true;target.cameraRequested=false;}else if(m.action==='deny-camera'){target.cameraAllowed=false;target.cameraRequested=false;}else return;
    send(target.ws,{type:'moderation',action:m.action});state(r);return;
   }
   if(m.type==='request-camera'&&!host){p.cameraRequested=true;state(r);return;}
   if(m.type==='media'){p.mic=m.mic===true&&!p.micBlocked&&p.inCall;p.camera=m.camera===true&&(host||p.cameraAllowed)&&p.inCall;state(r);return;}
   if(m.type==='typing'){
    if(!rate('typing:'+p.id,4,2000))return;const target=m.to?r.people.get(m.to):null;if(m.to&&!target)return;const event={type:'typing',from:p.id,name:p.name,to:target?.id||null,active:m.active===true};if(target)send(target.ws,event);else for(const x of r.people.values())if(x!==p)send(x.ws,event);return;
   }
   if(m.type==='chat'){const text=clean(m.text,1500),target=m.to?r.people.get(m.to):null;if(m.to&&!target)return send(ws,{type:'error',message:'This participant is no longer in the room.'});if(text){const message={type:'chat',id:randomUUID(),from:p.id,name:p.name,to:target?.id||null,toName:target?.name||null,text,at:Date.now()};r.history.push(message);if(r.history.length>100)r.history.shift();if(target){send(p.ws,message);if(target!==p)send(target.ws,message);}else broadcast(r,message);persist();}return;}
   if(m.type==='room-theme'&&host&&['','lime','violet','ocean','amber'].includes(m.theme)){r.theme=m.theme||null;state(r);return;}
   if(m.type==='capacity'&&host){const capacity=Number(m.capacity);if(Number.isInteger(capacity)&&capacity>=2&&capacity<=10&&capacity>=occupied(r)){if(capacity>r.capacity)r.locked=false;r.capacity=capacity;state(r);}else send(ws,{type:'error',message:'Room size must fit current members, with a maximum of 10.'});return;}
   if(m.type==='call-join'){if(!p.inCall&&[...r.people.values()].filter(x=>online(x)&&x.inCall).length>=4)return send(ws,{type:'error',message:'All four call seats are occupied. You can still watch and chat.'});p.inCall=true;p.session=(p.session||0)+1;state(r);return;}
   if(m.type==='call-leave'){p.inCall=false;p.mic=false;p.camera=false;state(r);return;}
   if(m.type==='lock'&&host){r.locked=m.locked===true;state(r);return;}
   if(m.type==='source'&&host){choose(r,p,m.source);return;}
   if(m.type==='queue-add'){if(!/^[\w-]{11}$/.test(m.videoId)||r.queue.length>=50)return;const existing=r.queue.find(q=>q.videoId===m.videoId);if(existing){if(!existing.votes.includes(p.id))existing.votes.push(p.id);}else r.queue.push({id:randomUUID(),videoId:m.videoId,title:clean(m.title,150)||'YouTube video',addedBy:p.name,votes:[p.id],createdAt:Date.now()});state(r);return;}
   if(m.type==='vote'){const item=r.queue.find(q=>q.id===m.id);if(item){item.votes=item.votes.includes(p.id)?item.votes.filter(id=>id!==p.id):[...item.votes,p.id];state(r);}return;}
   if(m.type==='queue-remove'&&host){r.queue=r.queue.filter(q=>q.id!==m.id);state(r);return;}
   if((m.type==='queue-play'||m.type==='next')&&host){const item=m.type==='next'?[...r.queue].sort((a,b)=>b.votes.length-a.votes.length||a.createdAt-b.createdAt)[0]:r.queue.find(q=>q.id===m.id);if(item){r.queue=r.queue.filter(q=>q.id!==item.id);choose(r,p,{type:'youtube',videoId:item.videoId,title:item.title});}return;}
   if(m.type==='ready'&&m.sourceId===r.source?.id){p.ready=m.ready===true;p.loadStatus=clean(m.status,100)||(p.ready?'Ready':'Loading');state(r);return;}
   if(m.type==='buffering'&&r.source?.type==='youtube'&&m.sourceId===r.source.id){p.buffering=m.buffering===true&&r.playback.playing;syncBuffering(r);return;}
   if(m.type==='resync'){send(ws,{type:'playback',sourceId:r.source?.id,playback:r.playback,serverTime:Date.now()});return;}
   if(m.type==='playback'&&r.source&&m.sourceId===r.source.id&&finite(m.position)&&typeof m.playing==='boolean'){
    const waiting=[...r.people.values()].filter(x=>online(x)&&!x.ready);
    if(r.source.type==='file'&&m.playing&&(!r.source.uploaded||waiting.length))return send(ws,{type:'error',message:!r.source.uploaded?'The video is uploading. Progress is shown below the player.':'Waiting for '+waiting.map(x=>x.name+' ('+(x.loadStatus||'loading')+')').join(', ')});
    for(const x of r.people.values())x.buffering=false;r.playback={position:m.position,playing:m.playing,updatedAt:Date.now(),waitingFor:[],revision:r.playback.revision+1};broadcast(r,{type:'playback',sourceId:r.source.id,playback:r.playback,from:p.id,serverTime:Date.now()});persist();return;
   }
   if(m.type==='anchor'&&host&&m.sourceId===r.source?.id&&r.playback.playing&&finite(m.position)){r.playback={...r.playback,position:m.position,updatedAt:Date.now()};broadcast(r,{type:'anchor',sourceId:r.source.id,playback:r.playback,serverTime:Date.now()});return;}
   if(m.type==='signal'){const target=r.people.get(m.to);if(p.inCall&&target?.inCall&&online(target)&&target!==p&&m.signal&&typeof m.signal==='object')send(target.ws,{type:'signal',from:p.id,signal:m.signal});}
  }catch{send(ws,{type:'error',message:'Invalid request'});}});
  ws.on('close',()=>{clearTimeout(timeout);const p=ws.person;if(p&&p.ws===ws&&clients.has(p.token)){p.ws=null;p.buffering=false;p.inCall=false;p.mic=false;p.camera=false;p.ready=false;const r=rooms.get(p.code);if(r){if(r.hostId===p.id){const next=[...r.people.values()].find(x=>x!==p&&online(x));if(next){r.hostId=next.id;next.cameraAllowed=true;next.micBlocked=false;}}state(r);}}});
 });
 const maintenance=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}for(const[key,b]of buckets)if(b.until<Date.now())buckets.delete(key);},30000);maintenance.unref();
 return {server,rooms,close:async()=>{clearInterval(maintenance);clearTimeout(saveTimer);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));for(const id of files.keys())dropFile(id);}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const app=createXparty();app.server.listen(Number(process.env.PORT||8787),'0.0.0.0',()=>console.log('Xparty 0.3 listening on '+(process.env.PORT||8787)));const stop=()=>app.close().then(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);}
