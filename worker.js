const BASES = [
  "https://api.sofascore.app/api/v1",
  "https://api.sofascore.com/api/v1",
  "https://www.sofascore.com/api/v1"
];

function cors(contentType="application/json; charset=utf-8"){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":contentType,
    "Cache-Control":"public, max-age=120"
  };
}
function norm(s){return String(s||"").trim().toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}
function surfaceBucket(s){
  const x=norm(s);
  if(x.includes("clay")) return "clay";
  if(x.includes("grass")) return "grass";
  if(x.includes("indoor")) return "indoor hard";
  if(x.includes("hard")) return "hard";
  return x||"unknown";
}
function browserHeaders(){
  return {
    "Accept":"application/json, text/plain, */*",
    "Accept-Language":"en-US,en;q=0.9",
    "Origin":"https://www.sofascore.com",
    "Referer":"https://www.sofascore.com/",
    "User-Agent":"Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    "X-Requested-With":"XMLHttpRequest"
  };
}
async function sofa(path){
  let last;
  for(const base of BASES){
    try{
      const r=await fetch(base+path,{headers:browserHeaders(),redirect:"follow"});
      if(r.ok) return await r.json();
      last=new Error("Sofascore "+r.status+" on "+path);
    }catch(e){last=e}
  }
  throw last||new Error("Sofascore request failed");
}
function similarity(name,want){
  const n=norm(name), w=norm(want);
  if(n===w) return 100;
  if(n.includes(w)||w.includes(n)) return 70;
  const na=n.split(" "), wa=w.split(" ");
  return na.filter(x=>wa.includes(x)).length*15;
}
async function findViaSearch(name){
  const d=await sofa("/search/all?q="+encodeURIComponent(name));
  const list=(d.results||[]).map(x=>x.entity||x).filter(Boolean);
  const candidates=list.filter(e=>{
    const sport=norm(e.sport?.slug||e.team?.sport?.slug||e.category?.sport?.slug||"");
    const type=norm(e.type||"");
    return e.id && (!sport||sport==="tennis") && (!type||type.includes("player"));
  });
  candidates.sort((a,b)=>similarity(b.name,name)-similarity(a.name,name));
  if(!candidates[0] || similarity(candidates[0].name,name)<15) throw new Error("Player not found: "+name);
  return candidates[0];
}
async function findViaSchedule(name,date){
  if(!date) throw new Error("No date supplied for schedule fallback");
  const d=await sofa("/sport/tennis/scheduled-events/"+encodeURIComponent(date));
  const events=d.events||[];
  const candidates=[];
  for(const e of events){
    for(const t of [e.homeTeam,e.awayTeam]) if(t?.id&&t?.name) candidates.push(t);
  }
  candidates.sort((a,b)=>similarity(b.name,name)-similarity(a.name,name));
  if(!candidates[0] || similarity(candidates[0].name,name)<15) throw new Error("Player not found in schedule: "+name);
  return candidates[0];
}
async function findPlayer(name,date){
  try{return await findViaSearch(name)}
  catch(searchErr){
    try{return await findViaSchedule(name,date)}
    catch(scheduleErr){throw new Error("Lookup failed. Search: "+searchErr.message+" | Schedule: "+scheduleErr.message)}
  }
}
async function profile(id){const d=await sofa("/player/"+id);return d.player||d}
async function lastEvents(id){
  for(const path of ["/player/"+id+"/events/last/0","/player/"+id+"/events/last"]){
    try{const d=await sofa(path);if(Array.isArray(d.events)) return d.events}catch{}
  }
  return [];
}
function eventSurface(e){return surfaceBucket(e.groundType||e.surface||e.tournament?.surface||e.tournament?.uniqueTournament?.surface||"")}
function outcome(e,id){
  const h=e.homeTeam||{},a=e.awayTeam||{};
  const home=String(h.id)===String(id),away=String(a.id)===String(id);
  if(!home&&!away) return null;
  if(e.winnerCode===1) return home;
  if(e.winnerCode===2) return away;
  const hs=Number(e.homeScore?.current),as=Number(e.awayScore?.current);
  if(Number.isFinite(hs)&&Number.isFinite(as)&&hs!==as) return home?hs>as:as>hs;
  return null;
}
function summarize(events,id,target){
  const rows=events.map(e=>({surface:eventSurface(e),win:outcome(e,id)})).filter(x=>x.win!==null).slice(0,10);
  const same=rows.filter(x=>target==="hard"?(x.surface==="hard"||x.surface==="indoor hard"):x.surface===target);
  const wins=a=>a.filter(x=>x.win).length,pct=a=>a.length?100*wins(a)/a.length:null;
  return {recentMatches:rows.length,recentWins:wins(rows),recentLosses:rows.length-wins(rows),recentWinPct:pct(rows),
    surfaceMatches:same.length,surfaceWins:wins(same),surfaceLosses:same.length-wins(same),surfaceWinPct:pct(same)};
}
function rankScore(rank){
  const r=Number(rank); if(!(r>0)) return 50;
  return Math.max(35,Math.min(88,100-18*Math.log10(Math.max(1,r))));
}

