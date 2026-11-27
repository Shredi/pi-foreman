// The figure fit and the Enlarge button of the page snippet (zoom.ts): the rules that shrink every figure to its box, and the corner button that
// opens the same overlay as a click. The repo has no DOM library, so these pin the snippet's text and compile its script; the live check (headless
// Chromium, run by hand; its results are in the PR's Verification section) covers the layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as vm from "node:vm";
import { ZOOM_SNIPPET } from "../zoom.ts";

const STYLE = /<style>([\s\S]*?)<\/style>/.exec(ZOOM_SNIPPET)?.[1] ?? "";
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(ZOOM_SNIPPET)?.[1] ?? "";

test("the fit rules shrink every figure to its box and keep its shape, never past natural size", () => {
  // the cap: 100% of the box, or the viewBox width for an SVG without a pixel width (set by the script); !important beats a page's own sizes
  assert.match(STYLE, /:is\(img,svg\):not\(svg \*\):not\(\.pfz-ov \*\)\{max-width:min\(100%,var\(--pfz-w,100%\)\)!important\}/);
  // the height follows the width: an SVG with a viewBox and an img keep their aspect ratio
  assert.match(STYLE, /:is\(img,svg\[viewBox\]\):not\(svg \*\):not\(\.pfz-ov \*\)\{height:auto!important\}/);
  // a picture (a mermaid diagram) is a block, so the figure inside it is capped by its box
  assert.match(STYLE, /picture\{display:block\}/);
});

test("the fit rules leave the overlay and the figures inside an SVG alone", () => {
  // the overlay's own sizes (set by the script on its clones) must not be capped
  assert.equal(STYLE.split(":not(.pfz-ov *)").length - 1, 3);
  assert.equal(STYLE.split(":not(svg *)").length - 1, 2);
});

