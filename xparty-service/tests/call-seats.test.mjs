import test from 'node:test';import assert from 'node:assert/strict';import {createCallSeats} from '../call-seats.mjs';
test('controlled call seats require the host; microphone offers never enable devices or exceed capacity',()=>{
 const events=[],host={id:'h',inCall:true},guest={id:'g',inCall:false,mic:false,camera:false},other={id:'o',inCall:false};
 for(const p of[host,guest,other])p.ws={id:p.id};const r={hostId:'h',mode:'HOST_ONLY',people:new Map([host,guest,other].map(p=>[p.id,p]))};
 const seats=createCallSeats({online:p=>!!p.ws,send:(ws,m)=>events.push({to:ws.id,...m}),state:()=>{},rate:()=>true});
 seats.handle(r,guest,{type:'call-join'});assert.equal(guest.inCall,false);assert.equal(guest.seatRequested,true);
 seats.handle(r,other,{type:'review-seat',target:'g',approve:true});assert.equal(guest.inCall,false);
 seats.handle(r,host,{type:'review-seat',target:'g',approve:true});assert.equal(guest.inCall,true);assert.equal(guest.cameraAllowed,true);assert.equal(guest.mic,false);assert.equal(guest.camera,false);
 seats.handle(r,guest,{type:'call-leave'});assert.equal(guest.cameraAllowed,false);seats.handle(r,guest,{type:'call-join'});seats.handle(r,host,{type:'review-seat',target:'g',approve:false});assert.equal(guest.inCall,false);assert.equal(guest.seatRequested,false);
 seats.handle(r,other,{type:'offer-mic',target:'g'});assert.equal(guest.inCall,false);seats.handle(r,host,{type:'offer-mic',target:'g'});assert.equal(guest.inCall,true);assert.equal(guest.cameraAllowed,false);assert.equal(guest.mic,false);assert(events.some(e=>e.to==='g'&&e.action==='offer-mic'));
 for(const id of['x','y','z'])r.people.set(id,{id,inCall:true,ws:{id}});seats.handle(r,host,{type:'offer-mic',target:'o'});assert.equal(other.inCall,false);
 for(const id of['x','y','z'])r.people.delete(id);r.mode='SHARED_CONTROL';seats.handle(r,other,{type:'call-join'});assert.equal(other.inCall,true);
});
