const canvas=document.getElementById('character'),ctx=canvas.getContext('2d',{alpha:false});
const COUNT=64, frames=[], center=new Image(); center.src='frames/center.webp';
let loaded=0,targetAngle=-Math.PI/2,currentAngle=targetAngle,useCenter=true,activeTouch=false;
for(let i=0;i<COUNT;i++){const im=new Image();im.src=`frames/${String(i).padStart(2,'0')}.webp`;im.onload=()=>loaded++;frames.push(im)}
function resize(){const d=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(innerWidth*d);canvas.height=Math.round(innerHeight*d);canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';ctx.setTransform(d,0,0,d,0,0)}addEventListener('resize',resize);resize();
function shortest(a,b){let d=(b-a+Math.PI)%(Math.PI*2)-Math.PI;return d<-Math.PI?d+Math.PI*2:d}
function setTarget(x,y){const cx=innerWidth*.56,cy=innerHeight*.42,dx=x-cx,dy=y-cy;const r=Math.hypot(dx,dy),dead=Math.min(innerWidth,innerHeight)*.10;useCenter=r<dead;targetAngle=Math.atan2(dy,dx)}
addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||e.pointerType==='pen'||activeTouch)setTarget(e.clientX,e.clientY)},{passive:true});
addEventListener('pointerdown',e=>{if(e.pointerType==='touch'){activeTouch=true;setTarget(e.clientX,e.clientY)}},{passive:true});
addEventListener('pointerup',e=>{if(e.pointerType==='touch'){activeTouch=false;useCenter=true}},{passive:true});
addEventListener('pointercancel',()=>{activeTouch=false;useCenter=true},{passive:true});
function drawCover(im){if(!im.complete||!im.naturalWidth)return;const sw=im.naturalWidth,sh=im.naturalHeight,s=Math.max(innerWidth/sw,innerHeight/sh),dw=sw*s,dh=sh*s;ctx.drawImage(im,(innerWidth-dw)/2,(innerHeight-dh)/2,dw,dh)}
function loop(){currentAngle+=shortest(currentAngle,targetAngle)*.22;let im=center;if(!useCenter&&loaded){let norm=(currentAngle+Math.PI*2)%(Math.PI*2);let idx=Math.round(norm/(Math.PI*2)*COUNT)%COUNT;im=frames[idx]}ctx.fillStyle='#ef0b0b';ctx.fillRect(0,0,innerWidth,innerHeight);drawCover(im);requestAnimationFrame(loop)}requestAnimationFrame(loop);
