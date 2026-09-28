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
  a.send('playback',{sourceId:file.id,position:0,playing:true});assert.match((await a.next('error')).message,/Wait/);
  a.send('ready',{sourceId:file.id,ready:true});b.send('ready',{sourceId:file.id,ready:true});await b.next('state',m=>m.room.people.every(p=>p.ready));
  b.send('playback',{sourceId:file.id,position:0,playing:true});assert.equal((await a.next('playback')).playback.playing,true);
  b.ws.close();await new Promise(r=>setTimeout(r,80));const resumed=await client(port);resumed.send('resume',{token:bw.token});assert.equal((await resumed.next('welcome')).id,bw.id);
  resumed.send('leave');await a.next('state',m=>m.room.people.length===1);
  a.send('lock',{locked:true});await a.next('state',m=>m.room.locked);
  const newcomer=await client(port);newcomer.send('join',{code:aw.room.code});assert.match((await newcomer.next('error')).message,/unavailable/);
  a.send('leave');await new Promise(r=>setTimeout(r,60));assert.equal(app.rooms.has(aw.room.code),false);
 }finally{await app.close();}
});
test('video link validation and synchronization avoids small-drift seeks',()=>{
 assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=2'),'dQw4w9WgXcQ');assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),'dQw4w9WgXcQ');assert.equal(youtubeId('https://evil.example/watch?v=dQw4w9WgXcQ'),null);
 assert.equal(targetPosition({position:10,playing:true,updatedAt:1000},3500),12.5);assert.equal(targetPosition({position:10,playing:false,updatedAt:1000},3500),10);
 assert.equal(correction(.1,false,99999),'none');assert.equal(correction(.6,false,99999),'rate');assert.equal(correction(3,false,1000),'rate');assert.equal(correction(3,false,10000),'seek');assert.equal(correction(20,true,0),'seek');
});
