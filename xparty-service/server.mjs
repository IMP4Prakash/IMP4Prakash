import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname} from 'node:path';
import {randomBytes, randomUUID, createHmac} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';

const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const MAX_FILE = 250 * 1024 * 1024;
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const finite = (v, max = 604800) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const code = () => [...randomBytes(8)].map(x => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join('');
const secret = () => randomBytes(32).toString('base64url');

export function createXparty(options = {}) {
  const rooms = new Map(), clients = new Map(), buckets = new Map();
  const graceMs = options.graceMs ?? 30000;
  const allowed = new Set((process.env.ALLOWED_ORIGINS || 'https://pkx404.github.io,http://localhost:8787,http://127.0.0.1:8787').split(',').map(x=>x.trim()));
  const originOK = req => allowed.has(req.headers.origin);
  function rate(key, limit, windowMs) {
    const now = Date.now(); let b = buckets.get(key);
    if (!b || b.until < now) {b = {count: 0, until: now + windowMs}; buckets.set(key, b);}
    return ++b.count <= limit;
  }
  function ip(req) {return process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;}
  function send(ws, obj) {if (ws?.readyState === WebSocket.OPEN) {if(ws.bufferedAmount > 1024*1024) return ws.close(1013, 'Slow connection'); ws.send(JSON.stringify(obj));}}
  function broadcast(room, obj) {for (const p of room.people.values()) send(p.ws, obj);}
  function snapshot(room) {return {code: room.code, hostId: room.hostId, capacity: room.capacity, locked: room.locked, source: room.source, playback: room.playback, people:[...room.people.values()].map(p=>({id:p.id,name:p.name,online:p.ws?.readyState===WebSocket.OPEN,mic:p.mic,camera:p.camera,ready:p.ready})),serverTime:Date.now()};}
  function state(room) {broadcast(room, {type:'state', room:snapshot(room)});}
  function ice(id) {
    const result = [{urls:'stun:stun.l.google.com:19302'}];
    if (process.env.TURN_URLS && process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now()/1000)+86400}:${id}`;
      result.push({urls:process.env.TURN_URLS.split(','),username,credential:createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64')});
    }
    if (process.env.ICE_SERVERS_JSON) result.push(...JSON.parse(process.env.ICE_SERVERS_JSON));
    return result;
  }
  function welcome(p, room) {const iceServers=ice(p.id);send(p.ws,{type:'welcome',id:p.id,token:p.token,room:snapshot(room),iceServers,hasRelay:iceServers.some(s=>[s.urls].flat().some(u=>/^turns?:/.test(u))),searchEnabled:Boolean(process.env.YOUTUBE_API_KEY)});}
  function remove(p, explicit = false) {
    clearTimeout(p.timer); const room = rooms.get(p.code); if(!room) return;
    clients.delete(p.token); room.people.delete(p.id);
    if (p.id === room.hostId) {
      broadcast(room,{type:'ended',message:'The host left. This room has ended.'});
      for(const other of room.people.values()){clearTimeout(other.timer);clients.delete(other.token);other.ws?.close(1000,'Room ended');}
      rooms.delete(room.code);
    } else if (room.people.size) state(room);
  }
  const server = http.createServer(async (req,res)=>{
    const url = new URL(req.url, 'http://localhost');
    if(originOK(req)) {res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    const json = (status, body) => {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if(req.method === 'OPTIONS') {res.writeHead(originOK(req)?204:403);return res.end();}
    if(req.method !== 'GET') return json(405,{error:'Method not allowed'});
    if(url.pathname === '/health') return json(200,{ok:true,service:'Xparty'});
    if(url.pathname === '/api/search') {
      if(!originOK(req)) return json(403,{error:'Origin not allowed'});
      const p=clients.get(String(req.headers.authorization||'').replace(/^Bearer /,''));
      if(!p || p.ws?.readyState!==WebSocket.OPEN) return json(401,{error:'Join a room first'});
      if(!rate('search:'+p.id,6,60000) || !rate('search-global',60,3600000)) return json(429,{error:'Search limit reached. Paste a YouTube link instead.'});
      if(!process.env.YOUTUBE_API_KEY) return json(503,{error:'Search is not configured yet. Paste a YouTube link.'});
      const q=clean(url.searchParams.get('q'),100);if(q.length<2) return json(400,{error:'Enter at least two characters'});
      try {
        const query=new URLSearchParams({part:'snippet',type:'video',videoEmbeddable:'true',maxResults:'6',q,key:process.env.YOUTUBE_API_KEY});
        const upstream=await fetch('https://www.googleapis.com/youtube/v3/search?'+query,{signal:AbortSignal.timeout(8000)});
        if(!upstream.ok) return json(502,{error:'YouTube search is unavailable. Paste a link instead.'});
        const body=await upstream.json();return json(200,{items:body.items.map(i=>({id:i.id.videoId,title:i.snippet.title,channel:i.snippet.channelTitle,thumbnail:i.snippet.thumbnails.medium.url}))});
      } catch {return json(502,{error:'Search timed out. Try a link.'});}
    }
    let pathname;try {pathname=decodeURIComponent(url.pathname);}catch{return json(400,{error:'Invalid URL'});}
    if(pathname === '/') {res.writeHead(302,{Location:'/xparty/'});return res.end();}
    if(pathname.endsWith('/')) pathname+='index.html';
    const path=resolve(ROOT,'.'+pathname);
    if(!path.startsWith(ROOT+'/')) return json(403,{error:'Forbidden'});
    try {const data=await readFile(path);res.writeHead(200,{'Content-Type':({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{return json(404,{error:'Not found'});}
  });
  const wss = new WebSocketServer({noServer:true,maxPayload:64*1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url !== '/ws' || !originOK(req) || !rate('connect:'+ip(req),40,60000) || wss.clients.size>500) {socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');return socket.destroy();}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  wss.on('connection',(ws,req)=>{
    ws.alive=true;ws.on('pong',()=>ws.alive=true);
    const unauthTimeout=setTimeout(()=>{if(!ws.person) ws.close(1008,'Join timeout');},15000);
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      try {
        if(!rate('message:'+ (ws.person?.id || ip(req)),120,10000)) return send(ws,{type:'error',message:'Too many actions. Wait a moment.'});
        const m=JSON.parse(raw);if(!m || typeof m !== 'object') return;
        if(m.type==='ping') return send(ws,{type:'pong',sent:m.sent,serverTime:Date.now()});
        if(m.type==='create' || m.type==='join' || m.type==='resume') {
          if(ws.person) return send(ws,{type:'error',message:'You are already in a room.'});
          if(!rate('join:'+ip(req),20,60000)) return send(ws,{type:'error',message:'Too many join attempts. Try again in one minute.'});
          let room,p;
          if(m.type==='resume') {
            p=clients.get(m.token);if(!p || p.ws?.readyState===WebSocket.OPEN) return send(ws,{type:'resume-failed'});
            room=rooms.get(p.code);if(!room) return send(ws,{type:'resume-failed'});clearTimeout(p.timer);
          } else {
            if(m.type==='create') {
              if(rooms.size>=100) return send(ws,{type:'error',message:'Rooms are busy. Try later.'});
              let c;do{c=code();}while(rooms.has(c));
              room={code:c,hostId:null,capacity:m.capacity===4?4:2,locked:false,people:new Map(),source:null,playback:{position:0,playing:false,updatedAt:Date.now(),revision:0},createdAt:Date.now()};rooms.set(c,room);
            } else {
              room=rooms.get(clean(m.code,12).toUpperCase());
              if(!room || room.locked) return send(ws,{type:'error',message:'Room unavailable. Check the code or ask the host to unlock it.'});
              if(room.people.size>=room.capacity) return send(ws,{type:'error',message:'This room is full.'});
            }
            p={id:randomUUID(),token:secret(),name:clean(m.name,24)||'Guest',code:room.code,ws,mic:false,camera:false,ready:false};
            room.people.set(p.id,p);clients.set(p.token,p);room.hostId??=p.id;
          }
          p.ws=ws;ws.person=p;clearTimeout(unauthTimeout);welcome(p,room);state(room);return;
        }
        const p=ws.person, room=p && rooms.get(p.code);if(!room || room.people.get(p.id)!==p) return;
        if(m.type==='leave') {remove(p,true);ws.person=null;return ws.close(1000,'Left');}
        if(m.type==='chat') {const text=clean(m.text,1500);if(text) broadcast(room,{type:'chat',id:randomUUID(),from:p.id,name:p.name,text,at:Date.now()});}
        else if(m.type==='media') {p.mic=m.mic===true;p.camera=m.camera===true;state(room);}
        else if(m.type==='lock' && p.id===room.hostId) {room.locked=m.locked===true;state(room);}
        else if(m.type==='source' && p.id===room.hostId) {
          const s=m.source;if(!s || !['youtube','file'].includes(s.type)) return;
          if(s.type==='youtube' && !/^[\w-]{11}$/.test(s.videoId)) return;
          if(s.type==='file' && (!finite(s.size,MAX_FILE) || s.size===0 || !/^video\//.test(s.mime))) return;
          room.source={type:s.type,id:randomUUID(),title:clean(s.title,150)||'YouTube video',owner:p.id,...(s.type==='youtube'?{videoId:s.videoId}:{size:s.size,mime:clean(s.mime,80)})};
          room.playback={position:0,playing:false,updatedAt:Date.now(),revision:room.playback.revision+1};
          for(const person of room.people.values()) person.ready=false;state(room);
        }
        else if(m.type==='ready' && m.sourceId===room.source?.id) {p.ready=m.ready===true;state(room);}
        else if(m.type==='playback' && room.source && m.sourceId===room.source.id && finite(m.position) && typeof m.playing==='boolean') {
          if(room.source.type==='file' && m.playing && [...room.people.values()].some(x=>!x.ready || x.ws?.readyState!==WebSocket.OPEN)) return send(ws,{type:'error',message:'Wait until every device has received and loaded the file.'});
          room.playback={position:m.position,playing:m.playing,updatedAt:Date.now(),revision:room.playback.revision+1};
          broadcast(room,{type:'playback',sourceId:room.source.id,playback:room.playback,from:p.id,serverTime:Date.now()});
        }
        else if(m.type==='anchor' && p.id===room.hostId && m.sourceId===room.source?.id && room.playback.playing && finite(m.position)) {
          room.playback={...room.playback,position:m.position,updatedAt:Date.now()};broadcast(room,{type:'anchor',sourceId:room.source.id,playback:room.playback,serverTime:Date.now()});
        }
        else if(m.type==='signal') {
          const target=room.people.get(m.to);if(!target || target===p || !m.signal || typeof m.signal!=='object') return;
          send(target.ws,{type:'signal',from:p.id,signal:m.signal});
        }
      }catch {send(ws,{type:'error',message:'Invalid request'});}
    });
    ws.on('close',()=>{clearTimeout(unauthTimeout);const p=ws.person;if(p && p.ws===ws && clients.has(p.token)){p.ws=null;const room=rooms.get(p.code);if(room)state(room);p.timer=setTimeout(()=>remove(p),graceMs);}});
  });
  const maintenance=setInterval(()=>{
    for(const ws of wss.clients){if(!ws.alive) {ws.terminate();continue;}ws.alive=false;ws.ping();}
    const now=Date.now();for(const [key,b]of buckets)if(b.until<now)buckets.delete(key);
    for(const room of rooms.values()) if(now-room.createdAt>12*3600000) {const host=room.people.get(room.hostId);broadcast(room,{type:'ended',message:'This room expired after 12 hours.'});remove(host);host.ws?.close();}
  },30000);maintenance.unref();
  return {server,rooms,close:async()=>{clearInterval(maintenance);for(const p of clients.values())clearTimeout(p.timer);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createXparty();app.server.listen(Number(process.env.PORT||8787),'0.0.0.0',()=>console.log('Xparty listening on '+(process.env.PORT||8787)));
  const stop=()=>app.close().then(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
