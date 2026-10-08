(function(){
'use strict';
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inr=n=>'\u20B9'+Math.round(n||0).toLocaleString('en-IN');
const MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthLabel=k=>{const p=k.split('-');return MN[+p[1]-1]+' '+p[0]};
const dim=k=>{const p=k.split('-').map(Number);return new Date(p[0],p[1],0).getDate()};
const mkey=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
const uid=()=>Math.random().toString(36).slice(2,9);

/* ---------- server API client (same interface the app used for the shared database) ---------- */
const H={'Content-Type':'application/json','X-PFSS':'1'};
async function http(method,url,body){
  const r=await fetch(url,{method,headers:H,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
  if(r.status===401&&!/^\/api\/(login|setup|status)/.test(url)){const e={code:'unauthenticated'};if(window.__onUnauth)window.__onUnauth();throw e}
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok)throw {code:r.status===403?'forbidden':r.status===409?'locked':r.status===401?'badlogin':r.status===429?'toomany':r.status===413||r.status===400?'invalid':'unavailable',message:j.error||''};
  return j;
}
function makeDb(){
  const subs=new Set();
  const snapOf=(rows)=>{const docs=rows.map(r=>({id:r.id,exists:true,data:()=>r.data}));return {docs,size:docs.length,empty:!docs.length}};
  const refresh=async(sub)=>{
    try{
      let snap,key;
      if(sub.id!=null){const j=await http('GET','/api/d/'+sub.col+'/'+encodeURIComponent(sub.id));key=JSON.stringify(j);snap={id:sub.id,exists:j.exists,data:()=>j.data}}
      else{const rows=await http('GET','/api/c/'+sub.col+(sub.month!=null?'?month='+encodeURIComponent(sub.month):''));key=JSON.stringify(rows);snap=snapOf(rows)}
      if(sub.dead||key===sub.last)return;sub.last=key;sub.next(snap);
    }catch(e){if(!sub.dead&&sub.err&&e&&e.code==='unauthenticated')sub.err(e)}
  };
  const timers={};
  const notify=c=>{
    subs.forEach(sub=>{if(c==='*'||sub.col===c){clearTimeout(sub.t);sub.t=setTimeout(()=>refresh(sub),30)}});
  };
  const add=(sub)=>{subs.add(sub);refresh(sub);return ()=>{sub.dead=true;subs.delete(sub)}};
  const docRef=(col,id)=>({
    async get(){const j=await http('GET','/api/d/'+col+'/'+encodeURIComponent(id));return {id,exists:j.exists,data:()=>j.data}},
    async set(data){await http('PUT','/api/d/'+col+'/'+encodeURIComponent(id),data);notify(col)},
    async delete(){await http('DELETE','/api/d/'+col+'/'+encodeURIComponent(id));notify(col)},
    onSnapshot(next,err){return add({col,id,next,err})}
  });
  const colRef=(col,month)=>({
    where(f,op,v){if(f!=='month'||op!=='==')throw new Error('Unsupported query');return colRef(col,v)},
    async get(){const rows=await http('GET','/api/c/'+col+(month!=null?'?month='+encodeURIComponent(month):''));return snapOf(rows)},
    onSnapshot(next,err){return add({col,month,next,err})},
    doc:id=>docRef(col,id)
  });
  // No live push on serverless hosting, so ask a tiny "pulse" endpoint for change counters.
  let last=null,pulling=false;
  const pull=async()=>{
    if(pulling||document.hidden)return;pulling=true;
    try{
      const now=await http('GET','/api/pulse');
      if(last){Object.keys(now).forEach(c=>{if(now[c]!==last[c])notify(c)});Object.keys(last).forEach(c=>{if(!(c in now))notify(c)})}
      last=now;
    }catch(e){}
    pulling=false;
  };
  pull();
  setInterval(pull,5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)pull()});
  return {
    async batch(writes){
      for(let i=0;i<writes.length;i+=200){
        const part=writes.slice(i,i+200);
        await http('POST','/api/batch',{writes:part});
        new Set(part.map(w=>w.c)).forEach(c=>notify(c));
      }
    },
    collection:c=>colRef(c),
    doc:p=>{const i=p.indexOf('/');return docRef(p.slice(0,i),p.slice(i+1))}
  };
}
const DEF={pfRate:12,pfCeiling:15000,esiEmp:0.75,esiEr:3.25,esiCeiling:21000,otMult:2,nightAllowance:150,ptThreshold:15000,ptAmount:200};
function prevMonth(){const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);return mkey(d)}
function initialMonth(){try{const m=localStorage.getItem('pfss_month');if(m&&/^\d{4}-\d{2}$/.test(m))return m}catch(e){}return prevMonth()}

/* ---------- state (kept in sync with the shared database) ---------- */
const S={employees:[],sites:[],settings:Object.assign({},DEF),attendance:{},runs:{},lines:[],approvals:{},
  month:initialMonth(),page:'dashboard',ui:{},loaded:{},db:null,err:'',users:{},usersList:[],me:{id:null,name:'',role:'viewer',canWrite:false,isAdmin:false}};
const PEND={};            // pending local writes, so snapshots do not overwrite them
const Q={};               // per-document write queues
const enqueue=(k,fn)=>{PEND[k]=(PEND[k]||0)+1;const p=(Q[k]||Promise.resolve()).catch(()=>{}).then(fn);Q[k]=p;const fin=()=>{PEND[k]--};p.then(fin,fin);return p};
let calcBusy=false;
const ready=()=>!!S.db&&['sites','employees','config','runs','approvals','att','lines'].every(k=>S.loaded[k]);

/* ---------- run helpers ---------- */
const STEPS=[
  {n:4,id:'attendance',label:'Attendance and shifts'},
  {n:5,id:'review',label:'Overtime, leave and absences'},
  {n:6,id:'calculate',label:'Calculate payroll'},
  {n:7,id:'validate',label:'Validate PF, ESI and deductions'},
  {n:8,id:'approval',label:'Manager approval'},
  {n:9,id:'payslips',label:'Payslips and bank file'},
  {n:10,id:'reports',label:'Reports and history'}];
const TITLES={dashboard:'Overview',sites:'Client sites',employees:'Employees',attendance:'Attendance and shifts',review:'Review overtime, leave and absences',calculate:'Calculate monthly payroll',validate:'Validate PF, ESI and deductions',approval:'Manager approval',payslips:'Payslips and bank file',reports:'Reports and payroll history',settings:'Settings',users:'Users'};
const run=m=>S.runs[m||S.month]||{log:[]};
const active=()=>S.employees.filter(e=>e.active!==false);
const siteOf=id=>S.sites.find(s=>s.id===id)||{name:'Unassigned',client:'',city:''};
function isApproved(m){const r=S.runs[m],a=S.approvals[m];return !!(r&&r.hasCalc&&a&&a.decision==='approved'&&a.stamp===r.stamp)}
const locked=m=>{m=m||S.month;const r=S.runs[m];return isApproved(m)||!!(r&&r.finalized)};
function attComplete(){const D=dim(S.month),list=active();if(!list.length)return false;return list.every(e=>{const r=S.attendance[e.id];return r&&((+r.present||0)+(+r.paidLeave||0)+(+r.unpaidLeave||0)+(+r.absent||0))===D})}
function done(id,m){const r=S.runs[m]||{};switch(id){case 'attendance':return attComplete();case 'review':return !!r.reviewed;case 'calculate':return !!r.hasCalc;case 'validate':return !!r.validated;case 'approval':return isApproved(m);case 'payslips':return !!r.finalized;case 'reports':return !!r.finalized}return false}
function nextStep(m){const s=STEPS.find(s=>!done(s.id,m));return s?s.id:null}
function statusOf(m){const r=S.runs[m]||{};if(r.finalized)return['Closed','ok'];if(isApproved(m))return['Approved','ok'];if(r.submitted)return['Awaiting approval','warn'];if(r.rejected&&!r.hasCalc)return['Sent back','bad'];if(r.validated)return['Validated','info'];if(r.hasCalc)return['Calculated','info'];return['Draft','muted']}
const pill=(t,tone)=>'<span class="pill '+tone+'">'+esc(t)+'</span>';

/* ---------- database writes ---------- */
const errTxt=e=>{const c=e&&e.code;if(c==='forbidden')return e.message||'You do not have permission to make this change.';if(c==='locked')return e.message||'This month is locked.';if(c==='invalid')return e.message||'That change was not accepted.';if(c==='unauthenticated')return 'Your session ended. Reload the page to sign in again.';return 'Could not save. Check your connection and try again.'};
async function guard(fn){if(!S.db){toast('Cannot reach the PFSS server');return false}try{await fn();return true}catch(e){toast(errTxt(e));return false}}
function patchRun(m,patch,msg){
  const base=S.runs[m]||{log:[]};
  const next=Object.assign({},base,patch);
  if(msg)next.log=(base.log||[]).concat([{t:new Date().toISOString(),by:S.me.id,msg}]).slice(-200);
  S.runs[m]=next;
  return enqueue('run/'+m,()=>S.db.doc('runs/'+m).set(next));
}
function invalidateRun(m){
  const r=S.runs[m];if(!r||locked(m))return;
  if(r.reviewed||r.hasCalc||r.validated||r.submitted)patchRun(m,{reviewed:false,hasCalc:false,validated:false,submitted:false,issues:null,totals:null}).catch(()=>{});
}
const invalidateAll=()=>Object.keys(S.runs).forEach(invalidateRun);
async function inChunks(items,size,fn){for(let i=0;i<items.length;i+=size)await Promise.all(items.slice(i,i+size).map(fn))}

