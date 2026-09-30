// Call-seat permissions are separate from the playback controller.
export function createCallSeats({online,send,state,rate}) {
 const count=r=>[...r.people.values()].filter(p=>online(p)&&p.inCall).length;
 const full=(r,p)=>!p.inCall&&count(r)>=4;
 function join(r,p){p.inCall=true;p.callSeatApproved=true;p.seatRequested=false;p.session=(p.session||0)+1;}
 function handle(r,p,m){
  const host=r.hostId===p.id;
  if(m.type==='call-join'){
   if(p.inCall)return true;
   if(full(r,p)){send(p.ws,{type:'error',message:'All four call seats are occupied. You can still watch and chat.'});return true;}
   if(!host&&r.mode!=='SHARED_CONTROL'){
    if(!p.seatRequested&&rate('call-seat:'+p.id,6,60000)){p.seatRequested=true;state(r);}
    send(p.ws,{type:'call-seat-status',status:'pending'});return true;
   }
   join(r,p);state(r);return true;
  }
  if(m.type==='call-leave'){p.inCall=false;p.callSeatApproved=false;p.seatRequested=false;p.mic=false;p.camera=false;p.cameraAllowed=host;p.cameraRequested=false;state(r);return true;}
  if(m.type==='review-seat'){
   if(!host)return true;const target=r.people.get(m.target);
   if(!target||!online(target)||!target.seatRequested)return true;
   if(m.approve===true){if(full(r,target)){send(p.ws,{type:'error',message:'All four call seats are occupied.'});return true;}join(r,target);target.cameraAllowed=true;}
   else target.seatRequested=false;
   send(target.ws,{type:'call-seat-status',status:m.approve===true?'approved':'declined'});state(r);return true;
  }
  if(m.type==='offer-mic'){
   if(!host)return true;const target=r.people.get(m.target);
   if(!target||target===p||!online(target))return true;
   if(full(r,target)){send(p.ws,{type:'error',message:'A call seat must be free before offering a microphone.'});return true;}
   if(!target.inCall)join(r,target);
   target.micBlocked=false;send(target.ws,{type:'moderation',action:'offer-mic'});state(r);return true;
  }
  return false;
 }
 return {handle};
}
