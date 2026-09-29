/* Throwaway rendering study. Fictional data and in-memory actions only. */
const icons = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  down:'<path d="m6 9 6 6 6-6"/>', right:'<path d="m9 5 7 7-7 7"/>', left:'<path d="m15 5-7 7 7 7"/>',
  threads:'<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 13h6M8 17h4"/>',
  inbox:'<path d="M5 4h14l3 11v5H2v-5L5 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--tt-surface)"/><circle cx="15" cy="17" r="3" fill="var(--tt-surface)"/>',
  computer:'<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20M9 16l-1 4m7-4 1 4"/>',
  folder:'<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3V6Z"/>',
  question:'<path d="M9 8a3 3 0 1 1 5 2.2c-1.5 1-2 1.3-2 2.8M12 17h.01"/><circle cx="12" cy="12" r="9"/>',
  check:'<path d="m5 12 4 4L19 6"/>', more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  up:'<path d="M12 20V4m-6 6 6-6 6 6"/>', file:'<path d="M5 3h9l5 5v13H5V3Z"/><path d="M14 3v6h5M8 13h8M8 17h6"/>',
  terminal:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  link:'<path d="m9 15 6-6m-7 9-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4-4 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.92)"/>',
};
const icon=(name)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.threads}</svg>`;
const esc=(text)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const directions={
  A:{name:'Focus',description:'Your selected direction. Questions and live work together, search always within reach, and a dedicated place for Settings.',principles:['Questions stay within Threads','Search is always visible','Settings replaces Needs you']},
  B:{name:'Projects',description:'Your workspaces become the way in. Threads sit inside their project, with just enough activity to know where to look.',principles:['Workspace before thread','Fewer repeated labels','Familiar folder hierarchy']},
  C:{name:'Conversations',description:'A familiar, readable index. The thread title and latest words do the talking; status is clear without taking over.',principles:['Content before controls','A preview worth opening','Compact, calm, easy to scan']},
};
const threads=[
  {id:'release',title:'Choose the release target',project:'Sotto',computer:'Laptop',provider:'Claude',state:'needs',time:'2m',preview:'Ready to ship. TestFlight only, or a desktop release too?',question:true},
  {id:'iphone',title:'Refine the iPhone thread view',project:'Sotto',computer:'Laptop',provider:'Codex',state:'working',time:'6m',kind:'turn',preview:'Checking the new layout at smaller screen sizes.'},
  {id:'wiring',title:'Clean up the wiring schedule',project:'Panel tools',computer:'Laptop',provider:'Claude',state:'working',time:'12m',kind:'background',preview:'A background agent is checking terminal labels.'},
  {id:'shortcuts',title:'Add keyboard shortcuts',project:'Sotto',computer:'Laptop',provider:'Codex',state:'done',time:'18m',preview:'Added shortcuts for switching threads and opening Tools.'},
  {id:'drives',title:'Compare motor drive options',project:'Panel tools',computer:'Laptop',provider:'Claude',state:'done',time:'1h',preview:'The comparison is ready, with sizing assumptions called out.'},
  {id:'lighting',title:'Update the lighting plan',project:'House',computer:'Studio Mac',provider:'Codex',state:'offline',time:'Yesterday',preview:'Reconnect to see the latest messages and activity.'},
  {id:'settings',title:'Tidy the settings page',project:'Sotto',computer:'Laptop',provider:'Codex',state:'done',time:'Yesterday',preview:'Settings now has a simpler layout and clearer labels.',settled:true},
  {id:'notes',title:'Import the panel notes',project:'Panel tools',computer:'Laptop',provider:'Claude',state:'done',time:'Mon',preview:'Imported the notes and grouped them by panel.',settled:true},
];
const params=new URLSearchParams(location.search);
const state={variant:directions[params.get('variant')]?params.get('variant'):'A',theme:params.get('theme')==='light'?'light':'dark',compare:params.get('compare')==='1',embed:params.get('embed')==='1',large:false,tab:'threads',filter:'all',computer:'all',query:'',search:false,settled:false,thread:null,pane:'messages',drafts:{},replies:{}};
const app=document.querySelector('#app'),sheet=document.querySelector('#sheet');
let toastTimer;
const find=id=>threads.find(t=>t.id===id);
const glyph=t=>t.provider==='Codex'?'›_':'C';
const workBars='<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>';
function status(t){
  const label={needs:'Needs you',working:t.kind==='background'?'Working · background':'Working',done:t.settled?'Settled':'Done',offline:'Offline'}[t.state];
  return `<span class="state ${t.state}">${t.state==='working'?workBars:t.state==='needs'?icon('question'):'<span class="state-dot" aria-hidden="true"></span>'}${label}</span>`;
}
function meta(t,project=true){return `<div class="metadata">${[project?t.project:null,t.provider,state.computer==='all'?t.computer:null].filter(Boolean).map(esc).join('<span class="separator">·</span>')}</div>`;}
function allVisible(){return threads.filter(t=>(state.computer==='all'||t.computer===state.computer)&&(!state.query||`${t.title} ${t.project} ${t.preview} ${t.provider}`.toLowerCase().includes(state.query.toLowerCase())));}
function filtered(){return allVisible().filter(t=>state.filter==='all'||(state.filter==='working'?t.state==='working':state.filter==='needs'?t.state==='needs':t.state==='done'));}
function header(){
  const all=allVisible().filter(t=>!t.settled),working=all.filter(t=>t.state==='working').length,needs=all.filter(t=>t.state==='needs').length;
  return `<header class="screen-header">
    <h2 class="screen-title">Threads</h2>
    <button class="scope" data-action="scope" aria-label="Choose a computer"><span class="connected-dot ${state.computer==='Studio Mac'?'offline':''}" aria-hidden="true"></span>${state.computer==='all'?'All computers':esc(state.computer)}${icon('down')}</button>
    <div class="search search-pill">${icon('search')}<input id="search-field" type="search" aria-label="Search threads" placeholder="Search threads" value="${esc(state.query)}" autocomplete="off"><button data-action="clear-search" aria-label="Clear search" ${state.query?'':'hidden'}>×</button></div>
    ${state.variant==='A'?`<div class="focus-summary" id="focus-summary"><span><b>${working}</b> working</span><span>${needs} ${needs===1?'needs':'need'} you</span></div>`:''}
    ${state.variant==='B'?`<p class="project-intro">${new Set(all.map(t=>t.project)).size} projects · ${working} working</p>`:''}
    ${state.variant!=='A'?`<div class="filters" aria-label="Filter threads">${[['all','All',all.length],['working','Working',working],['needs','Needs you',needs]].map(([key,label,n])=>`<button data-filter="${key}" aria-pressed="${state.filter===key}">${label}<span class="filter-count">${n}</span></button>`).join('')}</div>`:''}
  </header>`;
}
function quiet(t){return `<button class="row-hit quiet-row" data-thread="${t.id}"><span class="quiet-row-top"><span class="thread-title">${esc(t.title)}</span><span class="time">${t.time}</span></span>${t.state==='offline'?'<span class="thread-preview">Can’t reach Studio Mac</span>':''}${meta(t)}</button>`;}
function live(t){return `<button class="live-card" data-thread="${t.id}"><span class="live-card-top">${status(t)}<span class="time">${t.time}</span></span><span class="thread-title">${esc(t.title)}</span><span class="thread-preview">${esc(t.preview)}</span>${meta(t)}</button>`;}
function question(t){return `<button class="focus-question" data-thread="${t.id}">${status(t)}<span class="thread-title" style="display:block">${esc(t.title)}</span><span class="thread-preview">${esc(t.preview)}</span><span class="question-cta">Review question ${icon('right')}</span></button>`;}
function section(name,items,render){return items.length?`<div class="section-heading"><span>${name}</span><span>${items.length}</span></div>${items.map(render).join('')}`:'';}
function focus(items){return section('Needs your answer',items.filter(t=>t.state==='needs'),question)+section('Working now',items.filter(t=>t.state==='working'),live)+section('Recent',items.filter(t=>!['needs','working'].includes(t.state)),quiet);}
function projectRows(items){return [...new Set(items.map(t=>t.project))].map(project=>{
  const ts=items.filter(t=>t.project===project),working=ts.filter(t=>t.state==='working').length,needs=ts.filter(t=>t.state==='needs').length;
  return `<section class="project-group"><h3 class="project-header"><span class="project-icon">${icon('folder')}</span><span class="project-name">${esc(project)}</span><span class="project-counts">${needs?`<span class="needs" aria-label="${needs} needs you">${needs} ?</span>`:''}${working?`<span class="working" aria-label="${working} working">${working} ${workBars}</span>`:`<span>${ts.length}</span>`}</span></h3><div class="project-rows">${ts.map(t=>`<button class="row-hit project-row ${t.state}" data-thread="${t.id}"><span class="thread-title">${esc(t.title)}</span><span class="thread-preview">${esc(t.preview)}</span>${status(t)}<span class="metadata">${esc(t.provider)} · ${t.time}${state.computer==='all'?` · ${esc(t.computer)}`:''}</span></button>`).join('')}</div></section>`;
}).join('');}
function conversationRow(t){return `<button class="row-hit conversation-row ${t.state}" data-thread="${t.id}"><span class="agent-glyph" aria-hidden="true">${glyph(t)}</span><span><span class="conversation-row-top"><span class="conversation-project">${esc(t.project)}</span>${t.state==='done'?`<span class="state">${t.time}</span>`:status(t)}</span><span class="thread-title">${esc(t.title)}</span><span class="thread-preview">${esc(t.preview)}</span>${meta(t,false)}</span></button>`;}
function listContents(){
  const ts=filtered(),open=ts.filter(t=>!t.settled),settled=ts.filter(t=>t.settled);
  const content=state.variant==='A'?focus(open):state.variant==='B'?projectRows(open):open.map(conversationRow).join('');
  const settledHeading=state.query?`<div class="section-heading"><span>Settled</span><span>${settled.length}</span></div>`:`<button class="settled-button" data-action="settled" aria-expanded="${state.settled}">${icon('right')}<span>Settled</span><span>${settled.length}</span></button>`;
  return `${content||(!settled.length?'<p class="empty">No threads here.<br>Try another filter or search.</p>':'')}${settled.length?`${settledHeading}${state.settled||state.query?`<div class="settled-list">${settled.map(state.variant==='C'?conversationRow:quiet).join('')}</div>`:''}`:''}`;
}
function tabbar(){const n=threads.filter(t=>t.state==='needs').length;return `<nav class="tabbar" aria-label="App navigation">${[['threads','threads','Threads'],['computers','computer','Computers'],['settings','settings','Settings']].map(([tab,glyph,name])=>`<button data-tab="${tab}" ${state.tab===tab?'aria-current="page"':''}>${icon(glyph)}${tab==='threads'&&n?`<span class="nav-badge" aria-label="${n} needs your answer">${n}</span>`:''}<span>${name}</span></button>`).join('')}</nav>`;}
function settingsPage(){return `<header class="screen-header"><h2 class="screen-title">Settings</h2></header><div class="scroll-area settings-content">
  <section class="settings-group" aria-labelledby="appearance-heading"><h3 id="appearance-heading">Appearance</h3><div class="setting-choices" role="group" aria-label="Appearance">${['dark','light'].map(theme=>`<button data-appearance="${theme}" aria-pressed="${state.theme===theme}"><span class="theme-swatch ${theme}" aria-hidden="true"><i></i><i></i></span><span>${theme==='dark'?'Dark':'Light'}</span><span class="choice-check" aria-hidden="true">${state.theme===theme?icon('check'):''}</span></button>`).join('')}</div></section>
  <section class="settings-group" aria-labelledby="reading-heading"><h3 id="reading-heading">Reading</h3><div class="setting-row"><span>Larger text<small>More room for every word.</small></span><button class="toggle" role="switch" aria-checked="${state.large}" aria-label="Larger text" data-action="large-text"><span></span></button></div></section>
  <p class="settings-note">These choices apply to this preview.</p>
  </div>${tabbar()}`;}
function computerPage(){return `<header class="screen-header"><h2 class="screen-title">Computers</h2><p class="project-intro">Your threads stay on your computers.</p></header><div class="scroll-area"><div class="section-heading">PAIRED COMPUTERS</div>${['Laptop','Studio Mac'].map(name=>`<button class="sheet-option" data-computer-info="${name}"><span>${esc(name)}<small>${name==='Laptop'?'Online · 7 threads':'Can’t reach it · last seen yesterday'}</small></span>${icon('right')}</button>`).join('')}</div>${tabbar()}`;}
const userMessages={iphone:'Can we make the thread list easier to scan? I want to see what’s working without opening every thread.',wiring:'Check the terminal labels against the wiring schedule and flag anything that doesn’t match.',release:'The iPhone fixes look good. Let’s get the next build ready.',shortcuts:'Add keyboard shortcuts for switching threads and opening Tools.',drives:'Compare the drive options for the new panel. Keep the sizing assumptions clear.'};
function assistantText(t){
  if(t.id==='iphone')return '<p>I’ve separated current work from finished conversations and made the latest activity easier to read.</p><p><strong>The main changes</strong></p><ul><li>Working threads have a clear status and a short activity preview.</li><li>Questions stay visible until you answer.</li><li>Settled threads stay together at the bottom.</li></ul><p>I’m checking the layout at smaller screen sizes now.</p>';
  if(t.id==='wiring')return '<p>The schedule is organized by terminal strip. I found two labels that need a closer look.</p><p>A background agent is checking those against the drawing while I finish the summary.</p>';
  if(t.id==='release')return '<p>The checks passed and the iPhone build is ready.</p><p>Before I prepare the release, which target did you have in mind?</p>';
  if(t.id==='shortcuts')return '<p>The shortcuts are in place.</p><ul><li><strong>Ctrl + 1–9</strong> switches between your open threads.</li><li><strong>Ctrl + Shift + T</strong> opens Tools.</li></ul><p>They also appear beside the controls so you can learn them as you go.</p>';
  return `<p>${esc(t.preview)}</p><p>The details are grouped by project, with the assumptions called out alongside each result.</p>`;
}
function activity(t){
  const events=[['check','Opened the thread',t.project+' · '+t.computer,'4m ago'],['file',t.state==='offline'?'Last shared update':'Latest update',t.preview,'2m ago'],['terminal',t.state==='working'?'Work continues':t.state==='needs'?'Waiting for your answer':t.state==='offline'?'Computer unavailable':'Turn finished',t.kind==='background'?'Background agent is running':t.state==='offline'?'Current activity is unknown':t.state==='needs'?'No release has been started':t.provider+' on '+t.computer,'Now']];
  return `<div class="activity-list scroll-area">${events.map(([ico,title,desc,time])=>`<div class="activity-item">${icon(ico)}<div><strong>${esc(title)}</strong><p>${esc(desc)}</p></div><span class="activity-time">${time}</span></div>`).join('')}</div>`;
}
function messages(t){return `<div class="scroll-area messages"><div class="day-divider">Today · 9:32 AM</div>${t.state==='offline'?'<p class="empty">This computer is offline.<br>These are the last messages it shared.</p>':''}<div class="user-message">${esc(userMessages[t.id]||'Let’s finish this piece of work and keep the result easy to follow.')}</div><div class="agent-byline"><span class="agent-glyph" aria-hidden="true">${glyph(t)}</span>${esc(t.provider)}<time>9:34 AM</time></div><article class="assistant-message">${assistantText(t)}</article>${t.question?`<section class="message-question" aria-label="Question waiting for you"><h3>Where should this release go?</h3><button data-answer="TestFlight only">TestFlight only</button><button data-answer="Both releases">TestFlight and desktop</button></section>`:''}${t.state==='working'?`<div class="inline-work">${status(t)}<p>${esc(t.preview)}</p></div>`:''}${(state.replies[t.id]||[]).map(reply=>`<div class="user-message" style="margin-top:25px;margin-bottom:0">${esc(reply)}</div>`).join('')}</div>`;}
function composer(t){const active=t.state==='working',blocked=active||t.state==='offline'||t.question;return `<footer class="composer">${active?`<div class="activity-strip">${status(t)}${t.kind==='turn'?'<button class="stop-button" data-action="stop"><span class="stop-square" aria-hidden="true"></span>Stop</button>':`<span>${t.time}</span>`}</div>`:''}<div class="reply-field"><textarea id="reply" rows="1" aria-label="Reply to thread" placeholder="${t.state==='offline'?'Computer offline':t.question?'Answer the question above':active?'Reply when this turn finishes':'Reply to '+t.provider+'…'}" ${blocked?'disabled':''}>${esc(state.drafts[t.id]||'')}</textarea><button class="send-button" data-action="send" aria-label="Add reply to prototype" ${blocked||!state.drafts[t.id]?.trim()?'disabled':''}>${icon('up')}</button></div></footer>`;}
function threadPage(){const t=find(state.thread);return `<nav class="thread-nav"><button class="back-button" data-action="back">${icon('left')}Threads</button><span class="nav-context">${esc(t.computer)}</span><button class="icon-button" data-action="info" aria-label="Thread details">${icon('more')}</button></nav><header class="thread-heading"><h2>${esc(t.title)}</h2>${meta(t)}</header><div class="thread-tabs"><button data-pane="messages" aria-pressed="${state.pane==='messages'}">Messages</button><button data-pane="activity" aria-pressed="${state.pane==='activity'}">Activity</button></div>${state.pane==='messages'?messages(t):activity(t)}${composer(t)}`;}
function renderApp(){app.className=`variant-${state.variant}`;app.innerHTML=state.thread?threadPage():state.tab==='settings'?settingsPage():state.tab==='computers'?computerPage():`${header()}<div class="scroll-area" id="thread-list">${listContents()}</div>${tabbar()}`;}
function render(){
  document.documentElement.dataset.theme=state.theme;
  document.body.classList.toggle('embed',state.embed);document.body.classList.toggle('compare-mode',state.compare);document.body.classList.toggle('large-text',state.large);
  const d=directions[state.variant];document.querySelector('#direction').textContent=d.name;document.querySelector('#description').textContent=d.description;
  document.querySelector('#principles').innerHTML=d.principles.map((p,i)=>`<div class="principle"><span>0${i+1}</span>${p}</div>`).join('');
  document.querySelector('#variant-label').innerHTML=`<b>${state.variant} · ${d.name}</b><span>${'ABC'.indexOf(state.variant)+1} / 3</span>`;
  document.querySelector('#theme').textContent=state.theme==='dark'?'Light':'Dark';document.querySelector('#theme').setAttribute('aria-label',`Switch to ${state.theme==='dark'?'light':'dark'} appearance`);
  document.querySelector('#large').setAttribute('aria-pressed',String(state.large));document.querySelector('#compare').textContent=state.compare?'Single view':'Compare';
  const comparison=document.querySelector('#comparison');comparison.hidden=!state.compare;
  if(state.compare)comparison.innerHTML=Object.entries(directions).map(([key,value])=>`<section><h2><span>${key}</span>${value.name}</h2><iframe title="${value.name} direction" src="?variant=${key}&theme=${state.theme}&embed=1"></iframe></section>`).join('');else comparison.innerHTML='';
  renderApp();
}
function updateURL(){const p=new URLSearchParams(location.search);p.set('variant',state.variant);p.set('theme',state.theme);state.compare?p.set('compare','1'):p.delete('compare');history.replaceState({},'',`${location.pathname}?${p}`);}
function cycle(delta){const keys=Object.keys(directions);state.variant=keys[(keys.indexOf(state.variant)+delta+3)%3];updateURL();render();}
function toast(text){clearTimeout(toastTimer);const e=document.querySelector('#toast');e.textContent=text;e.classList.add('visible');toastTimer=setTimeout(()=>e.classList.remove('visible'),3200);}
function openSheet(html){document.querySelector('#sheet-body').innerHTML=html;sheet.showModal();}
function openThread(id){state.thread=id;state.pane='messages';renderApp();app.querySelector('.back-button')?.focus({preventScroll:true});}
function back(){const previous=state.thread;state.thread=null;renderApp();app.querySelector(`[data-thread="${previous}"]`)?.focus({preventScroll:true});}
function scope(){openSheet(`<h2>Show threads from</h2>${['all','Laptop','Studio Mac'].map(computer=>`<button class="sheet-option ${state.computer===computer?'selected':''}" data-choose-computer="${computer}"><span>${computer==='all'?'All computers':computer}<small>${computer==='all'?'Together in one list':computer==='Laptop'?'Online':'Offline · last shared threads'}</small></span>${state.computer===computer?icon('check'):''}</button>`).join('')}`);}
document.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.id==='previous')return cycle(-1);if(b.id==='next'||b.id==='variant-label')return cycle(1);
  if(b.id==='theme'){state.theme=state.theme==='dark'?'light':'dark';updateURL();return render();}
  if(b.id==='large'){state.large=!state.large;return render();}
  if(b.id==='compare'){state.compare=!state.compare;updateURL();return render();}
  if(b.id==='close-sheet')return sheet.close();
  if(b.dataset.appearance){state.theme=b.dataset.appearance;updateURL();render();app.querySelector(`[data-appearance="${state.theme}"]`)?.focus();return;}
  if(b.dataset.thread)return openThread(b.dataset.thread);
  if(b.dataset.tab){state.tab=b.dataset.tab;state.thread=null;renderApp();app.querySelector(`[data-tab="${state.tab}"]`)?.focus({preventScroll:true});return;}
  if(b.dataset.filter){state.filter=b.dataset.filter;return renderApp();}
  if(b.dataset.pane){state.pane=b.dataset.pane;return renderApp();}
  if(b.dataset.chooseComputer){state.computer=b.dataset.chooseComputer;sheet.close();renderApp();app.querySelector('[data-action=scope]')?.focus();return;}
  if(b.dataset.computerInfo){const name=b.dataset.computerInfo;return openSheet(`<h2>${esc(name)}</h2><p>${name==='Laptop'?'Online. Threads and current activity are shared with this iPhone.':'This computer is offline. Its saved threads stay visible; current activity is unknown.'}</p><p style="margin-top:18px">Sample computer for this design study.</p>`);}
  if(b.dataset.answer){const t=find(state.thread);t.question=false;t.state='working';t.kind='turn';t.preview='Preparing the '+b.dataset.answer.toLowerCase()+' release.';renderApp();toast('Answer selected in this preview only.');return;}
  if(b.dataset.demo){state.compare=false;updateURL();state.tab='threads';state.filter='all';state.computer='all';state.query='';if(b.dataset.demo==='settings'){state.tab='settings';state.thread=null;render();}else if(b.dataset.demo==='settled'){state.thread=null;state.settled=true;render();document.querySelector('.settled-button')?.scrollIntoView({block:'start'});}else{render();openThread(b.dataset.demo==='running'?'iphone':'release');}return;}
  switch(b.dataset.action){
    case 'scope':return scope();
    case 'clear-search':state.query='';renderApp();app.querySelector('#search-field')?.focus();break;
    case 'large-text':state.large=!state.large;render();app.querySelector('[data-action=large-text]')?.focus();break;
    case 'settled':state.settled=!state.settled;document.querySelector('#thread-list').innerHTML=listContents();document.querySelector('.settled-button')?.focus({preventScroll:true});break;
    case 'back':back();break;
    case 'info':{const t=find(state.thread);openSheet(`<h2>Thread details</h2><dl class="sheet-facts"><dt>Project</dt><dd>${esc(t.project)}</dd><dt>Computer</dt><dd>${esc(t.computer)}</dd><dt>Agent</dt><dd>${esc(t.provider)}</dd><dt>Status</dt><dd>${status(t)}</dd></dl>`);break;}
    case 'stop':openSheet('<h2>Stop this run?</h2><p>This simulates stopping the turn. No command will be sent to a computer.</p><button class="primary" data-action="confirm-stop">Stop in preview</button><button class="secondary" id="close-sheet">Keep working</button>');break;
    case 'confirm-stop':{const t=find(state.thread);t.state='done';sheet.close();renderApp();toast('Turn stopped in this preview only.');break;}
    case 'send':{const text=state.drafts[state.thread]?.trim();if(!text)return;(state.replies[state.thread]||=[]).push(text);state.drafts[state.thread]='';renderApp();app.querySelector('.messages')?.scrollTo({top:100000});toast('Reply added to the preview. Nothing sent.');break;}
  }
});
document.addEventListener('input',event=>{if(event.target.id==='search-field'){state.query=event.target.value;document.querySelector('#thread-list').innerHTML=listContents();document.querySelector('[data-action=clear-search]').hidden=!state.query;const summary=document.querySelector('#focus-summary');if(summary){const ts=allVisible().filter(t=>!t.settled),n=ts.filter(t=>t.state==='needs').length;summary.innerHTML=`<span><b>${ts.filter(t=>t.state==='working').length}</b> working</span><span>${n} ${n===1?'needs':'need'} you</span>`;}}if(event.target.id==='reply'){state.drafts[state.thread]=event.target.value;document.querySelector('[data-action=send]').disabled=!event.target.value.trim();}});
document.addEventListener('keydown',event=>{if(sheet.open)return;if(event.key==='Escape'){if(state.thread){back();event.preventDefault();}else if(state.query&&state.tab==='threads'){state.query='';renderApp();app.querySelector('#search-field')?.focus();event.preventDefault();}return;}if(event.target.closest('input,textarea,select,[contenteditable=true]'))return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){cycle(event.key==='ArrowLeft'?-1:1);event.preventDefault();}});
render();
