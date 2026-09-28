// Public YouTube results fallback; no account cookies, private API keys, or login bypass.
// Prefer the documented Data API when YOUTUBE_API_KEY is configured.
export function extractResults(html) {
  const marker = /(?:var\s+ytInitialData\s*=|window\["ytInitialData"\]\s*=)/g;
  const match=marker.exec(html);if(!match)return [];
  const start=html.indexOf('{',match.index);let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=start;i<html.length;i++){const c=html[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}}
  if(end<0)return [];const root=JSON.parse(html.slice(start,end)),items=[],seen=new Set();
  const walk=node=>{if(!node||typeof node!=='object')return;const v=node.videoRenderer||node.playlistVideoRenderer;
    if(v&&/^[\w-]{11}$/.test(v.videoId)&&!seen.has(v.videoId)){seen.add(v.videoId);items.push({id:v.videoId,title:v.title?.simpleText||v.title?.runs?.map(r=>r.text).join('')||'YouTube video',channel:v.ownerText?.runs?.map(r=>r.text).join('')||v.shortBylineText?.runs?.map(r=>r.text).join('')||'YouTube',thumbnail:'https://i.ytimg.com/vi/'+v.videoId+'/mqdefault.jpg'});}
    for(const value of Object.values(node))if(value&&typeof value==='object')walk(value);
  };walk(root);return items.slice(0,12);
}
export async function searchYouTube(q) {
  if(process.env.YOUTUBE_API_KEY){const query=new URLSearchParams({part:'snippet',type:'video',videoEmbeddable:'true',maxResults:'12',q,key:process.env.YOUTUBE_API_KEY});const r=await fetch('https://www.googleapis.com/youtube/v3/search?'+query,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('YouTube API search is unavailable. Check the configured key and quota.');const b=await r.json();return b.items.map(i=>({id:i.id.videoId,title:i.snippet.title,channel:i.snippet.channelTitle,thumbnail:i.snippet.thumbnails.medium.url}));}
  const r=await fetch('https://www.youtube.com/results?'+new URLSearchParams({search_query:q,hl:'en'}),{headers:{'User-Agent':'Mozilla/5.0 (compatible; Xparty/0.2; watch-party search)','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error('YouTube public search is unavailable. The owner can enable the official search API in Render.');
  const text=await r.text();if(text.length>10000000)throw Error('Search response too large');const items=extractResults(text);
  if(!items.length)throw Error('YouTube did not return usable public results. The owner can enable YOUTUBE_API_KEY in Render for supported in-app search.');return items;
}
