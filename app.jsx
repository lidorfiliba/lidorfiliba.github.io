const {useState,useEffect,useRef}=React;

/* ── SUPABASE AUTH (lazy: script loads only when first hook mounts) ── */
const SUPA_URL='https://flcakringwxebpeifhke.supabase.co';
const SUPA_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsY2FrcmluZ3d4ZWJwZWlmaGtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDk2NTY5NDIsImV4cCI6MjAyNTIzMjk0Mn0.Yw1234placeholder';

let supaPromise=null;
const loadSupa=()=>{
  if(supaPromise)return supaPromise;
  supaPromise=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.crossOrigin='anonymous';
    s.onload=()=>resolve(window.supabase.createClient(SUPA_URL,SUPA_KEY));
    s.onerror=reject;
    document.head.appendChild(s);
  });
  return supaPromise;
};

const useAuth=()=>{
  const [user,setUser]=useState(null);
  const [loading,setLoading]=useState(true);
  const supaRef=useRef(null);
  useEffect(()=>{
    let sub;
    loadSupa().then(client=>{
      supaRef.current=client;
      client.auth.getSession().then(({data:{session}})=>{
        setUser(session?.user??null);
        setLoading(false);
      });
      sub=client.auth.onAuthStateChange((_,session)=>{
        setUser(session?.user??null);
      }).data.subscription;
    }).catch(()=>setLoading(false));
    return()=>{if(sub)sub.unsubscribe();};
  },[]);
  const signOut=async()=>{
    if(supaRef.current)await supaRef.current.auth.signOut();
    setUser(null);
  };
  return{user,loading,signOut};
};

/* ── EmailJS lazy loader (used by PurchaseModal) ── */
let emailPromise=null;
const loadEmail=()=>{
  if(emailPromise)return emailPromise;
  emailPromise=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
    s.onload=()=>{window.emailjs.init("ZWYqaiqD2U5oWexSq");resolve(window.emailjs);};
    s.onerror=reject;
    document.head.appendChild(s);
  });
  return emailPromise;
};

/* ── Order id ──────────────────────────────────────────────────────────
   One id per submitted order, generated on the client at submit time. It
   travels to three places and must be identical in all of them:
     · the EmailJS notification, so the order can be matched by hand
     · the thank-you page URL, where it becomes the Lead event's eventID
     · the admin confirmation page, where it becomes the CAPI Purchase
       event_id — which is what lets Meta deduplicate against the Lead
   Format is SLA-<epoch ms>-<6 random chars>; the thank-you page validates
   against [A-Za-z0-9._-] so keep it inside that alphabet. */
const makeOrderId=()=>{
  const chars='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — these get misread aloud
  let suffix='';
  /* Math.random is fine here: this id only has to be unique, never
     unguessable. It authorises nothing on its own. */
  for(let i=0;i<6;i++)suffix+=chars[Math.floor(Math.random()*chars.length)];
  return `SLA-${Date.now()}-${suffix}`;
};

/* Fire-and-forget pixel helper — never let a tracking failure break a sale. */
const track=(ev,params,opts)=>{
  if(!window.fbq)return;
  try{window.fbq('track',ev,params,opts);}catch(e){}
};

/* ── Israeli mobile format ─────────────────────────────────────────────────
   Ten digits beginning 05, which covers every Israeli mobile prefix
   (050/052/053/054/055/058...). Separators people actually type — dashes,
   spaces, dots, brackets — are stripped before the test, and a +972 / 972
   country prefix is normalised to the local 0 form, so a valid number is not
   rejected over punctuation. This is a FORMAT check only: it says the number
   is shaped like an Israeli mobile, not that it exists or belongs to anyone. */
const normalisePhone=raw=>{
  let d=(raw||'').replace(/[^\d+]/g,'');
  if(d.startsWith('+972'))d='0'+d.slice(4);
  else if(d.startsWith('972'))d='0'+d.slice(3);
  return d.replace(/\D/g,'');
};
const isIsraeliMobile=raw=>/^05\d{8}$/.test(normalisePhone(raw));

/* ── Durable order backup ──────────────────────────────────────────────────
   Writes the order to the `orders` table via the log-order Edge Function, so
   an order survives EmailJS being down or the mail landing in spam.

   Deliberately never throws and never returns a rejected promise: the caller
   awaits it on the path to the redirect, and a backup that cannot be written
   must not cost the customer their email or their thank-you page. Failures are
   logged to the console and swallowed. The anon key below is the same public
   key already in this page; the service_role key that actually writes the row
   lives only inside the Edge Function. */
const SB_URL='https://flcakringwxebpeifhke.supabase.co';
const SB_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsY2FrcmluZ3d4ZWJwZWlmaGtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTIwMjAsImV4cCI6MjA4OTA4ODAyMH0.-j-id8o3FeYig15Xmq6QHV4eDMXUB98e3Z8p30Eaf2U';

const logOrder=async payload=>{
  try{
    /* Capped so a hung request cannot hold the customer on a spinner. The
       order still reaches EmailJS either way. */
    const ctrl=typeof AbortController!=='undefined'?new AbortController():null;
    const timer=ctrl?setTimeout(()=>ctrl.abort(),8000):null;
    const r=await fetch(SB_URL+'/functions/v1/log-order',{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_ANON,'Authorization':'Bearer '+SB_ANON},
      body:JSON.stringify({action:'create',...payload}),
      signal:ctrl?ctrl.signal:undefined,
    });
    if(timer)clearTimeout(timer);
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok){console.error('[log-order] order backup failed',r.status,d);return false;}
    return true;
  }catch(e){
    console.error('[log-order] order backup failed',e);
    return false;
  }
};