export default {
  async fetch(request){
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:cors()});
    if(url.pathname==="/health") return new Response(JSON.stringify({ok:true,service:"roman-tennis-v6.1"}),{headers:cors()});
    if(url.pathname!=="/compare") return new Response(JSON.stringify({ok:false,error:"Use /compare"}),{status:404,headers:cors()});

    const n1=url.searchParams.get("player1"),n2=url.searchParams.get("player2");
    const surface=surfaceBucket(url.searchParams.get("surface"));
    const date=url.searchParams.get("date");
    if(!n1||!n2) return new Response(JSON.stringify({ok:false,error:"player1 and player2 required"}),{status:400,headers:cors()});

    try{
      const [hit1,hit2]=await Promise.all([findPlayer(n1,date),findPlayer(n2,date)]);
      const [p1,p2,e1,e2]=await Promise.all([profile(hit1.id),profile(hit2.id),lastEvents(hit1.id),lastEvents(hit2.id)]);
      const s1=summarize(e1,hit1.id,surface),s2=summarize(e2,hit2.id,surface);
      const rank1=p1.ranking??p1.rank??hit1.ranking??null,rank2=p2.ranking??p2.rank??hit2.ranking??null;

      let A=0,B=0,W=0;
      if(s1.surfaceWinPct!=null&&s2.surfaceWinPct!=null){A+=.60*s1.surfaceWinPct;B+=.60*s2.surfaceWinPct;W+=.60}
      if(s1.recentWinPct!=null&&s2.recentWinPct!=null){A+=.25*s1.recentWinPct;B+=.25*s2.recentWinPct;W+=.25}
      A+=.15*rankScore(rank1);B+=.15*rankScore(rank2);W+=.15;A/=W;B/=W;

      const edge=Math.abs(A-B),winner=A>=B?p1.name:p2.name;
      const market=edge>=8?"MATCH WINNER":edge>=4?"WIN A SET":"SKIP";

      function pack(p,hit,s,rank,score){
        const slug=p.slug||hit.slug||norm(p.name).replace(/ /g,"-"),id=p.id||hit.id;
        return {id,name:p.name||hit.name,slug,country:p.country?.name||p.country?.alpha2||null,ranking:rank,
          image:`https://api.sofascore.app/api/v1/player/${id}/image`,
          sofascoreProfile:`https://www.sofascore.com/player/${slug}/${id}`,...s,score:+score.toFixed(1)};
      }
      return new Response(JSON.stringify({ok:true,requested:{player1:n1,player2:n2,surface,date},
        resolved:{player1:pack(p1,hit1,s1,rank1,A),player2:pack(p2,hit2,s2,rank2,B)},winner,market,edge:+edge.toFixed(1)}),{headers:cors()});
    }catch(e){
      return new Response(JSON.stringify({ok:false,error:String(e.message||e)}),{status:502,headers:cors()});
    }
  }
};