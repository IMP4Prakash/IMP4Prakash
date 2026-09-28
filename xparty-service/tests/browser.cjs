const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright');
const assert=require('node:assert/strict');
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const errors=[];
try{
const desktop=await browser.newContext({viewport:{width:1440,height:1100},permissions:['camera','microphone']});
const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['camera','microphone']});
for(const context of [desktop,mobile])await context.addInitScript(()=>{
  const Orig=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends Orig{constructor(...args){super(...args);window.__pcs??=[];window.__pcs.push(this);for(const event of ['connectionstatechange','iceconnectionstatechange','signalingstatechange','negotiationneeded'])this.addEventListener(event,()=>console.log('RTC',event,this.connectionState,this.iceConnectionState,this.signalingState));}};
});
const a=await desktop.newPage(),b=await mobile.newPage();for(const page of[a,b]){page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{console.log('browser:',m.type(),m.text());});}
await a.goto('http://localhost:8787/xparty/');await a.screenshot({path:'../Xparty-desktop-lobby.png',fullPage:true});
await a.fill('#name','Prakash');await a.click('#create');await a.waitForSelector('#room:not([hidden])');const code=await a.locator('#room-code').innerText();
await b.goto('http://localhost:8787/xparty/');await b.fill('#name','Friend');await b.fill('#code',code);await b.locator('#join-form button').click();await b.waitForSelector('#room:not([hidden])');
await a.waitForFunction(()=>document.querySelector('#call-status').textContent.includes('1/1'),null,{timeout:15000}).catch(async e=>{console.log('DEBUG A',await a.evaluate(()=>({status:document.querySelector('#call-status').textContent,pcs:(window.__pcs||[]).map(p=>({state:p.connectionState,local:p.localDescription?.type,remote:p.remoteDescription?.type}))})));console.log('DEBUG B',await b.evaluate(()=>({status:document.querySelector('#call-status').textContent,pcs:(window.__pcs||[]).map(p=>({state:p.connectionState,local:p.localDescription?.type,remote:p.remoteDescription?.type}))})));throw e;});
await b.waitForFunction(()=>document.querySelector('#call-status').textContent.includes('1/1'));
console.log('PASS: Two independent browser sessions joined by code; actual WebRTC connection established');
await a.fill('#message-input','Ready for movie night?');await a.locator('#chat-form button').click();await b.getByText('Ready for movie night?',{exact:true}).waitFor();
await b.fill('#message-input','<img src=x onerror=alert(1)>');await b.locator('#chat-form button').click();await a.getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await a.locator('#messages img').count(),0);
console.log('PASS: Bidirectional chat; HTML safely rendered as text');
for(const page of [a,b]){await page.click('#mic');await page.waitForFunction(()=>document.querySelector('#mic').textContent==='Mic on',null,{timeout:5000}).catch(async e=>{console.log('MEDIA DEBUG',await page.locator('#toast').textContent());throw e;});await page.click('#camera');await page.waitForFunction(()=>document.querySelector('#camera').textContent==='Camera on',null,{timeout:5000}).catch(async e=>{console.log('CAMERA DEBUG',await page.locator('#toast').textContent());throw e;});console.log('MEDIA buttons on');}
await a.waitForFunction(()=>[...document.querySelectorAll('.participant video')].every(v=>v.videoWidth>0),null,{timeout:8000}).catch(async e=>{console.log('VIDEO DEBUG',await a.locator('.participant video').evaluateAll(vs=>vs.map(v=>({width:v.videoWidth,paused:v.paused,hidden:v.hidden,tracks:v.srcObject?.getTracks().map(t=>({kind:t.kind,enabled:t.enabled,state:t.readyState}))}))));throw e;});
await b.waitForFunction(()=>[...document.querySelectorAll('.participant video')].every(v=>v.videoWidth>0));
for(const page of [a,b])await page.waitForFunction(async()=>{const stats=await Promise.all(window.__pcs.map(p=>p.getStats()));return stats.some(report=>[...report.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0));});
console.log('PASS: Bidirectional decoded synthetic video and received audio packets');
await a.click('#file-tab');await a.setInputFiles('#file-input','tests/sample.webm');
await b.waitForFunction(()=>document.querySelector('#file-player').readyState>=2,{timeout:30000});
await a.waitForFunction(()=>document.querySelector('#transfer-label').textContent.includes('Everyone'));
assert.ok(await b.locator('#file-player').getAttribute('src'));
await a.click('#play');await b.waitForFunction(()=>document.querySelector('#file-player').currentTime>1&&!document.querySelector('#file-player').paused);
const times=await Promise.all([a,b].map(p=>p.locator('#file-player').evaluate(v=>v.currentTime)));assert.ok(Math.abs(times[0]-times[1])<1,JSON.stringify(times));
console.log('PASS: Host-only file selection, real RTCDataChannel transfer and synchronized playback; drift='+Math.abs(times[0]-times[1]).toFixed(3)+'s');
await b.click('#play');await a.waitForFunction(()=>document.querySelector('#file-player').paused);console.log('PASS: Guest pause propagated to host');
await a.screenshot({path:'../Xparty-desktop-room.png',fullPage:true});await b.screenshot({path:'../Xparty-mobile-room.png',fullPage:true});
assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
await b.click('#theater');await b.screenshot({path:'../Xparty-mobile-cinema.png',fullPage:true});
assert.equal(await b.locator('#watch-stage').isVisible(),true);assert.equal(await b.locator('.call-panel').isVisible(),true);
console.log('PASS: 390px mobile layout has no horizontal overflow; cinema keeps film and calls visible');
await b.click('#theater');await b.click('#leave');await a.waitForFunction(()=>document.querySelector('#people-count').textContent==='1/2');
await a.click('#lock');await a.waitForFunction(()=>document.querySelector('#lock').textContent==='Unlock room');
await b.fill('#code',code);await b.locator('#join-form button').click();await b.getByText('Room unavailable. Check the code or ask the host to unlock it.').waitFor();
console.log('PASS: Room lock rejects new joins');
assert.deepEqual(errors,[]);console.log('PASS: No unhandled browser JavaScript errors');
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
