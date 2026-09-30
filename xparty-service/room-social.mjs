import {randomUUID} from 'node:crypto';
export function createRoomSocial({send,broadcast,online,rate,persist}){
 const view=(r,p)=>(r.friendRequests||[]).filter(q=>q.from===p.id||q.to===p.id);
 const notify=(r,q)=>{for(const id of[q.from,q.to]){const p=r.people.get(id);if(p)send(p.ws,{type:'friend-state',requests:view(r,p)});}persist();};
 function handle(r,p,m){
  if(m.type==='friend-request'){
   const target=r.people.get(m.target);if(!target||target===p||!online(target))return send(p.ws,{type:'error',message:'Choose someone currently in your room.'}),true;
   if(!rate('friend:'+p.id,6,60000))return true;r.friendRequests??=[];
   let q=r.friendRequests.find(q=>[q.from,q.to].includes(p.id)&&[q.from,q.to].includes(target.id)&&q.status!=='declined');
   if(!q){q={id:randomUUID(),from:p.id,to:target.id,fromName:p.name,toName:target.name,status:'pending'};r.friendRequests.push(q);if(r.friendRequests.length>100)r.friendRequests.shift();}notify(r,q);return true;
  }
  if(m.type==='friend-review'){
   const q=r.friendRequests?.find(q=>q.id===m.id&&q.to===p.id&&q.status==='pending');if(q&&r.people.has(q.from)){q.status=m.accept===true?'accepted':'declined';notify(r,q);}return true;
  }
  if(m.type==='poll-create'){
   if(p.chatBlocked||!rate('poll-create:'+p.id,3,60000))return true;
   const question=String(m.question||'').trim().slice(0,160),options=Array.isArray(m.options)?m.options.map(x=>String(x).trim().slice(0,80)).filter(Boolean).slice(0,6):[];
   if(!question||options.length<2||new Set(options).size!==options.length)return send(p.ws,{type:'error',message:'Add a question and 2–6 different choices.'}),true;
   const poll={id:randomUUID(),question,options,votes:{},by:p.id};r.polls??=[];r.polls.push(poll);if(r.polls.length>20)r.polls.shift();
   const message={type:'chat',id:randomUUID(),from:p.id,name:p.name,text:'',at:Date.now(),readBy:[],poll};r.history??=[];r.history.push(message);if(r.history.length>100)r.history.shift();broadcast(r,message);persist();return true;
  }
  if(m.type==='poll-vote'){
   if(p.chatBlocked||!rate('poll-vote:'+p.id,30,60000))return true;const poll=r.polls?.find(q=>q.id===m.id);
   if(poll&&Number.isInteger(m.choice)&&m.choice>=0&&m.choice<poll.options.length){poll.votes[p.id]=m.choice;for(const message of r.history||[])if(message.poll?.id===poll.id)message.poll=poll;broadcast(r,{type:'poll-update',poll});persist();}return true;
  }
  return false;
 }
 return {handle,view};
}
