import "./style.css";

const icons = {
  home: `<svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10h-6v-6H9v6H3z"/></svg>`,
  project: `<svg viewBox="0 0 24 24"><path d="M4 7h16v13H4zM8 4h8v3H8z"/></svg>`,
  cube: `<svg viewBox="0 0 24 24"><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M4 4h16v12H8l-4 4z"/></svg>`,
  sim: `<svg viewBox="0 0 24 24"><path d="M5 20V9m7 11V4m7 16v-7"/></svg>`,
  image: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/></svg>`,
  compare: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/></svg>`
};
const icon = (name) => `<span class="icon">${icons[name]}</span>`;

let state = { view: "cad", chatOpen: false, running: false, failed: false };

function sidebar(){ return `<aside class="sidebar">
  <div class="traffic"><i></i><i></i><i></i></div>
  <div class="brand"><b>R</b><strong>Reify · 器成</strong></div>
  <nav><button class="active">${icon("home")}Home</button><button>${icon("project")}Projects</button></nav>
  <small>Recent</small>
  <div class="recent active">${icon("cube")}<span><b>Aerospace Bracket</b><em>Just now</em></span></div>
  <div class="recent">${icon("cube")}<span><b>Pump Housing</b><em>2 days ago</em></span></div>
  <div class="recent">${icon("sim")}<span><b>Turbine Impeller</b><em>1 week ago</em></span></div>
  <div class="recent">${icon("cube")}<span><b>Camera Mount</b><em>1 week ago</em></span></div>
  <button class="view-all">View all →</button>
  <div class="profile"><i>JD</i><b>Jonas</b><span>›</span></div>
</aside>` }

function topbar(){ return `<header class="topbar">
  <div class="project-title">${icon("cube")}<span><strong>Aerospace Bracket</strong><small>${state.running ? "Generating… · Auto-saving" : "Last saved 2 minutes ago"}</small></span><em>v3</em></div>
  <div class="top-actions"><button aria-label="Undo">↶</button><button aria-label="Redo">↷</button><button aria-label="Share icon">⌘</button><button class="share">Share</button><button>♧</button><i>JD</i></div>
</header>` }

function modeTabs(){ return `<div class="mode-tabs">
  <button data-view="conversation" class="${state.view === "conversation" ? "active" : ""}">${icon("chat")}Conversation</button>
  <button data-view="cad" class="${state.view === "cad" ? "active" : ""}">${icon("cube")}Canvas</button><kbd>⌘ K</kbd>
</div>` }

function composer(expanded=false){ return `<section class="composer ${expanded ? "expanded" : ""}">
  <button class="mode-island" data-action="toggle-chat" aria-label="${expanded ? "Close conversation" : "Open conversation"}"><i></i><span>${expanded ? "Canvas" : "Conversation"}</span><kbd>⌘ K</kbd></button>
  <textarea aria-label="Tell Reify" placeholder="Tell Reify what you want to change, add, or explore..."></textarea>
  <footer><button class="attach">⌕</button><button>${icon("cube")}CAD</button><button>${icon("image")}Image</button><button>▣ Reference</button><button>▧ STEP</button><span></span>${state.running ? `<button data-action="queue">Queue after current step⌄</button><button class="send stop" data-action="stop">■</button>` : `<button>Reify 1⌄</button><button class="send" data-action="run">↑</button>`}</footer>
</section>` }

function conversation(){ return `<main class="conversation-view">
  ${modeTabs()}
  <section class="messages">
    <article class="message user"><i>JD</i><div><header><b>You</b><time>10:14 AM</time></header><p>I want to design an aerospace bracket.<br/>It needs to be lightweight but strong, made from 7075-T6 aluminum.<br/>The bracket will mount to a cylindrical component with an 8 mm through hole,<br/>and bolt to a base with four mounting holes. Please propose a concept design.</p></div></article>
    <article class="message"><i class="reify">R</i><div><header><b>Reify</b><time>10:15 AM</time></header><div class="reply"><p>Great! I understand you’re designing an aerospace bracket.<br/>Here’s a summary of your requirements:</p><ul><li><b>Material:</b> Aluminum 7075-T6</li><li><b>Function:</b> Mount to a cylindrical component and bolt to a base</li><li><b>Goals:</b> Lightweight, high strength, suitable for aerospace application</li></ul><p>I can explore concepts, create CAD models, run FEA, and prepare manufacturing-ready files.</p></div></div></article>
    <article class="message user"><i>JD</i><div><header><b>You</b><time>10:17 AM</time></header><p>Let’s start with a few concept options. Keep it simple and compare the pros and cons.</p></div></article>
  </section>${composer()}
</main>` }

