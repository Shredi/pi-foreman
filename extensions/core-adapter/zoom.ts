// Click-to-enlarge for the owner pages the page server sends (docs/pages.md). `injectZoom` adds one small style and script before the last `</body`
// of a served HTML page, at serve time only (pageserver.ts `handle`): the stored plan, note and brief bytes stay as they are, so plan hashes and
// approvals do not change. The snippet is ASCII, makes no request, uses no storage and no eval, and runs under the page's sandbox (allow-scripts).
// Enlarged images and inline SVG are redrawn at the new size (never scaled as a bitmap), so a mermaid diagram stays sharp.
// The same style fits every figure to its box (a model's own HTML plan has no harness stylesheet, so its figures need these rules too), and the
// script puts a small Enlarge button in the corner of each figure; it opens the same overlay as a click.

export const ZOOM_MARKER = "<!-- pi-foreman:zoom -->";

export const ZOOM_SNIPPET = [
  ZOOM_MARKER,
  "<style>",
  ".pfz-ov{position:fixed;z-index:2147483000;background:rgba(0,0,0,.9);touch-action:none;user-select:none;overflow:hidden}",
  ".pfz-ov>img,.pfz-ov>svg{position:absolute;z-index:0;transform:translate(-50%,-50%);max-width:none!important;max-height:none!important;opacity:1!important;filter:none!important;cursor:grab}",
  ".pfz-bar{position:absolute;top:12px;right:12px;display:flex;gap:8px;z-index:1}",
  ".pfz-ov button{min-width:44px;min-height:44px;padding:0 12px;border:0;border-radius:22px;font:600 20px/1 system-ui,sans-serif;background:#fff;color:#111;cursor:pointer}",
  ":is(img,svg):not(a *):not(.pfz-ov *):not(.pfz-enl *):hover{cursor:zoom-in;outline:2px dashed currentColor;outline-offset:3px}",
  "picture{display:block}:is(img,svg):not(svg *):not(.pfz-ov *){max-width:min(100%,var(--pfz-w,100%))!important}:is(img,svg[viewBox]):not(svg *):not(.pfz-ov *){height:auto!important}",
  ".pfz-w{position:relative;display:inline-block;max-width:100%;vertical-align:top}.pfz-w.pfz-b{display:block;width:fit-content}.pfz-w.pfz-p{display:block;width:min(100%,var(--pfz-w,100%))}.pfz-w.pfz-c{margin-left:auto;margin-right:auto}.pfz-w.pfz-r{margin-left:auto}",
  ".pfz-enl{position:absolute;top:6px;right:6px;z-index:1;display:flex;align-items:center;justify-content:center;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;opacity:.35;cursor:zoom-in;transition:opacity .15s}",
  ".pfz-enl:hover,.pfz-enl:focus-visible,.pfz-w:hover>.pfz-enl{opacity:1}.pfz-enl:focus-visible{outline:2px solid #fff;outline-offset:2px}@media (hover:none){.pfz-enl{opacity:.9}}",
  "</style>",
  "<script>",
  "(function(){",
  "var vv=window.visualViewport,ov,el,b,x0,s=1,x=0,y=0,p={},lastD=0,moved=false,po='',L=0,T=0,W=0,H=0,back=null;",
  "function geo(){L=vv?vv.offsetLeft:0;T=vv?vv.offsetTop:0;W=vv?vv.width:innerWidth;H=vv?vv.height:innerHeight;ov.style.left=L+'px';ov.style.top=T+'px';ov.style.width=W+'px';ov.style.height=H+'px';}",
  "function apply(){el.style.width=b.w*s+'px';el.style.height=b.h*s+'px';el.style.left='calc(50% + '+x+'px)';el.style.top='calc(50% + '+y+'px)';}",
  "function reset(){s=1;x=x0;y=0;apply();}",
  "function sync(){geo();apply();}",
  "function vl(m){if(vv)['resize','scroll'].forEach(function(t){vv[m](t,sync);});}",
  "function zoomAt(px,py,f){var n=Math.min(12,Math.max(1,s*f)),ux=(px-L-W/2-x)/s,uy=(py-T-H/2-y)/s;s=n;x=px-L-W/2-ux*s;y=py-T-H/2-uy*s;if(s<=1){x=x0;y=0;}apply();}",
  "function close(){if(!ov)return;ov.remove();ov=null;p={};lastD=0;document.removeEventListener('keydown',onKey);vl('removeEventListener');document.documentElement.style.overflow=po;var f=back;back=null;if(f&&f.isConnected)f.focus();}",
  "function onKey(e){if(e.key==='Escape')close();}",
  "function open(src,btn){back=btn||null;var r=src.getBoundingClientRect();if(!r.width||!r.height)return;var im=src.tagName.toLowerCase()==='img';",
  "el=im?document.createElement('img'):src.cloneNode(true);if(im)el.src=src.currentSrc||src.src;",
  "ov=document.createElement('div');ov.className='pfz-ov';ov.setAttribute('role','dialog');ov.setAttribute('aria-modal','true');",
  "ov.innerHTML='<div class=\"pfz-bar\"><button type=\"button\" data-a=\"reset\" aria-label=\"Reset view\">&#8634;</button><button type=\"button\" data-a=\"close\" aria-label=\"Close\">&times;</button></div>';",
  "ov.appendChild(el);document.body.appendChild(ov);geo();var a=r.width/r.height,fw=Math.min(W*.95,H*.95*a),n=im?src.naturalWidth:src.viewBox.baseVal.width||r.width;x0=0;",
  "if(fw<.5*n){fw=.75*n;x0=W*.025+fw/2-W/2;}",
  "b={w:fw,h:fw/a};po=document.documentElement.style.overflow;document.documentElement.style.overflow='hidden';document.addEventListener('keydown',onKey);vl('addEventListener');",
  "reset();ov.querySelector('[data-a=close]').focus();",
  "ov.addEventListener('wheel',function(e){e.preventDefault();zoomAt(e.clientX,e.clientY,Math.exp(-e.deltaY*(e.deltaMode?16:1)*(e.ctrlKey?0.01:0.0015)));},{passive:false});",
  "ov.addEventListener('pointerdown',function(e){if(!e.target.hasAttribute('data-a')){p[e.pointerId]={x:e.clientX,y:e.clientY};moved=false;}});",
  "ov.addEventListener('pointermove',function(e){var q=p[e.pointerId];if(!q)return;p[e.pointerId]={x:e.clientX,y:e.clientY};var ids=Object.keys(p);",
  "if(ids.length===1){var dx=e.clientX-q.x,dy=e.clientY-q.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;x+=dx;y+=dy;apply();return;}",
  "var a=p[ids[0]],c=p[ids[1]],d=Math.hypot(a.x-c.x,a.y-c.y);moved=true;if(lastD)zoomAt((a.x+c.x)/2,(a.y+c.y)/2,d/lastD);lastD=d;});",
  "function up(e){delete p[e.pointerId];if(!Object.keys(p).length)lastD=0;}",
  "ov.addEventListener('pointerup',up);ov.addEventListener('pointercancel',up);ov.addEventListener('dragstart',function(e){e.preventDefault();});",
  "ov.addEventListener('click',function(e){var t=e.target,a=t.getAttribute('data-a');if(a==='close')close();else if(a==='reset')reset();else if(t===ov&&!moved)close();});}",
  "document.addEventListener('click',function(e){var t=e.target;if(ov||!t.closest||t.closest('a,button'))return;var g=t.closest('img,svg');if(!g)return;",
  "while(g.tagName.toLowerCase()==='svg'&&g.parentElement&&g.parentElement.closest('svg'))g=g.parentElement.closest('svg');open(g);});",
  "function fit(){document.querySelectorAll('svg[viewBox]').forEach(function(s){var v=s.viewBox.baseVal,w=s.getAttribute('width');if(v.width&&(!w||/%$/.test(w)))s.style.setProperty('--pfz-w',v.width+'px');});",
  "document.querySelectorAll('img').forEach(function(i){var t=i.src.indexOf('data:image/svg+xml;base64,')===0?atob(i.src.split(',')[1]):'',k=t.indexOf('viewBox=');if(k<0)return;var p=t.slice(k+8,k+80).split(/[\\s\"'>]+/).filter(Boolean);if(p[2])i.style.setProperty('--pfz-w',p[2]+'px');});}",
  "function px(v){var n=parseFloat(v);return n>0&&!/%$/.test(v)?n:0;}",
  "function nat(g){var s=g.tagName.toLowerCase()==='svg',v=s?g.viewBox.baseVal:null,t,k,q;if(v&&v.width&&v.height)return [v.width,v.height];",
  "if(!s&&g.src.indexOf('data:image/svg+xml;base64,')===0){t=atob(g.src.split(',')[1]);k=t.indexOf('viewBox=');q=k<0?[]:t.slice(k+8,k+80).split(/[\\s\"'>]+/).filter(Boolean);if(q[2]&&q[3])return [+q[2],+q[3]];}",
  "if(!s&&g.naturalWidth&&g.naturalHeight)return [g.naturalWidth,g.naturalHeight];",
  "var w=px(g.getAttribute('width')||g.style.width),h=px(g.getAttribute('height')||g.style.height);return w&&h?[w,h]:null;}",
  "function enl(){document.querySelectorAll('img,svg').forEach(function(g){var t=g.parentElement&&g.parentElement.tagName==='PICTURE'?g.parentElement:g,p=t.parentElement;",
  "if(!p||g.closest('a,button,.pfz-ov')||(g.tagName.toLowerCase()==='svg'&&p.closest('svg')))return;var n=nat(g);if(n&&(n[0]<48||n[1]<48))return;",
  "var w=document.createElement('span'),b=document.createElement('button'),cs=getComputedStyle(t),wa=g.getAttribute('width')||g.style.width||'',pc=/%$/.test(wa)||(g.tagName.toLowerCase()==='svg'&&!wa),bl=cs.display!=='inline',mg=bl&&cs.marginLeft===cs.marginRight&&cs.marginLeft!=='0px';",
  "w.className='pfz-w'+(pc?' pfz-p':bl?' pfz-b':'')+(mg?' pfz-c':'');if(pc)w.style.setProperty('--pfz-w',g.style.getPropertyValue('--pfz-w'));p.insertBefore(w,t);w.appendChild(t);var pa=getComputedStyle(p).textAlign;if((pc||bl)&&/center$/.test(pa))w.classList.add('pfz-c');else if((pc||bl)&&/^(right|end)$/.test(pa))w.classList.add('pfz-r');b.type='button';b.className='pfz-enl';b.title='Enlarge';b.setAttribute('aria-label','Enlarge');",
  "b.innerHTML='<svg viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" aria-hidden=\"true\"><path d=\"M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg>';",
  "b.addEventListener('click',function(){open(g,b);});w.appendChild(b);});}",
  "fit();enl();",
  "})();",
  "</script>",
  "",
].join("\n");

/** `html` with the zoom snippet once: before the last `</body` (any case), or appended when there is none; unchanged when the marker is there already. */
export function injectZoom(html: string): string {
  if (html.includes(ZOOM_MARKER)) return html;
  const bodyClose = /<\/body/gi;
  let at = -1;
  for (let m = bodyClose.exec(html); m; m = bodyClose.exec(html)) at = m.index;
  if (at < 0) return html + ZOOM_SNIPPET;
  return html.slice(0, at) + ZOOM_SNIPPET + html.slice(at);
}
