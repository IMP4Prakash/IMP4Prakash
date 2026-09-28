import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createXparty} from '../server.mjs';
import {youtubeId,targetPosition,correction} from '../public/xparty/sync.js';
const origin='http://localhost:8787';
async function client(port){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin});const queue=[];ws.on('message',d=>queue.push(JSON.parse(d)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return{ws,send:(type,data={})=>ws.send(JSON.stringify({type,...data})),async next(type,predicate=()=>true){const start=Date.now();while(Date.now()-start<2000){const i=queue.findIndex(m=>m.type===type&&predicate(m));if(i!==-1)return queue.splice(i,1)[0];await new Promise(r=>setTimeout(r,10));}throw new Error('Missing '+type);},queue};}
test('room access, sync, signaling, readiness, resume and end-to-end cleanup',async()=>{
 const app=createXparty({graceMs:3000});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port;
 try{
  const health=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(health.status,200);
  await new Promise(resolve=>{const bad=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:'https://evil.example'});bad.on('error',()=>resolve());bad.on('open',()=>assert.fail('Foreign origin accepted'));});
  const a=await client(port);a.send('create',{name:'Host',capacity:2});const aw=await a.next('welcome');assert.match(aw.room.code,/^[A-Z2-9]{8}$/);
  const b=await client(port);b.send('join',{code:'ZZZZZZZZ'});assert.match((await b.next('error')).message,/unavailable/);b.send('join',{code:aw.room.code,name:'Guest'});const bw=await b.next('welcome');assert.equal(bw.room.people.length,2);
  const third=await client(port);third.send('join',{code:aw.room.code});assert.match((await third.next('error')).message,/full/);
  third.send('create',{capacity:4});const tw=await third.next('welcome');assert.equal(tw.room.capacity,4);
  a.send('signal',{to:tw.id,signal:{description:{type:'offer',sdp:'no'}}});await new Promise(r=>setTimeout(r,50));assert.equal(third.queue.some(m=>m.type==='signal'),false);
  a.send('chat',{text:'<script>alert(1)</script>'});assert.equal((await b.next('chat')).text,'<script>alert(1)</script>');assert.equal(third.queue.some(m=>m.type==='chat'),false);
  b.send('source',{source:{type:'youtube',videoId:'dQw4w9WgXcQ'}});await new Promise(r=>setTimeout(r,50));assert.equal(app.rooms.get(aw.room.code).source,null);
  a.send('source',{source:{type:'youtube',videoId:'dQw4w9WgXcQ'}});const source=(await b.next('state',m=>m.room.source?.type==='youtube')).room.source;
  b.send('playback',{sourceId:source.id,position:15,playing:true});const playback=await a.next('playback');assert.equal(playback.playback.position,15);assert.equal(playback.playback.playing,true);
  a.send('source',{source:{type:'file',size:1024,mime:'video/mp4',title:'test.mp4'}});const file=(await b.next('state',m=>m.room.source?.type==='file')).room.source;
  b.send('playback',{sourceId:source.id,position:100,playing:true});await new Promise(r=>setTimeout(r,50));assert.equal(app.rooms.get(aw.room.code).playback.playing,false);
  a.send('playback',{sourceId:file.id,position:0,playing:true});assert.match((await a.next('error')).message,/uploading/);
  const uploaded=await fetch(`http://127.0.0.1:${port}/api/file/${file.id}`,{method:'PUT',headers:{Authorization:'Bearer '+aw.token,'X-File-Offset':'0'},body:Buffer.alloc(1024,42)});assert.equal(uploaded.status,200);
  const download=await fetch(`http://127.0.0.1:${port}/api/file/${file.id}`,{headers:{Authorization:'Bearer '+bw.token}});assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.alloc(1024,42));
  a.send('ready',{sourceId:file.id,ready:true});b.send('ready',{sourceId:file.id,ready:true});await b.next('state',m=>m.room.people.every(p=>p.ready));
  b.send('playback',{sourceId:file.id,position:0,playing:true});assert.equal((await a.next('playback')).playback.playing,true);
  b.ws.close();await new Promise(r=>setTimeout(r,80));const resumed=await client(port);resumed.send('resume',{token:bw.token});assert.equal((await resumed.next('welcome')).id,bw.id);
  resumed.send('request-camera');await a.next('state',m=>m.room.people.some(p=>p.id===bw.id&&p.cameraRequested));
  a.send('moderate',{target:bw.id,action:'approve-camera'});await resumed.next('moderation');resumed.send('media',{camera:true,mic:true});await a.next('state',m=>m.room.people.some(p=>p.id===bw.id&&p.camera));
  a.send('moderate',{target:bw.id,action:'mute'});await resumed.next('moderation',m=>m.action==='mute');await a.next('state',m=>m.room.people.some(p=>p.id===bw.id&&p.micBlocked&&!p.mic));
  resumed.send('queue-add',{videoId:'dQw4w9WgXcQ',title:'Queue test'});const queued=(await a.next('state',m=>m.room.queue.length===1)).room.queue[0];a.send('vote',{id:queued.id});await a.next('state',m=>m.room.queue[0]?.votes.length===2);
  a.send('transfer-host',{target:bw.id});await resumed.next('state',m=>m.room.hostId===bw.id);resumed.send('transfer-host',{target:aw.id});await a.next('state',m=>m.room.hostId===aw.id);
  a.send('kick',{target:bw.id});await resumed.next('kicked');const rejected=await client(port);rejected.send('resume',{token:bw.token});await rejected.next('resume-failed');
  // Kick revokes the resume credential.
  await a.next('state',m=>m.room.people.length===1);
  a.send('lock',{locked:true});await a.next('state',m=>m.room.locked);
  const newcomer=await client(port);newcomer.send('join',{code:aw.room.code});assert.match((await newcomer.next('error')).message,/unavailable/);
  a.send('end-room');await new Promise(r=>setTimeout(r,60));assert.equal(app.rooms.has(aw.room.code),false);
 }finally{await app.close();}
});
test('video link validation and synchronization avoids small-drift seeks',()=>{
 assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=2'),'dQw4w9WgXcQ');assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),'dQw4w9WgXcQ');assert.equal(youtubeId('https://evil.example/watch?v=dQw4w9WgXcQ'),null);
 assert.equal(targetPosition({position:10,playing:true,updatedAt:1000},3500),12.5);assert.equal(targetPosition({position:10,playing:false,updatedAt:1000},3500),10);
 assert.equal(correction(.1,false,99999),'none');assert.equal(correction(.6,false,99999),'rate');assert.equal(correction(3,false,1000),'rate');assert.equal(correction(2,false,2000),'seek');assert.equal(correction(20,true,0),'seek');
});
test('ten-person capacity, four call seats, private delivery, typing, and owner return',async()=>{
 const app=createXparty();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port;
 try{
 const host=await client(port);host.send('create',{name:'Owner',capacity:2});const hw=await host.next('welcome');host.send('capacity',{capacity:10});await host.next('state',m=>m.room.capacity===10);
 const guests=[];for(let i=0;i<9;i++){const c=await client(port);c.send('join',{code:hw.room.code,name:'Guest '+i});const w=await c.next('welcome');guests.push({c,w});}const r=app.rooms.get(hw.room.code);assert.equal(r.people.size,10);assert.equal([...r.people.values()].filter(p=>p.inCall).length,4);
 const extra=await client(port);extra.send('join',{code:hw.room.code});assert.match((await extra.next('error')).message,/full/);
 const a=guests[0],b=guests[1],watcher=guests[8];watcher.c.send('call-join');assert.match((await watcher.c.next('error')).message,/four/);watcher.c.send('media',{mic:true,camera:true});await host.next('state',m=>m.room.people.some(p=>p.id===watcher.w.id&&!p.mic&&!p.camera));
 a.c.send('chat',{to:b.w.id,text:'Private secret'});assert.equal((await b.c.next('chat')).text,'Private secret');await a.c.next('chat');await new Promise(r=>setTimeout(r,80));assert.equal(host.queue.some(m=>m.type==='chat'),false);assert.equal(watcher.c.queue.some(m=>m.type==='chat'),false);
 a.c.send('typing',{to:b.w.id,active:true});assert.equal((await b.c.next('typing')).from,a.w.id);assert.equal(host.queue.some(m=>m.type==='typing'),false);
 const restored=await client(port);restored.send('resume',{token:watcher.w.token});const rw=await restored.next('welcome');assert.equal(rw.history.some(m=>m.text==='Private secret'),false);
 const restoredB=await client(port);restoredB.send('resume',{token:b.w.token});assert.equal((await restoredB.next('welcome')).history.some(m=>m.text==='Private secret'),true);
 host.send('leave');await a.c.next('state',m=>m.room.hostId===a.w.id);assert.ok(app.rooms.has(hw.room.code));
 const returned=await client(port);returned.send('resume',{token:hw.token});assert.equal((await returned.next('welcome')).room.hostId,hw.id);
 returned.send('end-room');await a.c.next('ended');await restoredB.next('ended');assert.equal(app.rooms.has(hw.room.code),false);
 }finally{await app.close();}
});