function cadImage(sim=false){ return `<div class="model-image ${sim ? "simulation" : ""}"><div class="model-crop"></div></div>` }
function tools(){ return `<div class="tools"><button>↖</button><button>${icon("cube")}</button><button>⊙</button><button>⌁</button><button>▱</button></div>` }
function viewportControls(){ return `<div class="view-controls"><button>◌</button><button>♟</button><button>⌕</button><button>${icon("cube")}</button><button>⌗</button></div>` }

function parameterPanel(){ return `<aside class="right-panel"><header>${icon("cube")}<span><strong>Selected Feature</strong><small>Hole · Through</small></span><button data-action="close-panel">×</button></header>
  <div class="form"><label>Diameter <span><input value="8.0"/><em>mm⌄</em></span></label><label>Hole type <span><input value="Through"/><em>⌄</em></span></label><label>Counterbore <input type="checkbox"/></label><label>Position <span><input value="X   24.0"/><em>mm</em></span></label></div>
  <h3>Part Parameters</h3><div class="form"><label>Overall thickness <span><input value="12.0"/><em>mm⌄</em></span></label><label>Fillet radius <span><input value="3.0"/><em>mm⌄</em></span></label><label>Material <span><input value="Aluminum 7075-T6"/><em>⌄</em></span></label><label>Process <span><input value="CNC Machining"/><em>⌄</em></span></label></div>
  <div class="deeper"><b>✣ &nbsp; Ask Reify for deeper changes</b><p>Add chamfer to this hole, adjust rib thickness, or apply a pattern…</p></div><footer><button>Reset</button><button class="primary">Apply Changes</button></footer></aside>` }

function failurePanel(){ return `<aside class="right-panel failure"><header><i class="fail-icon">×</i><span><strong>Build failed</strong><small>Today 9:41 AM</small></span><button data-action="close-panel">×</button></header><p>Your changes could not be applied. The last stable model is preserved and shown in the canvas.</p><div class="error-card"><b>⊗ &nbsp; Geometry conflict</b><p>The fillet radius (6.0 mm) on the inner rib creates a geometric conflict with the adjacent hole.</p><div class="detail-shot"></div></div><h3>Comparison</h3><table><tr><td>Fillet radius</td><td>3.0 mm</td><td>→</td><td class="red">6.0 mm</td></tr><tr><td>Result</td><td>Valid</td><td>→</td><td class="red">Conflict</td></tr></table><h3>What would you like to do?</h3><button class="action primary">⌁ &nbsp; Modify parameter <span>›</span></button><button class="action">✣ &nbsp; Ask Reify to repair <span>›</span></button><button class="action">▧ &nbsp; Open failed changes <span>›</span></button><footer><button>↶ Restore stable version</button><button>•••</button></footer></aside>` }

function runningPanel(){ return `<aside class="right-panel running"><header>${icon("cube")}<span><strong>Generating Design Variants</strong><small>Exploring design alternatives</small></span><button>•••</button></header><div class="progress"><i></i></div><b class="percent">68%</b><small>About 1 min remaining</small><ol><li class="done">✓ <span>Understand request</span><time>12s</time></li><li class="done">✓ <span>Retrieve references</span><time>28s</time></li><li class="live">3 <span>Generate variants<small>Running CAD generation…</small></span><time>1m 12s</time></li><li>4 <span>Post-process & evaluate</span></li><li>5 <span>Prepare results</span></li></ol><div class="tool-activity"><b>⌁ Tool Activity</b><em>● Live</em><p>CAD &nbsp; Generating geometry variants…</p><p>Sim &nbsp; Running lightweight analysis…</p><p>Ref &nbsp; Retrieved 12 reference models</p></div><button class="stop-wide" data-action="stop">■ &nbsp; Stop Generation</button></aside>` }