/* ---------- subscriptions ---------- */
let unsubM=[],rafP=false,dirty=false;
function typing(){const a=document.activeElement;return !!(a&&$('#main').contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))}
function scheduleRender(){
  if(!ready()){renderShell();return}
  if(typing()){dirty=true;renderNav();return}
  if(rafP)return;rafP=true;requestAnimationFrame(()=>{rafP=false;render()});
}
const dbErr=name=>e=>{if(e&&(e.code==='revoked'||e.code==='unauthenticated')){S.err='revoked';renderShell()}else console.error(name,e)};
function mark(k){S.loaded[k]=true;scheduleRender()}
function subscribe(){
  const db=S.db;
  db.collection('sites').onSnapshot(snap=>{S.sites=snap.docs.map(d=>Object.assign({},d.data(),{id:d.id})).sort((a,b)=>String(a.name).localeCompare(b.name));mark('sites')},dbErr('sites'));
  db.collection('employees').onSnapshot(snap=>{S.employees=snap.docs.map(d=>Object.assign({},d.data(),{id:d.id})).sort((a,b)=>String(a.code).localeCompare(b.code));mark('employees')},dbErr('employees'));
  db.doc('config/settings').onSnapshot(d=>{S.settings=Object.assign({},DEF,d.exists?d.data():{});mark('config')},dbErr('config'));
  db.collection('runs').onSnapshot(snap=>{
    const o={};snap.docs.forEach(d=>{o[d.id]=d.data()});
    Object.keys(S.runs).forEach(k=>{if(PEND['run/'+k]>0)o[k]=S.runs[k]});
    S.runs=o;mark('runs')},dbErr('runs'));
  db.collection('approvals').onSnapshot(snap=>{const o={};snap.docs.forEach(d=>{o[d.id]=d.data()});S.approvals=o;mark('approvals')},dbErr('approvals'));
  subMonth();
}
function subMonth(){
  unsubM.forEach(f=>f());unsubM=[];
  const m=S.month;S.attendance={};S.lines=[];S.loaded.att=false;S.loaded.lines=false;
  unsubM.push(S.db.collection('attendance').where('month','==',m).onSnapshot(snap=>{
    if(m!==S.month)return;
    const o={};snap.docs.forEach(d=>{const x=d.data();o[x.empId]=x});
    Object.keys(S.attendance).forEach(k=>{if(PEND['att/'+m+'_'+k]>0)o[k]=S.attendance[k]});
    S.attendance=o;mark('att')},dbErr('attendance')));
  unsubM.push(S.db.collection('runlines').where('month','==',m).onSnapshot(snap=>{
    if(m!==S.month||calcBusy)return;
    S.lines=snap.docs.map(d=>d.data()).sort((a,b)=>String(a.code).localeCompare(b.code));mark('lines')},dbErr('runlines')));
}

/* ---------- calculation ---------- */
function calcEmp(e,a,m){
  const D=dim(m),st=S.settings;
  const payable=Math.min(D,(+a.present||0)+(+a.paidLeave||0));
  const r=payable/D;
  const basic=Math.round(e.basic*r),hra=Math.round(e.hra*r),other=Math.round(e.other*r);
  const otHrs=+a.ot||0,nights=+a.night||0;
  const ot=Math.round(otHrs*(e.basic/(D*8))*st.otMult);
  const night=Math.round(nights*st.nightAllowance);
  const gross=basic+hra+other+ot+night;
  const fixed=e.basic+e.hra+e.other;
  const pfWage=e.pf?Math.min(basic,st.pfCeiling):0;
  const pfEmp=Math.round(pfWage*st.pfRate/100),pfEr=pfEmp;
  const esiOn=!!e.esi&&fixed<=st.esiCeiling;
  const esiEmp=esiOn?Math.ceil(gross*st.esiEmp/100):0;
  const esiEr=esiOn?Math.ceil(gross*st.esiEr/100):0;
  const pt=gross>=st.ptThreshold?st.ptAmount:0;
  const od=+a.otherDed||0;
  const ded=pfEmp+esiEmp+pt+od;
  return {id:e.id,code:e.code,name:e.name,desig:e.desig||'',siteId:e.siteId,site:siteOf(e.siteId).name,client:siteOf(e.siteId).client||'',
    D,payable,lop:D-payable,basic,hra,other,ot,night,otHrs,nights,gross,basicEarned:basic,pfWage,pfEmp,pfEr,esiOn,esiEmp,esiEr,pt,otherDed:od,ded,net:gross-ded,
    uan:e.uan||'',esiNo:e.esiNo||'',acct:e.acct||'',ifsc:e.ifsc||'',bankName:e.bankName||'',note:a.note||''};
}
function totalsOf(c){const t={n:c.length,gross:0,ded:0,net:0,pfEmp:0,pfEr:0,esiEmp:0,esiEr:0,pt:0,otherDed:0,ot:0};
  c.forEach(x=>{t.gross+=x.gross;t.ded+=x.ded;t.net+=x.net;t.pfEmp+=x.pfEmp;t.pfEr+=x.pfEr;t.esiEmp+=x.esiEmp;t.esiEr+=x.esiEr;t.pt+=x.pt;t.otherDed+=x.otherDed;t.ot+=x.ot+x.night});
  t.cost=t.gross+t.pfEr+t.esiEr;return t}
function runChecks(){
  const out=[],seen={};
  S.lines.forEach(c=>{
    const e=S.employees.find(x=>x.id===c.id)||{};
    const add=(lv,msg)=>out.push({lv,id:c.id,name:c.name,msg});
    if(e.pf&&!/^\d{12}$/.test(e.uan||''))add('error','UAN is missing or is not 12 digits. It is needed for PF.');
    if(c.esiOn&&!String(e.esiNo||'').trim())add('error','ESI number is missing.');
    if(!/^\d{9,18}$/.test(e.acct||''))add('error','Bank account number is missing or invalid.');
    if(!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(e.ifsc||'').toUpperCase()))add('error','IFSC code is missing or invalid.');
    if(c.net<0)add('error','Deductions are higher than earnings, so net pay is negative.');
    if(c.payable===0)add('warn','No payable days this month. Net pay is zero.');
    if(e.esi&&!c.esiOn)add('warn','Marked ESI applicable, but fixed salary is above the ESI ceiling, so no ESI is deducted.');
    if(e.pf&&c.basicEarned>S.settings.pfCeiling)add('warn','Basic pay is above the PF wage ceiling. PF is limited to '+inr(S.settings.pfCeiling*S.settings.pfRate/100)+'.');
    if(c.otHrs>50)add('warn','Overtime of '+c.otHrs+' hours is unusually high.');
    if(e.acct)(seen[e.acct]=seen[e.acct]||[]).push(c.name);
  });
  Object.keys(seen).forEach(k=>{if(seen[k].length>1)out.push({lv:'warn',id:null,name:seen[k].join(', '),msg:'These employees share one bank account number.'})});
  return out;
}

/* ---------- ui helpers ---------- */
let pending=null,toastT=null;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2600)}
function openModal(title,body,foot,wide){
  $('#modal').className='modal'+(wide?' wide':'');
  $('#modal').innerHTML='<div class="head"><h3>'+esc(title)+'</h3><button class="x" data-act="closeModal" aria-label="Close">&times;</button></div><div class="body">'+body+'</div>'+(foot?'<div class="foot">'+foot+'</div>':'');
  $('#mb').classList.add('open');
}
function closeModal(){$('#mb').classList.remove('open');pending=null}
function confirmBox(title,msg,yes,label){pending=yes;openModal(title,'<p style="margin:0">'+msg+'</p>','<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmYes">'+esc(label||'Confirm')+'</button>')}
function gate(items){return '<div class="banner warn"><div><b>This step is not ready yet.</b><ul>'+items.map(i=>'<li>'+esc(i[1])+' <button class="btn sm" data-act="go" data-page="'+i[0]+'">Go to step</button></li>').join('')+'</ul></div></div>'}
function fmtTime(iso){const d=new Date(iso);return d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})+', '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}
function nameOf(id){return S.users[id]||'A teammate'}
function logHtml(m){const l=(run(m).log||[]).slice().reverse();return l.length?'<ul class="log">'+l.map(x=>'<li><time>'+esc(fmtTime(x.t))+'</time>'+(x.by&&x.by===S.me.id?'<b>You:</b> ':'<b>'+esc(nameOf(x.by))+':</b> ')+esc(x.msg)+'</li>').join('')+'</ul>':'<p class="muted small" style="margin:0">Nothing recorded yet for this month.</p>'}
async function loadUsers(){
  try{const list=await http('GET','/api/users');S.usersList=list;S.users={};list.forEach(u=>{S.users[u.id]=u.name})}catch(e){}
}
const busyMsg=m=>toast(m);

