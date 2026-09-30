import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
const LIMIT=20*1048576,ROOM_LIMIT=100*1048576,TOTAL_LIMIT=512*1048576;
function mediaType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'image/gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 if(bytes.subarray(4,8).toString()==='ftyp')return 'video/mp4';
 if(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])))return 'video/webm';
 return 'application/octet-stream';
}
export function createAttachmentStore({online}){
 const items=new Map(),busy=new Set(),reservations=new Map();let used=0,reserved=0;
 function remove(id){const item=items.get(id);if(!item)return;items.delete(id);used-=item.size;rm(item.dir,{recursive:true,force:true}).catch(()=>{});}
 function clearRoom(code){for(const a of items.values())if(a.code===code)remove(a.id);}
 function publish(id,p,to){const a=items.get(id);if(!a||a.owner!==p.id||a.code!==p.code||a.to!==(to||null)||a.published)return null;a.published=true;return {id:a.id,name:a.name,size:a.size,mime:a.mime};}
 async function handle(req,res,url,p,r,json){
  if(url.pathname==='/api/attachment'&&req.method==='POST'){
   if(p.chatBlocked){json(403,{error:'Chat is paused by the host.'});return true;}
   const to=req.headers['x-attachment-to']||null;if(to&&!r.people.has(to)){json(400,{error:'Recipient is no longer in the room.'});return true;}
   if(busy.has(p.id)||busy.size>=3){json(429,{error:'An upload is in progress. Try again shortly.'});return true;}
   const length=Number(req.headers['content-length']);const roomUsed=[...items.values()].filter(a=>a.code===r.code).reduce((n,a)=>n+a.size,0);
   if(!Number.isSafeInteger(length)||length<1||length>LIMIT){json(413,{error:'Attachments must be 20 MB or smaller.'});return true;}
   if(roomUsed+(reservations.get(r.code)||0)+length>ROOM_LIMIT||used+reserved+length>TOTAL_LIMIT){json(413,{error:'Temporary chat storage is full. Try a smaller file or start a new room.'});return true;}
   busy.add(p.id);reserved+=length;reservations.set(r.code,(reservations.get(r.code)||0)+length);let dir;
   try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>LIMIT||size>length){json(413,{error:'Attachment is too large.'});return true;}chunks.push(chunk);}if(size!==length){json(400,{error:'Upload was incomplete.'});return true;}
    if(!online(p)||p.code!==r.code||p.chatBlocked){json(403,{error:'Room connection changed during upload.'});return true;}
    let raw;try{raw=decodeURIComponent(String(req.headers['x-attachment-name']||'file'));}catch{raw='file';}const name=raw.replace(/[\u0000-\u001f\\/]/g,'').trim().slice(0,120)||'file';
    const bytes=Buffer.concat(chunks),id=randomUUID();dir=await mkdtemp(join(tmpdir(),'xparty-chat-'));const path=join(dir,'attachment');await writeFile(path,bytes,{mode:0o600});
    const a={id,code:r.code,owner:p.id,to,name,size,mime:mediaType(bytes),dir,path,published:false,at:Date.now()};items.set(id,a);used+=size;dir=null;json(201,{attachment:{id,name,size,mime:a.mime}});
   }catch{if(!res.headersSent)json(500,{error:'Attachment upload interrupted. Please retry.'});}
   finally{busy.delete(p.id);reserved-=length;reservations.set(r.code,Math.max(0,(reservations.get(r.code)||0)-length));if(dir)await rm(dir,{recursive:true,force:true});}return true;
  }
  const match=url.pathname.match(/^\/api\/attachment\/([\w-]+)$/);if(!match)return false;
  if(req.method!=='GET'){json(405,{error:'Method not allowed'});return true;}
  const a=items.get(match[1]);if(!a||a.code!==p.code||(!a.published&&a.owner!==p.id)||(a.to&&p.id!==a.to&&p.id!==a.owner)){json(404,{error:'Attachment unavailable.'});return true;}
  try{res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':a.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(a.name),'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox"});const stream=createReadStream(a.path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}catch{json(404,{error:'Attachment unavailable.'});}return true;
 }
 const timer=setInterval(()=>{for(const a of items.values())if(Date.now()-a.at>86400000||!a.published&&Date.now()-a.at>300000)remove(a.id);},60000);timer.unref();
 return {handle,publish,remove,clearRoom,close:()=>{clearInterval(timer);for(const id of items.keys())remove(id);}};
}