function simulationPanel(){ return `<aside class="right-panel"><header>${icon("sim")}<span><strong>Simulation Results</strong></span><button data-action="close-panel">×</button></header><div class="panel-tabs"><b>Results</b><span>Settings</span><span>Details</span></div><div class="form"><label>Result type <span><input value="Von Mises Stress"/><em>⌄</em></span></label><label>Load case <span><input value="LC1 – Bracket Load"/><em>•••</em></span></label><label>Display range <span><input value="Auto"/><em>Custom</em></span></label><label>Min (MPa)<span><input value="0"/></span></label><label>Max (MPa)<span><input value="240"/></span></label><label>Deformation scale<span><input value="1.0x"/><em>⌄</em></span></label></div><div class="toggles"><label>Show mesh <input type="checkbox" checked/></label><label>Show constraints <input type="checkbox"/></label><label>Show loads <input type="checkbox" checked/></label></div><div class="analysis"><b>⊙ Analysis Info</b><p>Solver <span>Static Structural</span></p><p>Elements <span>128,430</span></p><p>Run time <span>2 min 14 s</span></p><p>Status <span class="green">● Completed</span></p></div><footer><button class="primary">Re-run Analysis</button><button>Save as New Version</button></footer></aside>` }

function artifactRail(){ return `<aside class="artifact-rail"><header><b>Project Contents</b><button>＋</button></header><button data-view="conversation">▧ <span>01 Concept<small>v2 · 2h ago</small></span></button><button data-view="cad">${icon("cube")}<span>02 CAD<small>v4 · 1h ago</small></span></button><button data-view="simulation" class="${state.view === "simulation" ? "active" : ""}">${icon("sim")}<span>03 Simulation<small>v3 · Just now</small></span></button><button>▧ <span>04 Render<small>v1 · 3h ago</small></span></button><button class="add">＋ Add artifact type</button></aside>` }

function chatDrawer(){ return `<section class="chat-drawer ${state.chatOpen ? "open" : ""}" aria-hidden="${!state.chatOpen}"><header><span>${icon("chat")}<b>Conversation</b><small>Aerospace Bracket</small></span></header><section class="messages"><article class="message user"><i>JD</i><div><header><b>You</b><time>10:14 AM</time></header><p>Design an aerospace bracket with mounting holes. Keep it lightweight.</p></div></article><article class="message"><i class="reify">R</i><div><header><b>Reify</b><time>10:15 AM</time></header><div class="reply"><p>I created the first model. It remains available behind this conversation.</p><ul><li>Material: Aluminum 7075-T6</li><li>Through hole: Ø 8.0 mm</li><li>Process: CNC machining</li></ul></div></div></article><article class="message user"><i>JD</i><div><header><b>You</b><time>10:17 AM</time></header><p>Increase the hole diameter and keep the mounting face unchanged.</p></div></article></section></section>` }
function canvas(){ const sim=state.view==="simulation"; return `<main class="canvas-view ${state.chatOpen ? "chat-open" : ""}">${topbar()}<div class="artifact-tabs"><button>◉ Concept</button><button data-view="cad" class="${!sim ? "active" : ""}">${icon("cube")}CAD</button><button data-view="simulation" class="${sim ? "active" : ""}">${icon("sim")}Simulation</button><button>${icon("image")}Render</button><button>${icon("compare")}Compare</button></div>${sim ? artifactRail() : ""}<section class="viewport ${sim ? "with-rail" : ""}">${cadImage(sim)}</section>${composer()}${state.failed ? failurePanel() : state.running ? runningPanel() : sim ? simulationPanel() : parameterPanel()}<button class="demo-failure" data-action="failure">${state.failed ? "Show parameters" : "Demo failure"}</button>${chatDrawer()}</main>` }