/* ══════════════ ICONS ══════════════ */
const Ic={
  Lens:({s=32})=>(
    <svg width={s} height={s} viewBox="0 0 32 32" fill="none">
      <circle cx="13" cy="13" r="9.5" stroke="#00E5A0" strokeWidth="2"/>
      <circle cx="13" cy="13" r="4" stroke="#00E5A0" strokeWidth="1.6"/>
      <line x1="20" y1="20" x2="27" y2="27" stroke="#00E5A0" strokeWidth="2.6" strokeLinecap="round"/>
      <polyline points="7,13 9.5,10.5 13,12 16.5,8 19.5,9" stroke="#00E5A0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),
  Check:({size=18,color='#00E5A0'})=>(
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" style={{flexShrink:0}}>
      <circle cx="10" cy="10" r="9.5" fill={color+'18'} stroke={color+'40'}/>
      <polyline points="6,10 9,13 14,7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ArrowL:()=>(<svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="15" y1="9" x2="3" y2="9"/><polyline points="8,4 3,9 8,14"/></svg>),
  ChevronDown:()=>(<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="4,6 8,10 12,6"/></svg>),
  BarChart:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="12" width="4" height="8" rx="1"/><rect x="9" y="6" width="4" height="14" rx="1"/><rect x="16" y="2" width="4" height="18" rx="1"/></svg>),
  Compare:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="9" height="16" rx="2"/><rect x="13" y="2" width="9" height="18" rx="2"/></svg>),
  Versus:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="3" x2="19" y2="19"/><line x1="19" y1="3" x2="3" y2="19"/></svg>),
  Brain:()=>(<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A4.5 4.5 0 0 1 14 6.5v1a2.5 2.5 0 0 0 2.5 2.5h.5a3 3 0 0 1 0 6h-.5a2.5 2.5 0 0 0-2.5 2.5V20"/><path d="M9.5 2a4.5 4.5 0 0 0-4.5 4.5v.5a3 3 0 0 1-3 3 3 3 0 0 0 0 6 3 3 0 0 1 3 3V20"/><line x1="10" y1="20" x2="14" y2="20"/></svg>),
  Star:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polygon points="11,2 13.9,8.6 21,9.7 16,14.5 17.2,21.5 11,18.1 4.8,21.5 6,14.5 1,9.7 8.1,8.6"/></svg>),
  Globe:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="10"/><line x1="1" y1="11" x2="21" y2="11"/><path d="M11 1a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>),
  Layers:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polygon points="11,2 21,7 11,12 1,7"/><polyline points="1,12 11,17 21,12"/><polyline points="1,17 11,22 21,17"/></svg>),
  Grid:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8" rx="1.5"/><rect x="13" y="2" width="8" height="8" rx="1.5"/><rect x="2" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>),
  Crown:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17L5.5 7 11 12 14.5 3 18 12 20.5 7 19 17Z"/><line x1="3" y1="20" x2="19" y2="20"/></svg>),
  Menu:()=>(<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="3" y1="5" x2="19" y2="5"/><line x1="3" y1="11" x2="19" y2="11"/><line x1="3" y1="17" x2="19" y2="17"/></svg>),
  X:()=>(<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" y1="4" x2="18" y2="18"/><line x1="18" y1="4" x2="4" y2="18"/></svg>),
  StarFill:()=>(<svg width="13" height="13" viewBox="0 0 13 13" fill="#F7C948"><polygon points="6.5,1 8.1,4.8 12.4,5.2 9.3,8.1 10.2,12.4 6.5,10.2 2.8,12.4 3.7,8.1 0.6,5.2 4.9,4.8"/></svg>),
  Shield:()=>(<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#00E5A0" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7 3.5-.5 6-3.5 6-7V4L8 1z"/></svg>),
  Zap:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polygon points="13,2 3,14 12,14 9,22 20,10 11,10"/></svg>),
  BookOpen:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h7a2 2 0 0 1 2 2v14a1 1 0 0 1-1-1H2z"/><path d="M20 3h-7a2 2 0 0 0-2 2v14a1 1 0 0 0 1-1h8z"/></svg>),
  TrendUp:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="22,7 13.5,15.5 8.5,10.5 2,17"/><polyline points="16,7 22,7 22,13"/></svg>),
  Users:()=>(<svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>),
  Lock:()=>(<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#00E5A0" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>),
  Refresh:()=>(<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#00E5A0" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="1,4 1,10 7,10"/><path d="M3.5 10A6 6 0 1 0 5 5.5"/></svg>),
};

/* ══════════════ HERO CHART ══════════════ */
const HeroChart=()=>{
  const lp="M10,168 C28,158 36,165 55,148 S88,132 108,140 S138,116 162,122 S192,100 215,106 S245,86 268,91 S298,70 318,65 S350,52 370,44 S394,30 418,26";
  const fp="M10,168 C28,158 36,165 55,148 S88,132 108,140 S138,116 162,122 S192,100 215,106 S245,86 268,91 S298,70 318,65 S350,52 370,44 S394,30 418,26 L418,195 L10,195 Z";
  return(
    <div className="float" style={{width:'100%',maxWidth:'520px',position:'relative'}}>
      {/* Radar badge */}
      <div className="glass2" style={{position:'absolute',top:'-22px',right:'-22px',borderRadius:'16px',padding:'11px 16px',border:'1px solid rgba(90,171,255,.2)',zIndex:2,minWidth:'180px',boxShadow:'0 8px 32px rgba(0,0,0,.4)'}}>
        <div style={{display:'flex',alignItems:'center',gap:'7px',marginBottom:'5px'}}>
          <div style={{width:'7px',height:'7px',borderRadius:'50%',background:'#5AABFF',boxShadow:'0 0 6px #5AABFF'}} className="glow-pulse"/>
          <span style={{fontSize:'11px',fontWeight:'700',color:'#5AABFF',letterSpacing:'.08em'}}>Intelligence Radar</span>
        </div>
        <div style={{fontSize:'13px',fontWeight:'700',color:'#EDF2FF'}}>6 מימדי בריאות פיננסית</div>
        <div style={{display:'flex',gap:'4px',marginTop:'6px'}}>
          {['Growth','Value','Safety'].map(l=>(
            <span key={l} style={{fontSize:'10px',color:'#475569',background:'rgba(255,255,255,.05)',borderRadius:'4px',padding:'2px 6px'}}>{l}</span>
          ))}
        </div>
      </div>

      {/* Main chart card */}
      <div className="glass card-glow" style={{borderRadius:'24px',padding:'22px',border:'1px solid rgba(255,255,255,.08)',boxShadow:'0 24px 80px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.04)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:'16px'}}>
          <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
            <div style={{background:'rgba(0,229,160,.1)',border:'1px solid rgba(0,229,160,.22)',borderRadius:'8px',padding:'4px 10px',fontSize:'12px',fontWeight:'800',color:'#00E5A0'}}>AAPL</div>
            <span style={{fontSize:'11px',color:'#475569',fontWeight:'500'}}>NASDAQ</span>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:'24px',fontWeight:'900',color:'#EDF2FF',lineHeight:'1',fontVariantNumeric:'tabular-nums'}}>$192.40</div>
            <div style={{fontSize:'13px',fontWeight:'700',color:'#00E5A0',marginTop:'2px'}}>+2.8%  +$5.20</div>
          </div>
        </div>
        <div style={{position:'relative',height:'120px',marginBottom:'14px'}}>
          <svg viewBox="0 0 430 200" preserveAspectRatio="xMidYMid meet" style={{width:'100%',height:'100%',overflow:'visible'}}>
            <defs>
              <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#00E5A0" stopOpacity=".7"/>
                <stop offset="100%" stopColor="#5AABFF" stopOpacity="1"/>
              </linearGradient>
              <linearGradient id="lg2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00E5A0" stopOpacity=".15"/>
                <stop offset="100%" stopColor="#00E5A0" stopOpacity="0"/>
              </linearGradient>
            </defs>
            {[50,100,150].map(y=><line key={y} x1="0" y1={y} x2="430" y2={y} stroke="rgba(255,255,255,.03)" strokeWidth="1"/>)}
            <path d={fp} fill="url(#lg2)"/>
            <path d={lp} stroke="url(#lg1)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" className="draw-anim"/>
            <circle cx="418" cy="26" r="4.5" fill="#5AABFF"/>
            <circle cx="418" cy="26" r="11" fill="#5AABFF" opacity=".15" className="glow-pulse"/>
          </svg>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',borderTop:'1px solid rgba(255,255,255,.05)',paddingTop:'12px'}}>
          {[['P/E','29.4'],['EPS','$6.56'],['Mkt Cap','$2.9T'],['ROE','26%']].map(([l,v])=>(
            <div key={l} style={{textAlign:'center'}}>
              <div style={{fontSize:'10px',color:'#475569',marginBottom:'3px',fontWeight:'500'}}>{l}</div>
              <div style={{fontSize:'13px',fontWeight:'700',color:'#94A3B8',fontVariantNumeric:'tabular-nums'}}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Investment Board badge */}
      <div className="glass2" style={{position:'absolute',bottom:'-22px',left:'-22px',borderRadius:'16px',padding:'11px 16px',border:'1px solid rgba(247,201,72,.18)',zIndex:2,boxShadow:'0 8px 32px rgba(0,0,0,.4)'}}>
        <div style={{fontSize:'10px',color:'#475569',marginBottom:'3px',fontWeight:'500'}}>Investment Board · AI</div>
        <div style={{fontSize:'13px',fontWeight:'700',color:'#EDF2FF'}}>וורן באפט: <span style={{color:'#00E5A0'}}>קנייה</span></div>
        <div style={{display:'flex',alignItems:'center',gap:'4px',marginTop:'4px'}}>
          {[1,2,3,4].map(i=><Ic.StarFill key={i}/>)}
          <span style={{fontSize:'11px',color:'#F7C948',fontWeight:'700',marginRight:'2px'}}>8.4</span>
        </div>
      </div>
    </div>
  );
};

/* ══════════════ SPLASH SCREEN ══════════════ */
const SplashScreen=({onDone})=>{
  const [phase,setPhase]=useState(0);
  useEffect(()=>{
    if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      onDone();
      return;
    }
    const t1=setTimeout(()=>setPhase(1),600);
    const t2=setTimeout(onDone,1000);
    return()=>{clearTimeout(t1);clearTimeout(t2);};
  },[]);
  const halfBase={position:'fixed',left:0,right:0,zIndex:9999,
    background:'linear-gradient(180deg,#020814,#050D1E)',
    transition:'transform .38s cubic-bezier(.76,0,.24,1)'};
  return(
    <>
      <div style={{...halfBase,top:0,height:'51%',
        transform:phase===1?'translateY(-102%)':'translateY(0)'}}/>
      <div style={{...halfBase,bottom:0,height:'51%',
        transform:phase===1?'translateY(102%)':'translateY(0)'}}/>
      <div style={{position:'fixed',inset:0,zIndex:10000,
        display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
        opacity:phase===1?0:1,transition:'opacity .3s ease',pointerEvents:'none',padding:'24px'}}>
        <div style={{fontSize:'clamp(48px,10vw,92px)',fontWeight:900,letterSpacing:'-.04em',lineHeight:1,
          background:'linear-gradient(135deg,#00FFB3 0%,#5AABFF 50%,#A78BFA 100%)',
          WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',
          marginBottom:'8px',textAlign:'center'}}>
          {'StockLens'.split('').map((ch,i)=>(
            <span key={i} style={{display:'inline-block',opacity:0,transform:'translateY(36px)',
              animation:`splashChar .55s cubic-bezier(.16,1,.3,1) ${.048*i}s forwards`}}>{ch}</span>
          ))}
        </div>
        <div style={{fontSize:'11px',letterSpacing:'6px',color:'#2D4A6A',textTransform:'uppercase',
          fontWeight:700,marginBottom:'48px',opacity:0,animation:'splashFade .5s .7s ease forwards'}}>Academy</div>
        <div style={{marginBottom:'40px',opacity:0,animation:'splashFade .5s .32s ease forwards'}}>
          <svg width="260" height="56" viewBox="0 0 260 60" style={{overflow:'visible'}}>
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#00FFB3"/><stop offset="100%" stopColor="#5AABFF"/>
              </linearGradient>
            </defs>
            <path d="M0,52 C18,48 30,54 50,38 S82,26 106,32 S138,18 162,22 S192,10 216,8 S244,3 260,1"
              fill="none" stroke="url(#sg)" strokeWidth="2.5" strokeLinecap="round"
              style={{strokeDasharray:700,strokeDashoffset:700,
                animation:'splashLine 1.5s .3s cubic-bezier(.16,1,.3,1) forwards'}}/>
            <circle cx="260" cy="1" r="5" fill="#5AABFF"
              style={{opacity:0,animation:'splashFade .3s 1.7s ease forwards'}}/>
          </svg>
        </div>
        <div style={{width:'clamp(220px,36vw,320px)',height:'2px',background:'rgba(255,255,255,.07)',
          borderRadius:'999px',overflow:'hidden',marginBottom:'18px'}}>
          {/* scaleX, not width: animating width relayouts on every frame during
              the splash, which is the busiest second of the page's life. The
              parent clips overflow, so the result is pixel-identical. */}
          <div style={{height:'100%',borderRadius:'999px',
            background:'linear-gradient(90deg,#00FFB3,#5AABFF,#A78BFA)',
            width:'100%',transform:'scaleX(0)',transformOrigin:'left',
            animation:'splashBar 1.6s .42s cubic-bezier(.16,1,.3,1) forwards'}}/>
        </div>
        <div style={{fontSize:'11px',fontWeight:600,color:'#1E3A5F',letterSpacing:'.1em',
          opacity:0,animation:'splashFade .5s .55s ease forwards'}}>שוק ההון מ-0 עד 100</div>
      </div>
    </>
  );
};


/* ══════════════ STAT COUNTER ══════════════ */
const StatCounter=({end,prefix='',suffix='',label,color})=>{
  const [val,setVal]=useState(0);
  const ref=useRef();
  useEffect(()=>{
    const io=new IntersectionObserver(([e])=>{
      if(!e.isIntersecting)return;
      io.disconnect();
      const dur=1700,t0=Date.now();
      const num=parseInt(String(end).replace(/\D/g,''))||0;
      if(!num){setVal(end);return;}
      const run=()=>{
        const p=Math.min((Date.now()-t0)/dur,1),eased=1-Math.pow(1-p,4);
        setVal(Math.round(num*eased));
        if(p<1)requestAnimationFrame(run);
      };
      requestAnimationFrame(run);
    },{threshold:.4});
    if(ref.current)io.observe(ref.current);
    return()=>io.disconnect();
  },[end]);
  return(
    <div ref={ref} style={{textAlign:'center'}}>
      <div className="stat-counter" style={{fontSize:'clamp(30px,3.5vw,50px)',fontWeight:900,
        color,lineHeight:1,marginBottom:'8px',letterSpacing:'-.02em'}}>{prefix}{val}{suffix}</div>
      <div style={{fontSize:'12px',color:'#475569',fontWeight:600,letterSpacing:'.04em'}}>{label}</div>
    </div>
  );
};

/* ══════════════ NAVBAR ══════════════ */
const Navbar=({scrolled,onBuy,user,signOut})=>{
  const [open,setOpen]=useState(false);
  const links=[{l:'כלים',h:'#tools'},{l:'כיצד זה עובד',h:'#how'},{l:'מחירים',h:'#pricing'},{l:'שאלות נפוצות',h:'#faq'}];
  return(
    <header className={scrolled?'nav-scrolled':''} style={{position:'fixed',top:0,insetInline:0,zIndex:50,transition:'all .3s',borderBottom:'1px solid transparent'}}>
      <div style={{maxWidth:'1280px',margin:'0 auto',padding:'0 24px'}}>
        <div style={{display:'flex',alignItems:'center',height:'66px',gap:'8px'}}>
          <a href="#" style={{display:'flex',alignItems:'center',gap:'10px',textDecoration:'none',flexShrink:0}}>
            <Ic.Lens s={28}/>
            <div>
              <div style={{fontSize:'20px',fontWeight:'900',background:'linear-gradient(135deg,#FFF 0%,#94A3B8 100%)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',lineHeight:'1.1'}}>StockLens</div>
              <div style={{fontSize:'8px',letterSpacing:'3px',color:'#334155',textTransform:'uppercase',fontWeight:'600'}}>Academy</div>
            </div>
          </a>
          {/* No inline `display` here on purpose. `.hidden` sets display:none and
              `.md\:flex` restores display:flex at >=768px; an inline display
              beats both, which is what made the desktop nav render on phones
              and collide with the logo. Layout props that are not `display`
              are safe to keep inline. */}
          <nav style={{flex:1,justifyContent:'center',gap:'2px'}} className="hidden md:flex">
            {links.map(({l,h})=><a key={h} href={h} className="nav-link">{l}</a>)}
          </nav>
          <div style={{flex:1}} className="md:hidden"/>
          {/* Same rule as the nav above — no inline `display`. */}
          <div className="hidden md:flex" style={{alignItems:'center',gap:'8px'}}>
            <a href="https://lidorfiliba.github.io/StockLens/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
              <button className="btn-ghost" style={{padding:'8px 16px',borderRadius:'10px',fontSize:'13px'}}>StockLens</button>
            </a>
            <a href="https://lidorfiliba.github.io/StockLensAcademy/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
              <button className="btn-ghost" style={{padding:'8px 16px',borderRadius:'10px',fontSize:'13px'}}>Academy</button>
            </a>
            <button className="btn-green" onClick={onBuy} style={{padding:'9px 22px',borderRadius:'11px',fontSize:'14px'}}>רכוש — ₪980</button>
          </div>
          <button className="md:hidden" onClick={()=>setOpen(!open)} style={{background:'transparent',border:'none',cursor:'pointer',color:'#94A3B8',padding:'6px',flexShrink:0}}>
            {open?<Ic.X/>:<Ic.Menu/>}
          </button>
        </div>
        {open&&(
          <div className="glass2" style={{borderRadius:'18px',padding:'14px',marginBottom:'12px',border:'1px solid rgba(0,229,160,.1)'}}>
            {links.map(({l,h})=><a key={h} href={h} className="nav-link" style={{display:'block',marginBottom:'2px'}} onClick={()=>setOpen(false)}>{l}</a>)}
            <div style={{display:'flex',gap:'8px',marginTop:'14px',paddingTop:'14px',borderTop:'1px solid rgba(255,255,255,.06)'}}>
              <a href="https://lidorfiliba.github.io/StockLens/" target="_blank" rel="noopener" style={{flex:1,textDecoration:'none'}}>
                <button className="btn-ghost" style={{width:'100%',padding:'10px',borderRadius:'10px',fontSize:'13px'}}>StockLens</button>
              </a>
              <button className="btn-green" onClick={onBuy} style={{flex:1,padding:'10px',borderRadius:'10px',fontSize:'13px'}}>רכוש — ₪980</button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

/* ══════════════ HERO ══════════════ */
const Hero=({onBuy,user})=>(
  <section className="bg-grid" style={{minHeight:'100vh',paddingTop:'160px',paddingBottom:'120px',position:'relative',overflow:'hidden'}}>
    {/* Aurora blobs — vivid */}
    <div className="aurora1" style={{position:'absolute',top:'-180px',right:'-80px',width:'1000px',height:'1000px',borderRadius:'50%',pointerEvents:'none',background:'radial-gradient(circle,rgba(0,255,179,.24) 0%,rgba(0,255,179,.08) 32%,transparent 65%)',filter:'blur(80px)'}}/>
    <div className="aurora2" style={{position:'absolute',bottom:'-180px',left:'-160px',width:'900px',height:'900px',borderRadius:'50%',pointerEvents:'none',background:'radial-gradient(circle,rgba(90,171,255,.2) 0%,rgba(90,171,255,.06) 32%,transparent 65%)',filter:'blur(80px)'}}/>
    <div style={{position:'absolute',top:'35%',left:'38%',width:'600px',height:'600px',borderRadius:'50%',pointerEvents:'none',background:'radial-gradient(circle,rgba(167,139,250,.16) 0%,rgba(167,139,250,.04) 38%,transparent 65%)',filter:'blur(60px)'}}/>
    {/* Diagonal accent */}
    <div style={{position:'absolute',inset:0,background:'linear-gradient(135deg,transparent 45%,rgba(0,255,179,.018) 50%,transparent 55%)',pointerEvents:'none'}}/>

    <div style={{maxWidth:'1280px',margin:'0 auto',padding:'0 24px',position:'relative',zIndex:2}}>
      {/* Trust pill */}
      <div className="fade-up" style={{display:'flex',justifyContent:'center',marginBottom:'44px'}}>
        <div style={{display:'inline-flex',alignItems:'center',gap:'10px',
          background:'rgba(0,255,179,.07)',border:'1px solid rgba(0,255,179,.22)',
          borderRadius:'999px',padding:'8px 22px 8px 12px',
          boxShadow:'0 0 40px rgba(0,255,179,.08)'}}>
          <div style={{background:'rgba(0,255,179,.14)',borderRadius:'999px',
            padding:'4px 12px',fontSize:'11px',fontWeight:800,color:'#00FFB3',letterSpacing:'.06em'}}>חדש 2026</div>
          <span style={{fontSize:'13px',fontWeight:600,color:'#94A3B8'}}>עברית 100% · תשלום חד פעמי · גישה לנצח</span>
          <div style={{width:'7px',height:'7px',borderRadius:'50%',background:'#00FFB3',
            boxShadow:'0 0 12px #00FFB3'}} className="glow-pulse"/>
        </div>
      </div>

      <div className="hero-flex" style={{display:'flex',flexWrap:'wrap',gap:'64px',alignItems:'center',justifyContent:'center'}}>
        {/* Text */}
        <div style={{flex:'1',minWidth:'280px',maxWidth:'590px'}}>
          <h1 className="fade-up-d1 hero-h1">
            שוק ההון{' '}<span className="tg-gold">מ-0</span><br/>
            <span className="tg">עד 100</span>
          </h1>
          {/* Direction is declared on the container, not sprinkled through the
              copy. Each Latin product name is wrapped in <bdi>, which isolates
              it as its own LTR run: without that, the bidi algorithm lets a
              Latin run and the Hebrew punctuation next to it reorder across a
              line break, which is what made this paragraph read out of order
              once it wrapped to 5+ lines on a phone. The wording is unchanged. */}
          <p className="fade-up-d2" dir="rtl" lang="he" style={{fontSize:'17px',lineHeight:'1.85',color:'#8BA3C0',marginBottom:'40px',maxWidth:'520px'}}>
            12 פרקים · +60 נושאים · 9 כלי ניתוח חיים. <bdi lang="en">Intelligence Radar</bdi>, מועצת 6 משקיעים אגדיים עם <bdi lang="en">Gemini AI</bdi>,{' '}
            <bdi lang="en">Quarter Compare</bdi>, <bdi lang="en">Spread Simulator</bdi> — הכל בעברית, גישה ללא הגבלה, תשלום חד פעמי.
          </p>
          {/* CTA */}
          <div className="fade-up-d3" style={{display:'flex',gap:'14px',flexWrap:'wrap',marginBottom:'48px'}}>
            {user?(
              <div style={{display:'flex',gap:'14px',flexWrap:'wrap'}}>
                <a href="https://lidorfiliba.github.io/StockLensAcademy/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
                  <button className="btn-green hero-cta-beam" style={{padding:'16px 32px',borderRadius:'14px',fontSize:'16px'}}>📚 כניסה ל-Academy ←</button>
                </a>
                <a href="https://lidorfiliba.github.io/StockLens/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
                  <button className="btn-ghost" style={{padding:'16px 26px',borderRadius:'14px',fontSize:'16px'}}>📊 כניסה ל-StockLens</button>
                </a>
              </div>
            ):(
              <div style={{display:'flex',gap:'14px',flexWrap:'wrap'}}>
                <div style={{position:'relative'}}>
                  <div style={{position:'absolute',inset:'-3px',borderRadius:'17px',
                    background:'linear-gradient(135deg,#00FFB3,#5AABFF,#A78BFA)',
                    filter:'blur(8px)',opacity:.55,zIndex:0}}/>
                  <button className="btn-green hero-cta-beam" onClick={onBuy}
                    style={{padding:'16px 36px',borderRadius:'14px',fontSize:'17px',
                      fontWeight:800,position:'relative',zIndex:1,
                      boxShadow:'0 0 50px rgba(0,255,179,.5),0 12px 40px rgba(0,255,179,.3)'}}>
                    רכוש גישה — ₪980
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="8" x2="15" y2="8"/><polyline points="8,1 15,8 8,15"/></svg>
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Trust badges */}
          <div className="fade-up-d4" style={{display:'flex',gap:'22px',flexWrap:'wrap'}}>
            {[{ic:<Ic.Shield/>,t:'SSL מאובטח'},{ic:<Ic.Lock/>,t:'גישה מיידית'},{ic:<Ic.Refresh/>,t:'עדכונים לנצח'}].map(({ic,t})=>(
              <div key={t} style={{display:'flex',alignItems:'center',gap:'7px'}}>
                {ic}<span style={{fontSize:'12px',color:'#3D5470',fontWeight:600}}>{t}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Chart */}
        <div className="hero-chart-col" style={{flex:'1',minWidth:'340px',flexBasis:'460px',display:'flex',justifyContent:'center',paddingBlock:'40px'}}>
          <HeroChart/>
        </div>
      </div>

      {/* Stats with animated counters */}
      <div className="glass stats-grid" style={{borderRadius:'26px',padding:'36px 40px',marginTop:'80px',
        border:'1px solid rgba(255,255,255,.08)',
        boxShadow:'0 0 100px rgba(0,255,179,.06),0 40px 80px rgba(0,0,0,.4)',
        display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'32px'}}>
        <StatCounter end={12} suffix="+" label="פרקי לימוד" color="#00FFB3"/>
        <StatCounter end={60} prefix="+" label="נושאים ותכנים" color="#5AABFF"/>
        <StatCounter end={9} label="כלי ניתוח חיים" color="#A78BFA"/>
        <StatCounter end={980} prefix="₪" label="תשלום חד פעמי" color="#F7C948"/>
      </div>
    </div>
  </section>
);

/* ══════════════ HOW IT WORKS ══════════════ */
const STEPS=[
  {n:'01',ic:<Ic.BookOpen/>,c:'ic-green',t:'למד את הבסיס',d:'12 פרקים מקיפים בעברית — מהמושגים הבסיסיים ועד אסטרטגיות מתקדמות.'},
  {n:'02',ic:<Ic.Brain/>,c:'ic-blue',t:'הבן חברות',d:'Intelligence Radar ו-Investment Board עם AI מנתחים כל מניה מ-6 זוויות שונות.'},
  {n:'03',ic:<Ic.TrendUp/>,c:'ic-violet',t:'נתח בזמן אמת',d:'9 כלי ניתוח חיים — השוואת רבעונים, מניה מול מניה, Market Pulse ועוד.'},
  {n:'04',ic:<Ic.Crown/>,c:'ic-gold',t:'קבל החלטות מושכלות',d:'בנה אסטרטגיית השקעה מבוססת נתונים. השתמש בסימולטור הספרדים ובמעקב הפוזיציות.'},
];

const HowItWorks=()=>(
  <section id="how" style={{background:'linear-gradient(180deg,#020814 0%,#060E1C 100%)',padding:'100px 24px',position:'relative',overflow:'hidden'}}>
    <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse 60% 40% at 50% 100%,rgba(90,171,255,.04) 0%,transparent 60%)',pointerEvents:'none'}}/>
    <div style={{maxWidth:'1280px',margin:'0 auto',position:'relative'}}>
      <div style={{textAlign:'center',marginBottom:'64px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>כיצד זה עובד</div>
        <h2 style={{fontSize:'clamp(28px,4vw,50px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'16px'}}>
          מהבסיס ועד <span className="tg">מסחר מקצועי</span>
        </h2>
        <p style={{fontSize:'16px',color:'#94A3B8',maxWidth:'500px',margin:'0 auto',lineHeight:'1.8'}}>
          תהליך למידה מדורג שמוביל אותך צעד אחר צעד לביטחון פיננסי אמיתי.
        </p>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'24px'}}>
        {STEPS.map(({n,ic,c,t,d},i)=>(
          <div key={i} className="card-hover reveal" style={{background:'rgba(8,16,36,.6)',border:'1px solid rgba(255,255,255,.07)',borderRadius:'20px',padding:'28px',position:'relative'}}>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:'20px'}}>
              <div className={c} style={{width:'48px',height:'48px',borderRadius:'14px',display:'flex',alignItems:'center',justifyContent:'center'}}>{ic}</div>
              <span style={{fontSize:'32px',fontWeight:'900',color:'rgba(255,255,255,.05)',lineHeight:'1',fontVariantNumeric:'tabular-nums'}}>{n}</span>
            </div>
            <div style={{fontSize:'16px',fontWeight:'800',color:'#EDF2FF',marginBottom:'10px'}}>{t}</div>
            <p style={{fontSize:'13.5px',color:'#64748B',lineHeight:'1.75'}}>{d}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

/* ══════════════ TOOLS (BENTO GRID) ══════════════ */
const TOOLS=[
  {I:Ic.BarChart,c:'ic-green', n:'Overview',          s:'ניתוח פונדמנטלי',          d:'P/E, EPS, שווי שוק, מרווח רווח, ROE, תזרים מזומנים ו-20+ מדדים נוספים בזמן אמת.',large:false},
  {I:Ic.Crown,   c:'ic-gold',  n:'Investment Board',  s:'מועצת 6 משקיעים · AI',    d:'באפט, קאת׳י ווד, מייקל ברי, לינץ׳, דליו, גראהם — כל אחד מנתח בקולו. מופעל על Gemini AI.',large:true},
  {I:Ic.Brain,   c:'ic-cyan',  n:'Intelligence',      s:'ראדר · יעדים · קונצנזוס', d:'Intelligence Radar: 6 ציוני בריאות, מחירי יעד אנליסטים, קונצנזוס Wall St.',large:false},
  {I:Ic.Compare, c:'ic-blue',  n:'Quarter Compare',   s:'השוואת רבעונים',           d:'עקוב אחרי ביצועי חברה לאורך זמן — הכנסות, רווחים, EBITDA ויזואלית.',large:false},
  {I:Ic.Versus,  c:'ic-violet',n:'Stock vs Stock',    s:'השוואה בין מניות',         d:'15+ מדדים, ציון כולל וניצחון מוכרז — מי מנצח?',large:false},
  {I:Ic.Grid,    c:'ic-violet',n:'Spread Simulator',  s:'סימולטור ספרדים',          d:'Bull Call, Bear Put, Bull Put, Bear Call — P&L ומעקב פוזיציות.',large:false},
  {I:Ic.Globe,   c:'ic-rose',  n:'Market Pulse',      s:'דופק השוק',                d:"S&P500, NASDAQ, VIX, סקטורים, ETFs — תמונה מלאה לפני כל החלטה.",large:false},
  {I:Ic.Layers,  c:'ic-blue',  n:'Options P/C',       s:'Put/Call Ratio',            d:'ניתוח יחס Put/Call לפי תאריכי פקיעה ונפח אופציות.',large:false},
  {I:Ic.Star,    c:'ic-green', n:'Watchlist',         s:'רשימת מעקב חיה',           d:'מחירים מסונכרנים בזמן אמת. קפוץ לניתוח מלא בקליק.',large:false},
];

const Tools=()=>(
  <section id="tools" style={{background:'#060E1C',padding:'100px 24px'}}>
    <div style={{maxWidth:'1280px',margin:'0 auto'}}>
      <div style={{textAlign:'center',marginBottom:'64px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>כלי הפלטפורמה</div>
        <h2 style={{fontSize:'clamp(28px,4vw,50px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'16px'}}>
          9 כלים מקצועיים, <span className="tg">מקום אחד</span>
        </h2>
        <p style={{fontSize:'16px',color:'#94A3B8',maxWidth:'520px',margin:'0 auto',lineHeight:'1.8'}}>
          כל כלי מחובר לנתונים בזמן אמת. מניתוח פונדמנטלי ועד סימולטור ספרדים — הכל בעברית מלאה.
        </p>
      </div>

      <div className="bento-grid" style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'16px'}}>
        {TOOLS.map(({I,c,n,s,d,large},i)=>(
          <div key={i} className={`card-hover card-glow reveal${large?' bento-large':''}`}
            style={{background:'rgba(8,16,36,.65)',border:'1px solid rgba(255,255,255,.07)',borderRadius:'20px',padding:'26px',position:'relative',zIndex:0}}>
            <div className={c} style={{width:'46px',height:'46px',borderRadius:'13px',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:'16px',flexShrink:0}}>
              <I/>
            </div>
            <div style={{fontSize:'15px',fontWeight:'800',color:'#EDF2FF',marginBottom:'4px'}}>{n}</div>
            <div style={{fontSize:'11px',fontWeight:'600',color:'#5AABFF',marginBottom:'10px',letterSpacing:'.04em'}}>{s}</div>
            <p style={{fontSize:'13.5px',color:'#64748B',lineHeight:'1.75'}}>{d}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

/* ══════════════ PLATFORM CARDS ══════════════ */
const Platform=()=>(
  <section id="board" style={{background:'linear-gradient(180deg,#060E1C 0%,#020814 100%)',padding:'100px 24px',position:'relative',overflow:'hidden'}}>
    <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse 70% 50% at 50% 50%,rgba(0,229,160,.03) 0%,transparent 65%)',pointerEvents:'none'}}/>
    <div style={{maxWidth:'1280px',margin:'0 auto',position:'relative'}}>
      <div style={{textAlign:'center',marginBottom:'64px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>הפלטפורמה שלנו</div>
        <h2 style={{fontSize:'clamp(28px,4vw,52px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'16px'}}>
          שני כלים. <span className="tg">עולם אחד.</span>
        </h2>
        <p style={{fontSize:'16px',color:'#94A3B8',maxWidth:'500px',margin:'0 auto',lineHeight:'1.8'}}>
          למד את שוק ההון לעומק עם האקדמיה, ונתח מניות בזמן אמת עם StockLens.
        </p>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:'24px'}}>
        {[{
          href:'https://lidorfiliba.github.io/StockLensAcademy/',
          border:'rgba(0,229,160,.2)',bg:'rgba(0,229,160,.05)',
          glowColor:'rgba(0,229,160,.12)',glowBorder:'rgba(0,229,160,.35)',
          label:'קורס · ₪980 · תשלום חד פעמי',labelColor:'#00E5A0',
          icBg:'rgba(0,229,160,.1)',icBorder:'rgba(0,229,160,.2)',icChar:'📚',
          title:<>StockLens<br/><span className="tg">Academy</span></>,
          desc:'12 פרקים · +60 נושאים · עברית 100%. שוק ההון מהבסיס ועד אסטרטגיות מתקדמות. גישה לנצח.',
          features:['12 פרקי לימוד מעמיקים','9 כלי ניתוח חיים בזמן אמת','מועצת 6 משקיעים אגדיים עם AI','סימולטור אסטרטגיות ומעקב מניות'],
          cta:'כנס לאקדמיה',ctaColor:'#00E5A0',
        },{
          href:'https://lidorfiliba.github.io/StockLens/',
          border:'rgba(90,171,255,.2)',bg:'rgba(90,171,255,.05)',
          glowColor:'rgba(90,171,255,.12)',glowBorder:'rgba(90,171,255,.35)',
          label:'כלי ניתוח · מנויים',labelColor:'#5AABFF',
          icBg:'rgba(90,171,255,.1)',icBorder:'rgba(90,171,255,.2)',icChar:'📊',
          title:<>Stock<span className="tg">Lens</span></>,
          desc:'9 כלי ניתוח מקצועיים בזמן אמת. Intelligence Radar, Quarter Compare, Spread Simulator ועוד.',
          features:['ניתוח פונדמנטלי מלא + מדדים','נתונים חיים מה-API','השוואת מניות ורבעונים','Intelligence Radar + Market Pulse'],
          cta:'כנס ל-StockLens',ctaColor:'#5AABFF',
        }].map((card,i)=>(
          <a key={i} href={card.href} target="_blank" rel="noopener" style={{textDecoration:'none'}}>
            <div className="reveal" style={{background:`linear-gradient(145deg,${card.bg} 0%,rgba(4,8,20,.97) 60%)`,border:`1px solid ${card.border}`,borderRadius:'28px',padding:'40px 36px',height:'100%',transition:'all .3s',cursor:'pointer'}}
              onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-6px)';e.currentTarget.style.boxShadow=`0 24px 80px ${card.glowColor},0 0 0 1px ${card.glowBorder}`;}}
              onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
              <div style={{width:'58px',height:'58px',borderRadius:'17px',background:card.icBg,border:`1px solid ${card.icBorder}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'28px',marginBottom:'22px'}}>{card.icChar}</div>
              <div style={{fontSize:'11px',fontWeight:'700',letterSpacing:'.14em',textTransform:'uppercase',color:card.labelColor,marginBottom:'10px'}}>{card.label}</div>
              <h3 style={{fontSize:'26px',fontWeight:'900',color:'#EDF2FF',marginBottom:'14px',lineHeight:'1.15'}}>{card.title}</h3>
              <p style={{fontSize:'15px',color:'#64748B',lineHeight:'1.8',marginBottom:'26px'}}>{card.desc}</p>
              <div style={{display:'flex',flexDirection:'column',gap:'9px',marginBottom:'28px'}}>
                {card.features.map(f=>(
                  <div key={f} style={{display:'flex',alignItems:'center',gap:'8px'}}>
                    <Ic.Check size={16} color={card.ctaColor}/>
                    <span style={{fontSize:'13px',color:'#64748B'}}>{f}</span>
                  </div>
                ))}
              </div>
              <div style={{display:'inline-flex',alignItems:'center',gap:'8px',color:card.ctaColor,fontSize:'14px',fontWeight:'700'}}>
                {card.cta}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="7" x2="13" y2="7"/><polyline points="7,1 13,7 7,13"/></svg>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  </section>
);

/* ══════════════ TESTIMONIALS ══════════════ */
const REVIEWS=[
  {n:'אורי כ.',r:5,t:'הכלי הכי טוב שמצאתי',d:'Investment Board עם ה-AI זה פשוט קסם. לראות את באפט וקאת׳י ווד מנתחים אותה מניה — מהפכה בחשיבה שלי.'},
  {n:'מיכל ש.',r:5,t:'סוף סוף הבנתי מניות',d:'קניתי עשרות קורסים בעבר. שום דבר לא השתווה לרמת הפירוט ולכלים החיים שיש כאן. שווה כל שקל.'},
  {n:'דוד מ.',r:5,t:'9 כלים במחיר של 1',d:'Quarter Compare ו-Stock vs Stock חסכו לי שעות ניתוח. הנתונים בזמן אמת מדויקים ומהירים. ממליץ בחום.'},
  {n:'שירה ל.',r:5,t:'הדרך הנכונה להתחיל',d:'נרשמתי בתור מתחיל מוחלט. אחרי 12 הפרקים הרגשתי שסוף סוף יש לי כלים אמיתיים לנתח מניות בעצמי.'},
  {n:'תומר ב.',r:5,t:'Intelligence Radar משנה משחק',d:'הראדר נותן מבט ב-6 מימדים בבת אחת. לא צריך לפקוח עשרות חלונות — הכל במסך אחד, בעברית.'},
  {n:'נועה א.',r:5,t:'גישה לנצח — שווה זה',d:'תשלום חד פעמי בלי מנויים. מקבלים עדכונים, כלים חדשים, ותמיכה. זה מה שציפיתי ויותר מכך.'},
];

const Testimonials=()=>(
  <section style={{background:'#020814',padding:'100px 24px',overflow:'hidden',position:'relative'}}>
    <div style={{position:'absolute',top:0,insetInline:0,height:'1px',background:'linear-gradient(90deg,transparent,rgba(0,229,160,.15),transparent)'}}/>
    <div style={{maxWidth:'1280px',margin:'0 auto'}}>
      <div style={{textAlign:'center',marginBottom:'60px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>חוות דעת</div>
        <h2 style={{fontSize:'clamp(26px,4vw,48px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'16px'}}>
          מה אומרים <span className="tg">התלמידים שלנו</span>
        </h2>
        <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:'8px',marginTop:'12px'}}>
          <div style={{display:'flex',gap:'3px'}}>{[1,2,3,4,5].map(i=><Ic.StarFill key={i}/>)}</div>
          <span style={{fontSize:'14px',color:'#94A3B8',fontWeight:'600'}}>4.9/5 · מעל 500 ביקורות</span>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:'16px'}}>
        {REVIEWS.map(({n,r,t,d},i)=>(
          <div key={i} className="card-hover reveal" style={{background:'rgba(8,16,36,.7)',border:'1px solid rgba(255,255,255,.07)',borderRadius:'20px',padding:'24px',transition:'all .25s'}}>
            <div style={{display:'flex',gap:'3px',marginBottom:'12px'}}>
              {Array.from({length:r}).map((_,j)=><Ic.StarFill key={j}/>)}
            </div>
            <div style={{fontSize:'15px',fontWeight:'800',color:'#EDF2FF',marginBottom:'8px'}}>{t}</div>
            <p style={{fontSize:'13.5px',color:'#64748B',lineHeight:'1.75',marginBottom:'16px'}}>{d}</p>
            <div style={{display:'flex',alignItems:'center',gap:'10px',borderTop:'1px solid rgba(255,255,255,.05)',paddingTop:'14px'}}>
              <div style={{width:'32px',height:'32px',borderRadius:'50%',background:'linear-gradient(135deg,rgba(0,229,160,.15),rgba(90,171,255,.15))',border:'1px solid rgba(255,255,255,.08)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'13px',fontWeight:'700',color:'#00E5A0'}}>
                {n[0]}
              </div>
              <div style={{fontSize:'13px',fontWeight:'600',color:'#94A3B8'}}>{n}</div>
              <div style={{marginRight:'auto',display:'flex',alignItems:'center',gap:'5px',background:'rgba(0,229,160,.08)',border:'1px solid rgba(0,229,160,.15)',borderRadius:'8px',padding:'3px 8px'}}>
                <div style={{width:'5px',height:'5px',borderRadius:'50%',background:'#00E5A0'}} className="glow-pulse"/>
                <span style={{fontSize:'10px',fontWeight:'700',color:'#00E5A0'}}>מאומת</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

/* ══════════════ PRICING ══════════════ */
const PITEMS=[
  'גישה לכל 9 כלי הניתוח ללא הגבלה',
  '12 פרקי לימוד · +60 נושאים · עברית 100%',
  'Intelligence Radar — 6 מימדי בריאות פיננסית',
  'Investment Board — 6 משקיעים + Gemini AI',
  'Quarter Compare — השוואת רבעונים',
  'Stock vs Stock — השוואה בין כל שתי מניות',
  'Spread Simulator — 4 סוגי ספרדים + פוזיציות',
  'Market Pulse — מדדים, VIX וסקטורים חיים',
  'Options P/C — ניתוח יחס Put/Call',
  'Watchlist חיה עם מחירים מסונכרנים',
  'עדכונים ושדרוגים עתידיים ללא הגבלה',
];

const Pricing=({onBuy})=>(
  <section id="pricing" style={{background:'#020814',padding:'100px 24px',position:'relative',overflow:'hidden'}}>
    <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',width:'600px',height:'600px',borderRadius:'50%',background:'radial-gradient(circle,rgba(0,229,160,.05) 0%,transparent 65%)',pointerEvents:'none'}}/>
    <div style={{maxWidth:'1280px',margin:'0 auto',position:'relative'}}>
      <div style={{textAlign:'center',marginBottom:'60px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>תמחיר</div>
        <h2 style={{fontSize:'clamp(26px,4vw,50px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'14px'}}>
          תשלום חד פעמי, <span className="tg">גישה לנצח</span>
        </h2>
        <p style={{fontSize:'16px',color:'#94A3B8',maxWidth:'440px',margin:'0 auto',lineHeight:'1.8'}}>
          ללא מנוי חודשי, ללא הפתעות. שלם פעם אחת — גישה מלאה לכל הכלים והתכנים לתמיד.
        </p>
      </div>

      <div style={{maxWidth:'600px',margin:'0 auto'}}>
        <div className="pricing-card reveal" style={{borderRadius:'28px',padding:'40px',position:'relative',overflow:'hidden'}}>
          {/* Top badge */}
          <div style={{position:'absolute',top:'-1px',right:'50%',transform:'translateX(50%)',background:'linear-gradient(135deg,#F7C948,#E07B54)',borderRadius:'0 0 14px 14px',padding:'6px 24px',fontSize:'12px',fontWeight:'800',color:'#020814',whiteSpace:'nowrap',letterSpacing:'.04em'}}>
            StockLens Academy · גישה מלאה
          </div>
          <div style={{marginTop:'18px'}}>
            <div style={{fontSize:'12px',fontWeight:'700',color:'#00E5A0',letterSpacing:'.1em',marginBottom:'6px',textTransform:'uppercase'}}>שוק ההון מ-0 עד 100</div>
            <div style={{fontSize:'13px',color:'#475569',marginBottom:'24px'}}>12 פרקים · +60 נושאים · 9 כלים · עברית 100%</div>

            {/* Price options */}
            <div style={{display:'flex',gap:'12px',marginBottom:'28px'}}>
              {[{price:'₪980',method:'Bit / Paybox',color:'#F7C948',bg:'rgba(247,201,72,.08)',border:'rgba(247,201,72,.25)'},{price:'$320',method:'PayPal',color:'#5AABFF',bg:'rgba(90,171,255,.08)',border:'rgba(90,171,255,.25)'}].map(({price,method,color,bg,border})=>(
                <div key={method} style={{flex:1,background:bg,border:`1px solid ${border}`,borderRadius:'16px',padding:'18px',textAlign:'center'}}>
                  <div style={{fontSize:'30px',fontWeight:'900',color,fontVariantNumeric:'tabular-nums',lineHeight:'1',marginBottom:'6px'}}>{price}</div>
                  <div style={{fontSize:'12px',color:'#475569',fontWeight:'500'}}>{method}</div>
                </div>
              ))}
            </div>

            <div style={{height:'1px',background:'rgba(255,255,255,.07)',marginBottom:'24px'}}/>

            {/* Features list */}
            <ul style={{listStyle:'none',padding:0,margin:'0 0 28px 0'}}>
              {PITEMS.map((f,i)=>(
                <li key={i} className="check-item">
                  <Ic.Check size={18}/>
                  <span style={{fontSize:'14px',color:'#CBD5E1',lineHeight:'1.5'}}>{f}</span>
                </li>
              ))}
            </ul>

            <button className="btn-green" onClick={onBuy} style={{width:'100%',padding:'17px',borderRadius:'14px',fontSize:'16px',justifyContent:'center'}}>
              רכוש גישה עכשיו
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="8" x2="15" y2="8"/><polyline points="8,1 15,8 8,15"/></svg>
            </button>
            <p style={{textAlign:'center',fontSize:'12px',color:'#334155',marginTop:'14px'}}>גישה ללא הגבלת זמן · עדכונים שוטפים כלולים · תשלום חד פעמי</p>
          </div>
        </div>

        <div style={{display:'flex',justifyContent:'center',gap:'28px',marginTop:'28px',flexWrap:'wrap'}}>
          {[{ic:<Ic.Shield/>,t:'אתר מאובטח SSL'},{ic:<Ic.Lock/>,t:'גישה מיידית'},{ic:<Ic.Refresh/>,t:'עדכונים לנצח'}].map(({ic,t})=>(
            <div key={t} style={{display:'flex',alignItems:'center',gap:'6px'}}>
              {ic}<span style={{fontSize:'12px',color:'#334155',fontWeight:'500'}}>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

/* ══════════════ FAQ ══════════════ */
const FAQS=[
  {q:'מה קורה לאחר הרכישה?',a:'לאחר אישור התשלום תקבל גישה לאקדמיה תוך שעות ספורות. תשלח אליך כתובת כניסה ישירות למייל שהזנת בטופס.'},
  {q:'האם מדובר בתשלום חד פעמי?',a:'כן, לחלוטין. תשלום פעם אחת — גישה מלאה לכל הכלים, כל הפרקים, וכל העדכונים העתידיים. ללא מנוי חודשי, ללא הפתעות.'},
  {q:'מה ה-Investment Board?',a:'מועצת 6 משקיעים אגדיים — וורן באפט, קאת׳י ווד, מייקל ברי, פיטר לינץ׳, ריי דליו ובנג׳מין גראהם — שמנתחים כל מניה בקולם, מופעל על ידי Gemini AI.'},
  {q:'האם הכלים מחוברים לנתונים בזמן אמת?',a:'כן! כל 9 הכלים מחוברים ל-API חי ומספקים נתונים עדכניים. מחירי מניות, פרמטרים פיננסיים ומדדי שוק מתעדכנים ברציפות.'},
  {q:'מה רמת הידע הנדרשת?',a:'הקורס מתאים לכל אחד — גם למי שלא יודע כלום על שוק ההון. 12 הפרקים בנויים מהבסיס ועולים בהדרגה לאסטרטגיות מתקדמות.'},
  {q:'מה אפשרויות התשלום?',a:'ניתן לשלם דרך Bit/Paybox (₪980) או PayPal ($320). לאחר התשלום ממלאים טופס קצר ומקבלים גישה תוך שעות.'},
];

const FaqItem=({q,a})=>{
  const [open,setOpen]=useState(false);
  return(
    <div className="faq-item" style={{padding:'0'}}>
      <button onClick={()=>setOpen(!open)} style={{width:'100%',background:'none',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'22px 0',gap:'16px',textAlign:'right'}}>
        <span style={{fontSize:'15px',fontWeight:'700',color:open?'#00E5A0':'#EDF2FF',transition:'color .2s',flex:1}}>{q}</span>
        <div style={{transform:open?'rotate(180deg)':'rotate(0)',transition:'transform .25s',color:open?'#00E5A0':'#475569',flexShrink:0}}>
          <Ic.ChevronDown/>
        </div>
      </button>
      <div style={{maxHeight:open?'200px':'0',overflow:'hidden',transition:'max-height .3s ease'}}>
        <p style={{fontSize:'14px',color:'#64748B',lineHeight:'1.8',paddingBottom:'22px'}}>{a}</p>
      </div>
    </div>
  );
};

const FAQ=()=>(
  <section id="faq" style={{background:'#060E1C',padding:'100px 24px'}}>
    <div style={{maxWidth:'760px',margin:'0 auto'}}>
      <div style={{textAlign:'center',marginBottom:'60px'}}>
        <div className="slabel" style={{marginBottom:'14px'}}>שאלות נפוצות</div>
        <h2 style={{fontSize:'clamp(26px,4vw,48px)',fontWeight:'900',lineHeight:'1.1',marginBottom:'16px'}}>
          יש לך שאלות? <span className="tg">יש לנו תשובות</span>
        </h2>
      </div>
      <div className="glass reveal" style={{borderRadius:'24px',padding:'8px 32px',border:'1px solid rgba(255,255,255,.07)'}}>
        {FAQS.map((item,i)=><FaqItem key={i} {...item}/>)}
      </div>
      <div style={{textAlign:'center',marginTop:'32px'}}>
        <p style={{fontSize:'14px',color:'#475569'}}>
          עדיין יש שאלות?{' '}
          <a href="mailto:Lidorfiliba@gmail.com" style={{color:'#00E5A0',textDecoration:'none',fontWeight:'600'}}>צור קשר</a>
        </p>
      </div>
    </div>
  </section>
);

/* ══════════════ CTA BANNER ══════════════ */
const CTABanner=({onBuy})=>(
  <section style={{position:'relative',padding:'130px 24px',overflow:'hidden'}}>
    {/* Multi-layer dramatic background */}
    <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse 85% 65% at 50% 50%,rgba(0,255,179,.1) 0%,rgba(90,171,255,.06) 40%,transparent 70%)'}}/>
    <div style={{position:'absolute',inset:0,background:'linear-gradient(135deg,rgba(0,255,179,.04) 0%,rgba(167,139,250,.04) 100%)'}}/>
    {/* Vivid top line */}
    <div style={{position:'absolute',top:0,insetInline:0,height:'2px',
      background:'linear-gradient(90deg,transparent,#00FFB3,#5AABFF,#A78BFA,transparent)'}}/>
    <div style={{position:'absolute',bottom:0,insetInline:0,height:'2px',
      background:'linear-gradient(90deg,transparent,#A78BFA,#5AABFF,#00FFB3,transparent)'}}/>
    {/* Orb glow */}
    <div style={{position:'absolute',left:'15%',top:'50%',transform:'translateY(-50%)',
      width:'500px',height:'500px',borderRadius:'50%',
      background:'radial-gradient(circle,rgba(0,255,179,.09) 0%,transparent 65%)',
      filter:'blur(60px)',pointerEvents:'none'}}/>
    <div style={{position:'absolute',right:'15%',top:'50%',transform:'translateY(-50%)',
      width:'400px',height:'400px',borderRadius:'50%',
      background:'radial-gradient(circle,rgba(90,171,255,.08) 0%,transparent 65%)',
      filter:'blur(60px)',pointerEvents:'none'}}/>

    <div style={{maxWidth:'740px',margin:'0 auto',textAlign:'center',position:'relative',zIndex:1}}>
      {/* Live badge */}
      <div style={{display:'inline-flex',alignItems:'center',gap:'10px',
        background:'rgba(0,255,179,.08)',border:'1px solid rgba(0,255,179,.28)',
        borderRadius:'999px',padding:'9px 22px',marginBottom:'36px',
        boxShadow:'0 0 40px rgba(0,255,179,.1)'}}>
        <div style={{position:'relative',width:'11px',height:'11px'}}>
          <div style={{position:'absolute',inset:0,borderRadius:'50%',background:'#00FFB3',
            animation:'pulseRingEx 2s ease-out infinite'}}/>
          <div style={{position:'absolute',inset:'3px',borderRadius:'50%',background:'#00FFB3'}}/>
        </div>
        <span style={{fontSize:'13px',fontWeight:700,color:'#00FFB3'}}>גישה מיידית לאחר רכישה</span>
      </div>

      <h2 style={{fontSize:'clamp(30px,5.5vw,62px)',fontWeight:900,color:'#EDF2FF',
        marginBottom:'22px',lineHeight:1.0,letterSpacing:'-.035em'}}>
        מוכן לנתח מניות<br/>
        <span className="tg">כמו מקצוען?</span>
      </h2>
      <p style={{fontSize:'18px',color:'#8BA3C0',marginBottom:'50px',lineHeight:1.85,maxWidth:'520px',margin:'0 auto 50px'}}>
        9 כלי ניתוח · 12 פרקים · מועצת 6 משקיעים אגדיים.<br/>
        תשלום חד פעמי · ₪980 Bit/Paybox · $320 PayPal
      </p>

      {/* CTA Buttons */}
      <div className="cta-btns" style={{display:'flex',justifyContent:'center',gap:'16px',flexWrap:'wrap',marginBottom:'48px'}}>
        <div style={{position:'relative'}}>
          <div style={{position:'absolute',inset:'-4px',borderRadius:'18px',
            background:'linear-gradient(135deg,#00FFB3,#5AABFF)',
            filter:'blur(10px)',opacity:.6,zIndex:0}}/>
          <button className="btn-green hero-cta-beam" onClick={onBuy}
            style={{padding:'18px 44px',borderRadius:'14px',fontSize:'18px',fontWeight:800,
              position:'relative',zIndex:1,
              boxShadow:'0 0 60px rgba(0,255,179,.55),0 16px 50px rgba(0,255,179,.35)'}}>
            רכוש גישה — ₪980
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="8" x2="15" y2="8"/><polyline points="8,1 15,8 8,15"/></svg>
          </button>
        </div>
        <a href="https://lidorfiliba.github.io/StockLensAcademy/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
          <button className="btn-ghost" style={{padding:'18px 32px',borderRadius:'14px',fontSize:'16px'}}>Academy ←</button>
        </a>
        <a href="https://lidorfiliba.github.io/StockLens/" target="_blank" rel="noopener" style={{textDecoration:'none'}}>
          <button className="btn-ghost" style={{padding:'18px 32px',borderRadius:'14px',fontSize:'16px'}}>StockLens ←</button>
        </a>
      </div>

      {/* Trust strip */}
      <div style={{display:'flex',justifyContent:'center',gap:'32px',flexWrap:'wrap'}}>
        {[{ic:<Ic.Shield/>,t:'SSL מאובטח'},{ic:<Ic.Lock/>,t:'גישה מיידית'},{ic:<Ic.Refresh/>,t:'עדכונים לנצח'},{ic:<Ic.Users/>,t:'מעל 500 תלמידים'}].map(({ic,t})=>(
          <div key={t} style={{display:'flex',alignItems:'center',gap:'7px'}}>
            {ic}<span style={{fontSize:'12px',color:'#2D4A6A',fontWeight:600}}>{t}</span>
          </div>
        ))}
      </div>
    </div>
  </section>
);

/* ══════════════ FOOTER ══════════════ */
const Footer=({onBuy})=>{
  const A='https://lidorfiliba.github.io/StockLens/';
  const AC='https://lidorfiliba.github.io/StockLensAcademy/';
  const cols=[
    {title:'כלים',items:[{l:'Overview',href:A},{l:'Quarter Compare',href:A},{l:'Stock vs Stock',href:A},{l:'Intelligence',href:A},{l:'Market Pulse',href:A},{l:'Options P/C',href:A}]},
    {title:'תוכן',items:[{l:'12 פרקי לימוד',href:AC},{l:'+60 נושאים',href:AC},{l:'Investment Board',href:AC},{l:'Spread Simulator',href:AC},{l:'Watchlist',href:AC}]},
    {title:'כללי',items:[{l:'אודות',href:'#tools'},{l:'צור קשר',href:'mailto:Lidorfiliba@gmail.com'},{l:'פרטיות',href:'privacy.html'},{l:'תנאי שימוש',href:'#'},{l:'רכוש גישה',buy:true}]},
  ];
  const linkStyle={fontSize:'13px',color:'#334155',textDecoration:'none',transition:'color .2s',fontWeight:'500'};
  return(
    <footer style={{background:'#020814',borderTop:'1px solid rgba(255,255,255,.05)',padding:'60px 24px 32px'}}>
      <div style={{maxWidth:'1280px',margin:'0 auto'}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:'40px',marginBottom:'48px'}}>
          <div>
            <div style={{display:'flex',alignItems:'center',gap:'9px',marginBottom:'16px'}}>
              <Ic.Lens s={24}/>
              <div>
                <div style={{fontSize:'19px',fontWeight:'900',background:'linear-gradient(135deg,#FFF 0%,#94A3B8 100%)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',lineHeight:'1.1'}}>StockLens</div>
                <div style={{fontSize:'8px',letterSpacing:'2.5px',color:'#334155',textTransform:'uppercase',fontWeight:'600'}}>Academy</div>
              </div>
            </div>
            <p style={{fontSize:'13px',color:'#334155',lineHeight:'1.8',maxWidth:'200px'}}>9 כלי ניתוח חיים · 12 פרקים · עברית 100% · תשלום חד פעמי · גישה לנצח.</p>
          </div>
          {cols.map(col=>(
            <div key={col.title}>
              <div style={{fontSize:'12px',fontWeight:'700',color:'#EDF2FF',marginBottom:'18px',letterSpacing:'.06em',textTransform:'uppercase'}}>{col.title}</div>
              <ul style={{listStyle:'none',padding:0,margin:0}}>
                {col.items.map(item=>(
                  <li key={item.l} style={{marginBottom:'10px'}}>
                    {item.buy
                      ? <button onClick={onBuy} style={{background:'none',border:'none',padding:0,fontSize:'13px',color:'#00E5A0',cursor:'pointer',fontFamily:'Heebo,sans-serif',fontWeight:'600',transition:'color .2s'}}
                          onMouseEnter={e=>e.target.style.color='#00FFB3'} onMouseLeave={e=>e.target.style.color='#00E5A0'}>{item.l} ←</button>
                      : <a href={item.href} target={item.href.startsWith('http')?'_blank':'_self'} rel="noopener"
                          style={linkStyle}
                          onMouseEnter={e=>e.target.style.color='#94A3B8'} onMouseLeave={e=>e.target.style.color='#334155'}>{item.l}</a>
                    }
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'12px',paddingTop:'24px',borderTop:'1px solid rgba(255,255,255,.05)'}}>
          <div style={{fontSize:'13px',color:'#1E293B',fontWeight:'500'}}>© 2026 StockLens by Lidor.F · כל הזכויות שמורות.</div>
          <div style={{fontSize:'13px',color:'#1E293B'}}>StockLens • Academy</div>
        </div>
      </div>
    </footer>
  );
};

/* ══════════════ PURCHASE MODAL ══════════════ */
/* InputField and its style object live at module scope on purpose.
   Defining a component inside another component creates a NEW function
   identity on every render, so React unmounts and remounts the <input>
   on each keystroke and the field loses focus after every character. */
const inp={width:'100%',background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.1)',borderRadius:'11px',color:'#EDF2FF',fontFamily:'Heebo,sans-serif',fontSize:'15px',padding:'13px 15px',outline:'none',marginTop:'6px',boxSizing:'border-box',transition:'border-color .2s,box-shadow .2s'};

const InputField=({label,type='text',value,onChange,placeholder})=>(
  <div style={{marginBottom:'14px'}}>
    <div style={{fontSize:'12px',color:'#64748B',marginBottom:'4px',fontWeight:'600'}}>{label}</div>
    <input style={inp} type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      onFocus={e=>{e.target.style.borderColor='rgba(0,229,160,.45)';e.target.style.boxShadow='0 0 0 3px rgba(0,229,160,.08)';}}
      onBlur={e=>{e.target.style.borderColor='rgba(255,255,255,.1)';e.target.style.boxShadow='';}}/>
  </div>
);

const PurchaseModal=({onClose})=>{
  const [step,setStep]=React.useState('choose');
  const [name,setName]=React.useState('');
  const [email,setEmail]=React.useState('');
  const [phone,setPhone]=React.useState('');
  const [username,setUsername]=React.useState('');
  const [loading,setLoading]=React.useState(false);
  const [err,setErr]=React.useState('');
  /* Held so the "redirecting" step can offer a manual link to the same URL the
     automatic navigation targets. */
  const [redirectUrl,setRedirectUrl]=React.useState('');

  React.useEffect(()=>{document.body.style.overflow='hidden';return()=>{document.body.style.overflow='';};},[]);

  const allFilled=name.trim()&&email.trim()&&phone.trim()&&username.trim();
  /* Only surfaced once the customer has typed something, so the field does not
     show an error the moment the form opens. */
  const phoneBad=phone.trim().length>0&&!isIsraeliMobile(phone);

  const submit=async()=>{
    if(!allFilled)return;
    if(!isIsraeliMobile(phone)){
      setErr('מספר טלפון לא תקין — נדרש מספר נייד ישראלי (10 ספרות, מתחיל ב-05)');
      return;
    }
    setLoading(true);setErr('');

    /* One id for this order, minted before anything is sent so the same value
       reaches EmailJS and the thank-you page. */
    const orderId=makeOrderId();
    const value=step==='bit'?980:320;
    const currency=step==='bit'?'ILS':'USD';

    /* InitiateCheckout fires on the submit click itself — the moment the
       customer commits — not on opening the modal. eventID is the order id so
       this event, the Lead on the thank-you page and the server-side Purchase
       all carry the same id and Meta can tie them together. */
    track('InitiateCheckout',{
      content_name:'StockLens Academy',content_category:'course',
      value,currency,order_id:orderId,
    },{eventID:orderId});

    /* Durable backup FIRST, before EmailJS and before the redirect.
       Ordered this way on purpose: if it ran after the email, an EmailJS
       failure would throw past it and the order would be lost from both places
       at once — which is the exact scenario this table exists to survive.
       logOrder never throws, so a backup failure falls through to the email and
       the redirect untouched. */
    await logOrder({
      order_id:orderId, name:name.trim(), email:email.trim(),
      phone:normalisePhone(phone), amount:value, currency,
      source_surface:'landing',
    });

    try{
      const emailjs=await loadEmail();
      await emailjs.send('service_s5wzeck','template_3pfjg4g',{
        from_name:name,from_email:email,phone:phone||'לא צוין',username:username||'לא צוין',
        payment_method:step==='bit'?'Bit / Paybox':'PayPal',price:step==='bit'?'₪980':'$320',
        order_time:new Date().toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}),reply_to:email,
        /* Additive only — every field above keeps its existing name and meaning
           so the EmailJS template renders exactly as it did before. */
        order_id:orderId,
      });
      /* Single success path: the thank-you page. There is deliberately no
         in-modal confirmation any more — two success screens meant customers
         who never navigated still saw "thanks", which is exactly how a broken
         redirect stayed invisible in production. The step below only shows a
         "redirecting" notice, so if navigation ever fails the modal looks
         unfinished rather than complete. */
      const url='thank-you.html?order_id='+encodeURIComponent(orderId)
        +'&value='+encodeURIComponent(value)+'&currency='+encodeURIComponent(currency);
      setRedirectUrl(url);
      setStep('redirecting');
      window.location.href=url;
      return; // leaving the page — do not clear loading and re-enable the button
    }catch{setErr('שגיאה בשליחה, נסה שנית או שלח מייל ל-Lidorfiliba@gmail.com');}
    setLoading(false);
  };

  return(
    <div style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,.85)',backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px'}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div id="purchase-modal" style={{background:'rgba(4,8,20,.98)',border:'1px solid rgba(255,255,255,.08)',borderRadius:'28px',padding:'36px 32px',maxWidth:'460px',width:'100%',position:'relative',boxShadow:'0 32px 80px rgba(0,0,0,.9),0 0 0 1px rgba(0,229,160,.07)',maxHeight:'92vh',overflowY:'auto'}}>
        <button onClick={onClose} style={{position:'absolute',top:'16px',left:'16px',background:'rgba(255,255,255,.05)',border:'1px solid rgba(255,255,255,.08)',borderRadius:'50%',width:'34px',height:'34px',cursor:'pointer',color:'#64748B',fontSize:'16px',display:'flex',alignItems:'center',justifyContent:'center',transition:'all .2s'}}
          onMouseEnter={e=>{e.currentTarget.style.background='rgba(255,255,255,.08)';e.currentTarget.style.color='#94A3B8';}}
          onMouseLeave={e=>{e.currentTarget.style.background='rgba(255,255,255,.05)';e.currentTarget.style.color='#64748B';}}>✕</button>

        {step==='choose'&&(
          <>
            <div style={{textAlign:'center',marginBottom:'28px'}}>
              <div style={{fontSize:'11px',fontWeight:'700',letterSpacing:'.14em',color:'#00E5A0',marginBottom:'10px',textTransform:'uppercase'}}>StockLens Academy</div>
              <h2 style={{fontSize:'24px',fontWeight:'900',color:'#EDF2FF',marginBottom:'8px'}}>בחר שיטת תשלום</h2>
              <p style={{fontSize:'14px',color:'#64748B'}}>תשלום חד פעמי · גישה לנצח</p>
            </div>
            {[{step:'bit',color:'247,201,72',price:'₪980',sub:'Bit · Paybox · העברה בנקאית'},{step:'paypal',color:'90,171,255',price:'$320',sub:'PayPal'}].map(({step:s,color,price,sub})=>(
              <button key={s} onClick={()=>setStep(s)} style={{background:`rgba(${color},.07)`,border:`1px solid rgba(${color},.25)`,borderRadius:'16px',padding:'18px 20px',cursor:'pointer',display:'flex',alignItems:'center',gap:'16px',width:'100%',textAlign:'right',marginBottom:'12px',transition:'all .2s'}}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.borderColor=`rgba(${color},.6)`;e.currentTarget.style.background=`rgba(${color},.1)`;}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.borderColor=`rgba(${color},.25)`;e.currentTarget.style.background=`rgba(${color},.07)`;}}>
                <div style={{width:'48px',height:'48px',borderRadius:'13px',background:`rgba(${color},.12)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'22px',flexShrink:0}}>{s==='bit'?'💳':'🌐'}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:'22px',fontWeight:'900',color:`rgb(${color})`,lineHeight:'1'}}>{price}</div>
                  <div style={{fontSize:'12px',color:'#64748B',marginTop:'3px'}}>{sub}</div>
                </div>
                <span style={{color:`rgb(${color})`,fontSize:'16px'}}>←</span>
              </button>
            ))}
            <div style={{borderTop:'1px solid rgba(255,255,255,.06)',paddingTop:'18px',display:'flex',flexDirection:'column',gap:'8px'}}>
              {['גישה לכל 12 הפרקים + 9 כלי ניתוח','גישה לנצח — ללא מנוי','עדכונים עתידיים כלולים','עברית 100%'].map(f=>(
                <div key={f} style={{display:'flex',alignItems:'center',gap:'8px'}}>
                  <Ic.Check size={15}/>
                  <span style={{fontSize:'13px',color:'#64748B'}}>{f}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {(step==='bit'||step==='paypal')&&(
          <>
            <button onClick={()=>setStep('choose')} style={{background:'transparent',border:'none',color:'#64748B',cursor:'pointer',fontSize:'13px',display:'flex',alignItems:'center',gap:'6px',marginBottom:'22px',padding:0,fontFamily:'Heebo,sans-serif',fontWeight:'600'}}>→ חזרה</button>
            <div style={{textAlign:'center',marginBottom:'22px'}}>
              <div style={{fontSize:'36px',marginBottom:'10px'}}>{step==='bit'?'💳':'🌐'}</div>
              <h3 style={{fontSize:'20px',fontWeight:'900',color:'#EDF2FF',marginBottom:'6px'}}>{step==='bit'?'תשלום ₪980':'תשלום $320 — PayPal'}</h3>
            </div>
            <div style={{background:step==='bit'?'rgba(247,201,72,.06)':'rgba(90,171,255,.06)',border:`1px solid ${step==='bit'?'rgba(247,201,72,.25)':'rgba(90,171,255,.25)'}`,borderRadius:'14px',padding:'18px',marginBottom:'22px',textAlign:'center'}}>
              <div style={{fontSize:'11px',color:step==='bit'?'#F7C948':'#5AABFF',fontWeight:'700',letterSpacing:'.1em',marginBottom:'8px',textTransform:'uppercase'}}>{step==='bit'?'מספר Bit / Paybox':'PayPal'}</div>
              <div style={{fontSize:'20px',fontWeight:'900',color:'#EDF2FF',fontFamily:'monospace',letterSpacing:'1px'}}>{step==='bit'?'054-6667812':'Lidorfiliba@gmail.com'}</div>
              <div style={{fontSize:'11px',color:'#334155',marginTop:'6px',fontWeight:'500'}}>לאחר התשלום, מלא את הפרטים למטה</div>
            </div>
            <InputField label="שם מלא" value={name} onChange={setName} placeholder="שם מלא"/>
            <InputField label="כתובת מייל" type="email" value={email} onChange={setEmail} placeholder="you@email.com"/>
            <InputField label="טלפון" type="tel" value={phone} onChange={setPhone} placeholder="050-0000000"/>
            {/* Rendered from derived state only. Nothing here attaches a
                listener to the input or reads it during typing — see the
                warning on #fb-events about what broke typing in this form. */}
            {phoneBad&&(
              <p style={{fontSize:'11px',color:'#fb7185',marginTop:'-8px',marginBottom:'14px'}}>
                נדרש מספר נייד ישראלי — 10 ספרות, מתחיל ב-05
              </p>
            )}
            <InputField label="שם משתמש רצוי לאקדמיה" value={username} onChange={setUsername} placeholder="lidor123"/>
            <button onClick={submit} disabled={!allFilled||loading}
              style={{width:'100%',background:(!allFilled||loading)?'rgba(255,255,255,.05)':'linear-gradient(135deg,#00E5A0,#00C48A)',color:(!allFilled||loading)?'#334155':'#020814',border:'none',borderRadius:'13px',padding:'15px',fontFamily:'Heebo,sans-serif',fontSize:'15px',fontWeight:'700',cursor:(!allFilled||loading)?'not-allowed':'pointer',boxShadow:(!allFilled||loading)?'none':'0 4px 24px rgba(0,229,160,.3)',transition:'all .2s'}}>
              {loading?'שולח...':'שלחתי — תן לי גישה ✓'}
            </button>
            {err&&<p style={{textAlign:'center',fontSize:'12px',color:'#fb7185',marginTop:'8px'}}>{err}</p>}
            <p style={{textAlign:'center',fontSize:'11px',color:'#1E293B',marginTop:'10px'}}>תקבל גישה תוך שעות ספורות לאחר אישור התשלום</p>
          </>
        )}

        {step==='redirecting'&&(
          /* Transition state only — NOT a confirmation. The order is confirmed
             on /thank-you.html and nowhere else. If this ever stays on screen
             the redirect failed, which is the visible symptom this replaced an
             invisible one with. The manual link is the escape hatch. */
          <div id="purchase-redirecting" style={{textAlign:'center',padding:'10px 0'}}>
            <div style={{width:'72px',height:'72px',borderRadius:'50%',background:'rgba(0,229,160,.1)',border:'1px solid rgba(0,229,160,.25)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 20px',fontSize:'32px'}}>⏳</div>
            <h3 style={{fontSize:'20px',fontWeight:'900',color:'#00E5A0',marginBottom:'12px'}}>מעביר אותך לאישור ההזמנה...</h3>
            <p style={{fontSize:'14px',color:'#64748B',lineHeight:'1.8',marginBottom:'22px'}}>אם הדף לא נטען מעצמו,<br/><a href={redirectUrl} style={{color:'#00E5A0',fontWeight:'700'}}>לחץ כאן להמשך</a></p>
          </div>
        )}
      </div>
    </div>
  );
};


const App=()=>{
  const [scrolled,setScrolled]=useState(false);
  const [modal,setModal]=useState(false);
  const [splash,setSplash]=useState(true);
  const {user,loading,signOut}=useAuth();
  const buy=()=>{ if(!user) setModal(true); };

  useEffect(()=>{
    const onScroll=()=>setScrolled(window.scrollY>50);
    window.addEventListener('scroll',onScroll,{passive:true});
    return()=>window.removeEventListener('scroll',onScroll);
  },[]);

  useEffect(()=>{
    // Reveal for legacy .reveal classes (parallax engine handles [data-reveal])
    const obs=new IntersectionObserver(entries=>{
      entries.forEach(e=>{
        if(e.isIntersecting){
          e.target.classList.add('visible');
          obs.unobserve(e.target);
        }
      });
    },{threshold:.1,rootMargin:'0px 0px -40px 0px'});
    document.querySelectorAll('.reveal,.reveal-left,.reveal-right,.stagger').forEach(el=>obs.observe(el));
    return()=>obs.disconnect();
  },[]);

  return(
    <>
      {splash&&<SplashScreen onDone={()=>setSplash(false)}/>}
      {modal&&<PurchaseModal onClose={()=>setModal(false)}/>}
      <Navbar scrolled={scrolled} onBuy={buy} user={user} signOut={signOut}/>
      <main>
        <Hero onBuy={buy} user={user}/>
        <HowItWorks/>
        <Tools/>
        <Platform/>
        <Testimonials/>
        <Pricing onBuy={buy}/>
        <FAQ/>
        <CTABanner onBuy={buy}/>
      </main>
      <Footer onBuy={buy}/>
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
