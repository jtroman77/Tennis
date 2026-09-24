const BASES = [
  "https://api.sofascore.app/api/v1",
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
async function sofa(path){
  let last;
  for(const base of BASES){
    try{
      const r=await fetch(base+path,{headers:{
        "Accept":"application/json",
        "User-Agent":"Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      }});
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
  const common=na.filter(x=>wa.includes(x)).length;
  return common*15;
}
async function findPlayer(name){
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
async function profile(id){
  const d=await sofa("/player/"+id);
  return d.player||d;
}
async function lastEvents(id){
  for(const path of ["/player/"+id+"/events/last/0","/player/"+id+"/events/last"]){
    try{
      const d=await sofa(path);
      if(Array.isArray(d.events)) return d.events;
    }catch{}
  }
  return [];
}
function eventSurface(e){
  return surfaceBucket(
    e.groundType || e.surface || e.tournament?.surface ||
    e.tournament?.uniqueTournament?.surface || e.tournament?.category?.name || ""
  );
}
function outcome(e,id){
  const h=e.homeTeam||{},a=e.awayTeam||{};
  const home=String(h.id)===String(id), away=String(a.id)===String(id);
  if(!home&&!away) return null;
  if(e.winnerCode===1) return home;
  if(e.winnerCode===2) return away;
  const hs=Number(e.homeScore?.current),as=Number(e.awayScore?.current);
  if(Number.isFinite(hs)&&Number.isFinite(as)&&hs!==as) return home?hs>as:as>hs;
  return null;
}
function summarize(events,id,target){
  const rows=events.map(e=>({
    event:e,
    surface:eventSurface(e),
    win:outcome(e,id)
  })).filter(x=>x.win!==null).slice(0,10);

  const same=rows.filter(x=>{
    if(target==="hard") return x.surface==="hard"||x.surface==="indoor hard";
    return x.surface===target;
  });

  const wins=a=>a.filter(x=>x.win).length;
  const pct=a=>a.length ? 100*wins(a)/a.length : null;

  let streak=0,streakType="";
  for(const r of rows){
    const t=r.win?"W":"L";
    if(!streakType){streakType=t;streak=1}
    else if(t===streakType) streak++;
    else break;
  }

  return {
    recentMatches:rows.length,
    recentWins:wins(rows),
    recentLosses:rows.length-wins(rows),
    recentWinPct:pct(rows),
    surfaceMatches:same.length,
    surfaceWins:wins(same),
    surfaceLosses:same.length-wins(same),
    surfaceWinPct:pct(same),
    streak:streak?`${streakType}${streak}`:"N/A"
  };
}
function rankScore(rank){
  const r=Number(rank);
  if(!(r>0)) return 50;
  return Math.max(35,Math.min(88,100-18*Math.log10(Math.max(1,r))));
}
function safe(v){return v==null?null:v}

export default {
  async fetch(request){
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{headers:cors()});

    if(url.pathname==="/health"){
      return new Response(JSON.stringify({ok:true,service:"roman-tennis-v6"}),{headers:cors()});
    }

    if(url.pathname==="/image"){
      const id=url.searchParams.get("id");
      if(!id) return new Response("Missing id",{status:400,headers:cors("text/plain")});
      const imageUrl=`https://api.sofascore.app/api/v1/player/${encodeURIComponent(id)}/image`;
      const r=await fetch(imageUrl,{headers:{"User-Agent":"Mozilla/5.0"}});
      if(!r.ok) return new Response(null,{status:404,headers:cors("text/plain")});
      const h=cors(r.headers.get("content-type")||"image/png");
      h["Cache-Control"]="public, max-age=86400";
      return new Response(r.body,{status:200,headers:h});
    }

    if(url.pathname!=="/compare"){
      return new Response(JSON.stringify({ok:false,error:"Use /compare"}),{status:404,headers:cors()});
    }

    const n1=url.searchParams.get("player1");
    const n2=url.searchParams.get("player2");
    const surface=surfaceBucket(url.searchParams.get("surface"));
    if(!n1||!n2){
      return new Response(JSON.stringify({ok:false,error:"player1 and player2 required"}),{status:400,headers:cors()});
    }

    try{
      const [hit1,hit2]=await Promise.all([findPlayer(n1),findPlayer(n2)]);
      const [p1,p2,e1,e2]=await Promise.all([
        profile(hit1.id),profile(hit2.id),lastEvents(hit1.id),lastEvents(hit2.id)
      ]);

      const s1=summarize(e1,hit1.id,surface);
      const s2=summarize(e2,hit2.id,surface);

      const rank1=p1.ranking ?? p1.rank ?? hit1.ranking ?? null;
      const rank2=p2.ranking ?? p2.rank ?? hit2.ranking ?? null;

      let A=0,B=0,W=0;
      if(s1.surfaceWinPct!=null&&s2.surfaceWinPct!=null){
        A+=0.60*s1.surfaceWinPct; B+=0.60*s2.surfaceWinPct; W+=0.60;
      }
      if(s1.recentWinPct!=null&&s2.recentWinPct!=null){
        A+=0.25*s1.recentWinPct; B+=0.25*s2.recentWinPct; W+=0.25;
      }
      A+=0.15*rankScore(rank1); B+=0.15*rankScore(rank2); W+=0.15;
      A/=W; B/=W;

      const edge=Math.abs(A-B);
      const winner=A>=B?p1.name:p2.name;
      const market=edge>=8?"MATCH WINNER":edge>=4?"WIN A SET":"SKIP";

      function pack(p,hit,s,rank,score){
        const slug=p.slug||hit.slug||norm(p.name).replace(/ /g,"-");
        return {
          id:p.id||hit.id,
          name:p.name||hit.name,
          shortName:p.shortName||null,
          slug,
          country:p.country?.name||p.country?.alpha2||null,
          hand:p.plays||p.hand||null,
          ranking:safe(rank),
          rankingPoints:safe(p.rankingPoints||p.ranking_points),
          dateOfBirthTimestamp:safe(p.dateOfBirthTimestamp),
          image:`${url.origin}/image?id=${encodeURIComponent(p.id||hit.id)}`,
          sofascoreProfile:`https://www.sofascore.com/player/${slug}/${p.id||hit.id}`,
          ...s,
          score:+score.toFixed(1)
        };
      }

      return new Response(JSON.stringify({
        ok:true,
        requested:{player1:n1,player2:n2,surface},
        resolved:{
          player1:pack(p1,hit1,s1,rank1,A),
          player2:pack(p2,hit2,s2,rank2,B)
        },
        winner,market,edge:+edge.toFixed(1),
        model:{
          surfaceWeight:60,
          recentWeight:25,
          rankingWeight:15
        }
      }),{headers:cors()});
    }catch(e){
      return new Response(JSON.stringify({ok:false,error:String(e.message||e)}),{status:502,headers:cors()});
    }
  }
};