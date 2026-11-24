// Click-to-enlarge for the owner pages the page server sends (docs/pages.md). `injectZoom` adds one small style and script before the last `</body`
// of a served HTML page, at serve time only (pageserver.ts `handle`): the stored plan, note and brief bytes stay as they are, so plan hashes and
// approvals do not change. The snippet is ASCII, makes no request, uses no storage and no eval, and runs under the page's sandbox (allow-scripts).
// Enlarged images and inline SVG are redrawn at the new size (never scaled as a bitmap), so a mermaid diagram stays sharp.

export const ZOOM_MARKER = "<!-- pi-foreman:zoom -->";

export const ZOOM_SNIPPET = [
  ZOOM_MARKER,
  "<style>",
  ".pfz-ov{position:fixed;z-index:2147483000;background:rgba(0,0,0,.9);touch-action:none;user-select:none;overflow:hidden}",
  ".pfz-ov>img,.pfz-ov>svg{position:absolute;z-index:0;transform:translate(-50%,-50%);max-width:none!important;max-height:none!important;opacity:1!important;filter:none!important;cursor:grab}",
  ".pfz-bar{position:absolute;top:12px;right:12px;display:flex;gap:8px;z-index:1}",
  ".pfz-ov button{min-width:44px;min-height:44px;padding:0 12px;border:0;border-radius:22px;font:600 20px/1 system-ui,sans-serif;background:#fff;color:#111;cursor:pointer}",
  ":is(img,svg):not(a *):not(.pfz-ov *):hover{cursor:zoom-in;outline:2px dashed currentColor;outline-offset:3px}",
  "</style>",
  "<script>",
  "(function(){",
  "var vv=window.visualViewport,ov,el,b,x0,s=1,x=0,y=0,p={},lastD=0,moved=false,po='',L=0,T=0,W=0,H=0;",
  "function geo(){L=vv?vv.offsetLeft:0;T=vv?vv.offsetTop:0;W=vv?vv.width:innerWidth;H=vv?vv.height:innerHeight;ov.style.left=L+'px';ov.style.top=T+'px';ov.style.width=W+'px';ov.style.height=H+'px';}",
  "function apply(){el.style.width=b.w*s+'px';el.style.height=b.h*s+'px';el.style.left='calc(50% + '+x+'px)';el.style.top='calc(50% + '+y+'px)';}",
  "function reset(){s=1;x=x0;y=0;apply();}",
  "function sync(){geo();apply();}",
  "function vl(m){if(vv)['resize','scroll'].forEach(function(t){vv[m](t,sync);});}",
  "function zoomAt(px,py,f){var n=Math.min(12,Math.max(1,s*f)),ux=(px-L-W/2-x)/s,uy=(py-T-H/2-y)/s;s=n;x=px-L-W/2-ux*s;y=py-T-H/2-uy*s;if(s<=1){x=x0;y=0;}apply();}",
  "function close(){if(!ov)return;ov.remove();ov=null;p={};lastD=0;document.removeEventListener('keydown',onKey);vl('removeEventListener');document.documentElement.style.overflow=po;}",
  "function onKey(e){if(e.key==='Escape')close();}",
  "function open(src){var r=src.getBoundingClientRect();if(!r.width||!r.height)return;var im=src.tagName.toLowerCase()==='img';",
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