/* ---------- shell ---------- */
function renderNav(){
  const m=S.month,next=ready()?nextStep(m):null;
  const item=(id,label)=>'<button class="nav '+(S.page===id?'on':'')+'" data-act="go" data-page="'+id+'">'+label+'</button>';
  let h='<div class="brand"><span class="mark">PF</span><span><b>PFSS</b><small>Payroll</small></span></div>';
  h+=item('dashboard','Overview');
  h+='<div class="grp">Setup</div>'+item('sites','Client sites')+item('employees','Employees');
  h+='<div class="grp">'+esc(monthLabel(m))+' pay cycle</div><ol class="rail">';
  STEPS.forEach(s=>{const d=ready()&&done(s.id,m);h+='<li class="'+(d?'done':'')+' '+(next===s.id?'next':'')+'"><button class="nav '+(S.page===s.id?'on':'')+'" data-act="go" data-page="'+s.id+'"><span class="dot">'+(d?'\u2713':s.n)+'</span>'+s.label+'</button></li>'});
  h+='</ol><div class="grp">Admin</div>'+item('settings','Settings')+(S.me.isAdmin?item('users','Users'):'');
  $('#nav').innerHTML=h;
}
function monthOptions(){const out=[],d=new Date();d.setDate(1);for(let i=0;i<12;i++){out.push(mkey(d));d.setMonth(d.getMonth()-1)}if(out.indexOf(S.month)<0)out.push(S.month);return out}
function syncControls(){
  $('#month').innerHTML=monthOptions().map(k=>'<option value="'+k+'"'+(k===S.month?' selected':'')+'>'+monthLabel(k)+'</option>').join('');
  const w=$('#who'),roleName={manager:'Manager',payroll:'Payroll admin',viewer:'Viewer'}[S.me.role]||'';
  w.textContent=S.me.name?S.me.name+' \u00B7 '+roleName:'';
  w.className='pill '+(S.me.isAdmin?'ok':S.me.canWrite?'info':'muted');
}
function renderShell(){
  renderNav();syncControls();$('#title').textContent=TITLES[S.page];
  let h;
  if(S.err==='nodb')h='<div class="banner bad"><div><b>Cannot reach the PFSS server.</b><br>Check your connection and reload the page.</div></div>';
  else if(S.err==='revoked')h='<div class="banner bad"><div><b>Your session ended.</b><br>Reload the page to sign in again.</div></div>';
  else h='<div class="empty"><b>Loading payroll data</b>Connecting to the shared database.</div>';
  $('#main').innerHTML=h;
}
function render(scroll){
  if(!ready()){renderShell();return}
  dirty=false;
  renderNav();syncControls();
  $('#title').textContent=TITLES[S.page];
  $('#main').innerHTML=(S.me.canWrite?'':'<div class="banner info">You have view-only access. Ask a manager to change your role if you need to enter data.</div>')+PAGES[S.page]();
  if(scroll)window.scrollTo(0,0);
}

/* ---------- pages ---------- */
function dataGaps(){
  const out=[];
  active().forEach(e=>{
    if(e.pf&&!/^\d{12}$/.test(e.uan||''))out.push([e,'UAN missing']);
    if(!/^\d{9,18}$/.test(e.acct||'')||!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(e.ifsc||'').toUpperCase()))out.push([e,'Bank details incomplete']);
    if(e.esi&&!String(e.esiNo||'').trim())out.push([e,'ESI number missing']);
  });
  return out;
}
function pageDash(){
  const m=S.month,st=statusOf(m),next=nextStep(m),r=S.runs[m]||{},gaps=dataGaps();
  if(!S.sites.length&&!S.employees.length){
    return '<section class="hero"><div style="flex:1;min-width:240px"><h2>Welcome to PFSS Payroll</h2><p>Nothing is set up yet. Add your client sites first, then your employees. Everything you enter is saved to the shared database for your team.</p></div><button class="btn" data-act="go" data-page="sites">Add your first client site</button></section>';
  }
  const nextLabel=next?STEPS.find(s=>s.id===next).label:null;
  let h='<section class="hero"><div style="flex:1;min-width:240px"><h2>'+esc(monthLabel(m))+' payroll</h2><p>'+(next?'Next up: '+esc(nextLabel)+'.':'This month is closed. Payslips, bank file and reports are available.')+'</p></div>'+
    (next?'<button class="btn" data-act="go" data-page="'+next+'">Continue: '+esc(nextLabel)+'</button>':'<button class="btn" data-act="go" data-page="reports">Open reports</button>')+'</section>';
  h+='<div class="stats">'+
    '<div class="stat"><div class="v">'+active().length+'</div><div class="l">Active employees</div></div>'+
    '<div class="stat"><div class="v">'+S.sites.length+'</div><div class="l">Client sites</div></div>'+
    '<div class="stat"><div class="v">'+(r.totals?inr(r.totals.net):'Not yet')+'</div><div class="l">Net pay for '+esc(monthLabel(m))+'</div></div>'+
    '<div class="stat"><div class="v">'+(r.totals?inr(r.totals.cost):'Not yet')+'</div><div class="l">Total cost to company</div></div></div>';
  h+='<div class="two"><div class="card"><div class="row"><h3>Pay cycle</h3><span class="spacer"></span>'+pill(st[0],st[1])+'</div><p class="sub">Seven steps repeat every month.</p><ol class="steps">';
  STEPS.forEach(s=>{const d=done(s.id,m);h+='<li class="'+(d?'done':'')+' '+(next===s.id?'next':'')+'"><span class="dot">'+(d?'\u2713':s.n)+'</span><span style="flex:1">'+s.label+'</span><button class="btn sm" data-act="go" data-page="'+s.id+'">Open</button></li>'});
  h+='</ol></div><div class="card"><h3>Employee records to fix</h3><p class="sub">Missing details will block validation later.</p>';
  if(!gaps.length)h+='<p class="muted" style="margin:0">All active employees have complete statutory and bank details.</p>';
  else{h+='<ul class="log">'+gaps.slice(0,8).map(g=>'<li><b>'+esc(g[0].name)+'</b> <span class="muted">'+esc(g[1])+'</span> <button class="btn sm" data-act="editEmp" data-id="'+g[0].id+'">Fix</button></li>').join('')+'</ul>';if(gaps.length>8)h+='<p class="muted small">and '+(gaps.length-8)+' more</p>'}
  h+='</div></div>';
  return h;
}