test("the SVGs without a pixel width get their viewBox width as the cap, once, at load", () => {
  assert.match(SCRIPT, /function fit\(\)\{document\.querySelectorAll\('svg\[viewBox\]'\)/);
  assert.match(SCRIPT, /if\(v\.width&&\(!w\|\|\/%\$\/\.test\(w\)\)\)s\.style\.setProperty\('--pfz-w',v\.width\+'px'\);/);
  // an img of an SVG picture (a mermaid diagram) is capped the same way, by the viewBox width read from its data URI
  assert.match(SCRIPT, /document\.querySelectorAll\('img'\)\.forEach\(function\(i\)\{var t=i\.src\.indexOf\('data:image\/svg\+xml;base64,'\)===0/);
  assert.match(SCRIPT, /i\.style\.setProperty\('--pfz-w',p\[2\]\+'px'\)/);
  assert.match(SCRIPT, /fit\(\);enl\(\);/);
});

test("the Enlarge button: a real button with aria-label and title Enlarge, added to each figure", () => {
  assert.match(SCRIPT, /function enl\(\)\{document\.querySelectorAll\('img,svg'\)/);
  assert.match(SCRIPT, /b\.type='button';b\.className='pfz-enl';b\.title='Enlarge';b\.setAttribute\('aria-label','Enlarge'\)/);
  assert.match(SCRIPT, /w\.appendChild\(b\)/);
  // the wrapper takes the figure's place in the flow: a percentage-width or no-width SVG gets the pfz-p block (its cap is copied to the wrapper)
  assert.match(SCRIPT, /w\.className='pfz-w'\+\(pc\?' pfz-p':bl\?' pfz-b':''\)\+\(mg\?' pfz-c':''\);if\(pc\)w\.style\.setProperty\('--pfz-w',g\.style\.getPropertyValue\('--pfz-w'\)\);p\.insertBefore\(w,t\);w\.appendChild\(t\)/);
});

test("the Enlarge button opens the same overlay as a click on the figure", () => {
  assert.match(SCRIPT, /b\.addEventListener\('click',function\(\)\{open\(g,b\);\}\)/);
});

test("no button for a figure inside a link or a button, inside the overlay, or inside an SVG", () => {
  assert.match(SCRIPT, /if\(!p\|\|g\.closest\('a,button,\.pfz-ov'\)\|\|\(g\.tagName\.toLowerCase\(\)==='svg'&&p\.closest\('svg'\)\)\)return;/);
});

test("the button is low on screen normally, full on hover and keyboard focus, and visible on touch (hover:none)", () => {
  assert.match(STYLE, /\.pfz-enl\{[^}]*opacity:\.35/);
  assert.match(STYLE, /\.pfz-enl:hover,\.pfz-enl:focus-visible,\.pfz-w:hover>\.pfz-enl\{opacity:1\}/);
  assert.match(STYLE, /\.pfz-enl:focus-visible\{outline:2px solid #fff;outline-offset:2px\}/);
  assert.match(STYLE, /@media \(hover:none\)\{\.pfz-enl\{opacity:\.9\}\}/);
});

test("the wrapper keeps the figure in place: relative, inline-block only for an inline figure, block otherwise, capped at its box", () => {
  assert.match(STYLE, /\.pfz-w\{position:relative;display:inline-block;max-width:100%;vertical-align:top\}/);
  // a block figure gets a shrink-wrapped block: its box is the figure's, so the button sits on its corner
  assert.match(STYLE, /\.pfz-w\.pfz-b\{display:block;width:fit-content\}/);
  // a percentage-width SVG (mermaid) sizes to the box; a shrink-wrap would fall back to 300 px
  assert.match(STYLE, /\.pfz-w\.pfz-p\{display:block;width:min\(100%,var\(--pfz-w,100%\)\)\}/);
  // a centred block figure keeps its centring through the wrapper
  assert.match(STYLE, /\.pfz-w\.pfz-c\{margin-left:auto;margin-right:auto\}/);
});

test("the Enlarge button's focus goes back to it when an overlay it opened closes", () => {
  assert.match(SCRIPT, /function open\(src,btn\)\{back=btn\|\|null;/);
  assert.match(SCRIPT, /var f=back;back=null;if\(f&&f\.isConnected\)f\.focus\(\);/);
  assert.match(SCRIPT, /b\.addEventListener\('click',function\(\)\{open\(g,b\);\}\)/);
});

test("no Enlarge button for a figure whose natural size is under 48 px in either dimension", () => {
  assert.match(SCRIPT, /var n=nat\(g\);if\(n&&\(n\[0\]<48\|\|n\[1\]<48\)\)return;/);
});

test("the natural size: the viewBox for an SVG, the data-URI viewBox for an img of SVG, else the natural size or the pixel attributes", () => {
  assert.match(SCRIPT, /function nat\(g\)\{var s=g\.tagName\.toLowerCase\(\)==='svg',v=s\?g\.viewBox\.baseVal:null/);
  assert.match(SCRIPT, /if\(v&&v\.width&&v\.height\)return \[v\.width,v\.height\];/);
  assert.match(SCRIPT, /if\(!s&&g\.src\.indexOf\('data:image\/svg\+xml;base64,'\)===0\)\{t=atob\(g\.src\.split\(','\)\[1\]\);k=t\.indexOf\('viewBox='\);/);
  assert.match(SCRIPT, /if\(!s&&g\.naturalWidth&&g\.naturalHeight\)return \[g\.naturalWidth,g\.naturalHeight\];/);
  // a percentage width is not a pixel size; an unknown size keeps the button
  assert.match(SCRIPT, /function px\(v\)\{var n=parseFloat\(v\);return n>0&&!\/%\$\/\.test\(v\)\?n:0;\}/);
  assert.match(SCRIPT, /var w=px\(g\.getAttribute\('width'\)\|\|g\.style\.width\),h=px\(g\.getAttribute\('height'\)\|\|g\.style\.height\);return w&&h\?\[w,h\]:null;\}/);
});

test("a figure centred or right-aligned by its parent keeps that alignment through a block wrapper", () => {
  // a block wrapper does not inherit text-align: the parent's computed alignment becomes a margin on the wrapper
  assert.match(SCRIPT, /var pa=getComputedStyle\(p\)\.textAlign;if\(\(pc\|\|bl\)&&\/center\$\/\.test\(pa\)\)w\.classList\.add\('pfz-c'\);/);
  assert.match(SCRIPT, /else if\(\(pc\|\|bl\)&&\/\^\(right\|end\)\$\/\.test\(pa\)\)w\.classList\.add\('pfz-r'\);/);
  assert.match(STYLE, /\.pfz-w\.pfz-r\{margin-left:auto\}/);
});

test("the dashed hover outline skips the Enlarge button's own icon", () => {
  assert.match(STYLE, /:is\(img,svg\):not\(a \*\):not\(\.pfz-ov \*\):not\(\.pfz-enl \*\):hover\{/);
});

test("the added style and script stay ASCII, with no request and no remote URL", () => {
  assert.doesNotMatch(ZOOM_SNIPPET, /[^\x00-\x7f]/);
  assert.doesNotMatch(ZOOM_SNIPPET, /https?:\/\//);
  assert.doesNotMatch(SCRIPT, /\beval\(|localStorage|sessionStorage|fetch\(|XMLHttpRequest/);
});

test("the script with the button compiles as JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(SCRIPT));
});