function help(){ return `<aside class="help-panel"><header><b>Get started</b><button>×</button></header><p>Turn your ideas into real, manufacturable results. Here are a few ways to begin:</p><button>${icon("chat")}<span><b>Describe a part</b><small>Tell Reify what you want to design</small></span></button><button>${icon("image")}<span><b>Upload a reference</b><small>Add sketches, images, or existing CAD files</small></span></button><button data-view="cad">${icon("cube")}<span><b>Generate CAD</b><small>Create and iterate on parametric CAD models</small></span></button><button data-view="simulation">${icon("sim")}<span><b>Run simulations</b><small>Evaluate performance with FEA</small></span></button></aside>` }

function render(){ document.querySelector("#app").innerHTML=`<div class="shell">${sidebar()}${canvas()}</div>`; bind(); }
function toggleChat(){state.chatOpen=!state.chatOpen;document.querySelector(".canvas-view")?.classList.toggle("chat-open",state.chatOpen);const drawer=document.querySelector(".chat-drawer");drawer?.classList.toggle("open",state.chatOpen);drawer?.setAttribute("aria-hidden",String(!state.chatOpen));const island=document.querySelector(".mode-island");island?.setAttribute("aria-label",state.chatOpen?"Close conversation":"Open conversation");const label=island?.querySelector("span");if(label)label.textContent=state.chatOpen?"Canvas":"Conversation";document.querySelector(".composer")?.classList.toggle("expanded",state.chatOpen)}
function placeComposer(x=.5,y=.82){const box=document.querySelector(".canvas-view>.composer");if(!box)return;const halfW=box.offsetWidth/2,halfH=box.offsetHeight/2;const px=Math.max(halfW+20,Math.min(innerWidth-halfW-20,x*innerWidth));const py=Math.max(halfH+80,Math.min(innerHeight-halfH-24,y*innerHeight));box.style.setProperty("left",`${px}px`,"important");box.style.setProperty("top",`${py}px`,"important")}
function savedComposerPosition(){try{return JSON.parse(localStorage.getItem("reify.composer-position")||"null")}catch{return null}}
function enableComposerDrag(){const handle=document.querySelector(".mode-island");const box=document.querySelector(".canvas-view>.composer");if(!handle||!box)return;const saved=savedComposerPosition();placeComposer(saved?.x,saved?.y);let origin=null,moved=false;handle.addEventListener("pointerdown",event=>{origin={x:event.clientX,y:event.clientY,left:box.getBoundingClientRect().left+box.offsetWidth/2,top:box.getBoundingClientRect().top+box.offsetHeight/2};moved=false;handle.setPointerCapture(event.pointerId);handle.classList.add("dragging")});handle.addEventListener("pointermove",event=>{if(!origin)return;const dx=event.clientX-origin.x,dy=event.clientY-origin.y;if(Math.hypot(dx,dy)>4)moved=true;if(moved){placeComposer((origin.left+dx)/innerWidth,(origin.top+dy)/innerHeight)}});handle.addEventListener("pointerup",event=>{if(!origin)return;handle.releasePointerCapture(event.pointerId);handle.classList.remove("dragging");if(moved){const rect=box.getBoundingClientRect();localStorage.setItem("reify.composer-position",JSON.stringify({x:(rect.left+rect.width/2)/innerWidth,y:(rect.top+rect.height/2)/innerHeight}))}else toggleChat();origin=null});handle.addEventListener("dblclick",()=>{localStorage.removeItem("reify.composer-position");placeComposer()})}
function bind(){ document.querySelectorAll("[data-view]").forEach(el=>el.addEventListener("click",()=>{state.view=el.dataset.view;state.chatOpen=false;state.running=false;state.failed=false;render()}));enableComposerDrag();document.querySelectorAll("[data-action='run']").forEach(el=>el.addEventListener("click",()=>{state.view="cad";state.running=true;render()}));document.querySelectorAll("[data-action='stop']").forEach(el=>el.addEventListener("click",()=>{state.running=false;render()}));document.querySelectorAll("[data-action='failure']").forEach(el=>el.addEventListener("click",()=>{state.failed=!state.failed;state.running=false;render()}));}
window.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();toggleChat()}});
window.addEventListener("resize",()=>{const saved=savedComposerPosition();placeComposer(saved?.x,saved?.y)});
render();