function pageSites(){
  let h='<div class="row" style="margin-bottom:14px"><p class="muted" style="margin:0">Sites where your people are deployed, grouped by client.</p><span class="spacer"></span><button class="btn primary" data-act="addSite">Add client site</button></div>';
  if(!S.sites.length)return h+'<div class="card empty"><b>No client sites yet</b>Add the first site, then assign employees to it.</div>';
  h+='<div class="tw"><table class="t"><thead><tr><th>Site</th><th>Client</th><th>City</th><th class="num">Active staff</th><th></th></tr></thead><tbody>';
  S.sites.forEach(s=>{const n=S.employees.filter(e=>e.siteId===s.id&&e.active!==false).length;
    h+='<tr><td><b>'+esc(s.name)+'</b></td><td>'+esc(s.client)+'</td><td>'+esc(s.city)+'</td><td class="num">'+n+'</td><td class="num"><button class="btn sm" data-act="editSite" data-id="'+s.id+'">Edit</button> <button class="btn sm" data-act="delSite" data-id="'+s.id+'">Delete</button></td></tr>'});
  return h+'</tbody></table></div>';
}
function siteForm(s){
  s=s||{name:'',client:'',city:''};
  openModal(s.id?'Edit client site':'Add client site',
    '<div class="form"><div class="full"><label for="f_name">Site name</label><input id="f_name" type="text" value="'+esc(s.name)+'"></div>'+
    '<div><label for="f_client">Client</label><input id="f_client" type="text" value="'+esc(s.client)+'"></div>'+
    '<div><label for="f_city">City</label><input id="f_city" type="text" value="'+esc(s.city)+'"></div><div class="err" id="ferr"></div></div>',
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveSite" data-id="'+(s.id||'')+'">Save site</button>');
}

function empRows(){
  const q=(S.ui.q||'').toLowerCase(),sf=S.ui.site||'';
  const list=S.employees.filter(e=>(!sf||e.siteId===sf)&&(!q||((e.name||'')+' '+(e.code||'')+' '+(e.desig||'')).toLowerCase().indexOf(q)>=0));
  if(!list.length)return '<div class="empty"><b>No employees found</b>Change the search, or add a new employee.</div>';
  let h='<table class="t"><thead><tr><th>Employee</th><th>Client site</th><th class="num">Monthly salary</th><th>PF</th><th>ESI</th><th>Status</th><th></th></tr></thead><tbody>';
  list.forEach(e=>{const on=e.active!==false;h+='<tr style="'+(on?'':'opacity:.55')+'"><td><b>'+esc(e.name)+'</b><small>'+esc(e.code)+' &middot; '+esc(e.desig)+'</small></td><td>'+esc(siteOf(e.siteId).name)+'</td><td class="num">'+inr(e.basic+e.hra+e.other)+'</td><td>'+(e.pf?'Yes':'No')+'</td><td>'+(e.esi?'Yes':'No')+'</td><td>'+pill(on?'Active':'Inactive',on?'ok':'muted')+'</td><td class="num"><button class="btn sm" data-act="editEmp" data-id="'+e.id+'">Edit</button> <button class="btn sm" data-act="toggleEmp" data-id="'+e.id+'">'+(on?'Deactivate':'Reactivate')+'</button></td></tr>'});
  return h+'</tbody></table>';
}
function pageEmployees(){
  return '<div class="row" style="margin-bottom:14px"><input type="text" id="empq" placeholder="Search by name, code or role" value="'+esc(S.ui.q||'')+'" style="max-width:280px" aria-label="Search employees">'+
    '<select id="emps" style="max-width:220px" aria-label="Filter by site"><option value="">All client sites</option>'+S.sites.map(s=>'<option value="'+s.id+'"'+(S.ui.site===s.id?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select>'+
    '<span class="spacer"></span><button class="btn primary" data-act="addEmp">Add employee</button></div><div class="tw" id="emptable">'+empRows()+'</div>';
}
function empForm(e){
  const isNew=!e;
  const n=S.employees.reduce((a,x)=>Math.max(a,parseInt(String(x.code).replace(/\D/g,''),10)||0),0)+1;
  e=e||{code:'PFS-'+String(n).padStart(4,'0'),name:'',phone:'',desig:'',doj:new Date().toISOString().slice(0,10),siteId:'',basic:'',hra:'',other:'',pf:true,esi:false,uan:'',esiNo:'',bankName:'',acct:'',ifsc:''};
  const v=(id,label,val,type)=>'<div><label for="f_'+id+'">'+label+'</label><input id="f_'+id+'" type="'+(type||'text')+'" value="'+esc(val)+'"></div>';
  openModal(isNew?'Add employee':'Edit employee',
    '<div class="form"><h4>Step 1: Employee details</h4>'+
    v('name','Full name',e.name)+v('code','Employee code',e.code)+v('desig','Designation',e.desig)+v('phone','Phone',e.phone,'tel')+v('doj','Date of joining',e.doj,'date')+
    '<h4>Step 2: Client site</h4><div class="full"><label for="f_site">Assigned site</label><select id="f_site"><option value="">Select a site</option>'+S.sites.map(s=>'<option value="'+s.id+'"'+(e.siteId===s.id?' selected':'')+'>'+esc(s.name)+' ('+esc(s.client)+')</option>').join('')+'</select></div>'+
    '<h4>Step 3: Salary structure (monthly)</h4>'+
    v('basic','Basic pay',e.basic,'number')+v('hra','House rent allowance',e.hra,'number')+v('other','Other allowances',e.other,'number')+
    '<div class="chk"><input type="checkbox" id="f_pf"'+(e.pf?' checked':'')+'><label for="f_pf" style="margin:0;color:var(--ink)">PF applicable</label></div>'+
    '<div class="chk"><input type="checkbox" id="f_esi"'+(e.esi?' checked':'')+'><label for="f_esi" style="margin:0;color:var(--ink)">ESI applicable</label></div>'+
    '<h4>Statutory and bank details</h4>'+
    v('uan','UAN (12 digits)',e.uan)+v('esiNo','ESI number',e.esiNo)+v('bankName','Bank name',e.bankName)+v('acct','Account number',e.acct)+v('ifsc','IFSC code',e.ifsc)+
    '<div class="err" id="ferr"></div></div>',
    '<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveEmp" data-id="'+(isNew?'':e.id)+'">Save employee</button>',true);
}

function chkCell(id){
  const D=dim(S.month),a=S.attendance[id];
  if(!a)return pill('Not recorded','muted');
  const t=(+a.present||0)+(+a.paidLeave||0)+(+a.unpaidLeave||0)+(+a.absent||0);
  if(t===D)return pill('Complete','ok');
  return pill(t>D?(t-D)+' extra days':(D-t)+' days missing','bad');
}
function attRow(e,a){
  a=a||{};
  const inp=f=>'<td class="num"><input type="number" min="0" step="'+(f==='ot'||f==='otherDed'?'0.5':'1')+'" data-att="'+f+'" data-id="'+e.id+'" value="'+(a[f]!=null?a[f]:'')+'" aria-label="'+f+' for '+esc(e.name)+'"'+(locked()?' disabled':'')+'></td>';
  return '<tr><td><b>'+esc(e.name)+'</b><small>'+esc(e.code)+' &middot; '+esc(siteOf(e.siteId).name)+'</small></td>'+inp('present')+inp('paidLeave')+inp('unpaidLeave')+inp('absent')+inp('ot')+inp('night')+inp('otherDed')+'<td id="chk-'+e.id+'">'+chkCell(e.id)+'</td></tr>';
}
function pageAttendance(){
  const m=S.month,D=dim(m),list=active();
  let h='';
  if(locked())h+='<div class="banner info">This month is approved, so attendance is locked.</div>';
  h+='<div class="row" style="margin-bottom:14px"><p class="muted" style="margin:0;max-width:62ch">'+esc(monthLabel(m))+' has '+D+' days. For each employee, present, leave and absent days must add up to '+D+'. Count weekly offs and holidays as present.</p><span class="spacer"></span><button class="btn" data-act="markAll"'+(locked()?' disabled':'')+'>Mark all present</button></div>';
  if(!list.length)return h+'<div class="card empty"><b>No active employees</b>Add employees first, then record their attendance.</div>';
  h+='<div class="tw"><table class="t" style="min-width:900px"><thead><tr><th>Employee</th><th class="num">Present</th><th class="num">Paid leave</th><th class="num">Unpaid leave</th><th class="num">Absent</th><th class="num">OT hours</th><th class="num">Night shifts</th><th class="num">Other deduction</th><th>Days check</th></tr></thead><tbody>';
  list.forEach(e=>{h+=attRow(e,S.attendance[e.id])});
  return h+'</tbody></table></div><p class="muted small">Changes save automatically and show for everyone on your team.</p>';
}

function pageReview(){
  const m=S.month,r=run(m);
  if(!attComplete())return gate([['attendance','Complete attendance for every active employee']]);
  const rows=active().filter(e=>{const x=S.attendance[e.id]||{};return x.paidLeave>0||x.unpaidLeave>0||x.absent>0||x.ot>0||x.night>0||x.otherDed>0||x.note});
  let h='';
  if(locked())h+='<div class="banner info">This month is approved, so the review is locked.</div>';
  else if(r.reviewed)h+='<div class="banner ok">Review confirmed. You can continue to calculate payroll.</div>';
  h+='<p class="muted" style="margin:0 0 14px;max-width:70ch">These employees have overtime, leave, absences, night shifts or deductions this month. Check them, add a note where something needs explaining, then confirm.</p>';
  if(!rows.length)h+='<div class="card empty"><b>No exceptions this month</b>Everyone worked a regular month.</div>';
  else{h+='<div class="tw"><table class="t" style="min-width:820px"><thead><tr><th>Employee</th><th class="num">Paid leave</th><th class="num">Unpaid leave</th><th class="num">Absent</th><th class="num">OT hours</th><th class="num">Night shifts</th><th class="num">Other deduction</th><th>Note</th></tr></thead><tbody>';
    rows.forEach(e=>{const x=S.attendance[e.id];h+='<tr><td><b>'+esc(e.name)+'</b><small>'+esc(siteOf(e.siteId).name)+'</small></td><td class="num">'+x.paidLeave+'</td><td class="num">'+x.unpaidLeave+'</td><td class="num">'+x.absent+'</td><td class="num">'+(x.ot>50?'<span class="pill warn">'+x.ot+'</span>':x.ot)+'</td><td class="num">'+x.night+'</td><td class="num">'+inr(x.otherDed)+'</td><td><input type="text" data-att="note" data-id="'+e.id+'" value="'+esc(x.note||'')+'" placeholder="Add a note" aria-label="Note for '+esc(e.name)+'"'+(locked()?' disabled':'')+'></td></tr>'});
    h+='</tbody></table></div>'}
  if(!locked())h+='<button class="btn primary" data-act="confirmReview"'+(r.reviewed?' disabled':'')+'>'+(r.reviewed?'Review confirmed':'Confirm review')+'</button>';
  return h;
}

function calcTable(c,t){
  let h='<div class="tw"><table class="t" style="min-width:980px"><thead><tr><th>Employee</th><th>Client site</th><th class="num">Payable days</th><th class="num">Fixed earnings</th><th class="num">OT and shifts</th><th class="num">Gross</th><th class="num">PF</th><th class="num">ESI</th><th class="num">PT</th><th class="num">Other</th><th class="num">Net pay</th></tr></thead><tbody>';
  c.forEach(x=>{h+='<tr><td><b>'+esc(x.name)+'</b><small>'+esc(x.code)+'</small></td><td>'+esc(x.site)+'</td><td class="num">'+x.payable+'/'+x.D+'</td><td class="num">'+inr(x.basic+x.hra+x.other)+'</td><td class="num">'+inr(x.ot+x.night)+'</td><td class="num">'+inr(x.gross)+'</td><td class="num">'+inr(x.pfEmp)+'</td><td class="num">'+inr(x.esiEmp)+'</td><td class="num">'+inr(x.pt)+'</td><td class="num">'+inr(x.otherDed)+'</td><td class="num"><b>'+inr(x.net)+'</b></td></tr>'});
  h+='</tbody><tfoot><tr><td colspan="3">Total for '+t.n+' employees</td><td class="num"></td><td class="num">'+inr(t.ot)+'</td><td class="num">'+inr(t.gross)+'</td><td class="num">'+inr(t.pfEmp)+'</td><td class="num">'+inr(t.esiEmp)+'</td><td class="num">'+inr(t.pt)+'</td><td class="num">'+inr(t.otherDed)+'</td><td class="num">'+inr(t.net)+'</td></tr></tfoot></table></div>';
  return h;
}
function pageCalculate(){
  const m=S.month,r=run(m),miss=[];
  if(!attComplete())miss.push(['attendance','Complete attendance for every active employee']);
  if(!r.reviewed&&!r.hasCalc)miss.push(['review','Confirm the overtime, leave and absence review']);
  if(miss.length&&!r.hasCalc)return gate(miss);
  let h='';
  if(r.rejected&&r.remark&&!isApproved(m))h+='<div class="banner bad"><div><b>Sent back by manager:</b> '+esc(r.remark)+'</div></div>';
  if(locked())h+='<div class="banner info">This month is approved, so the calculation is locked.</div>';
  h+='<div class="row" style="margin-bottom:14px"><p class="muted" style="margin:0;max-width:62ch">Pay is worked out from salary structure and attendance. PF, ESI and professional tax rates come from Settings.</p><span class="spacer"></span>'+(locked()?'':'<button class="btn primary" data-act="doCalc">'+(r.hasCalc?'Recalculate payroll':'Calculate payroll for '+esc(monthLabel(m)))+'</button>')+'</div>';
  if(!r.hasCalc)return h+'<div class="card empty"><b>Payroll not calculated yet</b>Calculate to see gross pay, deductions and net pay for each employee.</div>';
  return h+calcTable(S.lines,r.totals||totalsOf(S.lines));
}

function pageValidate(){
  const m=S.month,r=run(m);
  if(!r.hasCalc)return gate([['calculate','Calculate monthly payroll']]);
  const t=r.totals||totalsOf(S.lines);let h='';
  h+='<div class="stats"><div class="stat"><div class="v">'+inr(t.pfEmp)+'</div><div class="l">PF from employees</div></div><div class="stat"><div class="v">'+inr(t.pfEr)+'</div><div class="l">PF by employer</div></div><div class="stat"><div class="v">'+inr(t.esiEmp)+'</div><div class="l">ESI from employees</div></div><div class="stat"><div class="v">'+inr(t.esiEr)+'</div><div class="l">ESI by employer</div></div></div>';
  h+='<div class="row" style="margin-bottom:14px"><p class="muted" style="margin:0;max-width:62ch">Checks cover UAN, ESI number, bank details, negative pay and unusual values. Errors must be fixed. Warnings can be accepted.</p><span class="spacer"></span>'+(locked()?'':'<button class="btn primary" data-act="runChecks">'+(r.issues?'Run checks again':'Run checks')+'</button>')+'</div>';
  if(!r.issues)return h+'<div class="card empty"><b>Checks not run yet</b>Run checks before sending this payroll for approval.</div>';
  const errs=r.issues.filter(i=>i.lv==='error'),warns=r.issues.filter(i=>i.lv==='warn');
  if(r.validated)h+='<div class="banner ok"><b>Validated.</b> '+(warns.length?warns.length+' warning'+(warns.length>1?'s':'')+' accepted. ':'No issues found. ')+'This payroll can go to the manager.</div>';
  else h+='<div class="banner bad"><b>'+errs.length+' error'+(errs.length>1?'s':'')+' to fix.</b> Update the employee record, then run checks again.</div>';
  if(r.issues.length){h+='<div class="tw"><table class="t"><thead><tr><th>Level</th><th>Employee</th><th>Issue</th><th></th></tr></thead><tbody>';
    errs.concat(warns).forEach(i=>{h+='<tr><td>'+pill(i.lv==='error'?'Error':'Warning',i.lv==='error'?'bad':'warn')+'</td><td><b>'+esc(i.name)+'</b></td><td>'+esc(i.msg)+'</td><td class="num">'+(i.id&&!locked()?'<button class="btn sm" data-act="editEmp" data-id="'+i.id+'">Fix</button>':'')+'</td></tr>'});
    h+='</tbody></table></div>'}
  return h;
}

function pageApproval(){
  const m=S.month,r=run(m),appr=isApproved(m);
  if(!r.hasCalc)return gate([['calculate','Calculate monthly payroll']]);
  if(!r.validated&&!r.submitted&&!appr)return gate([['validate','Validate PF, ESI and deductions']]);
  const t=r.totals||totalsOf(S.lines),st=statusOf(m);
  let h='<div class="card"><div class="row"><h3>'+esc(monthLabel(m))+' payroll summary</h3><span class="spacer"></span>'+pill(st[0],st[1])+'</div><div class="stats" style="margin:14px 0 0">'+
    '<div class="stat"><div class="v">'+t.n+'</div><div class="l">Employees</div></div><div class="stat"><div class="v">'+inr(t.gross)+'</div><div class="l">Gross pay</div></div><div class="stat"><div class="v">'+inr(t.ded)+'</div><div class="l">Deductions</div></div><div class="stat"><div class="v">'+inr(t.net)+'</div><div class="l">Net pay</div></div><div class="stat"><div class="v">'+inr(t.cost)+'</div><div class="l">Cost to company</div></div></div></div>';
  if(r.rejected&&r.remark&&!r.submitted&&!appr)h+='<div class="banner bad"><div><b>Last rejection:</b> '+esc(r.remark)+'</div></div>';
  if(appr)h+='<div class="banner ok">Approved. Continue to payslips and bank file.</div>';
  else if(!r.submitted){
    h+='<div class="card"><h3>Send for approval</h3><p class="sub">A manager reviews the totals and approves or sends the payroll back.</p><button class="btn primary" data-act="submit">Submit for approval</button></div>';
  }else if(!S.me.isAdmin){
    h+='<div class="banner warn">Waiting for a manager. Only a user with the Manager role can approve payroll.</div>';
  }else{
    h+='<div class="card"><h3>Your decision</h3><p class="sub">Rejecting sends the payroll back to the review step so it can be corrected.</p><label class="small muted" for="remark">Remark (required when rejecting)</label><textarea id="remark" rows="2"></textarea><div class="row" style="margin-top:12px"><button class="btn primary" data-act="approve">Approve payroll</button><button class="btn danger" data-act="reject">Reject and send back</button></div></div>';
  }
  return h+'<div class="card"><h3>Activity</h3><p class="sub">Who did what for this month.</p>'+logHtml(m)+'</div>';
}

function bankText(m){
  const lines=['Sr,Beneficiary name,Account number,IFSC,Amount,Narration'];
  let tot=0;
  S.lines.filter(c=>c.net>0).forEach((c,i)=>{tot+=c.net;lines.push([i+1,'"'+c.name+'"',c.acct,String(c.ifsc||'').toUpperCase(),c.net.toFixed(2),'Salary '+monthLabel(m)].join(','))});
  lines.push('Total,,,,'+tot.toFixed(2)+',');
  return lines.join('\n');
}
function pagePayslips(){
  const m=S.month,r=run(m);
  if(!isApproved(m)&&!r.finalized)return gate([['approval','Get manager approval']]);
  if(!r.finalized){
    return '<div class="card"><h3>Ready to generate</h3><p class="sub">This creates a payslip for each employee and the bank transfer file, then closes '+esc(monthLabel(m))+'. Nothing can be edited afterwards.</p><button class="btn primary" data-act="generate">Generate payslips and bank file</button></div>';
  }
  let h='<div class="banner ok">Payslips and bank file are ready. This month is closed.</div>';
  h+='<div class="card"><h3>Bank transfer file</h3><p class="sub">Save it as a CSV, or copy it into the format your bank portal expects.</p><textarea class="bank" id="bankfile" readonly aria-label="Bank file">'+esc(bankText(m))+'</textarea><div class="row" style="margin-top:10px"><button class="btn primary" data-act="saveBank">Save as CSV</button><button class="btn" data-act="copyBank">Copy bank file</button></div></div>';
  h+='<div class="tw"><table class="t"><thead><tr><th>Employee</th><th>Client site</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th></th></tr></thead><tbody>';
  S.lines.forEach(c=>{h+='<tr><td><b>'+esc(c.name)+'</b><small>'+esc(c.code)+'</small></td><td>'+esc(c.site)+'</td><td class="num">'+inr(c.gross)+'</td><td class="num">'+inr(c.ded)+'</td><td class="num"><b>'+inr(c.net)+'</b></td><td class="num"><button class="btn sm" data-act="viewSlip" data-id="'+c.id+'">View payslip</button></td></tr>'});
  return h+'</tbody></table></div>';
}
function payslipHtml(c,m){
  const row=(l,v)=>'<tr><td>'+l+'</td><td class="n">'+inr(v)+'</td></tr>';
  let earn=row('Basic pay',c.basic)+row('House rent allowance',c.hra)+row('Other allowances',c.other);
  if(c.ot)earn+=row('Overtime ('+c.otHrs+' hrs)',c.ot);
  if(c.night)earn+=row('Night shift allowance ('+c.nights+')',c.night);
  let ded=row('Provident fund',c.pfEmp)+row('ESI',c.esiEmp)+row('Professional tax',c.pt);
  if(c.otherDed)ded+=row('Other deduction',c.otherDed);
  return '<div class="ps"><h2>PFSS</h2><div class="muted">Payslip for '+esc(monthLabel(m))+'</div><div class="meta"><div><span>Name</span><br><b>'+esc(c.name)+'</b></div><div><span>Employee code</span><br><b>'+esc(c.code)+'</b></div><div><span>Designation</span><br>'+esc(c.desig)+'</div><div><span>Client site</span><br>'+esc(c.site)+'</div><div><span>UAN</span><br>'+esc(c.uan||'Not provided')+'</div><div><span>Paid days</span><br>'+c.payable+' of '+c.D+'</div></div>'+
    '<div class="two" style="gap:24px"><table><thead><tr><th>Earnings</th><th class="n">Amount</th></tr></thead><tbody>'+earn+'<tr class="tot"><td>Gross pay</td><td class="n">'+inr(c.gross)+'</td></tr></tbody></table>'+
    '<table><thead><tr><th>Deductions</th><th class="n">Amount</th></tr></thead><tbody>'+ded+'<tr class="tot"><td>Total deductions</td><td class="n">'+inr(c.ded)+'</td></tr></tbody></table></div>'+
    '<div class="net"><span>Net pay</span><span>'+inr(c.net)+'</span></div><p class="muted small" style="margin:12px 0 0">Employer contributions this month: PF '+inr(c.pfEr)+', ESI '+inr(c.esiEr)+'. This is a system-generated payslip.</p></div>';
}

function pageReports(){
  const m=S.month,r=S.runs[m];
  let h='';
  const hist=Object.keys(S.runs).filter(k=>S.runs[k].totals).sort().reverse();
  if(r&&r.hasCalc&&S.lines.length){
    const t=r.totals||totalsOf(S.lines),bySite={};
    S.lines.forEach(c=>{const k=c.site;(bySite[k]=bySite[k]||{client:c.client,n:0,gross:0,net:0,cost:0});const b=bySite[k];b.n++;b.gross+=c.gross;b.net+=c.net;b.cost+=c.gross+c.pfEr+c.esiEr});
    if(!r.finalized)h+='<div class="banner info">'+esc(monthLabel(m))+' is not closed yet. Figures below are from the latest calculation.</div>';
    h+='<div class="card"><h3>Cost by client site, '+esc(monthLabel(m))+'</h3><p class="sub">Cost to company includes employer PF and ESI.</p><div class="tw" style="margin:0"><table class="t"><thead><tr><th>Site</th><th>Client</th><th class="num">Employees</th><th class="num">Gross pay</th><th class="num">Net pay</th><th class="num">Cost to company</th></tr></thead><tbody>';
    Object.keys(bySite).forEach(k=>{const b=bySite[k];h+='<tr><td><b>'+esc(k)+'</b></td><td>'+esc(b.client)+'</td><td class="num">'+b.n+'</td><td class="num">'+inr(b.gross)+'</td><td class="num">'+inr(b.net)+'</td><td class="num">'+inr(b.cost)+'</td></tr>'});
    h+='</tbody><tfoot><tr><td colspan="2">Total</td><td class="num">'+t.n+'</td><td class="num">'+inr(t.gross)+'</td><td class="num">'+inr(t.net)+'</td><td class="num">'+inr(t.cost)+'</td></tr></tfoot></table></div></div>';
    h+='<div class="card"><h3>Statutory summary, '+esc(monthLabel(m))+'</h3><p class="sub">Amounts to remit for this month.</p><div class="tw" style="margin:0"><table class="t" style="min-width:420px"><thead><tr><th>Contribution</th><th class="num">Employee</th><th class="num">Employer</th><th class="num">Total</th></tr></thead><tbody>'+
      '<tr><td>Provident fund</td><td class="num">'+inr(t.pfEmp)+'</td><td class="num">'+inr(t.pfEr)+'</td><td class="num">'+inr(t.pfEmp+t.pfEr)+'</td></tr>'+
      '<tr><td>ESI</td><td class="num">'+inr(t.esiEmp)+'</td><td class="num">'+inr(t.esiEr)+'</td><td class="num">'+inr(t.esiEmp+t.esiEr)+'</td></tr>'+
      '<tr><td>Professional tax</td><td class="num">'+inr(t.pt)+'</td><td class="num">-</td><td class="num">'+inr(t.pt)+'</td></tr></tbody></table></div></div>';
    h+='<div class="row" style="margin:22px 0 10px"><h3 style="margin:0;font-size:16px">Payroll register</h3><span class="spacer"></span><button class="btn sm" data-act="saveRegister">Save as CSV</button></div>'+calcTable(S.lines,t);
  }else h+='<div class="card empty"><b>No payroll calculated for '+esc(monthLabel(m))+'</b>Reports appear here once payroll is calculated.</div>';
  h+='<div class="card"><h3>Payroll history</h3><p class="sub">All months with a calculated payroll.</p>';
  if(!hist.length)h+='<p class="muted" style="margin:0">No history yet.</p>';
  else{h+='<div class="tw" style="margin:0"><table class="t" style="min-width:560px"><thead><tr><th>Month</th><th>Status</th><th class="num">Employees</th><th class="num">Net pay</th><th class="num">Cost to company</th><th></th></tr></thead><tbody>';
    hist.forEach(k=>{const x=S.runs[k],s=statusOf(k);h+='<tr><td><b>'+esc(monthLabel(k))+'</b></td><td>'+pill(s[0],s[1])+'</td><td class="num">'+x.totals.n+'</td><td class="num">'+inr(x.totals.net)+'</td><td class="num">'+inr(x.totals.cost)+'</td><td class="num"><button class="btn sm" data-act="openRun" data-m="'+k+'">Open</button></td></tr>'});
    h+='</tbody></table></div>'}
  return h+'</div>';
}

function pageSettings(){
  const s=S.settings,adm=S.me.isAdmin;
  const f=(k,l,hint)=>'<div><label for="s_'+k+'">'+l+'</label><input id="s_'+k+'" type="number" step="any" value="'+s[k]+'"'+(adm?'':' disabled')+'>'+(hint?'<div class="muted small" style="margin-top:2px">'+hint+'</div>':'')+'</div>';
  let h='<div class="card"><h3>Who can do what</h3><p class="sub">Each person signs in with their own account. Managers add users on the Users page.</p><ul class="log"><li><b>Payroll admin</b>: enters sites, employees and attendance, calculates payroll, validates and submits for approval.</li><li><b>Manager</b>: everything a payroll admin can do, plus approving payroll, changing the rates below, managing users, backups and deleting data.</li><li><b>Viewer</b>: can look but not change anything.</li></ul></div>';
  h+='<div class="card"><h3>Statutory and pay rules</h3><p class="sub">'+(adm?'Applied the next time you calculate payroll. Confirm current rates with your compliance advisor.':'Only a manager can change these.')+'</p><div class="form">'+
    '<h4>Provident fund</h4>'+f('pfRate','PF rate (%)')+f('pfCeiling','PF wage ceiling (monthly basic)')+
    '<h4>ESI</h4>'+f('esiEmp','Employee rate (%)')+f('esiEr','Employer rate (%)')+f('esiCeiling','ESI salary ceiling (monthly)')+
    '<h4>Overtime, shifts and professional tax</h4>'+f('otMult','Overtime multiplier','Applied to basic hourly rate')+f('nightAllowance','Night shift allowance per shift')+f('ptThreshold','Professional tax applies from gross')+f('ptAmount','Professional tax per month')+
    '</div>'+(adm?'<div class="row" style="margin-top:16px"><button class="btn primary" data-act="saveSettings">Save settings</button></div>':'')+'</div>';
  if(adm){
    h+='<div class="card"><h3>Backup and restore</h3><p class="sub">The backup file holds every site, employee, attendance record, payroll run and approval. User accounts are not included. Restoring replaces all current data. Backup files up to about 5 MB can be restored.</p><div class="row"><button class="btn primary" data-act="backup">Download backup</button><button class="btn" data-act="pickRestore">Restore from backup</button><input type="file" id="restorefile" accept=".json,application/json" hidden></div></div>';
    if(!S.employees.length&&!S.sites.length)h+='<div class="card"><h3>Sample data</h3><p class="sub">Load a few sites, employees and a month of attendance to try the app. Only works while the database is empty.</p><button class="btn" data-act="seedSample">Load sample data</button></div>';
    h+='<div class="card"><h3>Delete all data</h3><p class="sub">Removes every site, employee, attendance record, payroll run and approval for everyone. User accounts stay. Download a backup first.</p><button class="btn danger" data-act="clearAll">Delete all data</button></div>';
  }
  return h;
}
const ROLE_NAMES={manager:'Manager',payroll:'Payroll admin',viewer:'Viewer'};
function pageUsers(){
  let h='<div class="row" style="margin-bottom:14px"><p class="muted" style="margin:0;max-width:62ch">People who can sign in to PFSS Payroll. Deactivating a user signs them out and blocks sign-in, and keeps their history.</p><span class="spacer"></span><button class="btn primary" data-act="addUser">Add user</button></div>';
  h+='<div class="tw"><table class="t"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>';
  S.usersList.forEach(u=>{
    h+='<tr style="'+(u.active?'':'opacity:.55')+'"><td><b>'+esc(u.name)+'</b>'+(u.id===S.me.id?'<small>You</small>':'')+'</td><td>'+esc(u.username)+'</td><td><select data-role-user="'+u.id+'" aria-label="Role for '+esc(u.name)+'" style="min-height:32px;padding:4px 8px">'+Object.keys(ROLE_NAMES).map(r=>'<option value="'+r+'"'+(u.role===r?' selected':'')+'>'+ROLE_NAMES[r]+'</option>').join('')+'</select></td><td>'+pill(u.active?'Active':'Inactive',u.active?'ok':'muted')+'</td><td class="num"><button class="btn sm" data-act="resetPw" data-id="'+u.id+'">Reset password</button> <button class="btn sm" data-act="toggleUser" data-id="'+u.id+'">'+(u.active?'Deactivate':'Reactivate')+'</button></td></tr>'});
  return h+'</tbody></table></div>';
}
const PAGES={dashboard:pageDash,sites:pageSites,employees:pageEmployees,attendance:pageAttendance,review:pageReview,calculate:pageCalculate,validate:pageValidate,approval:pageApproval,payslips:pagePayslips,reports:pageReports,settings:pageSettings,users:pageUsers};

/* ---------- actions ---------- */
const val=id=>{const el=$('#'+id);return el?el.value.trim():''};
function downloadBlob(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
function saveFile(name,text){downloadBlob(name,new Blob([text],{type:'text/csv'}))}
function registerCsv(){
  const rows=[['Code','Name','Site','Payable days','Basic','HRA','Other','OT','Night','Gross','PF','ESI','PT','Other deduction','Net pay','PF employer','ESI employer']];
  S.lines.forEach(c=>rows.push([c.code,c.name,c.site,c.payable,c.basic,c.hra,c.other,c.ot,c.night,c.gross,c.pfEmp,c.esiEmp,c.pt,c.otherDed,c.net,c.pfEr,c.esiEr].map(x=>'"'+String(x).replace(/"/g,'""')+'"')));
  return rows.map(r=>r.join(',')).join('\n');
}
const A={
  go(t){S.page=t.dataset.page;document.body.classList.remove('menu');render(true)},
  menu(){document.body.classList.toggle('menu')},
  closeModal(){closeModal()},
  confirmYes(){const f=pending;closeModal();if(f)f()},
  addSite(){siteForm()},
  editSite(t){siteForm(S.sites.find(s=>s.id===t.dataset.id))},
  async saveSite(t){
    const name=val('f_name');if(!name){$('#ferr').textContent='Enter a site name.';return}
    const id=t.dataset.id||'s'+uid(),rec={name,client:val('f_client'),city:val('f_city')};
    if(await guard(()=>S.db.doc('sites/'+id).set(rec))){closeModal();toast('Site saved')}},
  delSite(t){
    const s=S.sites.find(x=>x.id===t.dataset.id);
    if(S.employees.some(e=>e.siteId===s.id)){openModal('Cannot delete site','<p style="margin:0">'+esc(s.name)+' still has employees assigned. Move them to another site first.</p>','<button class="btn primary" data-act="closeModal">OK</button>');return}
    confirmBox('Delete client site','Delete '+esc(s.name)+'? This cannot be undone.',async()=>{if(await guard(()=>S.db.doc('sites/'+s.id).delete()))toast('Site deleted')},'Delete site')},
  addEmp(){if(!S.sites.length){openModal('Add a client site first','<p style="margin:0">Employees are assigned to a client site. Add at least one site before adding employees.</p>','<button class="btn" data-act="closeModal">Close</button><button class="btn primary" data-act="go" data-page="sites">Go to client sites</button>');return}empForm()},
  editEmp(t){empForm(S.employees.find(e=>e.id===t.dataset.id))},
  async saveEmp(t){
    const err=m=>{$('#ferr').textContent=m};
    const rec={name:val('f_name'),code:val('f_code'),desig:val('f_desig'),phone:val('f_phone'),doj:val('f_doj'),siteId:$('#f_site').value,basic:parseFloat(val('f_basic'))||0,hra:parseFloat(val('f_hra'))||0,other:parseFloat(val('f_other'))||0,pf:$('#f_pf').checked,esi:$('#f_esi').checked,uan:val('f_uan'),esiNo:val('f_esiNo'),bankName:val('f_bankName'),acct:val('f_acct'),ifsc:val('f_ifsc').toUpperCase()};
    if(!rec.name)return err('Enter the employee name.');
    if(!rec.siteId)return err('Assign a client site.');
    if(rec.basic<=0)return err('Enter basic pay greater than zero.');
    if(rec.uan&&!/^\d{12}$/.test(rec.uan))return err('UAN must be 12 digits.');
    if(S.employees.some(e=>e.code===rec.code&&e.id!==t.dataset.id))return err('Employee code '+rec.code+' is already used.');
    const id=t.dataset.id||'e'+uid(),old=S.employees.find(e=>e.id===id);
    const body=Object.assign({active:true},old||{},rec);delete body.id;
    const changed=!!old&&['basic','hra','other','pf','esi','siteId'].some(k=>old[k]!==rec[k]);
    if(await guard(()=>S.db.doc('employees/'+id).set(body))){if(changed)invalidateAll();closeModal();toast('Employee saved')}},
  async toggleEmp(t){
    const e=S.employees.find(x=>x.id===t.dataset.id),on=e.active===false;
    const body=Object.assign({},e,{active:on});delete body.id;
    if(await guard(()=>S.db.doc('employees/'+e.id).set(body))){invalidateAll();toast(on?'Employee reactivated':'Employee deactivated')}},
  async markAll(){
    const m=S.month,D=dim(m);
    const recs=active().map(e=>{const old=S.attendance[e.id]||{};return {month:m,empId:e.id,present:D,paidLeave:0,unpaidLeave:0,absent:0,ot:+old.ot||0,night:+old.night||0,otherDed:+old.otherDed||0,note:old.note||''}});
    recs.forEach(r=>{S.attendance[r.empId]=r});
    const keys=recs.map(r=>'att/'+m+'_'+r.empId);keys.forEach(k=>{PEND[k]=(PEND[k]||0)+1});
    const ok=await guard(()=>S.db.batch(recs.map(r=>({op:'set',c:'attendance',id:m+'_'+r.empId,data:r}))));
    keys.forEach(k=>{PEND[k]--});
    if(ok){invalidateRun(m);render();toast('Everyone marked present for '+D+' days')}},
  async confirmReview(){if(await guard(()=>patchRun(S.month,{reviewed:true},'Confirmed overtime, leave and absence review')))toast('Review confirmed')},
  async doCalc(){
    const m=S.month;calcBusy=true;toast('Calculating payroll');
    const lines=active().map(e=>Object.assign({month:m},calcEmp(e,S.attendance[e.id]||{},m)));
    const keep={};lines.forEach(l=>{keep[l.id]=1});
    const stale=S.lines.filter(l=>!keep[l.id]);
    S.lines=lines;
    const stamp=String(Date.now()),totals=totalsOf(lines);
    const ok=await guard(async()=>{
      await S.db.batch(lines.map(l=>({op:'set',c:'runlines',id:m+'_'+l.id,data:l})).concat(stale.map(l=>({op:'delete',c:'runlines',id:m+'_'+l.id}))));
      await patchRun(m,{hasCalc:true,stamp,totals,validated:false,issues:null,submitted:false,rejected:false},'Calculated payroll for '+lines.length+' employees');
    });
    calcBusy=false;
    if(ok){render();toast('Payroll calculated')}else{scheduleRender()}},
  async runChecks(){
    const m=S.month,issues=runChecks(),errs=issues.filter(i=>i.lv==='error').length,valid=errs===0;
    if(await guard(()=>patchRun(m,{issues,validated:valid},valid?'Validation passed':'Validation found '+errs+' error'+(errs>1?'s':''))))toast(valid?'Validation passed':'Fix the errors, then run checks again')},
  async submit(){if(await guard(()=>patchRun(S.month,{submitted:true,rejected:false},'Submitted payroll for approval')))toast('Sent for approval')},
  async approve(){
    const m=S.month,r=run(m),rm=val('remark');
    const ok=await guard(async()=>{
      await S.db.doc('approvals/'+m).set({decision:'approved',stamp:r.stamp,remark:rm,by:S.me.id,at:new Date().toISOString()});
      await patchRun(m,{submitted:false},'Approved payroll'+(rm?': '+rm:''));
    });
    if(ok)toast('Payroll approved')},
  async reject(){
    const rm=val('remark');if(!rm){toast('Add a remark so the team knows what to fix');return}
    const m=S.month,r=run(m);
    const ok=await guard(async()=>{
      await S.db.doc('approvals/'+m).set({decision:'rejected',stamp:r.stamp,remark:rm,by:S.me.id,at:new Date().toISOString()});
      await patchRun(m,{rejected:true,remark:rm,submitted:false,reviewed:false,hasCalc:false,validated:false,issues:null,totals:null},'Rejected payroll: '+rm);
    });
    if(ok){S.page='review';render(true);toast('Sent back to review')}},
  async generate(){
    const m=S.month;
    const ok=await guard(async()=>{
      const fresh=S.lines.map(c=>{const e=S.employees.find(x=>x.id===c.id);return e?Object.assign({},c,{uan:e.uan||'',esiNo:e.esiNo||'',acct:e.acct||'',ifsc:e.ifsc||'',bankName:e.bankName||''}):c});
      calcBusy=true;S.lines=fresh;
      try{await S.db.batch(fresh.map(l=>({op:'set',c:'runlines',id:m+'_'+l.id,data:l})))}finally{calcBusy=false}
      await patchRun(m,{finalized:true},'Generated payslips and bank file; month closed');
    });
    if(ok){render();toast('Payslips and bank file generated')}},
  viewSlip(t){
    const c=S.lines.find(x=>x.id===t.dataset.id);if(!c)return;
    openModal('Payslip, '+c.name,payslipHtml(c,S.month),'<button class="btn" data-act="closeModal">Close</button><button class="btn primary" data-act="printSlip">Print payslip</button>',true)},
  printSlip(){try{window.print()}catch(e){toast('Use your browser print option')}},
  saveBank(){saveFile('pfss-bank-file-'+S.month+'.csv',bankText(S.month))},
  saveRegister(){saveFile('pfss-payroll-register-'+S.month+'.csv',registerCsv())},
  copyBank(){
    const ta=$('#bankfile'),txt=ta.value;
    const fallback=()=>{ta.focus();ta.select();let ok=false;try{ok=document.execCommand('copy')}catch(e){}toast(ok?'Bank file copied':'Select the text and copy it manually')};
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).then(()=>toast('Bank file copied'),fallback);else fallback()},
  openRun(t){setMonth(t.dataset.m);render(true)},
  async saveSettings(){
    const o=Object.assign({},S.settings);
    Object.keys(DEF).forEach(k=>{const v=parseFloat($('#s_'+k).value);if(!isNaN(v)&&v>=0)o[k]=v});
    if(await guard(()=>S.db.doc('config/settings').set(o)))toast('Settings saved. Recalculate payroll to apply them.')},
  clearAll(){confirmBox('Delete all data','This removes all sites, employees, attendance, payroll runs and approvals for everyone using PFSS Payroll. It cannot be undone.',async()=>{
    toast('Deleting data');
    if(await guard(()=>http('POST','/api/wipe',{}))){S.page='dashboard';render(true);toast('All data deleted')}},'Delete all data')},
  async backup(){
    try{const j=await http('GET','/api/export');downloadBlob('pfss-backup-'+new Date().toISOString().slice(0,10)+'.json',new Blob([JSON.stringify(j,null,1)],{type:'application/json'}));toast('Backup downloaded')}
    catch(e){toast(errTxt(e))}},
  async seedSample(){if(await guard(()=>http('POST','/api/seed-sample',{}))){render();toast('Sample data loaded')}},
  pickRestore(){const f=$('#restorefile');if(f)f.click()},
  account(){
    openModal('Your account','<p style="margin:0 0 14px"><b>'+esc(S.me.name)+'</b><br><span class="muted">'+esc(S.me.username)+' &middot; '+esc(ROLE_NAMES[S.me.role])+'</span></p><div class="form"><h4>Change password</h4><div class="full"><label for="f_cur">Current password</label><input id="f_cur" type="password" autocomplete="current-password"></div><div class="full"><label for="f_new">New password (at least 8 characters)</label><input id="f_new" type="password" autocomplete="new-password"></div><div class="err" id="ferr"></div></div>','<button class="btn" data-act="signout">Sign out</button><span class="spacer"></span><button class="btn" data-act="closeModal">Close</button><button class="btn primary" data-act="changePw">Change password</button>')},
  async changePw(){
    const cur=$('#f_cur').value,nw=$('#f_new').value;
    try{await http('POST','/api/password',{current:cur,next:nw});closeModal();toast('Password changed')}catch(e){$('#ferr').textContent=e.message||'Could not change password.'}},
  async signout(){try{await http('POST','/api/logout',{})}catch(e){}location.reload()},
  addUser(){
    openModal('Add user','<div class="form"><div><label for="f_uname">Full name</label><input id="f_uname" type="text"></div><div><label for="f_uuser">Username</label><input id="f_uuser" type="text" autocapitalize="none" autocomplete="off"></div><div><label for="f_urole">Role</label><select id="f_urole"><option value="payroll">Payroll admin</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select></div><div><label for="f_upass">Starting password (at least 8 characters)</label><input id="f_upass" type="text" autocomplete="off"></div><div class="err" id="ferr"></div></div>','<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveUser">Add user</button>')},
  async saveUser(){
    try{await http('POST','/api/users',{name:val('f_uname'),username:val('f_uuser'),role:$('#f_urole').value,password:$('#f_upass').value});closeModal();await loadUsers();render();toast('User added. Share the username and starting password with them.')}
    catch(e){$('#ferr').textContent=e.message||'Could not add user.'}},
  resetPw(t){
    openModal('Reset password','<div class="form"><div class="full"><label for="f_rpw">New password (at least 8 characters)</label><input id="f_rpw" type="text" autocomplete="off"></div><div class="err" id="ferr"></div></div>','<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveResetPw" data-id="'+t.dataset.id+'">Reset password</button>')},
  async saveResetPw(t){
    try{await http('PATCH','/api/users/'+t.dataset.id,{password:$('#f_rpw').value});closeModal();toast('Password reset. The user is signed out everywhere.')}
    catch(e){$('#ferr').textContent=e.message||'Could not reset password.'}},
  async toggleUser(t){
    const u=S.usersList.find(x=>x.id===t.dataset.id);
    try{await http('PATCH','/api/users/'+u.id,{active:!u.active});await loadUsers();render();toast(u.active?'User deactivated':'User reactivated')}catch(e){toast(errTxt(e))}}
};
const WRITE=new Set(['saveSite','delSite','saveEmp','toggleEmp','markAll','confirmReview','doCalc','runChecks','submit','generate']);
const ADMIN=new Set(['seedSample','approve','reject','saveSettings','clearAll','backup','pickRestore','addUser','saveUser','resetPw','saveResetPw','toggleUser']);
function setMonth(m){S.month=m;try{localStorage.setItem('pfss_month',m)}catch(e){}if(S.db)subMonth();renderShell()}

document.addEventListener('click',ev=>{
  const t=ev.target.closest('[data-act]');
  if(t&&A[t.dataset.act]){
    const a=t.dataset.act;
    if(WRITE.has(a)&&!S.me.canWrite){toast('You have view-only access to this page.');return}
    if(ADMIN.has(a)&&!S.me.isAdmin){toast('Only a manager can do this.');return}
    A[a](t);return}
  if(ev.target===$('#mb'))closeModal();
  if(document.body.classList.contains('menu')&&!ev.target.closest('#nav')&&!ev.target.closest('.burger'))document.body.classList.remove('menu');
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeModal()});
document.addEventListener('focusout',()=>setTimeout(()=>{if(dirty&&!typing())render()},0));
document.addEventListener('input',ev=>{if(ev.target.id==='empq'){S.ui.q=ev.target.value;$('#emptable').innerHTML=empRows()}});
document.addEventListener('change',ev=>{
  const t=ev.target,m=S.month;
  if(t.dataset&&t.dataset.roleUser){
    http('PATCH','/api/users/'+t.dataset.roleUser,{role:t.value}).then(()=>loadUsers()).then(()=>{if(t.dataset.roleUser===S.me.id){location.reload()}else{render();toast('Role updated')}}).catch(e=>{toast(errTxt(e));loadUsers().then(()=>render())});return}
  if(t.id==='restorefile'){
    const f=t.files&&t.files[0];if(!f)return;
    confirmBox('Restore from backup','This replaces all current sites, employees, attendance, payroll runs and approvals with the contents of '+esc(f.name)+'. Download a backup first if you may need the current data.',async()=>{
      try{const txt=await f.text();const j=JSON.parse(txt);const r=await http('POST','/api/restore',j);toast('Restored '+r.count+' records');render()}catch(e){toast(e&&e.message?e.message:'That file could not be restored')}},'Restore data');
    t.value='';return}
  if(t.id==='emps'){S.ui.site=t.value;$('#emptable').innerHTML=empRows();return}
  if(t.id==='month'){setMonth(t.value);return}
  if(t.dataset&&t.dataset.att){
    if(!S.me.canWrite){toast('You have view-only access to this page.');return}
    if(locked(m))return;
    const id=t.dataset.id;
    const rec=Object.assign({month:m,empId:id,present:0,paidLeave:0,unpaidLeave:0,absent:0,ot:0,night:0,otherDed:0,note:''},S.attendance[id]||{});
    if(t.dataset.att==='note')rec.note=t.value;else rec[t.dataset.att]=Math.max(0,parseFloat(t.value)||0);
    S.attendance[id]=rec;
    enqueue('att/'+m+'_'+id,()=>S.db.doc('attendance/'+m+'_'+id).set(rec)).catch(e=>toast(errTxt(e)));
    if(t.dataset.att!=='note')invalidateRun(m);
    const c=$('#chk-'+id);if(c)c.innerHTML=chkCell(id);
    renderNav();
  }
});

/* ---------- sign in, setup, start ---------- */
function authScreen(kind,msg){
  const setup=kind==='setup';
  $('#auth').classList.add('open');
  $('#auth').innerHTML='<div class="box"><div class="brand"><span class="mark">PF</span><span><b>PFSS</b><small>Payroll</small></span></div><h2>'+(setup?'Create the manager account':'Sign in')+'</h2><p>'+(setup?'This is the first time PFSS Payroll has run. The setup key proves you own this site. This account can add everyone else.':'Use the username and password your manager gave you.')+'</p>'+
    (setup?'<div class="field"><label for="a_key">Setup key</label><input id="a_key" type="password" autocomplete="off"><div class="muted small" style="margin-top:3px">The SETUP_KEY value you added in Netlify environment variables.</div></div><div class="field"><label for="a_name">Your full name</label><input id="a_name" type="text" autocomplete="name"></div>':'')+
    '<div class="field"><label for="a_user">Username</label><input id="a_user" type="text" autocomplete="username" autocapitalize="none"></div>'+
    '<div class="field"><label for="a_pass">Password'+(setup?' (at least 8 characters)':'')+'</label><input id="a_pass" type="password" autocomplete="'+(setup?'new-password':'current-password')+'"></div>'+
    '<div class="err" id="a_err" style="margin-bottom:10px">'+esc(msg||'')+'</div><button class="btn primary" id="a_go">'+(setup?'Create account and continue':'Sign in')+'</button></div>';
  const go=async()=>{
    $('#a_err').textContent='';
    try{
      if(setup)await http('POST','/api/setup',{setupKey:$('#a_key').value,name:$('#a_name').value,username:$('#a_user').value,password:$('#a_pass').value});
      else await http('POST','/api/login',{username:$('#a_user').value,password:$('#a_pass').value});
      location.reload();
    }catch(e){$('#a_err').textContent=e.message||'Something went wrong. Try again.'}
  };
  $('#a_go').onclick=go;
  $('#auth').onkeydown=ev=>{if(ev.key==='Enter')go()};
  const first=$(setup?'#a_key':'#a_user');if(first)first.focus();
}
window.__onUnauth=()=>{if(!$('#auth').classList.contains('open'))authScreen('login','Your session ended. Sign in again.')};
async function init(){
  renderShell();
  try{
    const st=await http('GET','/api/status');
    if(st.setup){authScreen('setup');return}
    let me;
    try{me=await http('GET','/api/me')}catch(e){if(e&&e.code==='unauthenticated'){authScreen('login');return}throw e}
    S.me={id:me.id,name:me.name,username:me.username,role:me.role,isAdmin:me.role==='manager',canWrite:me.role!=='viewer'};
    await loadUsers();
    S.db=makeDb();
    subscribe();
  }catch(e){S.err='nodb';renderShell()}
}
init();
})();
