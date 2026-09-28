// Contract test with an explicitly simulated IFrame API, not a real YouTube streaming test.
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--allow-loopback-in-peer-connection']});
 try{
  const a=await browser.newPage(),b=await browser.newPage();
  for(const p of[a,b])await p.route('https://www.youtube.com/iframe_api',route=>route.fulfill({contentType:'text/javascript',body:`window.YT={Player:class{constructor(id,o){this.options=o;this.position=0;this.state=2;window.fakeYT=this;this.seeks=0;setTimeout(()=>o.events.onReady({target:this}),0);setInterval(()=>{if(this.state===1)this.position+=.1},100);}cueVideoById(id){this.id=id;this.position=0;this.state=2;}setVolume(n){this.volume=n;}stopVideo(){this.state=2;}getCurrentTime(){return this.position;}getDuration(){return 180;}getPlayerState(){return this.state;}seekTo(n){this.position=n;this.seeks++;}playVideo(){this.state=1;this.options.events.onStateChange({data:1});}pauseVideo(){this.state=2;this.options.events.onStateChange({data:2});}}};window.onYouTubeIframeAPIReady();`}));
  await a.goto('http://localhost:8787/xparty/');await a.click('#create-toggle');await a.click('#create');await a.waitForSelector('#room:not([hidden])');const code=await a.locator('#room-code').textContent();
  await b.goto('http://localhost:8787/xparty/');await b.fill('#code',code);await b.locator('#join-form button').click();await b.waitForSelector('#room:not([hidden])');
  await a.fill('#youtube-input','https://youtu.be/dQw4w9WgXcQ');await a.click('#load-video');await a.getByRole('button',{name:'Play now',exact:true}).click();await b.waitForFunction(()=>window.fakeYT?.id==='dQw4w9WgXcQ');
  await a.click('#play');await b.waitForFunction(()=>window.fakeYT?.state===1);
  await a.waitForFunction(()=>window.fakeYT.position>3);await b.evaluate(()=>{fakeYT.position-=2;});await b.waitForTimeout(2000);const times=await Promise.all([a,b].map(p=>p.evaluate(()=>fakeYT.position)));assert.ok(Math.abs(times[0]-times[1])<.4,JSON.stringify(times));console.log('PASS: Injected 2-second YouTube drift corrected; remaining difference='+Math.abs(times[0]-times[1]).toFixed(3)+'s');
  const before=await b.evaluate(()=>{fakeYT.state=3;fakeYT.options.events.onStateChange({data:3});return fakeYT.seeks;});await b.waitForTimeout(2500);assert.equal(await b.evaluate(()=>fakeYT.seeks),before,'Automatic seeks must not restart buffering');await b.evaluate(()=>{fakeYT.state=1;fakeYT.options.events.onStateChange({data:1});});await b.waitForTimeout(2500);console.log('PASS: No seek loop while buffering; playback recovers afterward');
  await b.evaluate(()=>{fakeYT.state=2;fakeYT.options.events.onStateChange({data:2});});await b.waitForTimeout(1800);assert.equal(await a.evaluate(()=>fakeYT.state),1,'A local player pause must not broadcast a shared pause');await b.waitForFunction(()=>fakeYT.state===1);console.log('PASS: Native player events cannot overwrite shared playback');
  await b.click('#forward10');await a.waitForFunction(()=>window.fakeYT?.position>9);
  await b.click('#play');await a.waitForFunction(()=>window.fakeYT?.state===2);
  await a.locator('#movie-volume').fill('25');assert.equal(await a.evaluate(()=>fakeYT.volume),25);assert.equal(await b.evaluate(()=>fakeYT.volume),70);
  console.log('PASS: Simulated YouTube API contract: source, play, guest seek/pause, independent movie volume. Actual YouTube streaming not validated.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
