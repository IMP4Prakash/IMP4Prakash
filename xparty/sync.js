export function youtubeId(input) {
  if(/^[\w-]{11}$/.test(input))return input;
  try{const u=new URL(input);if(!['https:','http:'].includes(u.protocol))return null;let id;
    if(u.hostname==='youtu.be')id=u.pathname.split('/')[1];
    else if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(u.hostname))id=u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
    return /^[\w-]{11}$/.test(id||'')?id:null;
  }catch{return null;}
}
export function targetPosition(playback,serverNow){return Math.max(0,playback.position+(playback.playing&&!playback.waitingFor?.length?Math.max(0,serverNow-playback.updatedAt)/1000:0));}
export function correction(drift,explicit,msSinceCorrection){if(explicit&&Math.abs(drift)>.15)return 'seek';if(Math.abs(drift)>.65&&msSinceCorrection>1500)return 'seek';if(Math.abs(drift)>.25)return 'rate';return 'none';}
