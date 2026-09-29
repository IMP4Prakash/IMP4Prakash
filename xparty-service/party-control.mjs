import {randomUUID} from 'node:crypto';
export const MODES=['HOST_APPROVAL','HOST_ONLY','SHARED_CONTROL'];
export const PENDING=['REQUEST_CREATED','QUEUE_PENDING','HOST_REVIEW'];
export function partyState(r){return {mode:r.mode||'HOST_APPROVAL',controller:r.controller||null,approvalPolicy:r.approvalPolicy||'manual',autoSync:!!r.autoSync,autoPause:!!r.autoPause,requests:(r.requests||[]).slice(-50)};}
export function createPartyControl({online,send,state,execute,now=Date.now,requestMs=30000,lockMs=10000}){
 const position=r=>r.playback.position+(r.playback.playing&&!r.playback.waitingFor?.length?Math.max(0,now()-r.playback.updatedAt)/1000:0);
 const notify=(r,q)=>{send(r.people.get(q.by)?.ws,{type:'request-status',request:q});};
 function finish(r,q,status,reason){q.status=status;q.reason=reason;q.updatedAt=now();notify(r,q);}
 function cancel(r,reason){for(const q of r.requests||[])if(PENDING.includes(q.status))finish(r,q,'CANCELLED',reason);r.controller=null;}
 function mode(r,value){if(!MODES.includes(value))return false;cancel(r,'Party mode changed.');r.mode=value;state(r);return true;}
 function sweep(r){let changed=false;for(const q of r.requests||[])if(PENDING.includes(q.status)&&now()>=q.expiresAt){finish(r,q,'EXPIRED','No decision within 30 seconds.');changed=true;}if(r.controller&&(now()>=r.controller.until||!online(r.people.get(r.controller.id)))){r.controller=null;changed=true;}if(changed)state(r);}
 function approve(r,q){const person=r.people.get(q.by);if(!person||!online(person)){finish(r,q,'CANCELLED','Participant is offline.');return;}if(q.sourceId!==(r.source?.id||null)){finish(r,q,'CANCELLED','The video changed. Send a new request.');return;}
  if(q.action.type==='playback'&&q.action.intent==='seek'&&q.revision!==r.playback.revision){finish(r,q,'CANCELLED','Playback changed while this seek was pending.');return;}
  finish(r,q,'APPROVED','Host approved.');let action={...q.action};if(action.type==='playback'&&action.intent!=='seek')action.position=position(r);
  if(action.type==='party-mode')mode(r,action.mode);else if(action.type==='request-control')r.controller={id:person.id,until:now()+lockMs};else if(execute(person,r,action)!==true){finish(r,q,'CANCELLED','Action could not run. Check video readiness and try again.');return;}
  finish(r,q,'EXECUTED','Approved action dispatched.');
 }
 function request(r,p,action){if((r.mode||'HOST_APPROVAL')==='HOST_ONLY'){send(p.ws,{type:'error',message:'Host Only mode: playback is controlled by the host.'});return;}
  if(action.type==='source'&&(action.source?.type!=='youtube'||!/^[-\w]{11}$/.test(action.source.videoId))){send(p.ws,{type:'error',message:'Guests can request a YouTube video. Local files must be shared by the host.'});return;}
  if(action.type==='party-mode'&&!MODES.includes(action.mode))return;
  r.requests??=[];const fingerprint=JSON.stringify(action);const duplicate=r.requests.find(q=>q.by===p.id&&PENDING.includes(q.status)&&JSON.stringify(q.action)===fingerprint);if(duplicate){notify(r,duplicate);return;}
  if(r.requests.filter(q=>q.by===p.id&&now()-q.createdAt<10000).length>=3||r.requests.filter(q=>PENDING.includes(q.status)).length>=30){send(p.ws,{type:'error',message:'Please wait before sending another request.'});return;}
  const q={id:randomUUID(),by:p.id,name:p.name,action,sourceId:r.source?.id||null,revision:r.playback.revision,createdAt:now(),expiresAt:now()+requestMs,status:'REQUEST_CREATED'};r.requests.push(q);q.status='QUEUE_PENDING';q.status='HOST_REVIEW';while(r.requests.length>80){const i=r.requests.findIndex(x=>!PENDING.includes(x.status));if(i<0)break;r.requests.splice(i,1);}
  if(r.approvalPolicy==='reject')finish(r,q,'REJECTED','Requests are automatically rejected.');else if(r.approvalPolicy==='approve'||(action.type==='resync'&&r.autoSync)||(action.type==='playback'&&!action.playing&&action.intent!=='seek'&&r.autoPause))approve(r,q);else notify(r,q);state(r);
 }
 function handle(r,p,m){sweep(r);if(m.eventId){p.events??=[];if(p.events.includes(m.eventId))return true;p.events.push(m.eventId);if(p.events.length>100)p.events.shift();}if(m.type==='playback'){p.actionTimes=(p.actionTimes||[]).filter(t=>now()-t<1000);if(p.actionTimes.length>=12){send(p.ws,{type:'error',message:'Too many playback actions. Wait a moment.'});return true;}p.actionTimes.push(now());}const host=r.hostId===p.id;
  if(m.type==='review-request'){if(host){const q=(r.requests||[]).find(q=>q.id===m.id&&PENDING.includes(q.status));if(q){if(m.approve===true)approve(r,q);else finish(r,q,'REJECTED','Host declined.');state(r);}}return true;}
  if(m.type==='cancel-request'){const q=(r.requests||[]).find(q=>q.id===m.id&&q.by===p.id&&PENDING.includes(q.status));if(q){finish(r,q,'CANCELLED','Cancelled by requester.');state(r);}return true;}
  if(m.type==='approval-settings'){if(host){if(['manual','approve','reject'].includes(m.policy))r.approvalPolicy=m.policy;r.autoSync=m.autoSync===true;r.autoPause=m.autoPause===true;state(r);}return true;}
  if(m.type==='party-mode'){if(host)mode(r,m.mode);else request(r,p,{type:'party-mode',mode:m.mode});return true;}
  if(m.type==='request-control'){if(!host&&r.mode==='SHARED_CONTROL')request(r,p,{type:'request-control'});return true;}
  const controlled=['playback','source','next','previous','queue-play','queue-add','queue-remove','resync'];if(!controlled.includes(m.type))return false;
  if(m.type==='playback'&&(!Number.isFinite(m.position)||m.position<0||m.position>604800||typeof m.playing!=='boolean'||m.sourceId!==r.source?.id))return true;
  // A reconnect snapshot and periodic anchors are recovery traffic, not guest actions.
  if(host){if(m.type==='playback'&&r.mode==='SHARED_CONTROL'){r.controller={id:p.id,until:now()+lockMs};state(r);}return false;}
  if(r.mode==='SHARED_CONTROL'&&m.type==='playback'&&Math.abs(m.position-position(r))<=60){if(!r.controller||r.controller.id===p.id){r.controller={id:p.id,until:now()+lockMs};state(r);return false;}send(p.ws,{type:'error',message:'Another participant has control for up to 10 seconds. Request control from the key menu.'});return true;}
  const action={type:m.type};for(const key of ['sourceId','position','playing','intent','source','videoId','title','id'])if(m[key]!==undefined)action[key]=m[key];request(r,p,action);return true;
 }
 return {handle,sweep,cancel};
}
