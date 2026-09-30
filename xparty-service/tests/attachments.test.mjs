import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createXparty} from '../server.mjs';
async function client(port){const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:'http://localhost:8787'}),queue=[];ws.on('message',v=>queue.push(JSON.parse(v)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return {ws,send:(type,data={})=>ws.send(JSON.stringify({type,...data})),async next(type,p=()=>true){for(let n=0;n<200;n++){const i=queue.findIndex(v=>v.type===type&&p(v));if(i>=0)return queue.splice(i,1)[0];await new Promise(r=>setTimeout(r,10));}throw Error('Missing '+type);},queue};}
test('attachments stay inside room and recipient, revoke on kick/end, reject forged MIME and recipient',async()=>{
 const app=createXparty();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port,base=`http://127.0.0.1:${port}`;
 try{const a=await client(port);a.send('create',{capacity:4});const aw=await a.next('welcome');const b=await client(port),c=await client(port),outsider=await client(port);b.send('join',{code:aw.room.code});const bw=await b.next('welcome');c.send('join',{code:aw.room.code});const cw=await c.next('welcome');outsider.send('create');const ow=await outsider.next('welcome');
 const upload=async(headers={},bytes=Buffer.from('hello'))=>fetch(base+'/api/attachment',{method:'POST',headers:{Authorization:'Bearer '+aw.token,'X-Attachment-Name':encodeURIComponent('photo.gif'),'Content-Type':'image/gif',...headers},body:bytes});
 const response=await upload({'X-Attachment-To':bw.id});assert.equal(response.status,201);const {attachment}=await response.json();assert.equal(attachment.mime,'application/octet-stream');a.send('chat',{attachmentId:attachment.id,to:cw.id});await a.next('error');a.send('chat',{attachmentId:attachment.id,to:bw.id});const message=await b.next('chat');assert.equal(message.attachment.id,attachment.id);await a.next('chat');assert.equal(c.queue.some(v=>v.type==='chat'),false);
 const get=token=>fetch(base+'/api/attachment/'+attachment.id,{headers:{Authorization:'Bearer '+token}});
 assert.equal((await get(cw.token)).status,404);assert.equal((await get(ow.token)).status,404);assert.equal((await get(bw.token)).status,200);const mine=await get(aw.token);assert.match(mine.headers.get('content-disposition'),/^attachment/);assert.equal(await mine.text(),'hello');
 a.send('kick',{target:bw.id});await b.next('kicked');assert.equal((await get(bw.token)).status,401);
 const denied=await upload({'X-Attachment-To':'missing'});assert.equal(denied.status,400);
 a.send('moderate',{target:cw.id,action:'block-chat'});await c.next('moderation');const blocked=await fetch(base+'/api/attachment',{method:'POST',headers:{Authorization:'Bearer '+cw.token},body:'x'});assert.equal(blocked.status,403);
 a.send('end-room');await a.next('ended');assert.equal((await get(aw.token)).status,401);
 }finally{await app.close();}
});
test('vote mode plays top vote while automatic mode keeps queue order',async()=>{
 const app=createXparty();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const port=app.server.address().port;
 try{const a=await client(port);a.send('create');const aw=await a.next('welcome');a.send('queue-add',{videoId:'dQw4w9WgXcQ',title:'First'});await a.next('state',v=>v.room.queue.length===1);a.send('queue-add',{videoId:'abcdefghijk',title:'Second'});const r=(await a.next('state',v=>v.room.queue.length===2)).room;a.send('queue-vote',{id:r.queue[1].id});await a.next('state',v=>v.room.queue[1]?.votes?.length===1);a.send('autoplay',{enabled:false});await a.next('state',v=>v.room.autoplay===false);a.send('next');assert.equal((await a.next('state',v=>v.room.source)).room.source.title,'Second');a.send('autoplay',{enabled:true});a.send('next');assert.equal((await a.next('state',v=>v.room.source?.title==='First')).room.source.title,'First');
 }finally{await app.close();}
});
