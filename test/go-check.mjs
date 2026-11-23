// The remote browser's end-to-end check, run by go-check.sh.
//
//   node go-check.mjs site DIR            writes the test site into DIR
//   node go-check.mjs check BASE PORT SITE checks /go at BASE with the
//                                         Chrome whose DevTools are on PORT,
//                                         browsing the test site at SITE
//
// Throughout, every request Chrome makes, from the page and from its frames,
// is recorded: none may go anywhere but the TabTop server.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createBrowserHarness, sleep } from "./browser/harness.mjs";

const [mode, ...args] = process.argv.slice(2);

// --- The test site ------------------------------------------------------

function png(width, height, [r, g, b]) {
    const crc = (buf) => {
        let c = ~0;
        for (const byte of buf) {
            c ^= byte;
            for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
        }
        return ~c >>> 0;
    };
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "latin1");
        data.copy(out, 8);
        out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
    }
    return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function systemFont() {
    for (const dir of ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation", "/usr/share/fonts/truetype"]) {
        try {
            const ttf = readdirSync(dir).find((f) => f.endsWith(".ttf"));
            if (ttf) return readFileSync(join(dir, ttf));
        } catch { /* not there */ }
    }
    throw new Error("no TrueType font found to serve");
}

function writeSite(dir) {
    // A video streamed by the page's own player (MediaSource), playing.
    const streamedVideo = `<video id="streamed" muted width="320" height="180"></video><script>
const streamed = document.getElementById("streamed"), source = new MediaSource();
source.onsourceopen = async () => {
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
    buffer.onupdateend = () => { buffer.onupdateend = null; source.endOfStream(); streamed.play().catch(() => {}); };
    buffer.appendBuffer(await (await fetch("stream.mp4")).arrayBuffer());
};
streamed.src = URL.createObjectURL(source);
</script>`;
    // As HLS.js with preferManagedMediaSource: empty <source>, then attach via
    // ManagedMediaSource (our relay) on a <source>, with startstreaming.
    const hlsLikeVideo = `<video id="streamed" muted width="320" height="180"><source src="" type="video/mp4"></video><script>
const streamed = document.getElementById("streamed");
const Ctor = window.ManagedMediaSource || window.MediaSource;
const source = new Ctor();
const url = URL.createObjectURL(source);
let streaming = 0;
source.addEventListener("startstreaming", () => { streaming++; document.documentElement.setAttribute("data-stream", "start:" + streaming); });
source.addEventListener("sourceopen", async () => {
    document.documentElement.setAttribute("data-mms", Ctor === ManagedMediaSource ? "managed" : "plain");
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
    buffer.onupdateend = () => { buffer.onupdateend = null; source.endOfStream(); streamed.play().catch(() => {}); };
    buffer.appendBuffer(await (await fetch("stream.mp4")).arrayBuffer());
});
streamed.removeAttribute("src");
for (const s of [...streamed.querySelectorAll("source")]) s.remove();
const el = document.createElement("source");
el.type = "video/mp4";
el.src = url;
streamed.appendChild(el);
streamed.load();
</script>`;
    const files = {
        "index.html": `<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="h">Fixture</h1>
<p id="p" onclick="steal()">static</p>
<p id="ws"><a href="a.html">portable</a> <a href="b.html">binary</a>
<b>code</b></p>
<img id="img" src="pic.png" srcset="pic.png 1x, pic2.png 2x" alt="picture">
<div id="bg" style="background-image:url(pic.png);width:10px;height:10px"></div><div id="varbg" style="width:10px;height:10px"></div>
<iframe id="frame" src="https://example.com/"></iframe>
<iframe id="embedded" src="embedded/frame.html"></iframe>
<object data="https://example.com/x.swf"></object>
<a id="next" href="second.html">next</a> <a id="jump" href="#end">end</a>
<form id="form" action="https://example.com/steal"><input name="q"><button>Send</button></form>
<svg width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect id="rect" width="20" height="20" fill="url(#g)"/></svg>
<div style="height:3000px"></div><p id="end">the end</p>
<script>document.getElementById("p").textContent = "scripted"; fetch("https://example.com/beacon").catch(() => {});</script>
</body></html>`,
        "embedded/frame.html": `<!doctype html><style>p { color: teal }</style>
<p id="embedded-text" onclick="throw Error()">initial content</p><img src="../pic.png">
<script>setTimeout(() => { document.getElementById("embedded-text").textContent = "updated content"; }, 1500);</script>`,
        "certlink.html": `<!doctype html><title>Cert link</title><a id="to">to the site</a><script>document.getElementById("to").href = new URLSearchParams(location.search).get("to");</script>`,
        "second.html": `<!doctype html><title>Second</title><p id="p">second page</p><a id="back" href="index.html">back</a>`,
        // WebGL drawn in the engine, replayed in the copy (gogl.js): a still
        // WebGL1 and WebGL2 square on red; one that, clicked, changes colour,
        // each tick drawn 50 times over so its log passes the 4,096-call cap
        // and is compacted (a full log again) as it goes, and clicked again
        // turns blue; and one that, clicked, draws past the cap with no clear
        // between (which can't be compacted), so can't be shown any more.
        "webgl.html": `<!doctype html><title>WebGL</title>
<canvas id="still" width="64" height="64"></canvas> <canvas id="two" width="64" height="64"></canvas> <canvas id="moving" width="64" height="64"></canvas> <canvas id="broken" width="64" height="64"></canvas> <canvas id="overrun" width="64" height="64"></canvas> <canvas id="sized" width="64" height="64"></canvas> <canvas id="upload" width="64" height="64"></canvas>
<p id="n">0</p><p id="io"></p><div style="position:absolute;top:4000px;width:1px;height:1px"></div>
<script>
new IntersectionObserver((seen) => { document.getElementById("io").textContent = seen.at(-1).isIntersecting ? "in" : "out"; }).observe(document.getElementById("moving"));
function scene(canvas, kind) {
    const gl = canvas.getContext(kind, { antialias: false });
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }"));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, "precision mediump float; uniform vec4 c; void main() { gl_FragColor = c; }"));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const c = gl.getUniformLocation(program, "c");
    const draw = (color) => { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); draw.over(color); };
    draw.over = (color) => { gl.uniform4fv(c, color); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
    return draw;
}
scene(document.getElementById("still"), "webgl")([0, 1, 0, 1]);
scene(document.getElementById("two"), "webgl2")([0, 0, 1, 1]);
// A shader the viewer can't compile (the engine's says it did): shown as
// unavailable, not as a stale or partial picture.
const broken = document.getElementById("broken").getContext("webgl"), bad = broken.createShader(broken.FRAGMENT_SHADER);
broken.shaderSource(bad, "void main() { not glsl }");
broken.compileShader(bad);
broken.clearColor(0, 1, 0, 1);
broken.clear(broken.COLOR_BUFFER_BIT);
const moving = scene(document.getElementById("moving"), "webgl");
let n = 0, tick = 0;
moving([0, 0, 0, 1]);
document.getElementById("moving").addEventListener("click", () => {
    if (n === 30) { moving([0, 0, 1, 1]); document.getElementById("n").textContent = "clicked"; return; }
    if (tick) return;
    tick = setInterval(() => {
        n++;
        for (let i = 0; i < 50; i++) moving([n / 30, 1 - n / 30, 0.5, 1]);
        document.getElementById("n").textContent = n;
        if (n === 30) clearInterval(tick);
    }, 150);
});
const overrun = scene(document.getElementById("overrun"), "webgl");
overrun([0, 1, 0, 1]);
document.getElementById("overrun").addEventListener("click", () => { for (let i = 0; i < 2500; i++) overrun.over([0, 1, 0, 1]); });
// Clicked: two big textures uploaded (an update past a batch's 3 MB), then blue.
const upload = document.getElementById("upload"), up = upload.getContext("webgl");
up.clearColor(0, 1, 0, 1); up.clear(up.COLOR_BUFFER_BIT);
upload.addEventListener("click", () => {
    for (let i = 0; i < 2; i++) {
        up.bindTexture(up.TEXTURE_2D, up.createTexture());
        up.texImage2D(up.TEXTURE_2D, 0, up.RGBA, 512, 600, 0, up.RGBA, up.UNSIGNED_BYTE, new Uint8Array(512 * 600 * 4).fill(i + 1));
    }
    // (A clear in a scissor box: not one the hook compacts at, so these go
    // as an update, not a log sent whole.)
    up.enable(up.SCISSOR_TEST); up.scissor(0, 0, 64, 64);
    up.clearColor(0, 0, 1, 1); up.clear(up.COLOR_BUFFER_BIT);
});
// Resized by the page, then drawn again at its new size.
const sizedCanvas = document.getElementById("sized"), sized = scene(sizedCanvas, "webgl");
sized([0, 1, 0, 1]);
sizedCanvas.addEventListener("click", () => {
    sizedCanvas.width = 96;
    sizedCanvas.height = 48;
    const gl = sizedCanvas.getContext("webgl");
    gl.viewport(0, 0, 96, 48);
    sized([0, 0, 1, 1]);
});
</script>`,
        // More WebGL canvases than a page may have mirrored (16).
        "glmany.html": `<!doctype html><title>GL many</title><body><script>
for (let i = 0; i < 20; i++) { const c = document.createElement("canvas"); c.width = c.height = 16; document.body.append(c); const gl = c.getContext("webgl"); gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
</script>`,
        // A WebGL canvas animating by itself: 20 ticks, from blue to red.
        "glanim.html": `<!doctype html><title>GL anim</title><body><canvas id="a" width="64" height="64"></canvas><script>
const gl = document.getElementById("a").getContext("webgl");
let n = 0;
gl.clearColor(0, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
setTimeout(() => { const t = setInterval(() => { n++; gl.clearColor(n / 20, 0, 1 - n / 20, 1); gl.clear(gl.COLOR_BUFFER_BIT); if (n === 20) clearInterval(t); }, 250); }, 1500);
</script>`,
        // A page replacing its WebGL canvas, 20 times: the last blue.
        "glswap.html": `<!doctype html><title>GL swap</title><body><script>
let n = 0;
const swap = () => { document.querySelector("canvas")?.remove(); const c = document.createElement("canvas"); c.id = "c"; c.width = c.height = 32; document.body.append(c);
    const gl = c.getContext("webgl"); gl.clearColor(n === 19 ? 0 : 1, 0, n === 19 ? 1 : 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); if (++n < 20) setTimeout(swap, 250); };
swap();
</script>`,
        // WebGL in an embedded page: webgl.html, or the page ?src names.
        "glframe.html": `<!doctype html><title>GL frame</title><iframe id="f" width="700" height="260"></iframe>
<script>document.getElementById("f").src = new URLSearchParams(location.search).get("src") || "webgl.html";</script>`,
        // three.js (the image's /opt/three, copied in by go-check.sh), drawing
        // a red box on blue and turning it.
        "three.html": `<!doctype html><title>Three</title><canvas id="three" width="128" height="128"></canvas> <canvas id="lit" width="128" height="128"></canvas><p id="s">starting</p><p id="f"></p>
<script type="module">
import * as THREE from "./three/three.module.js";
try {
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("three"), antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(128, 128, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0000ff);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    camera.position.z = 3;
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    scene.add(box);
    // Turned by requestAnimationFrame, as pages animate: 20 frames.
    let turns = 0;
    const draw = () => { box.rotation.y = turns * 0.1; renderer.render(scene, camera); document.getElementById("f").textContent = turns; };
    draw();
    const turn = () => { draw(); if (++turns <= 20) requestAnimationFrame(turn); };
    requestAnimationFrame(turn);
    // Lit: a standard (physically based) material, a light, a texture.
    const lit = new THREE.WebGLRenderer({ canvas: document.getElementById("lit"), antialias: false });
    lit.setPixelRatio(1);
    lit.setSize(128, 128, false);
    const litScene = new THREE.Scene();
    litScene.background = new THREE.Color(0x000000);
    litScene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(1, 2, 3);
    litScene.add(sun);
    const checks = new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 2) % 2 ? 255 : 128));
    const map = new THREE.DataTexture(checks, 4, 4);
    map.needsUpdate = true;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.6, map }));
    litScene.add(ball);
    lit.render(litScene, camera);
    document.getElementById("s").textContent = "drawn";
} catch (err) {
    document.getElementById("s").textContent = "failed: " + err.message;
}
</script>`,
        // What a page is told of light or dark (Dark mode), as it changes.
        // The same in its CSS, which the copy's styles go by.
        "schemecss.html": `<!doctype html><title>Scheme CSS</title><style>#c { color: rgb(1, 1, 1); } @media (prefers-color-scheme: dark) { #c { color: rgb(2, 2, 2); } }</style><p id="c">css</p>`,
        "scheme.html": `<!doctype html><title>Scheme</title><p id="s"></p><script>const q = matchMedia("(prefers-color-scheme: dark)"); const say = () => { document.getElementById("s").textContent = q.matches ? "dark" : "light"; }; say(); q.addEventListener("change", say);</script>`,
        // Rich text (contenteditable): what the engine's page holds, said
        // in #got (its paragraphs, | between); a chat box Enter sends
        // (Shift+Enter a new line), as a messenger's does.
        "editable.html": `<!doctype html><title>Editable</title>
<div id="ed" contenteditable="true"><p>hello</p></div>
<p id="got">engine: hello</p>
<div id="chat" contenteditable="true"></div><ul id="sent"></ul>
<iframe id="fr" src="editable-frame.html" style="width: 300px; height: 120px"></iframe>
<div id="fw" contenteditable="true"></div><p id="fwgot"></p>
<script>
// An editor as frameworks make them: every edit taken (beforeinput
// cancelled), its text a model, the box made anew from it, the caret kept
// by selectionchange.
const fw = document.getElementById("fw");
let model = "", place = 0;
const render = () => {
    const t = document.createTextNode(model);
    fw.replaceChildren(t);
    if (document.activeElement === fw) getSelection().setBaseAndExtent(t, place, t, place);
    document.getElementById("fwgot").textContent = "model: " + model;
};
document.addEventListener("selectionchange", () => { const s = getSelection(); if (s.anchorNode && fw.contains(s.anchorNode)) place = s.anchorNode.nodeType === 3 ? s.anchorOffset : 0; });
fw.addEventListener("beforeinput", (e) => {
    e.preventDefault();
    if (e.inputType === "insertText") { model = model.slice(0, place) + e.data + model.slice(place); place += e.data.length; }
    else if (e.inputType === "deleteContentBackward" && place > 0) { model = model.slice(0, place - 1) + model.slice(place); place--; }
    render();
});
render();
</script>
<script>
const ed = document.getElementById("ed"), got = document.getElementById("got"), chat = document.getElementById("chat");
const say = () => { got.textContent = "engine: " + [...ed.childNodes].map((n) => n.textContent).join("|"); };
ed.addEventListener("input", say);
chat.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const li = document.createElement("li");
    li.textContent = chat.textContent;
    document.getElementById("sent").append(li);
    chat.textContent = "";
});
</script>`,
        // Web components: shadow roots (adopted stylesheets, a slot, a
        // closed one, one attached later), and in them a button, rich text,
        // and frames (?x: another site's page for one).
        "shadow.html": `<!doctype html><title>Shadow</title>
<x-card id="card"><span id="slotted">slotted text</span></x-card>
<x-closed id="closed"></x-closed>
<x-late id="late"></x-late>
<x-dsd id="dsd"><template shadowrootmode="open"><style>em { color: rgb(5, 6, 7) }</style><em id="declared">declared</em></template></x-dsd>
<div id="dsdc"><template shadowrootmode="closed"><style>s { color: rgb(12, 13, 14) }</style><s id="dsdclosed">closed, from the HTML</s></template></div>
<x-lazy id="lazy"></x-lazy>
<button id="define">Define</button> <button id="restyle">Restyle</button> <button id="rerule">Rule</button>
<p id="clicks">clicks 0</p><p id="edgot">engine: edit me</p>
<script>
const sheet = new CSSStyleSheet();
sheet.replaceSync(":host { display: block; color: rgb(1, 2, 3) } b { color: rgb(10, 20, 30) } ::slotted(span) { color: rgb(40, 50, 60) }");
const other = new URLSearchParams(location.search).get("x");
customElements.define("x-card", class extends HTMLElement {
    constructor() {
        super();
        const r = this.attachShadow({ mode: "open" });
        r.adoptedStyleSheets = [sheet];
        r.innerHTML = '<b id="inner">inner text</b> <slot></slot> <button id="btn">press</button> <div id="ed" contenteditable="true">edit me</div>'
            + '<iframe id="fr" src="shadow-frame.html" style="width: 220px; height: 50px"></iframe>' + (other ? '<iframe id="frx" src="' + other + '" style="width: 220px; height: 50px"></iframe>' : "");
        let n = 0;
        r.getElementById("btn").addEventListener("click", () => { document.getElementById("clicks").textContent = "clicks " + (++n); });
        const ed = r.getElementById("ed");
        ed.addEventListener("input", () => { document.getElementById("edgot").textContent = "engine: " + [...ed.childNodes].map((n) => n.textContent).join("|"); });
    }
});
customElements.define("x-closed", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<style>i { color: rgb(70, 80, 90) }</style><i id="secret">closed text</i>'; }
});
document.getElementById("restyle").addEventListener("click", () => sheet.replaceSync(":host { display: block } b { color: rgb(90, 91, 92) } ::slotted(span) { color: rgb(40, 50, 60) }"));
document.getElementById("define").addEventListener("click", () => customElements.define("x-late", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<em id="later">defined later</em>'; }
}));
// Its root from its HTML (declarative), taken up as Lit does.
customElements.define("x-dsd", class extends HTMLElement {
    connectedCallback() { const r = this.shadowRoot ?? this.attachShadow({ mode: "open" }); r.querySelector("em")?.setAttribute("data-taken", "yes"); }
});
// Drawn once what's in its root is seen (an IntersectionObserver's).
customElements.define("x-lazy", class extends HTMLElement {
    constructor() {
        super();
        const r = this.attachShadow({ mode: "open" });
        r.innerHTML = '<div id="lazybox" style="height: 20px">waiting</div>';
        new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) r.getElementById("lazybox").textContent = "seen"; }).observe(r.getElementById("lazybox"));
    }
});
// A <style> in a root filled by script (insertRule, no text: styled-
// components'), its root closed and made before it's in the document; a
// rule put in later, at a press.
customElements.define("x-ruled", class extends HTMLElement {
    constructor() {
        super();
        const r = this.attachShadow({ mode: "closed" });
        r.innerHTML = '<style></style><u id="ruledtext">ruled text</u>';
        this.sheetOf = () => r.querySelector("style").sheet;
    }
    connectedCallback() { this.sheetOf().insertRule("u { color: rgb(11, 22, 33) }"); }
});
const ruled = document.createElement("x-ruled");
document.body.append(ruled);
document.getElementById("rerule").addEventListener("click", () => ruled.sheetOf().insertRule("u { color: rgb(44, 55, 66) }", 1));
window.pageSees = String(document.getElementById("closed").shadowRoot);
</script>`,
        "shadow-frame.html": `<!doctype html><title>Shadow frame</title><p id="infr">in a frame in a shadow root</p><x-fcard></x-fcard>
<div><template shadowrootmode="closed"><b class="fdsd">closed in a frame, from its HTML</b></template></div>
<button id="fbtn" onclick="this.textContent = 'frame pressed'">frame button</button>
<script>
const s = new CSSStyleSheet();
s.replaceSync("i { color: rgb(33, 44, 55) }");
customElements.define("x-fcard", class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: "open" }); r.adoptedStyleSheets = [s]; r.innerHTML = '<i class="finner">a component in the frame</i>'; } });
</script>`,
        // Rich text in an embedded page (edited by script there).
        "editable-frame.html": `<!doctype html><title>Editable frame</title>
<div id="fed" contenteditable="true"><p>in</p></div><p id="fgot">frame: in</p>
<script>const fed = document.getElementById("fed"); fed.addEventListener("input", () => { document.getElementById("fgot").textContent = "frame: " + [...fed.childNodes].map((n) => n.textContent).join("|"); });</script>`,
        // A window opened by a press anywhere on the page (no place to find in
        // one copy of several tabs').
        "opener.html": `<!doctype html><title>Opener</title>
<button id="open" style="position:fixed;inset:0;width:100%;height:100%" onclick="window.open('second.html')">Open</button>`,
        "interact.html": `<!doctype html><title>Interact</title>
<p id="status">ready</p>
<button id="add">Add</button><ul id="list"></ul>
<input id="todo" placeholder="todo">
<form id="get" action="result.html"><input id="q" name="q"><button id="go">Search</button></form>
<form id="post" method="post" action="posted"><input id="pq" name="pq" value="posted value"><button id="send">Send</button></form>
<label><input type="checkbox" id="cb"> tick</label>
<select id="sel"><option value="a">A</option><option value="b">B</option></select>
<button id="push">Route</button> <button id="redirect">Redirect</button>
<button id="alert">Alert</button> <button id="confirm">Confirm</button> <button id="open">Open</button> <button id="openask">Open and ask</button> <button id="svgbtn"><svg width="20" height="20"><path id="svgpath" d="M0 0h20v20H0z"/></svg></button>
<a id="pdf" href="doc.pdf">a PDF</a>
<script>
const $ = (id) => document.getElementById(id), status = (t) => { $("status").textContent = t; };
$("add").onclick = () => { const li = document.createElement("li"); li.textContent = "item " + ($("list").children.length + 1); $("list").append(li); };
$("todo").onkeydown = (e) => { if (e.key === "Enter") { const li = document.createElement("li"); li.textContent = "todo " + e.target.value; $("list").append(li); e.target.value = ""; } };
$("cb").onchange = () => status("checked " + $("cb").checked);
$("sel").onchange = () => status("selected " + $("sel").value);
$("push").onclick = () => { history.pushState({}, "", "/routed"); status("routed"); };
$("redirect").onclick = () => { location.href = "second.html"; };
$("alert").onclick = () => { alert("hello from the page"); status("after alert"); };
$("confirm").onclick = () => { status("confirmed " + confirm("sure?")); };
$("open").onclick = () => { window.open("second.html"); };
$("svgbtn").onclick = () => status("icon pressed");
$("openask").onclick = () => { window.open(location.protocol + "//" + location.hostname + ":8081/second.html"); alert("who asks"); };
setTimeout(() => { const p = document.createElement("p"); p.id = "late"; p.textContent = "late"; document.body.append(p); }, 1500);
</script>`,
        "bgcolor.html": `<!doctype html><title>Bgcolor</title><body bgcolor="#000000" text="#ffffff"><p id="t">Light text on a dark page, by attributes</p></body>`,
        "result.html": `<!doctype html><title>Result</title><p id="p"></p><script>document.getElementById("p").textContent = "query " + new URLSearchParams(location.search).get("q");</script>`,
        "view.html": `<!doctype html><title>View</title><style>body { margin: 0 } #hd { height: 123px; background: #eee } .wide-only { display: none } @media (min-width: 900px) { .wide-only { display: block } }</style>
<header id="hd"><button id="menu">Menu</button></header><p id="w"></p><p id="mq"></p><p id="or"></p><p class="wide-only" id="wide">wide</p>
<script>
if (location.search === "?tall") document.body.append(Object.assign(document.createElement("div"), { style: "height: 3000px" }));
const show = () => { document.getElementById("w").textContent = "width " + innerWidth; document.getElementById("mq").textContent = matchMedia("(min-width: 900px)").matches ? "wide" : "narrow"; };
show(); addEventListener("resize", show);
const turned = () => { document.getElementById("or").textContent = (screen.orientation ? screen.orientation.type + " " + screen.orientation.angle : "none") + " " + (matchMedia("(orientation: portrait)").matches ? "portrait" : "landscape"); };
turned(); screen.orientation?.addEventListener("change", turned); matchMedia("(orientation: portrait)").addEventListener("change", turned);
document.getElementById("menu").onclick = () => { const o = document.createElement("div"); o.id = "overlay"; o.style.cssText = "position: fixed; left: 0; right: 0; bottom: 0; background: #def"; o.style.top = document.getElementById("hd").getBoundingClientRect().bottom + "px"; o.textContent = "menu"; document.body.append(o); };
</script>`,
        "cache.html": `<!doctype html><title>Cached</title><img id="pic" src="pic.png?cache" width="4" height="4" alt="cached">`,
        "lazy.html": `<!doctype html><title>Lazy</title><p id="state">waiting</p><p id="feature"></p>
<div style="height:3000px">down there</div><img id="lazy" data-src="pic.png" width="10" height="10" alt="lazy">
<script>
document.getElementById("feature").textContent = "intersectionRatio" in IntersectionObserverEntry.prototype ? "feature yes" : "feature no";
const img = document.getElementById("lazy"), state = document.getElementById("state");
let calls = 0;
new IntersectionObserver((entries, observer) => {
    for (const e of entries) {
        calls++;
        // As YouTube's thumbnails go by: only what has a visible area.
        if (e.isIntersecting && e.intersectionRect.height > 0) { img.src = img.dataset.src; observer.unobserve(img); state.textContent = "loaded, call " + calls; }
        else state.textContent = "not visible";
    }
}).observe(img);
</script>`,
        "ioalert.html": `<!doctype html><title>Observed alert</title><p id="seen">here</p><p id="after"></p>
<script>
const seen = document.getElementById("seen");
const o = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    o.disconnect();
    alert("seen it");
    document.getElementById("after").textContent = "after the alert";
});
o.observe(seen);
</script>`,
        "input.html": `<!doctype html><title>Input</title>
<style>#menu { display: none } #host.open #menu { display: block } #pad { width: 200px; height: 100px; background: #eee }
#cover { position: relative; width: 120px; height: 40px } #cover embed { position: absolute; inset: 0; width: 100%; height: 100%; border: 0 }</style>
<button id="count">count</button> <span id="n">0</span>
<div id="host"><span id="trigger">hover here</span><div id="menu"><a href="#" id="mitem">item</a></div></div>
<button id="pointer">pointer only</button>
<div id="pad">pad</div>
<div id="cover"><button id="under">under</button><embed type="image/png" src="pic.png"></div>
<p id="log"></p>
<script>
const $ = (i) => document.getElementById(i), log = (t) => { $("log").textContent += t + ";"; };
let n = 0;
$("count").addEventListener("click", (e) => { $("n").textContent = ++n; log("count " + e.isTrusted); });
$("host").addEventListener("mouseenter", () => $("host").classList.add("open"));
$("host").addEventListener("mouseleave", () => $("host").classList.remove("open"));
let down = false;
$("pointer").addEventListener("pointerdown", () => { down = true; });
$("pointer").addEventListener("pointerup", () => { if (down) log("pointer pressed"); down = false; });
$("pad").addEventListener("dblclick", () => log("dblclick"));
$("pad").addEventListener("contextmenu", (e) => { e.preventDefault(); log("contextmenu"); });
$("pad").addEventListener("wheel", (e) => log("wheel " + (e.deltaY > 0 ? "down" : "up")), { passive: true });
$("pad").addEventListener("click", (e) => log("pad " + (e.offsetX < 100 ? "left" : "right")));
$("under").addEventListener("click", () => log("under clicked"));
</script>`,
        // A video on a dark page: the page stays dark around it.
        "darkvideo.html": `<!doctype html><title>Dark video</title><style>html { background: #102030; color: #eee; }</style><p>a clip:</p>
<video id="clip" src="clip.mp4" width="320" height="180" muted autoplay></video>`,
        "blackvideo.html": `<!doctype html><title>Black video</title><style>html { background: #000; color: #eee; }</style><p>a clip:</p>
<video id="clip" src="clip.mp4" width="320" height="180" muted autoplay></video>`,
        "darkvideo-oklch.html": `<!doctype html><title>Oklch video</title><style>html { background: oklch(0.25 0.04 250); color: #eee; }</style><p>a clip:</p>
<video id="clip" src="clip.mp4" width="320" height="180" muted autoplay></video>`,
        "video.html": `<!doctype html><title>Video</title><link rel="stylesheet" href="style.css"><p>a clip:</p>
<div style="position:relative;width:320px;height:180px"><div style="overflow:hidden;width:1px;height:1px">
<video id="clip" src="clip.mp4" width="320" height="180" poster="pic.png" style="position:absolute;top:0;left:0;object-fit:cover;object-position:75% 25%" muted></video>
</div></div>
<p>streamed by its own player:</p><video id="streamed" width="160" height="90"></video>
<audio id="silent"></audio><p id="meta">no size</p><div style="height:1600px"></div>
<script>document.getElementById("streamed").src = URL.createObjectURL(new Blob(["x"]));
const clip = document.getElementById("clip");
clip.addEventListener("loadedmetadata", () => { document.getElementById("meta").textContent = clip.videoWidth + "x" + clip.videoHeight + " " + Math.round(clip.duration) + " s"; });</script>`,
        "relay.html": `<!doctype html><title>Relay</title>
<video id="player" muted width="320" height="180"><source src="clip.mp4"></video>
<p id="status">playing clip</p>
<script>
const video = document.getElementById("player");
const status = document.getElementById("status");
video.addEventListener("ended", () => {
    const child = video.querySelector("source");
    const source = new MediaSource();
    source.onsourceopen = async () => {
        try {
            const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
            buffer.onupdateend = () => {
                buffer.onupdateend = null;
                if (!buffer.buffered.length) {
                    status.textContent = "updateend before media was buffered";
                    return;
                }
                source.endOfStream();
                status.textContent = "stream supplied";
            };
            const reply = await fetch("stream.mp4");
            buffer.appendBuffer(await reply.arrayBuffer());
            await video.play();
        } catch (error) { status.textContent = String(error); }
    };
    child.src = URL.createObjectURL(source);
    video.load();
    if (video.ended) {
        source.onsourceopen = null;
        status.textContent = "the replacement stream inherited the preroll end state";
    }
}, { once: true });
</script>`,
        "feed.html": `<!doctype html><title>Feed</title><p id="status">ready</p>
<button id="nextclip">next</button><video id="a" src="clip.mp4" width="320" height="180" muted></video><video id="b" width="320" height="180" muted><source src="" type="video/mp4"></video>
<div id="scroller" style="height:150px;width:300px;overflow:auto"><div style="height:3000px">scroll me</div></div>
<script>
document.getElementById("nextclip").onclick = () => { const b = document.getElementById("b"); b.src = "clip.mp4"; b.play().catch(() => {}); };
document.getElementById("scroller").onscroll = (e) => { document.getElementById("status").textContent = "at " + Math.round(e.target.scrollTop); };
</script>`,
        "memory.html": `<!doctype html><title>Memory</title><p id="s">not yet</p>
<script>
// Address space past a gigabyte, little of it used: the engine's limit is on
// what it has (Moli's V8 ended at 1 GiB on Wikipedia, using 400 MiB).
try {
    const memories = [];
    for (let i = 0; i < 6; i++) memories.push(new ArrayBuffer(200 << 20));
    document.getElementById("s").textContent = "memory " + memories.reduce((n, m) => n + m.byteLength, 0);
} catch (e) {
    document.getElementById("s").textContent = "refused " + e.name;
}
</script>`,
        "noreferer.html": `<!doctype html><title>No referer</title><img id="pic" src="pic.png?with-referer-off">`,
        "norange.html": `<!doctype html><title>No ranges</title><video id="v" src="norange.mp4" width="320" height="180" muted></video><img id="pic" src="pic.png?from-norange">`,
        "reel-player.html": `<!doctype html><title>Reel player</title><p id="status">ready</p><p id="time">no time</p><button id="load">load</button>
<div id="wrap" style="visibility:hidden"><video id="v" width="320" height="180" muted></video></div>
<script>
// As YouTube's Shorts goes to its next video: its player hidden till the
// video it's given plays, and where it is read as it plays.
const v = document.getElementById("v");
document.getElementById("load").onclick = () => { v.src = "clip.mp4"; v.play().catch(() => {}); };
v.addEventListener("playing", () => { document.getElementById("wrap").style.visibility = "visible"; document.getElementById("status").textContent = "playing"; });
v.addEventListener("timeupdate", () => { document.getElementById("time").textContent = "time " + v.currentTime.toFixed(1) + (v.paused ? " paused" : ""); });
</script>`,
        "long-feed.html": `<!doctype html><title>Long feed</title>
<style>#clips { width: 320px; height: 180px; overflow: auto; }
#clips video { display: block; width: 100%; height: 180px; object-fit: cover; }</style>
<div id="clips">${Array.from({ length: 11 }, (_, i) => `<video id="clip-${i}" src="clip.mp4?clip=${i}" width="120" height="60" muted></video>`).join("")}</div>`,
        "ask-load.html": `<!doctype html><title>Asks</title><p id="before">before</p><script>alert("while loading");</script><p id="after">after</p>`,
        "ask-frame.html": `<!doctype html><title>Frame asks</title><p id="status">ready</p><iframe src="embedded/ask.html"></iframe>`,
        "embedded/ask.html": `<!doctype html><p>asking</p><script>setTimeout(() => { parent.document.getElementById("status").textContent = "answered " + confirm("from the frame"); }, 300);</script>`,
        "ask-prompt.html": `<!doctype html><title>Prompts</title><p id="status">ready</p><button id="ask">Ask</button>
<script>document.getElementById("ask").onclick = () => { document.getElementById("status").textContent = "prompted " + prompt("your name?", "nobody"); };</script>`,
        "ask-loop.html": `<!doctype html><title>Loop</title><p id="status">ready</p><button id="loop">Loop</button>
<script>document.getElementById("loop").onclick = () => { for (let i = 0; i < 1000; i++) alert("again " + i); document.getElementById("status").textContent = "done"; };</script>`,
        "hands.html": `<!doctype html><title>Hands</title><p id="status">ready</p><p id="screen"></p>
<div id="a" draggable="true" style="width:120px;height:60px;background:#c33">drag me</div>
<div id="t" style="margin-top:40px;width:240px;height:100px;background:#36c">drop here</div>
<button id="tap" style="width:120px;height:60px">tap</button>
<script>
const $ = (id) => document.getElementById(id), status = (t) => { $("status").textContent = t; };
const tell = () => { $("screen").textContent = screen.width + "x" + screen.height + " " + ("ontouchstart" in window) + " " + navigator.maxTouchPoints; };
tell(); addEventListener("resize", tell);
$("a").ondragstart = (e) => e.dataTransfer.setData("text/plain", "from the page");
$("t").ondragover = (e) => e.preventDefault();
$("t").ondrop = (e) => { e.preventDefault(); status("dropped " + e.dataTransfer.getData("text/plain")); };
let touches = 0;
$("tap").addEventListener("touchstart", () => touches++);
$("tap").onclick = () => status("tapped, touches " + touches);
</script>`,
        "slow.html": `<!doctype html><title>Slow video</title><video id="slow" src="clip.mp4?slow" width="320" height="180" muted></video>`,
        "phone.html": `<!doctype html><title>Phone video</title><meta name="viewport" content="width=device-width"><style>body { margin: 0 } video { display: block; width: 100% }</style>
<video id="big" src="clip.mp4?phone=1&slow" style="height: 220px" muted></video><p>a feed:</p><video id="small" src="clip.mp4?phone=2&slow" style="width: 160px; height: 90px" muted></video>`,
        "skip.html": `<!doctype html><title>Skip</title><style>body { margin: 0 } video { display: block }</style>
<video id="a" src="clip.mp4?skip" width="320" height="180" muted></video><p id="a-out">a not ended</p>
<video id="b" src="clip.mp4?slow" width="320" height="180" muted></video><p id="b-out">b not ended</p>
<script>for (const id of ["a", "b"]) { const v = document.getElementById(id); v.addEventListener("ended", () => { document.getElementById(id + "-out").textContent = id + " ended at " + Math.round(v.currentTime) + " " + v.ended; }); v.play().catch(() => {}); }</script>`,
        "resume.html": `<!doctype html><title>Resume</title><input id="t" aria-label="kept"><p id="n">0</p><div style="height:4000px"></div><p id="end">end</p>
<script>let n = 0; setInterval(() => { document.getElementById("n").textContent = String(++n); }, 200);</script>`,
        "swipe.html": `<!doctype html><title>Swipe</title><style>body { margin: 0 } button { display: block; width: 100%; height: 120px; font-size: 20px }</style><p id="out">clicks 0</p>
${Array.from({ length: 40 }, (_, i) => `<button id="b${i}">button ${i}</button>`).join("")}
<script>let clicks = 0; for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => { document.getElementById("out").textContent = "clicks " + ++clicks + " " + b.id; });</script>`,
        "many.html": `<!doctype html><title>Many</title><p id="n">loading</p><div>${Array.from({ length: 80 }, (_, i) => `<img src="pic.png?many=${i}&slow" width="4" height="4" alt="">`).join("")}</div>`,
        "rotate.html": `<!doctype html><title>Rotate</title><meta name="viewport" content="width=device-width"><style>body { margin: 0 } video { display: block; width: 100%; aspect-ratio: 16 / 9 }</style>
<p>top</p><video id="v" src="clip.mp4?rotate" muted loop></video><p>below</p><script>document.getElementById("v").play().catch(() => {});</script>`,
        "auto.html": `<!doctype html><title>Autoplay</title><video id="v" src="clip.mp4?auto" width="320" height="180" muted loop></video><p id="out">none</p><button id="again">again</button>
<script>const v = document.getElementById("v"), out = document.getElementById("out"); for (const t of ["play", "pause"]) v.addEventListener(t, () => { out.textContent = t + " " + (v.paused ? "paused" : "playing"); }); v.play().catch(() => {}); document.getElementById("again").onclick = () => v.play().catch(() => {});</script>`,
        "swiped.html": `<!doctype html><title>Swiped</title><meta name="viewport" content="width=device-width"><style>html, body { margin: 0; height: 100%; overflow: hidden } #wrap { position: relative; height: 100%; overflow: hidden } #items { position: absolute; inset: 0; transition: transform .2s } .item { height: 100vh } video { width: 100%; height: 100%; object-fit: cover; display: block } #out { position: fixed; top: 0; left: 0; background: #fff }</style>
<p id="out">at 0, clicks 0</p><div id="wrap"><div id="items">${[0, 1, 2].map((i) => `<div class="item"><video src="clip.mp4?reel=${i}" muted loop></video></div>`).join("")}</div></div>
<script>let at = 0, clicks = 0, from = null, dy = 0; const out = () => { document.getElementById("out").textContent = "at " + at + ", clicks " + clicks; };
addEventListener("touchstart", (e) => { from = e.touches[0].clientY; dy = 0; }, { passive: false });
addEventListener("touchmove", (e) => { if (from !== null) { dy = e.touches[0].clientY - from; e.preventDefault(); } }, { passive: false });
addEventListener("touchend", () => { if (from !== null && dy < -50 && at < 2) { at++; document.getElementById("items").style.transform = "translateY(" + (-100 * at) + "vh)"; } from = null; out(); });
addEventListener("click", () => { clicks++; out(); });
document.querySelector("video").play().catch(() => {});</script>`,
        "far.html": `<!doctype html><title>Far</title><video id="far" src="${process.env.GO_VIDEO_URL || "clip.mp4"}" width="640" height="360"></video>`,
        "trap.html": `<!doctype html><title>Trap</title><p id="status">safe</p><iframe id="f" src="trap-frame.html"></iframe>`,
        "trap-frame.html": `<!doctype html><p id="inner">inner</p>
<script>
// Whatever the remote browser's agent hands this window's constructors is
// reported in the page: it mustn't hand anything.
for (const name of ["MutationObserver", "IntersectionObserver", "ResizeObserver"]) {
    window[name] = function (cb) { parent.document.getElementById("status").textContent = "handed a " + typeof cb + " by " + name; this.observe = () => {}; this.disconnect = () => {}; this.takeRecords = () => []; };
}
setTimeout(() => { document.getElementById("inner").textContent = "inner changed"; }, 800);
</script>`,
        "reels.html": `<!doctype html><title>Reels</title><style>#box { height: 300px; width: 200px; overflow-y: scroll; scroll-snap-type: y mandatory } .reel { height: 280px; margin-bottom: 20px; scroll-snap-align: start; background: #ddd }</style>
<div id="box">${Array.from({ length: 10 }, (_, i) => `<div class="reel">reel ${i}</div>`).join("")}</div><p id="status">not scrolled</p><p id="sized">not sized</p><button id="next">next</button>
<script>
// As YouTube's Shorts goes by it: a reel's height from the box's scroll height
// when the box is resized, which reel shows from where it's scrolled.
const box = document.getElementById("box");
let item = 0;
new ResizeObserver((entries) => {
    item = box.scrollHeight / 10;
    document.getElementById("sized").textContent = "box " + entries[0].contentRect.height + " high, reels " + item;
}).observe(box);
box.addEventListener("scroll", () => {
    document.getElementById("status").textContent = item ? "reel " + Math.round(box.scrollTop / item) : "no reel height";
});
// Its next button scrolls the next reel into view, as Shorts' does.
document.getElementById("next").addEventListener("click", () => {
    box.children[Math.round(box.scrollTop / item) + 1]?.scrollIntoView({ block: "start" });
});
</script>`,
        "cssom.html": `<!doctype html><title>Rules</title><style id="css"></style><p id="early">early</p><p id="late">late</p>
<script>
// As styled-components and Emotion do in production: rules into the sheet, no text.
const sheet = document.getElementById("css").sheet;
sheet.insertRule("#early { color: rgb(1, 2, 3) }");
setTimeout(() => sheet.insertRule("#late { color: rgb(4, 5, 6) }", sheet.cssRules.length), 800);
</script>`,
        // A script the engines' shared cache keeps (cached.js), on the
        // untrusted HTTPS site (an exception's) and from a trusted page.
        "certpage.html": `<!doctype html><title>Cert page</title><p>excepted</p><script src="cached.js"></script>`,
        "cachehost.html": `<!doctype html><title>Cache host</title><p>trusted page</p><script>const s = document.createElement("script"); s.src = "https://" + location.host + "/cached.js"; document.head.append(s);</script>`,
        "audiopage.html": `<!doctype html><title>Audio page</title><p>a podcast:</p><audio id="pod" src="tone.wav" controls style="width:400px"></audio><div style="height:3000px">more</div>`,
        // A video whose box's style the page sets again as it plays.
        "restyle.html": `<!doctype html><title>Restyle</title><style>#box { background: #000; width: 340px; height: 200px }</style><div id="box"><video id="clip" src="clip.mp4" width="320" height="180" muted autoplay></video></div>
<script>setTimeout(() => { document.getElementById("box").setAttribute("style", "cursor: pointer"); document.title = "Restyle done"; }, 3000);</script>`,
        // A 2D canvas in a same-origin frame, drawn red, then blue.
        "c2dframe.html": `<!doctype html><title>Canvas frame</title><iframe id="f" src="c2dinner.html" width="100" height="100"></iframe>`,
        "c2dinner.html": `<!doctype html><canvas id="c" width="20" height="20"></canvas><script>
const g = document.getElementById("c").getContext("2d"); g.fillStyle = "#f00"; g.fillRect(0, 0, 20, 20);
setTimeout(() => { g.fillStyle = "#00f"; g.fillRect(0, 0, 20, 20); }, 3000);</script>`,
        // A WebGL canvas taken out of the page, then put back and drawn on.
        "glback.html": `<!doctype html><title>GL back</title><div id="box"><canvas id="c" width="64" height="64"></canvas></div><p id="s">drawn</p><script>
const c = document.getElementById("c"), gl = c.getContext("webgl");
const paint = (r, g, b) => { gl.clearColor(r, g, b, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
paint(0, 0, 1);
setTimeout(() => { c.remove(); document.getElementById("s").textContent = "removed"; }, 3000);
setTimeout(() => { document.getElementById("box").append(c); paint(1, 0, 0); document.getElementById("s").textContent = "back"; }, 6000);
</script>`,
        // A same-origin frame in a same-origin frame, its page changing.
        "nestframe.html": `<!doctype html><title>Nest frame</title><p>outer</p><iframe id="mid" src="nestmid.html" width="400" height="200"></iframe>`,
        "nestmid.html": `<!doctype html><p>middle</p><iframe id="inner" src="nestinner.html" width="300" height="100"></iframe>`,
        "nestinner.html": `<!doctype html><p id="n">first</p><script>setTimeout(() => { document.getElementById("n").textContent = "later"; }, 4000);</script>`,
        // Another origin's frame (changing) holding a third's, with a field
        // (?c: its address, the other server's).
        "nestfocus.html": `<!doctype html><title>Nest focus</title><p>outer</p><iframe id="p" width="420" height="220"></iframe><script>document.getElementById("p").src = "http://[::ffff:" + location.hostname + "]/nestfocusmid.html" + location.search;</script>`,
        "nestfocusmid.html": `<!doctype html><p id="tick">0</p><iframe id="c" width="300" height="100"></iframe><script>document.getElementById("c").src = new URLSearchParams(location.search).get("c"); let n = 0; setInterval(() => { document.getElementById("tick").textContent = ++n; }, 700);</script>`,
        "nestfocusin.html": `<!doctype html><input id="t" value="hello">`,
        // File inputs: a hidden one its button opens (as most sites' are),
        // its files read and posted; one shown, pressed itself; and one a
        // timer opens, with no press.
        "fileinput.html": `<!doctype html><title>File input</title>
<input type="file" id="hidden" multiple style="display:none"><button id="pick">Upload</button>
<input type="file" id="shown" accept=".txt">
<p id="fgot">nothing</p><p id="fposted">not posted</p><p id="fshown">nothing</p>
<script>
const hidden = document.getElementById("hidden");
document.getElementById("pick").addEventListener("click", () => hidden.click());
hidden.addEventListener("change", async () => {
    const parts = [];
    for (const f of hidden.files) parts.push(f.name + "=" + await f.text());
    document.getElementById("fgot").textContent = parts.join(", ");
    const fd = new FormData();
    for (const f of hidden.files) fd.append("file", f);
    const body = await (await fetch("/posted", { method: "POST", body: fd })).text();
    document.getElementById("fposted").textContent = ["first file's", "second file's"].every((t) => body.includes(t)) && /filename="a.txt"/.test(body) && /filename="b.txt"/.test(body) ? "both posted" : "posted: " + body.slice(0, 200);
});
document.getElementById("shown").addEventListener("change", async (e) => { document.getElementById("fshown").textContent = e.target.files[0].name + "=" + await e.target.files[0].text(); });
</script>`,
        // Files dropped: a drop zone that keeps what each drop gives it.
        "filedrop.html": `<!doctype html><title>File drop</title>
<div id="zone" style="width: 400px; height: 200px; background: #eef">drop files here</div><p id="dropped">nothing</p><p id="dtypes"></p>
<script>
const zone = document.getElementById("zone"), got = [];
zone.addEventListener("dragover", (e) => { e.preventDefault(); document.getElementById("dtypes").textContent = [...e.dataTransfer.types].join(","); });
zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer.files) got.push(f.name + "=" + await f.text());
    document.getElementById("dropped").textContent = got.join(", ");
});
</script>`,
        // A page that says when it was loaded: a new number each load.
        "restart.html": `<!doctype html><title>Restart</title><p id="born"></p><script>document.getElementById("born").textContent = String(Math.random()).slice(2);</script>`,
        "fileauto.html": `<!doctype html><title>File auto</title><input type="file" id="auto"><script>setTimeout(() => document.getElementById("auto").click(), 300);</script>`,
        // A video in another site's embedded page, on a white page.
        "clipframe.html": `<!doctype html><title>Clip frame</title><style>body { background: #fff; margin: 0 }</style><video id="clip" src="clip.mp4" width="320" height="180" muted autoplay></video>`,
        "framevideo.html": `<!doctype html><title>Frame video</title><style>html, body { background: #fff }</style><p>an embed:</p><div style="background:#fff"><iframe id="f" width="340" height="200"></iframe></div>
<script>document.getElementById("f").src = "http://[::ffff:" + location.hostname + "]/clipframe.html";</script>`,
        "xframe.html": `<!doctype html><title>Other origin</title><p>a page of another origin:</p><iframe id="x" width="300" height="120"></iframe>
<script>
// The same server by another name (its address as IPv6): another origin.
document.getElementById("x").src = "http://[::ffff:" + location.hostname + "]/xinner.html";
</script>`,
        "xinner.html": `<!doctype html><style>/* old Internet Explorer's hacks, which match nothing in a document */ * html #b, *:first-child+html #b { display: none }</style><button id="b">press</button> <span id="s">not pressed</span> <button id="tb">tap</button> <span id="ts">not tapped</span>
<form id="f"><input id="t" name="t"></form><span id="echo">nothing typed</span> <span id="sent">not sent</span>
<div id="h" style="width:120px;height:20px;background:#ddd">hover me</div><span id="hs">not hovered</span>
<script>
const $ = (i) => document.getElementById(i);
$("b").addEventListener("click", () => { $("s").textContent = "pressed " + location.hostname; });
let taps = 0;
$("tb").addEventListener("click", () => { $("ts").textContent = "tapped " + ++taps; });
$("t").addEventListener("input", () => { $("echo").textContent = "typed " + $("t").value; });
$("f").addEventListener("submit", (e) => { e.preventDefault(); $("sent").textContent = "sent " + $("t").value; });
$("h").addEventListener("mouseenter", () => { $("hs").textContent = "hovered"; });
</script>`,
        "big.html": `<!doctype html><title>Big</title><link rel="stylesheet" href="style.css"><ul id="items"></ul>
${Array.from({ length: 3000 }, (_, i) => `<p class="row">row ${i} of a page large enough to be sent compressed</p>`).join("")}
<script>let n = 0; const add = () => { const li = document.createElement("li"); li.textContent = "item " + ++n; document.getElementById("items").append(li); if (n < 20) setTimeout(add, 50); }; add();</script>`,
        "churn.html": `<!doctype html><title>Churn</title><p id="n">0</p><script>let n = 0; setInterval(() => { document.getElementById("n").textContent = ++n; }, 5);</script>`,
        // A video the page streams itself (MediaSource), as a site's player does, and the
        // manifest(s) such a player would load: Save stream is the /go player's.
        "stream-save.html": `<!doctype html><title>Save stream</title>${streamedVideo}<script>fetch(location.search ? "cancel.m3u8" : "movie.m3u8").then(r => r.text())</script>`,
        // Media Source only (no HLS/DASH manifest): Save uses the buffered MSE capture.
        "mse-save.html": `<!doctype html><title>MSE save</title>${streamedVideo}`,
        // HLS.js-style attach (empty source, then MediaSource on a <source>): must
        // play under the copy, not stay on "nothing to play".
        "mse-hls-like.html": `<!doctype html><title>MSE HLS-like</title>${hlsLikeVideo}`,
        // As YouTube's Shorts: MediaSource play is stubbed; the page's pause must
        // stop the underlaid player and read as paused on the element.
        // Its file as a browser picks it: an empty <source> passed over for
        // the next; an element's own src="" (none) used, its <source> not.
        "sources.html": `<!doctype html><title>Sources</title>
<video id="a" width="320" height="180" muted><source src="" type="video/mp4"><source src="clip.mp4" type="video/mp4"></video>
<video id="b" width="320" height="180" muted src=""><source src="clip.mp4" type="video/mp4"></video>`,
        // A player choosing as dash.js does (createMediaSource): the managed
        // kind if the window has the name at all, else MediaSource. Must not
        // throw (name present but undefined).
        "dash-like.html": `<!doctype html><title>DASH-like</title><pre id="out"></pre><script>
let made;
try {
    made = ("ManagedMediaSource" in window) ? ["managed", new ManagedMediaSource()] : ("MediaSource" in window) ? ["plain", new MediaSource()] : ["none", null];
    const ok = made[1] && typeof made[1].addSourceBuffer === "function" && typeof (made[0] === "managed" ? ManagedMediaSource : MediaSource).isTypeSupported === "function";
    document.getElementById("out").textContent = "made " + made[0] + " " + !!ok;
} catch (err) { document.getElementById("out").textContent = "failed " + err.name; }
</script>`,
        "mse-pause.html": `<!doctype html><title>MSE pause</title>
<video id="streamed" muted width="320" height="180"></video>
<button type="button" id="pause">Pause</button>
<button type="button" id="quick">Play and pause</button>
<button type="button" id="idle">Pause again</button>
<pre id="out"></pre><p id="count">0</p>
<script>
const streamed = document.getElementById("streamed"), source = new MediaSource(), out = document.getElementById("out");
for (const t of ["play", "pause"]) streamed.addEventListener(t, () => { out.textContent = t + " " + (streamed.paused ? "paused" : "playing"); });
// (A "make sure it's paused" handler: pause() on what's paused is nothing.)
let pauses = 0;
streamed.addEventListener("pause", () => { document.getElementById("count").textContent = String(++pauses); streamed.pause(); });
document.getElementById("idle").onclick = () => { streamed.pause(); streamed.pause(); };
source.onsourceopen = async () => {
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
    buffer.onupdateend = () => { buffer.onupdateend = null; source.endOfStream(); streamed.play().catch(() => {}); };
    buffer.appendBuffer(await (await fetch("stream.mp4")).arrayBuffer());
};
document.getElementById("quick").onclick = () => { streamed.play().catch(() => {}); streamed.pause(); };
streamed.src = URL.createObjectURL(source);
document.getElementById("pause").onclick = () => streamed.pause();
</script>`,
        // A single-page site: a video's manifest loaded, then the page moved
        // to its next video (pushState), played through Media Source alone.
        "mse-moved.html": `<!doctype html><title>MSE moved</title><video id="streamed" muted width="320" height="180"></video><script>
fetch("movie.m3u8").then((r) => r.text()).then(() => setTimeout(() => {
    history.pushState({}, "", "?next");
    const streamed = document.getElementById("streamed"), source = new MediaSource();
    source.onsourceopen = async () => {
        const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
        buffer.onupdateend = () => { buffer.onupdateend = null; source.endOfStream(); streamed.play().catch(() => {}); };
        buffer.appendBuffer(await (await fetch("stream.mp4")).arrayBuffer());
    };
    streamed.src = URL.createObjectURL(source);
}, 1500));
</script>`,
        "cancel.m3u8": "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:3,\npending.m4s\n#EXT-X-ENDLIST\n",
        // A master playlist, and its variant, fetched after it, as a player does.
        "stream-master.html": `<!doctype html><title>Master stream</title>${streamedVideo}<script>fetch("master.m3u8").then(r => r.text()).then(() => fetch("movie.m3u8")).then(r => r.text())</script>`,
        // A stream the site's own player plays, none relayed here.
        "onlystream.html": `<!doctype html><title>Only stream</title><p>a stream the site's player plays</p><script>fetch("movie.m3u8").then(r => r.text())</script>`,
        "master.m3u8": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmovie.m3u8\n",
        "movie.m3u8": "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:3,\npart.m4s\n#EXT-X-ENDLIST\n",
        "doc.pdf": "%PDF-1.4 not really",
        "style.css": `@import "more.css";
@font-face { font-family: "Fixture Font"; src: url(font.ttf) format("truetype"); }
#p { color: teal; }
:root { --pic: url(pic.png); }
#varbg { background-image: var(--pic); }
h1 { font-family: "Fixture Font", sans-serif; }`,
        "more.css": `body { background-color: rgb(250, 250, 240); }`,
        "fonts.html": `<!doctype html><title>Fonts</title><link rel="stylesheet" href="fonts.css"><p id="used">in the font used</p>`,
        "fonts-next.html": `<!doctype html><title>Shared fonts</title><link rel="stylesheet" href="fonts.css"><p id="used">in the same font</p>`,
        // Old Internet Explorer's EOT, an SVG font, then one a browser
        // takes; and a face the page never shows.
        "fonts.css": `@font-face { font-family: "Used Font"; src: url(old.eot); src: url(old.eot?#iefix) format("embedded-opentype"), url(icons.svg#f) format("svg"), url(font.ttf?used) format("truetype"), url(fallback.woff) format("woff"); }
@font-face { font-family: "Unused Font"; src: url(unused.woff2) format("woff2"); }
#used { font-family: "Used Font", monospace; }`,
        "serve.js": `const http = require("http"), fs = require("fs"), path = require("path"), zlib = require("zlib");
const types = { ".html": "text/html", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".pdf": "application/pdf", ".mp4": "video/mp4", ".js": "text/javascript", ".ico": "image/x-icon" };
const seen = {};  // what fetched the picture and the clip said: its user agent, its cookies
const handle = function handle(req, res) {
  // ?slow: each answer a second and a half late (a player loading, seen).
  if (/[?&]slow$/.test(req.url)) {
    req.url = req.url.replace(/[?&]slow$/, "");
    return setTimeout(() => handle(req, res), 1500);
  }
  const name = req.url.split("?")[0];
  if (req.url === "/pic.png?cache") seen.cached = (seen.cached || 0) + 1;  // Clear cache's
  if (req.url.startsWith("/pic.png?ad")) seen.ads = (seen.ads || 0) + 1;  // ad blocking's
  if (name.startsWith("/ads/") || name.startsWith("/banner/")) seen[name] = (seen[name] || 0) + 1;  // and by address
  if (name === "/ads/ok.js" || name === "/ads/track.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(name === "/ads/ok.js" ? 'document.getElementById("ok").textContent = "ran";' : 'document.getElementById("tracked").textContent = "ran";');
  }
  if (name === "/nocontent") { res.writeHead(204); return res.end(); }  // (a link that loads no page)
  if (name === "/cached.js") {
    // A script kept a while (the engines' shared cache), its fetches counted.
    seen.cachedjs = (seen.cachedjs || 0) + 1;
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" });
    return res.end('document.title = "Cached ran";');
  }
  if (name.startsWith("/banner/")) {
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(fs.readFileSync("/srv/pic.png"));
  }
  if (name === "/filters.txt") {
    // A filter list blocking the host asked for (?host=).
    // And elements hidden: .ad and .late-ad anywhere, .native on the page's site (?page=).
    const fq = new URLSearchParams(req.url.split("?")[1] || "");
    const host = fq.get("host") || "", page = fq.get("page") || "";
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("[Adblock Plus 2.0]\\n! Title: TabTop check list\\n! Expires: 1 days\\n||" + host + "^\\n##.ad\\n##.late-ad\\n/ads/*$script\\n@@/ads/ok.js\\n/banner/*$image\\n" + (page ? page + "##.native\\n" : ""));
  }
  if (name === "/auto-from") {
    // The autoplay page, its video from another site (?from=: its address).
    const from = (new URLSearchParams(req.url.split("?")[1] || "").get("from") || "").replace(/[^\\w.:/-]/g, "");
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync("/srv/auto.html", "utf8").replace('src="clip.mp4?auto"', 'src="' + from + 'clip.mp4?auto"'));
  }
  if (name === "/ads") {
    // A page with another site's picture (?ad=, its address), and its own.
    const q = new URLSearchParams(req.url.split("?")[1] || "");
    const ad = (q.get("ad") || "").replace(/[^\\w.:/-]/g, ""), v = (q.get("v") || "").replace(/\\W/g, "");
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end('<!doctype html><title>Ads</title><img id="own" src="pic.png?own" width="4" height="4" alt="own"><img id="ad" src="' + ad + 'pic.png?ad' + (v ? "&v=" + v : "") + '" width="4" height="4" alt="ad">' +
      '<p id="content">The page</p><div class="ad" id="banner">An ad</div><div class="native">A native ad</div>' +
      '<p id="ok">not run</p><p id="tracked">not run</p><img id="pathad" src="banner/ad.png?' + v + '" width="4" height="4" alt="by address">' +
      '<script src="ads/ok.js"></script><script src="ads/track.js"></script>' +
      '<script>setTimeout(() => { const d = document.createElement("div"); d.className = "late-ad"; d.id = "late"; d.textContent = "A late ad"; document.body.append(d); }, 800);</script>');
  }
  // (The clip played is asked for in ranges; saved, whole: kept apart, the saves listed.)
  const said = { ua: req.headers["user-agent"] || "", cookie: req.headers.cookie || "", referer: req.headers.referer || "" };
  if (name === "/clip.mp4" && !req.headers.range) (seen.saved ??= []).push(said);
  else if (name === "/clip.mp4" || name === "/pic.png") seen[name] = said;
  if (name === "/pending.m4s") { res.writeHead(200); res.write("pending"); return; }
  if (name === "/norange.mp4") {
    // A server without byte ranges: the whole file, whatever's asked.
    seen.norange = (seen.norange || 0) + 1;
    const data = fs.readFileSync("/srv/clip.mp4");
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": data.length });
    return res.end(data);
  }
  if (/\.(eot|svg|woff2?|ttf)$/.test(name)) (seen.fonts ??= []).push(req.url);  // the fonts asked for
  if (name === "/seen") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end("<!doctype html><title>Seen</title><pre id=s>" + JSON.stringify(seen).replace(/[<&]/g, "") + "</pre>");
  }
  if (name === "/ua") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end("<!doctype html><title>UA</title><p id=ua>" + (req.headers["user-agent"] || "").replace(/[<&]/g, "") + "</p><p id=m>" + (req.headers["sec-ch-ua-mobile"] || "none") + "</p><img src=pic.png?ua>");
  }
  if (req.url.startsWith("/storage")) {
    res.setHeader("Content-Type", "text/html");
    const write = req.url.includes("?set");
    return res.end('<!doctype html><title>Site storage</title><p id="storage"></p><script>' +
      (write ? 'localStorage.setItem("check", "saved");' : '') +
      'document.getElementById("storage").textContent = localStorage.getItem("check") ?? "empty";</script>');
  }
  if (req.url.startsWith("/sent")) {
    // What the browser sent of its cookies, in the title (a tab's, read
    // from the tabs' strip: no copy to find among several tabs').
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end("<!doctype html><title>Sent " + (req.headers.cookie || "nothing").replace(/[<&]/g, "") + "</title><p>sent</p>");
  }
  if (req.url.startsWith("/cookie")) {
    // What the browser sent of its cookies; ?set sets one (for an hour),
    // ?session one for the session (no expiry).
    const head = { "Content-Type": "text/html", "Cache-Control": "no-store" };
    if (req.url.includes("?set")) head["Set-Cookie"] = "kept=yes; Path=/; Max-Age=3600; HttpOnly";
    if (req.url.includes("?session")) head["Set-Cookie"] = "signin=s; Path=/; HttpOnly";
    res.writeHead(200, head);
    return res.end("<!doctype html><title>Cookie</title><p id=c>sent " + (req.headers.cookie || "nothing").replace(/[<&]/g, "") + "</p>");
  }
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Posted</title><p id=p>" + body.replace(/[<&]/g, "") + "</p>"); });
    return;
  }
  const file = path.join("/srv", path.normalize(decodeURIComponent(req.url.split("?")[0])));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    const type = types[path.extname(file)] || "application/octet-stream";
    // Byte ranges, as media is read in parts.
    const range = /^bytes=(\\d+)-(\\d*)$/.exec(req.headers.range || "");
    if (range) {
      const first = Number(range[1]), last = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
      if (first > last) { res.writeHead(416, { "Content-Range": "bytes */" + data.length }); return res.end(); }
      res.writeHead(206, { "Content-Type": type, "Content-Range": "bytes " + first + "-" + last + "/" + data.length, "Accept-Ranges": "bytes", "ETag": '"clip"' });
      return res.end(data.subarray(first, last + 1));
    }
    // Stylesheets in Brotli to who asks, as sites send them; the one
    // imported (more.css) in zstd.
    if (type === "text/css" && name === "/more.css" && /\\bzstd\\b/.test(req.headers["accept-encoding"] || "")) {
      seen.zstd = (seen.zstd || 0) + 1;
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "zstd", "Vary": "Accept-Encoding" });
      return res.end(zlib.zstdCompressSync(data));
    }
    if (type === "text/css" && /\\bbr\\b/.test(req.headers["accept-encoding"] || "")) {
      seen.brotli = (seen.brotli || 0) + 1;
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "br", "Vary": "Accept-Encoding" });
      return res.end(zlib.brotliCompressSync(data));
    }
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes" });
    res.end(data);
  });
};
http.createServer(handle).listen(80);
// The same over HTTPS, its certificate self-signed (go-check.sh makes it):
// a site whose certificate isn't trusted.
if (fs.existsSync("/srv/cert.pem")) require("https").createServer({ key: fs.readFileSync("/srv/key.pem"), cert: fs.readFileSync("/srv/cert.pem") }, handle).listen(443);`,
    };
    mkdirSync(join(dir, "embedded"), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, "pic.png"), png(4, 4, [200, 30, 30]));
    // A tone, 3 s, for a sound's player (audiopage.html).
    const rate = 8000, n = rate * 3, wav = Buffer.alloc(44 + n * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), 44 + i * 2);
    writeFileSync(join(dir, "tone.wav"), wav);
    // A short clip, for the players the page lays over the copy.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "5",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, "clip.mp4")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "3",
        "-c:v", "libx264", "-profile:v", "baseline", "-level:v", "1.2", "-pix_fmt", "yuv420p",
        "-movflags", "+empty_moov+frag_keyframe+default_base_moof", join(dir, "stream.mp4")]);
    const fragmented = readFileSync(join(dir, "stream.mp4"));
    let split = 0;
    while (split < fragmented.length && fragmented.toString("ascii", split + 4, split + 8) !== "moof") split += fragmented.readUInt32BE(split);
    writeFileSync(join(dir, "init.mp4"), fragmented.subarray(0, split));
    writeFileSync(join(dir, "part.m4s"), fragmented.subarray(split));
    writeFileSync(join(dir, "pic2.png"), png(8, 8, [30, 30, 200]));
    writeFileSync(join(dir, "favicon.ico"), png(16, 16, [30, 160, 60]));  // (a PNG, as many sites' are)
    writeFileSync(join(dir, "font.ttf"), systemFont());
}

// --- The check --------------------------------------------------------

let lastStep = -1;
async function totp() {
    while (30 - (Date.now() / 1000) % 30 < 3 || Math.floor(Date.now() / 30000) === lastStep) await sleep(500);
    lastStep = Math.floor(Date.now() / 30000);
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const h = createHmac("sha1", "12345678901234567890").update(c).digest();
    const o = h[19] & 15;
    return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function step(name, f) {
    const t = Date.now();
    try {
        const note = await f();
        console.log(`ok   ${name}${note ? ` (${note})` : ""} ${Date.now() - t} ms`);
    } catch (err) {
        console.log(`FAIL ${name}: ${err.message}`);
        throw err;
    }
}

async function check(base, port, site, adSite) {
    const browser = await createBrowserHarness({ port, base });
    const { cdp, ev, waitFor, open, inFrame, exceptions } = browser;
    const frame = (expr) => inFrame("go-frame.html", expr);
    // frameClick clicks the element in the frame that sel finds, at its place
    // on the screen: a click the page sees as a person's.
    // The page held in view while the next is built takes nothing (see
    // render in go-frame.js): a click is for the page shown.
    const pageShown = () => waitFor(`document.getElementById("go_view").getAttribute("aria-busy") !== "true"`, "the page shown", 30000);
    // A click right after a modal dialog closes can be routed by Chrome as
    // if the dialog's backdrop were still there (the frame is in a process
    // of its own, found by hit-test data that's updated a frame later): the
    // frame never gets it. Seen in CI, 2 of 5 runs, never by a person. So
    // every click waits for the next frames to be drawn.
    const dialogGone = () => ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))`);
    async function frameClick(sel) {
        await pageShown();
        await dialogGone();
        const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        }
    }
    async function frameWait(expr, what, ms = 15000) {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
            if (await frame(expr).catch(() => false)) return;
        }
        throw new Error(`timed out waiting for ${what}: ${await frame("document.body?.innerText.slice(0, 200)").catch((e) => e.message)}`);
    }
    const goTo = async (url, title) => {
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); })()`);
        try {
            await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, title, 30000);
        } catch (err) {
            // What the page shows instead, to say why.
            const shows = await ev(`JSON.stringify({ title: document.title, at: location.pathname, status: document.getElementById("go_status")?.textContent, notice: document.getElementById("go_notice")?.hidden ? "" : document.getElementById("go_notice")?.textContent, url: document.getElementById("go_url")?.dataset.url, reconnect: document.getElementById("tabtop_reconnect")?.textContent })`).catch((e) => e.message);
            throw new Error(`${err.message} (the page shows ${shows})`);
        }
        await pageShown();
    };
    const origin = new URL(base).origin;

    // Every request, from the page and its frames, in-process or not.
    const requests = [];
    // Through a connection of its own to the browser, attached to every
    // page and frame as they come.
    const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    let n = 0;
    const call = (method, params = {}, sessionId) => new Promise((resolve) => {
        const id = ++n;
        const done = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", done); resolve(m.result); } };
        ws.addEventListener("message", done);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (m.method === "Target.attachedToTarget") {
            call("Network.enable", {}, m.params.sessionId);
            call("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId);
        }
        if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    });
    await call("Target.setDiscoverTargets", { discover: true });
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "page" }, { type: "iframe" }] });

    await cdp("Page.enable");
    await cdp("Log.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    await step("log in on /go", async () => {
        // A tab on its own (go/tab), as the tabs' page has each (see the
        // tabs' step, below).
        await open("go/tab", `!!document.querySelector("#tabtop_login input")`, "the login form");
        const code = await totp();
        await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
        await waitFor(`!document.querySelector("#tabtop_login") && !!document.getElementById("go_url")`, "the browser page");
    });

    // With GO_VIDEO_URL, only this, after logging in: how a video from the
    // web loads and plays (GO_LINK="delay,rate" puts a far link between
    // this browser and the server: see the end of this file).
    const farVideo = () => step("a video from the web (GO_VIDEO_URL), timed", async () => {
        const t0 = Date.now();
        await goTo(site + "far.html", "Far");
        const tPage = Date.now() - t0;
        await waitFor(`!!document.querySelector("video")`, "the player", 60000);
        const tPlayer = Date.now() - t0;
        await waitFor(`document.querySelector("video").readyState >= 1`, "metadata", 60000);
        const tMeta = Date.now() - t0;
        await ev(`(() => { const v = document.querySelector("video"); v.muted = true; window.__w = 0; v.addEventListener("waiting", () => window.__w++); v.play(); })()`);
        await waitFor(`document.querySelector("video").currentTime > 0`, "playing", 60000);
        const tPlay = Date.now() - t0;
        await sleep(15000);
        const r = await ev(`(() => { const v = document.querySelector("video"); return { t: v.currentTime, stalls: window.__w, bytes: v.dataset.bytes, buf: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 }; })()`);
        return (`page ${tPage} player ${tPlayer} metadata ${tMeta} playing ${tPlay} ms; after 15 s: ${JSON.stringify(r)}`);
    });
    // With GO_PROBE (a module's path), only that, after logging in: its
    // default export, given the steps' helpers, to look into a site.
    if (process.env.GO_PROBE) {
        const probe = (await import(new URL(process.env.GO_PROBE, `file://${process.cwd()}/`).href)).default;
        await step("probe (GO_PROBE)", () => probe({ ev, frame, frameWait, frameClick, cdp, goTo, waitFor, sleep, writeFileSync, site, adSite, browser })).catch(() => { process.exitCode = 1; });
        ws.close();
        browser.close();
        process.exit();
    }
    if (process.env.GO_VIDEO_URL) {
        await farVideo().catch(() => { process.exitCode = 1; });
        ws.close();
        browser.close();
        process.exit();  // the link's connections, if any, needn't close
    }

    await step("the browser toolbar fits a mobile viewport", async () => {
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
            // The width at once; the height once the page has followed the
            // visual viewport's resize (an event of its own, a moment later).
            await waitFor(`document.getElementById("go_view").getBoundingClientRect().width === 390`, "mobile layout");
            await waitFor(`Math.abs(document.getElementById("go_view").getBoundingClientRect().bottom - visualViewport.height) <= 1`, "the page fitted to the screen's height", 5000).catch(() => {});
            const layout = await ev(`(() => {
                const input = document.getElementById("go_url"), bar = document.getElementById("go_bar");
                const view = document.getElementById("go_view").getBoundingClientRect();
                return { font: parseFloat(getComputedStyle(input).fontSize), radius: parseFloat(getComputedStyle(input).borderRadius),
                    targets: [...bar.querySelectorAll("button")].filter((b) => b.getClientRects().length).every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44),
                    // The bar of links in the menu, not above: this bar's at the top.
                    nav: !!document.querySelector("#go_menu_panel .tabtop-nav") && bar.getBoundingClientRect().top === 0,
                    // Forward stays in the history panel: room for the address.
                    forward: getComputedStyle(document.getElementById("go_forward")).display === "none",
                    top: view.top, barBottom: bar.getBoundingClientRect().bottom, bottom: view.bottom, height: visualViewport.height,
                    overflow: document.documentElement.scrollWidth > innerWidth };
            })()`);
            if (layout.font < 16 || layout.radius > 6 || !layout.targets || !layout.nav || !layout.forward || layout.overflow || layout.top !== layout.barBottom || Math.abs(layout.bottom - layout.height) > 1) {
                throw new Error(JSON.stringify(layout));
            }
            // A notch and a home bar (where this Chrome can say so): the bar
            // below the one, the page above the other.
            const insets = await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34, left: 0, right: 0 } }).then(() => true, () => false);
            if (insets) {
                try {
                    await waitFor(`parseFloat(getComputedStyle(document.getElementById("go_bar")).paddingTop) === 47`, "the bar below the notch", 5000);
                    const clear = await ev(`(() => {
                        const bar = document.getElementById("go_bar").getBoundingClientRect(), view = document.getElementById("go_view").getBoundingClientRect();
                        const input = document.getElementById("go_url").getBoundingClientRect();
                        return { input: input.top >= 47, view: view.top === bar.bottom && Math.abs(view.bottom - (document.body.getBoundingClientRect().bottom - 34)) <= 1,
                            pull: getComputedStyle(document.documentElement).overscrollBehaviorY === "none" };
                    })()`);
                    if (!clear.input || !clear.view || !clear.pull) throw new Error(`with a notch and home bar: ${JSON.stringify(clear)}`);
                } finally {
                    await cdp("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
                }
            }
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("load a page through the engine", async () => {
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "index.html")}; i.form.requestSubmit(); })()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the page's title", 30000);
        for (let i = 0; i < 100; i++) {
            if (await frame(`document.getElementById("p")?.textContent ?? ""`).catch(() => "") === "scripted") break;
            await sleep(100);
        }
        const text = await frame(`document.getElementById("p")?.textContent`);
        if (text !== "scripted") {
            const why = { status: await ev(`document.getElementById("go_status").textContent`),
                notice: await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`),
                frame: await frame(`document.documentElement.outerHTML.slice(0, 400)`).catch((e) => e.message) };
            throw new Error(`the page reads ${JSON.stringify(text)}, not what its script wrote: ${JSON.stringify(why)}`);
        }
        const ws = await frame(`document.getElementById("ws").textContent`);
        if (ws !== "portable binary\ncode") throw new Error(`whitespace between elements was lost: ${JSON.stringify(ws)}`);
        return await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`);
    });

    await step("stylesheets, imports, fonts and pictures through the server", async () => {
        await frame(`document.fonts.ready`);
        // A face's font comes once its text is shown (go-frame.js's fonts).
        await frameWait(`[...document.fonts].some((f) => f.family.replace(/"/g, "") === "Fixture Font" && f.status === "loaded")`, "the page's font");
        for (let i = 0; i < 50; i++) {
            if (await frame(`document.getElementById("img").naturalWidth > 0`)) break;
            await sleep(100);
        }
        const got = await frame(`(() => {
            const p = document.getElementById("p"), img = document.getElementById("img");
            return {
                color: getComputedStyle(p).color,
                background: getComputedStyle(document.body).backgroundColor,
                font: document.fonts.check('16px "Fixture Font"'),
                fontLoaded: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Fixture Font" && f.status === "loaded"),
                img: img.naturalWidth, imgSrc: img.src.slice(0, 5),
                bg: getComputedStyle(document.getElementById("bg")).backgroundImage.slice(0, 9),
                gradient: getComputedStyle(document.getElementById("rect")).fill,
                varBg: getComputedStyle(document.getElementById("varbg")).backgroundImage.slice(0, 9),
            };
        })()`);
        const want = { color: "rgb(0, 128, 128)", background: "rgb(250, 250, 240)", fontLoaded: true, imgSrc: "blob:", bg: 'url("blob', varBg: 'url("blob' };
        for (const [k, v] of Object.entries(want)) {
            if (got[k] !== v) throw new Error(`${k}: ${JSON.stringify(got[k])}, want ${JSON.stringify(v)} (${JSON.stringify(got)})`);
        }
        if (!(got.img > 0)) throw new Error(`the picture didn't load: ${JSON.stringify(got)}`);
        if (!got.gradient.includes("#g")) throw new Error(`the SVG's own url(#g) was lost: ${got.gradient}`);
        return `picture ${got.img}px wide`;
    });

    await step("what runs or loads is left out", async () => {
        const left = await frame(`({
            scripts: document.querySelectorAll("script").length,
            frames: document.querySelectorAll("iframe, object, embed").length,
            handlers: [...document.querySelectorAll("*")].filter((e) => [...e.attributes].some((a) => a.name.startsWith("on"))).length,
            linkHref: document.getElementById("next").getAttribute("href"),
            formAction: document.getElementById("form").getAttribute("action"),
            origin: self.origin,
        })`);
        const want = { scripts: 0, frames: 0, handlers: 0, linkHref: "#", formAction: null, origin: "null" };
        for (const [k, v] of Object.entries(want)) {
            if (left[k] !== v) throw new Error(`${k}: ${JSON.stringify(left[k])}, want ${JSON.stringify(v)}`);
        }
    });

    await step("iframe snapshots update and use the embedded page's base URL", async () => {
        await frameWait(`document.getElementById("embedded")?.shadowRoot?.getElementById("embedded-text")?.textContent === "updated content"`, "embedded page update");
        await frameWait(`document.getElementById("embedded")?.shadowRoot?.querySelector("img")?.naturalWidth > 0`, "embedded image");
        const valid = await frame(`(() => {
            const root = document.getElementById("embedded").shadowRoot;
            const paragraph = root.getElementById("embedded-text");
            // (Not inert: presses in it go to its page, in the engine.)
            return root.querySelector("script, iframe, [onclick]") === null && getComputedStyle(paragraph).color === "rgb(0, 128, 128)";
        })()`);
        if (!valid) throw new Error("embedded snapshot was not sanitized and styled");
    });

    await step("the frame can't reach the page, the site or the web", async () => {
        const got = await frame(`(async () => {
            const out = {};
            try { out.parent = !!parent.document; } catch { out.parent = false; }
            try { out.storage = !!localStorage; } catch { out.storage = false; }
            try { await fetch("https://example.com/"); out.fetch = true; } catch { out.fetch = false; }
            try { await fetch(${JSON.stringify(base)} + "go/"); out.site = true; } catch { out.site = false; }
            out.image = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(true); i.onerror = () => resolve(false); i.src = ${JSON.stringify(site + "pic.png")}; });
            return out;
        })()`);
        for (const [k, v] of Object.entries(got)) if (v !== false) throw new Error(`the frame reached ${k}`);
    });

    await step("the frame can't navigate itself to the web", async () => {
        const before = requests.length;
        // A raw link, as a sanitizer bypass would leave, and a script's own
        // navigation: the page's frame-src stops both.
        await frame(`(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(site + "second.html")}; document.body.append(a); a.click(); })()`);
        await sleep(1000);
        await frame(`location.href = ${JSON.stringify(site + "second.html")}`).catch(() => {});
        await sleep(1000);
        const leaked = requests.slice(before).filter((u) => u.startsWith(site));
        if (leaked.length) throw new Error(`the frame requested ${leaked.join(", ")}`);
        // Blocked, the frame shows the browser's own error page; the page
        // puts its document back, and the page shown again.
        for (let i = 0; i < 50; i++) {
            if (await frame(`document.getElementById("p")?.textContent`).catch(() => "") === "scripted") return "the frame was put back";
            await sleep(100);
        }
        throw new Error("the frame wasn't put back after being navigated away");
    });

    await step("a link loads the next page through the engine", async () => {
        await frameClick("#next");
        await waitFor(`document.title.startsWith("Second")`, "the second page", 30000);
        if (!(await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`)).endsWith("/second.html")) throw new Error("the address bar didn't follow");
    });

    await step("back and forward", async () => {
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the first page again", 30000);
        await ev(`document.getElementById("go_forward").click()`);
        await waitFor(`document.title.startsWith("Second")`, "the second page again", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the first page", 30000);
    });

    await step("a link within the page scrolls, without a load", async () => {
        await pageShown();
        for (let i = 0; i < 50 && !(await frame(`!!document.getElementById("jump")`).catch(() => false)); i++) await sleep(100);
        await frameClick("#jump");
        await waitFor(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value).endsWith("#end")`, "the address with #end");
        const y = await frame(`scrollY`);
        if (!(y > 1000)) throw new Error(`scrolled to ${y}`);
    });

    await step("the address shows its site till edited, the menu has the other pages, and the device's back goes back a page", async () => {
        await goTo(site + "second.html", "Second");
        const siteShown = (new URL(site).protocol === "https:" ? "" : "http://") + new URL(site).host.replace(/^www\./, "");
        const bar = await ev(`(() => { const a = document.getElementById("go_url"); return { value: a.value, url: a.dataset.url }; })()`);
        if (bar.value !== siteShown || !bar.url.endsWith("/second.html")) throw new Error(`the bar shows ${JSON.stringify(bar)}`);
        // The site's button at its start: its controls, not https said (the test site's http), out of the way while it's edited.
        const siteHost = new URL(site).hostname;
        await waitFor(`(() => { const b = document.getElementById("go_site"); return !b.hidden && b.classList.contains("insecure") && b.title.startsWith(${JSON.stringify("Site controls for " + siteHost + "; not secure")}) && b.getBoundingClientRect().right <= document.getElementById("go_url").getBoundingClientRect().left + parseFloat(getComputedStyle(document.getElementById("go_url")).paddingLeft); })()`, "the site's button, at the address's start, before its text");
        await ev(`document.getElementById("go_url").focus()`);
        if (!(await ev(`document.getElementById("go_url").value`)).endsWith("/second.html")) throw new Error("the whole address isn't there to edit");
        if (!(await ev(`document.getElementById("go_site").hidden`))) throw new Error("the site's button while the address is edited");
        await ev(`document.getElementById("go_url").blur()`);
        await waitFor(`document.getElementById("go_url").value === ${JSON.stringify(siteShown)} && !document.getElementById("go_site").hidden`, "the site again, not edited");
        // The menu: display modes, then the pages and logging out.
        await ev(`document.getElementById("go_menu").click()`);
        const items = await ev(`[...document.querySelectorAll("#go_menu_panel .label")].filter((l) => l.getClientRects().length).map((l) => l.textContent).join()`);
        // (The other pages are those the server has: Files, Terminal...)
        if (items !== "Settings") throw new Error(`the menu has ${items}`);
        // Its first row: what's done most, each a glyph over its name (Forward's in the bar here, not a phone's).
        const actions = await ev(`[...document.querySelectorAll("#go_menu_actions button")].filter((b) => b.getClientRects().length).map((button) => ({ name: button.textContent, top: button.getBoundingClientRect().top, glyph: !!button.querySelector("svg"), under: button.querySelector("svg")?.getBoundingClientRect().bottom <= button.querySelector(".caption").getBoundingClientRect().top }))`);
        if (actions.map((action) => action.name).join() !== "Desktop,Full screen,Hide browser" ||
            actions.some((action) => !action.glyph || !action.under) || new Set(actions.map((action) => action.top)).size !== 1) throw new Error(`the menu's first row: ${JSON.stringify(actions)}`);
        if (await ev(`document.getElementById("go_menu_actions").compareDocumentPosition(document.getElementById("go_menu_settings")) & Node.DOCUMENT_POSITION_PRECEDING`)) throw new Error("Settings above the first row");
        // The other pages and logging out: one row, icons only (named for a
        // screen reader), logging out last.
        const pages = await ev(`[...document.querySelectorAll("#go_menu_panel .tabtop-nav > .page, #go_menu_panel .tabtop-nav > button")].filter((p) => p.getClientRects().length).map((p) => ({ top: Math.round(p.getBoundingClientRect().top), name: p.getAttribute("aria-label") }))`);
        const hasFiles = pages.some((p) => p.name?.startsWith("Files ("));
        if (hasFiles !== (process.env.GO_NO_FS !== "1") || new Set(pages.map((p) => p.top)).size !== 1 || pages.some((p) => !p.name || /Browser/.test(p.name)) || !/^Log out/.test(pages.at(-1).name)) throw new Error(`the pages: ${JSON.stringify(pages)}`);
        // Set apart: the browser's items, then the other pages, then logging out.
        const parts = await ev(`(() => { const nav = document.querySelector("#go_menu_panel .tabtop-nav"), sep = nav.querySelector(".sep");
            return { navLine: getComputedStyle(nav).borderTopWidth, sep: sep ? Math.round(sep.getBoundingClientRect().height) : 0, before: sep?.nextElementSibling?.textContent, after: sep?.previousElementSibling?.textContent }; })()`);
        if (parts.navLine !== "1px" || !(parts.sep > 10) || parts.before !== "Log out" || !parts.after) throw new Error(`the menu's parts: ${JSON.stringify(parts)}`);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`document.getElementById("go_menu_panel").hidden`, "the menu closed");
        // The device's back (the tab's history: a swipe, a button): a page
        // back here, still on this page.
        const here = await ev(`location.href`);
        await ev(`history.back()`);
        await waitFor(`document.title.startsWith("Second") === false && !document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "the page before", 30000);
        if ((await ev(`location.href`)) !== here) throw new Error("left the browser page");
        await ev(`history.forward()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "forward again", 30000);
    });

    await step("Site controls and Settings open in a lightbox over the page, and close back to it", async () => {
        const here = await ev(`document.getElementById("go_url").dataset.url`);
        const inside = (expr) => ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !!d && (${expr}); })()`);
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "the lightbox open");
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !!d?.getElementById("popups") && !!d.getElementById("cookies") && d.documentElement.classList.contains("framed") && getComputedStyle(d.querySelector("header")).display === "none"; })()`, "the settings in it, its own header not shown", 15000);
        const host = new URL(here).hostname;
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("site_settings").hidden && d.getElementById("site_heading").textContent === ${JSON.stringify(host)} && d.getElementById("popups").value === "default" && d.getElementById("popups").selectedOptions[0].textContent === "Default (Ask)"; })()`, "the current site and its default permission");
        await inside(`(d.getElementById("show_all").click(), true)`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("all_sites").hidden && d.activeElement === d.getElementById("filter"); })()`, "All sites opens with search focused");
        await inside(`(d.getElementById("show_browser").click(), true)`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; return !d.getElementById("browser_settings").hidden && d.getElementById("site_settings").hidden && d.getElementById("default_popups").value === "ask" && !!d.getElementById("clear_cache"); })()`, "browser-wide settings in their own view");
        if ((await ev(`document.getElementById("go_settings_h").textContent`)) !== "Site controls") throw new Error("the lightbox isn't titled Site controls");
        if (await inside(`!!d.getElementById("adblock_on")`)) throw new Error("ad blocking is in Site controls");
        // The page's own close (its header's link) closes it; so do ✕ and Esc.
        await inside(`(d.getElementById("back").click(), true)`);
        await waitFor(`!document.getElementById("go_settings").open`, "closed by the page's link");
        // Settings from the menu: its own page, ad blocking in it.
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return d?.getElementById("adblock_on")?.disabled === false && d.querySelectorAll("#ad_lists li").length >= 2 && !d.getElementById("site_settings") && !d.getElementById("default_popups") && d.documentElement.classList.contains("framed"); })()`, "Settings from the menu", 15000).catch(async (err) => {
            const shows = await ev(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return JSON.stringify({ at: d?.location.pathname, done: d?.getElementById("done")?.textContent, on: d?.getElementById("adblock_on")?.disabled, lists: d?.querySelectorAll("#ad_lists li").length }); })()`);
            throw new Error(`${err.message} (it shows ${shows})`);
        });
        if ((await ev(`document.getElementById("go_settings_h").textContent`)) !== "Settings") throw new Error("the lightbox isn't titled Settings");
        // DNS over HTTPS: off at first; a custom server's address that isn't
        // https refused, said; off again.
        {
            const d = `document.querySelector("#go_settings iframe").contentDocument`;
            if ((await ev(`${d}.getElementById("doh").value`)) !== "off") throw new Error("DNS over HTTPS isn't off at first");
            await ev(`(() => { const s = ${d}.getElementById("doh"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`!${d}.getElementById("doh_custom").hidden`, "the custom server's address asked for");
            await ev(`(() => { const i = ${d}.getElementById("doh_url"); i.value = "http://dns.example/dns-query"; i.dispatchEvent(new Event("input")); ${d}.getElementById("doh_save").click(); })()`);
            await waitFor(`/https address/.test(${d}.getElementById("done").textContent)`, "a non-https DoH server refused, said", 15000);
            await ev(`(() => { const s = ${d}.getElementById("doh"); s.value = "off"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`${d}.getElementById("done").textContent === "DNS over HTTPS is off." && ${d}.getElementById("doh_custom").hidden`, "DNS over HTTPS off again", 15000);
            // Local DNS records: a name that isn't one refused, said; one
            // for the fixture's site added, listed (an A record).
            const add = (name, addr) => ev(`(() => { const d = ${d}; d.getElementById("host_name").value = ${JSON.stringify(name)}; d.getElementById("host_addr").value = ${JSON.stringify(addr)}; d.getElementById("host_addr").dispatchEvent(new Event("input")); d.getElementById("host_add_button").click(); })()`);
            await add("not a name", "192.0.2.1");
            await waitFor(`(() => { const e = ${d}.getElementById("host_name_error"); return !e.hidden && /Letters, digits/.test(e.textContent) && ${d}.getElementById("host_name").getAttribute("aria-invalid") === "true" && !${d}.querySelector("#host_list li"); })()`, "a record's bad name refused, said by the field", 15000);
            await add("fixture.home.arpa", new URL(site).hostname);
            await waitFor(`(() => { const li = ${d}.querySelector("#host_list li"); return ${d}.getElementById("done").textContent === "Record added." && li?.querySelector(".name").textContent === "fixture.home.arpa" && li.querySelector(".kind").textContent === "A" && !${d}.getElementById("host_name").value; })()`, "the record listed", 15000);
        }
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, "Settings closed by ✕");
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "open again");
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, "closed by ✕");
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`document.getElementById("go_settings").open`, "open once more");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await waitFor(`!document.getElementById("go_settings").open`, "closed by Esc");
        if ((await ev(`document.getElementById("go_url").dataset.url`)) !== here) throw new Error("the page changed under it");
        // The browser's history as it was: the device's back still a page
        // of the tab's (the lightbox's frames weren't entries of it).
        // (Removed as the dialog's close event comes, just after it's shut.)
        await waitFor(`!document.querySelector("#go_settings iframe")`, "its frame gone", 2000);
    });

    await step("Settings: records by name, edited in place, hosts lines pasted; unsaved filters asked of; settings exported and imported", async () => {
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        const w = `document.querySelector("#go_settings iframe").contentWindow`;
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`${d}?.getElementById("host_name")?.disabled === false && ${d}.getElementById("settings_export").disabled === false`, "Settings", 15000);
        const done = (text, what) => waitFor(`${d}.getElementById("done").textContent === ${JSON.stringify(text)}`, what, 15000);
        const add = async (name, addr) => {
            await ev(`(() => { const d = ${d}; d.getElementById("host_name").value = ${JSON.stringify(name)}; d.getElementById("host_addr").value = ${JSON.stringify(addr)}; d.getElementById("host_addr").dispatchEvent(new Event("input")); d.getElementById("host_add").requestSubmit(); })()`);
            await waitFor(`${d}.getElementById("done").textContent === "Record added." && !${d}.getElementById("host_name").value && ${d}.getElementById("host_list").textContent.includes(${JSON.stringify(addr)})`, "added " + addr, 15000);
        };
        // Exported first, to put back at the end.
        await ev(`(() => { const w = ${w}; w.__blob = null; w.URL.createObjectURL = (b) => (w.__blob = b, "blob:none"); w.HTMLAnchorElement.prototype.click = function () { w.__saved = this.download; }; w.document.getElementById("settings_export").click(); })()`);
        await waitFor(`!!${w}.__blob && ${w}.__saved === "tabtop-browser-settings.json"`, "the settings exported");
        const before = await ev(`${w}.__blob.text()`);
        const was = JSON.parse(before);
        if (was.tabtop !== "go-settings" || !Array.isArray(was.hosts) || !was.hosts.some((h) => h.name === "fixture.home.arpa") || !was.adblock?.lists?.length) throw new Error(`the export: ${before}`);
        // One name's two addresses, one entry; the A record edited in place.
        await add("nas.home.arpa", "192.168.1.10");
        await add("nas.home.arpa", "fd00::10");
        const nas = `[...${d}.querySelectorAll("#host_list li")].find((li) => li.querySelector(".name").textContent === "nas.home.arpa")`;
        if ((await ev(`${nas}.querySelectorAll(".addr-row").length`)) !== 2) throw new Error("the name's addresses aren't together");
        await ev(`${d}.querySelector('#host_list button[aria-label="Edit nas.home.arpa 192.168.1.10"]').click()`);
        await waitFor(`${d}.getElementById("host_add_button").textContent === "Save record" && ${d}.getElementById("host_addr").value === "192.168.1.10"`, "the record in the form to edit");
        await ev(`(() => { const a = ${d}.getElementById("host_addr"); a.value = "192.168.1.11"; a.dispatchEvent(new Event("input")); ${d}.getElementById("host_add").requestSubmit(); })()`);
        await done("Record saved.", "the record saved");
        if ((await ev(`[...${nas}.querySelectorAll(".addr")].map((a) => a.textContent).join()`)) !== "192.168.1.11,fd00::10") throw new Error("not edited in place");
        // Hosts lines pasted: each name a record; what can't be, said.
        await ev(`${d}.getElementById("hosts_paste").click()`);
        await ev(`(() => { const t = ${d}.getElementById("hosts_text"); t.value = "10.0.0.5 tv.home.arpa tv\\nbad line here\\n10.0.0.6"; t.dispatchEvent(new Event("input")); })()`);
        await waitFor(`${d}.getElementById("hosts_dialog_add").textContent === "Add 2 records" && ${d}.querySelectorAll("#hosts_text_problems li").length === 2`, "the lines read");
        await ev(`${d}.getElementById("hosts_paste_form").requestSubmit()`);
        await done("2 records added.", "the pasted records added");
        // My filters edited, not saved: marked, and asked of before closing.
        await ev(`(() => { const t = ${d}.getElementById("my_filters"); t.value += "\\n||unsaved.example^"; t.dispatchEvent(new Event("input")); })()`);
        await waitFor(`!${d}.getElementById("filters_unsaved").hidden && !${d}.getElementById("discard_filters").hidden`, "marked unsaved");
        await ev(`window.__asked = 0; window.__confirm = window.confirm; window.confirm = () => (window.__asked++, false)`);
        await ev(`document.querySelector("#go_settings .close").click()`);
        await sleep(300);
        if (!(await ev(`document.getElementById("go_settings").open && window.__asked === 1`))) throw new Error("closed on unsaved filters without asking");
        await ev(`window.confirm = window.__confirm`);
        await ev(`${d}.getElementById("discard_filters").click()`);
        await waitFor(`${d}.getElementById("filters_unsaved").hidden && !${d}.getElementById("my_filters").value.includes("unsaved.example")`, "the changes discarded");
        // Imported: what it can be, what it can't said; then the export put back.
        const load = (text) => ev(`(() => { const w = ${w}; w.confirm = () => true; const dt = new w.DataTransfer(); dt.items.add(new w.File([${JSON.stringify(text)}], "settings.json", { type: "application/json" })); const i = w.document.getElementById("settings_file"); i.files = dt.files; i.dispatchEvent(new w.Event("change")); })()`);
        await load(JSON.stringify({ ...was, searchEngine: "bing", doh: "nosuch", hosts: [{ name: "imported.home.arpa", addr: "192.0.2.9" }] }));
        await waitFor(`/Not imported: DNS over HTTPS/.test(${d}.getElementById("done").textContent) && /search engine/.test(${d}.getElementById("done").textContent)`, "the import, said in part", 20000);
        if ((await ev(`${d}.getElementById("search_engine").value + " " + [...${d}.querySelectorAll("#host_list .name")].map((n) => n.textContent).join()`)) !== "bing imported.home.arpa") throw new Error("not imported");
        await load(before);
        await done("Settings imported.", "the export put back");
        if ((await ev(`${d}.getElementById("search_engine").value + " " + [...${d}.querySelectorAll("#host_list .name")].map((n) => n.textContent).join()`)) !== `${was.searchEngine} fixture.home.arpa`) throw new Error("the export not put back");
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, "Settings closed");
    });

    await step("back held lists the pages before, to go to one; forward's the pages after", async () => {
        // Held (a touch or the mouse): the list, the page just before first.
        await ev(`document.getElementById("go_back").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "touch" }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list, back held", 3000);
        const pages = await ev(`[...document.querySelectorAll("#go_history button.item")].map((b) => b.title)`);
        if (pages.length < 2 || pages.some((u) => u.endsWith("/second.html"))) throw new Error(`back lists ${JSON.stringify(pages)}`);
        await ev(`document.getElementById("go_back").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "touch" }))`);
        // The first page, more than one back.
        const first = pages[pages.length - 1];
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_history").hidden && document.getElementById("go_url").dataset.url === ${JSON.stringify(first)}`, "the first page", 30000);
        // Forward's list (its context menu: a right click), and the last.
        await ev(`document.getElementById("go_forward").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list, forward", 3000);
        const ahead = await ev(`[...document.querySelectorAll("#go_history button.item")].map((b) => b.title)`);
        if (ahead.length !== pages.length || !ahead.at(-1).endsWith("/second.html")) throw new Error(`forward lists ${JSON.stringify(ahead)}`);
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "the last page again", 30000);
        // And the device's back still a page at a time from there.
        await ev(`history.back()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(pages[0])}`, "a page back", 30000);
        await ev(`history.forward()`);
        await waitFor(`document.getElementById("go_url").dataset.url.endsWith("/second.html")`, "forward again", 30000);
        // At the first page, Back opens the panel with Back disabled and
        // Forward available.
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden`, "the list again");
        const oldest = await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).title`);
        await ev(`[...document.querySelectorAll("#go_history button.item")].at(-1).click()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(oldest)}`, "the first page again", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .back:disabled") && !!document.querySelector("#go_history .foot .forward:not(:disabled)") && !!document.querySelector("#go_history .foot .clear:not(:disabled)")`, "Back, Forward, and Clear in the history panel");
        await ev(`document.querySelector("#go_history .foot .forward").click()`);
        await waitFor(`document.getElementById("go_url").dataset.url !== ${JSON.stringify(oldest)}`, "a page on, by its Forward", 30000);
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .back:not(:disabled)")`, "Back is available from a later page");
        await ev(`document.querySelector("#go_history .foot .back").click()`);
        await waitFor(`document.getElementById("go_url").dataset.url === ${JSON.stringify(oldest)}`, "a page back, by its Back glyph", 30000);
        // Clear history: none back or forward, the page kept.
        await ev(`document.getElementById("go_back").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
        await waitFor(`!document.getElementById("go_history").hidden && !!document.querySelector("#go_history .foot .clear:not(:disabled)")`, "Clear history offered");
        const kept = await ev(`document.getElementById("go_url").dataset.url`);
        await ev(`document.querySelector("#go_history .foot .clear").click()`);
        await waitFor(`document.getElementById("go_back").disabled && document.getElementById("go_forward").disabled && document.getElementById("go_url").dataset.url === ${JSON.stringify(kept)}`, "no pages back or forward, the page kept");
    });

    await step("a site's cookies are kept for new tabs, listed at go/cookie, and deleted by site or by time", async () => {
        const sent = () => frame(`document.getElementById("c")?.textContent`);
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent kept=yes") throw new Error(`the site was sent ${await sent()}`);
        // A new tab (this page loaded again: its engine closed, a new one
        // started): given the cookie.
        const browserPage = async (path = "go/tab") => {
            // (The page left marked: what's waited for next is the new one's,
            // not the old one's as it goes.)
            await ev(`(() => { window.__leaving = true; sessionStorage.removeItem("tabtop-go-kept"); sessionStorage.removeItem("tabtop-go-history"); sessionStorage.removeItem("tabtop-go-resume"); location.href = ${JSON.stringify(new URL(path, base).href)}; })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete"`, "the page loaded anew", 30000);
        };
        const newTab = async () => {
            await browserPage();
            await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
            await sleep(1000);
        };
        await newTab();
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent kept=yes") throw new Error(`a new tab sent ${await sent()}`);
        // The site deleted while this tab is open: gone from it too.
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); return t.reply.forgotten; })`);
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent nothing") throw new Error(`after deleting the site, the open tab sent ${await sent()}`);
        // The page at go/cookie: the site listed, then what was set in the
        // last hour cleared there.
        await goTo(site + "cookie?set", "Cookie");
        await browserPage("go/cookie");
        await waitFor(`[...document.querySelectorAll("#sites li")].some((li) => li.querySelector(".site").textContent === ${JSON.stringify(host)} && /1 cookie/.test(li.textContent))`, "the site listed with its cookie", 20000);
        // Older than an hour: the cookie just set isn't, kept.
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "older:3600"; document.getElementById("clear").click();`);
        await waitFor(`document.getElementById("done").textContent === "Cleared browsing data older than 1 hour." && [...document.querySelectorAll("#sites li")].some((li) => li.querySelector(".site").textContent === ${JSON.stringify(host)} && /1 cookie/.test(li.textContent))`, "older than an hour cleared, the cookie just set kept");
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "3600"; document.getElementById("clear").click();`);
        await waitFor(`/Cleared/.test(document.getElementById("done").textContent) && !/cookie/.test(document.getElementById("sites").textContent)`, "the last hour's cleared");
        await newTab();
        await goTo(site + "cookie", "Cookie");
        if ((await sent()) !== "sent nothing") throw new Error(`after clearing the last hour, a new tab sent ${await sent()}`);

        // Engines without localStorage persistence do not show the usage counter.
        await browserPage("go/cookie");
        await waitFor(`document.querySelectorAll("#sites li").length > 0 || document.getElementById("empty")?.hidden === false`, "storage capability loaded", 20000);
        if (process.env.GO_IMAGE ? (process.env.GO_ENGINE || "moli") === "moli" : true) {
            await waitFor(`document.getElementById("storage_usage")?.hidden === false`, "localStorage use is reported");
            const storageShown = () => frame(`document.getElementById("storage")?.textContent`);
            const usageRow = `[...document.querySelectorAll("#sites li")].find(li => li.dataset.site === ${JSON.stringify(host)})`;
            await newTab();
            await goTo(site + "storage?set", "Site storage");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "saved") throw new Error("new tab did not restore localStorage before the inline script");
            await browserPage("go/cookie");
            await waitFor(`/10 B in 1 item/.test((${usageRow})?.textContent) && /10 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "saved storage usage listed");
            await ev(`(${usageRow}).querySelector("button").click()`);
            await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("clear_site").disabled`, "the site's data details");
            await ev(`document.getElementById("clear_site").click(); document.getElementById("clear").click();`);
            await waitFor(`/Cleared site data/.test(document.getElementById("done").textContent) && /0 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "Delete cleared saved storage");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "empty") throw new Error("deleted storage was restored");
            await goTo(site + "storage?set", "Site storage");
            await browserPage("go/cookie");
            await waitFor(`/10 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "site storage listed again");
            await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "3600"; document.getElementById("clear").click();`);
            await waitFor(`/Cleared/.test(document.getElementById("done").textContent) && /0 B of 50 MB/.test(document.getElementById("storage_usage").textContent)`, "last hour's saved storage cleared");
            await newTab();
            await goTo(site + "storage", "Site storage");
            if (await storageShown() !== "empty") throw new Error("cleared storage was restored");
        }
    });

    await step("a site's cookies and localStorage are listed in its Inspect, each deleted on its own, in the tabs too", async () => {
        const host = new URL(site).hostname;
        const browserPage = async (path) => {
            await ev(`(() => { window.__leaving = true; sessionStorage.removeItem("tabtop-go-kept"); sessionStorage.removeItem("tabtop-go-history"); sessionStorage.removeItem("tabtop-go-resume"); location.href = ${JSON.stringify(new URL(path, base).href)}; })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete"`, "the page loaded anew", 30000);
        };
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "storage?set", "Site storage");
        await sleep(500);
        // What it says: the cookie as set (HttpOnly too), and the item.
        const d = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-site-data", name: ${JSON.stringify(host)} }); t.close(); return t.reply; })`);
        if (!d.cookies.some((c) => c.name === "kept" && c.value === "yes" && c.httpOnly && c.path === "/")) throw new Error(`the cookies: ${JSON.stringify(d.cookies)}`);
        const storage = !!d.storage;  // (kept only with an engine whose storage is: Moli's)
        if (storage && !d.storage.some((o) => o.items.some((i) => i.key === "check" && i.value === "saved"))) throw new Error(`the storage: ${JSON.stringify(d.storage)}`);
        // Its page: Site controls, the site, Inspect.
        await browserPage(`go/sites?site=${encodeURIComponent(host)}`);
        await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("inspect_site").disabled`, "the site, Inspect offered", 20000);
        await ev(`document.getElementById("inspect_site").click()`);
        const named = (name) => `[...document.querySelectorAll("#inspect_list .entry")].find((e) => e.querySelector(".name").textContent === ${JSON.stringify(name)})`;
        await waitFor(`!!${named("kept")}`, "the cookie listed", 20000);
        await ev(`${named("kept")}.querySelector("summary").click()`);
        if (!(await ev(`/HttpOnly/.test(${named("kept")}.querySelector("dl").textContent) && ${named("kept")}.querySelector(".value").textContent === "yes"`))) throw new Error("the cookie's details not shown");
        await ev(`document.getElementById("inspect_filter").value = "nothing like it"; document.getElementById("inspect_filter").dispatchEvent(new Event("input"))`);
        if (await ev(`!!${named("kept")} || document.getElementById("inspect_empty").hidden`)) throw new Error("the filter kept what it doesn't find");
        await ev(`document.getElementById("inspect_filter").value = ""; document.getElementById("inspect_filter").dispatchEvent(new Event("input"))`);
        if (storage) {
            await ev(`document.getElementById("show_storage").click()`);
            await waitFor(`!!${named("check")}`, "the item listed");
            await ev(`window.confirm = () => true; ${named("check")}.querySelector("summary").click(); ${named("check")}.querySelector(".danger").click()`);
            await waitFor(`/Deleted the item check/.test(document.getElementById("done").textContent) && !${named("check")}`, "the item deleted");
            await ev(`document.getElementById("show_cookies").click()`);
        }
        await ev(`window.confirm = () => true; ${named("kept")}.querySelector(".danger").click()`);
        await waitFor(`/Deleted the cookie kept/.test(document.getElementById("done").textContent) && !${named("kept")}`, "the cookie deleted");
        // A tab anew: neither given back.
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
        await goTo(site + "cookie", "Cookie");
        if ((await frame(`document.getElementById("c")?.textContent`)) !== "sent nothing") throw new Error("the deleted cookie was sent");
        if (storage) {
            await goTo(site + "storage", "Site storage");
            if ((await frame(`document.getElementById("storage")?.textContent`)) !== "empty") throw new Error("the deleted item was restored");
        }
    });

    await step("Keep: a site kept keeps its cookies (its session's too) and storage through Clear browsing data, all time; Select's choices pass it by", async () => {
        const host = new URL(site).hostname;
        const moli = process.env.GO_IMAGE ? (process.env.GO_ENGINE || "moli") === "moli" : true;
        const browserPage = async (path) => {
            await ev(`(() => { window.__leaving = true; sessionStorage.removeItem("tabtop-go-kept"); sessionStorage.removeItem("tabtop-go-history"); sessionStorage.removeItem("tabtop-go-resume"); location.href = ${JSON.stringify(new URL(path, base).href)}; })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete"`, "the page loaded anew", 30000);
        };
        const sitePage = async () => {
            await browserPage(`go/sites?site=${encodeURIComponent(host)}`);
            await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("keep_site").disabled`, "the site's page", 20000);
        };
        await goTo(site + "cookie?set", "Cookie");
        await goTo(site + "cookie?session", "Cookie");
        if (moli) await goTo(site + "storage?set", "Site storage");
        await sleep(500);
        // Kept, from its page.
        await sitePage();
        if (await ev(`document.getElementById("keep_site").checked`)) throw new Error("kept before it was asked");
        await ev(`document.getElementById("keep_site").click()`);
        await waitFor(`/are kept/.test(document.getElementById("done").textContent) && document.getElementById("keep_site").checked && /leaves it/.test(document.getElementById("keep_note").textContent)`, "kept");
        // All sites: marked; Select ▸ All passes it by.
        await ev(`document.getElementById("show_all").click()`);
        const row = `document.querySelector('#sites li[data-site=${JSON.stringify(host)}]')`;
        await waitFor(`/Data kept/.test(${row}?.textContent ?? "")`, "marked kept in All sites", 20000);
        await ev(`document.getElementById("select_sites").click(); document.getElementById("select_pick").click(); [...document.querySelectorAll("#select_menu button")].find((b) => b.textContent === "All").click()`);
        if (await ev(`${row}.querySelector(".site-row").getAttribute("aria-pressed")`) !== "false") throw new Error("Select ▸ All picked the kept site");
        await ev(`document.getElementById("clear_selection").click()`);
        // Clear browsing data, all time: said to spare it, and does.
        await ev(`document.getElementById("show_browser").click(); document.getElementById("clear_browser").click(); document.getElementById("within").value = "0"`);
        const summary = await ev(`document.getElementById("clear_summary").textContent`);
        if (!summary.includes(`Kept sites aren't cleared: ${host}`)) throw new Error(`the dialog: ${summary}`);
        await ev(`document.getElementById("clear").click()`);
        await waitFor(`document.getElementById("done").textContent === "Cleared all browsing data."`, "all browsing data cleared");
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
        await goTo(site + "cookie", "Cookie");
        const sent = await frame(`document.getElementById("c")?.textContent`);
        if (!/kept=yes/.test(sent) || !/signin=s/.test(sent)) throw new Error(`a new tab, after all time cleared, sent ${sent}`);
        if (moli) {
            await goTo(site + "storage", "Site storage");
            if ((await frame(`document.getElementById("storage")?.textContent`)) !== "saved") throw new Error("the kept site's storage was cleared");
        }
        // Keep off, and its data cleared by name, for the steps after.
        await sitePage();
        await ev(`document.getElementById("keep_site").click()`);
        await waitFor(`/no longer kept/.test(document.getElementById("done").textContent) && !document.getElementById("keep_site").checked`, "kept no longer");
        await waitFor(`!document.getElementById("clear_site").disabled`, "Clear data offered");
        await ev(`document.getElementById("clear_site").click(); document.getElementById("clear").click()`);
        await waitFor(`/Cleared site data/.test(document.getElementById("done").textContent)`, "its data cleared");
        await browserPage("go/tab");
        await waitFor(`!!document.getElementById("go_url") && !!document.getElementById("go_menu") && document.getElementById("go_progress").hidden`, "the browser page again, connected");
        await sleep(1000);
    });

    await step("All sites: Select, any site selected (bordered), Clear data and Delete settings for those each applies to; a site typed opened from the list", async () => {
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-block" }); t.close(); })`);
        await ev(`(() => { window.__leaving = true; location.href = ${JSON.stringify(new URL("go/sites", base).href)}; })()`);
        await waitFor(`!window.__leaving && document.readyState === "complete"`, "Site controls", 30000);
        await ev(`document.getElementById("show_all").click()`);
        const row = (name) => `document.querySelector('#sites li[data-site=${JSON.stringify(name)}]')`;
        await waitFor(`!!${row(host)} && !!${row("rules-only.example")}`, "both sites listed", 20000);
        // No boxes: Select makes each row a toggle, its state a border.
        if (await ev(`!!document.querySelector("#sites input[type=checkbox]") || !document.getElementById("selection_bar").hidden`)) throw new Error("boxes, or the selection bar, before selecting");
        await ev(`document.getElementById("select_sites").click()`);
        if (!(await ev(`!document.getElementById("selection_bar").hidden && document.getElementById("sites").classList.contains("selecting") && ${row(host)}.querySelector(".site-row").getAttribute("aria-pressed") === "false"`))) throw new Error("Select didn't make the rows toggles");
        const bar = () => ev(`[document.getElementById("selection_count").textContent, document.getElementById("clear_selected").textContent, document.getElementById("clear_selected").disabled, document.getElementById("forget_selected").textContent, document.getElementById("forget_selected").disabled].join("|")`);
        // A site with data and one with only a setting: each action counts
        // those it's for.
        await ev(`${row(host)}.querySelector(".site-row").click()`);
        if ((await bar()) !== "1 selected|Clear data (1)…|false|Delete settings…|true") throw new Error(`a site with data selected: ${await bar()}`);
        await ev(`${row("rules-only.example")}.querySelector(".site-row").click()`);
        if ((await bar()) !== "2 selected|Clear data (1)…|false|Delete settings (1)…|false") throw new Error(`a settings-only site selected too: ${await bar()}`);
        if (!(await ev(`${row("rules-only.example")}.querySelector(".site-row").getAttribute("aria-pressed") === "true" && getComputedStyle(${row("rules-only.example")}.querySelector(".site-row")).boxShadow !== "none"`))) throw new Error("a selected row not bordered");
        // Delete settings, for those selected: the settings-only site gone.
        await ev(`window.confirm = () => true; document.getElementById("forget_selected").click()`);
        await waitFor(`/Deleted the saved settings for rules-only\\.example/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "the selected site's settings deleted");
        if ((await bar()) !== "1 selected|Clear data (1)…|false|Delete settings…|true") throw new Error(`after deleting settings: ${await bar()}`);
        // Select ▾: all, none, or by when active (the site's cookie was set
        // just now); Invert.
        const choose = async (label) => {
            await ev(`document.getElementById("select_pick").click()`);
            await waitFor(`document.getElementById("select_menu").matches(":popover-open") && document.activeElement?.parentElement?.id === "select_menu"`, "the Select menu open, its first choice focused");
            await ev(`[...document.querySelectorAll("#select_menu button")].find((b) => (b.getAttribute("aria-label") || b.textContent) === ${JSON.stringify(label)}).click()`);
            await waitFor(`!document.getElementById("select_menu").matches(":popover-open")`, "the menu closed");
        };
        const pressed = (name) => ev(`${row(name)}.querySelector(".site-row").getAttribute("aria-pressed")`);
        const listed = await ev(`document.querySelectorAll("#sites li").length`);
        await choose("None");
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== "Select sites") throw new Error("None left some selected");
        await choose("Active in the last hour");
        if ((await pressed(host)) !== "true") throw new Error("a site active just now not selected as active in the last hour");
        await choose("Not active for an hour");
        if ((await pressed(host)) !== "false") throw new Error("a site active just now selected as not active for an hour");
        await ev(`document.getElementById("select_invert").click()`);
        if ((await pressed(host)) !== "true") throw new Error("Invert didn't select what wasn't");
        await choose("All");
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== `${listed} selected`) throw new Error(`All: ${await ev(`document.getElementById("selection_count").textContent`)} of ${listed}`);
        await ev(`document.getElementById("select_invert").click()`);
        if ((await ev(`document.getElementById("selection_count").textContent`)) !== "Select sites") throw new Error("Invert of all left some selected");
        await ev(`${row(host)}.querySelector(".site-row").click()`);
        // Done (or Esc): rows open their sites again.
        await ev(`document.getElementById("clear_selection").click()`);
        if (!(await ev(`document.getElementById("selection_bar").hidden && !${row(host)}.querySelector(".site-row").hasAttribute("aria-pressed")`))) throw new Error("Done kept selecting");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-block" }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`!!${row("rules-only.example")}`, "the settings-only site listed again");
        // Its settings as chips, a count, and the filters.
        if (!(await ev(`/Pop-ups: blocked/.test(${row("rules-only.example")}.querySelector(".chips")?.textContent ?? "") && /^\\d+ sites?$/.test(document.getElementById("site_count").textContent)`))) throw new Error("no chips, or no count");
        await ev(`document.querySelector('.filters [data-filter="custom"]').click()`);
        if (!(await ev(`!!${row("rules-only.example")} && !${row(host)} && /^\\d+ of \\d+ sites$/.test(document.getElementById("site_count").textContent)`))) throw new Error("Custom permissions didn't filter to the sites with them");
        await ev(`document.querySelector('.filters [data-filter="all"]').click()`);
        // A host under a listed site: found as it.
        await ev(`(() => { const f = document.getElementById("filter"); f.value = "www.sub.rules-only.example"; f.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`/Includes sub\\.rules-only\\.example/.test(${row("rules-only.example")}?.textContent ?? "") && !document.querySelector("#sites .open-row")`))) throw new Error("a host under a listed site not found as it");
        await ev(`(() => { const f = document.getElementById("filter"); f.value = ""; f.dispatchEvent(new Event("input")); })()`);
        // ⋯: its quick actions; Reset permissions puts it back to the defaults.
        await ev(`${row("rules-only.example")}.querySelector(".row-more").click()`);
        const items = await ev(`[...document.querySelectorAll("#row_menu button")].map((b) => b.textContent)`);
        if (items.join() !== "Open site settings,Reset permissions,Delete settings…") throw new Error(`the row's menu: ${JSON.stringify(items)}`);
        await ev(`[...document.querySelectorAll("#row_menu button")].find((b) => b.textContent === "Reset permissions").click()`);
        await waitFor(`/back to the browser's defaults/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "its permissions reset, and it gone from the list");
        // Reset to defaults, in a site's own view.
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "videos-block" }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`!!${row("rules-only.example")}`, "listed again with its video setting");
        await ev(`${row("rules-only.example")}.querySelector(".site-row").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && !document.getElementById("reset_site").disabled && document.getElementById("videos").value === "block"`, "its controls, Reset offered");
        // Reset…: what'll change listed, then all of it at once.
        await ev(`document.getElementById("reset_site").click()`);
        await waitFor(`document.getElementById("confirm_reset").open && /Videos and sound: Block → Allow/.test(document.getElementById("reset_list").textContent)`, "what Reset will change, listed");
        await ev(`document.getElementById("reset_confirm").click()`);
        await waitFor(`document.getElementById("videos").value === "default" && document.getElementById("reset_site").disabled`, "reset to the defaults");
        await ev(`document.getElementById("show_all").click()`);
        // Delete settings, from a row's ⋯: its block and permissions gone, and
        // it, with no data, from the list.
        for (const setting of ["block", "popups-allow"]) await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: ${JSON.stringify(setting)} }); t.close(); })`);
        await ev(`document.dispatchEvent(new Event("visibilitychange"))`);
        await waitFor(`/Blocked/.test(${row("rules-only.example")}?.textContent ?? "")`, "blocked, with its pop-ups allowed");
        await ev(`${row("rules-only.example")}.querySelector(".row-more").click()`);
        await ev(`window.confirm = () => true; [...document.querySelectorAll("#row_menu button")].find((b) => b.textContent === "Delete settings…").click()`);
        await waitFor(`/Deleted the saved settings for rules-only\\.example/.test(document.getElementById("done").textContent) && !${row("rules-only.example")}`, "its settings deleted, and it gone");
        const left = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings" }); t.close(); return t.reply; })`);
        if (left.blocked?.includes("rules-only.example") || left.popups?.["rules-only.example"]) throw new Error(`still kept: ${JSON.stringify(left)}`);
        // A site typed that isn't listed: a row to open it; Enter does too.
        await ev(`(() => { const f = document.getElementById("filter"); f.value = "typed-site.example"; f.dispatchEvent(new Event("input")); })()`);
        if (!(await ev(`/Open settings for typed-site\.example/.test(document.querySelector("#sites .open-row")?.textContent ?? "") && !document.getElementById("open_site")`))) throw new Error("no row to open a site typed");
        await ev(`document.querySelector("#sites .open-row button").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && document.getElementById("site_heading").textContent === "typed-site.example"`, "the typed site's controls");
        if (!(await ev(`document.getElementById("reset_site").disabled`))) throw new Error("Reset offered with nothing changed");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: "rules-only.example", setting: "popups-default" }); t.close(); })`).catch(() => {});
        await ev(`(() => { window.__leaving = true; location.href = ${JSON.stringify(new URL("go/tab", base).href)}; })()`);
        await waitFor(`!window.__leaving && !!document.getElementById("go_url") && document.getElementById("go_progress").hidden`, "the browser again", 30000);
        await sleep(1000);
    });

    await step("Dark mode: pages told dark or light as their site's setting says, changed live from Site controls", async () => {
        const host = new URL(site).hostname;
        const setTheme = (setting) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(host)}, setting: ${JSON.stringify(setting)} }); t.close(); })`);
        const told = () => frame(`document.getElementById("s")?.textContent`);
        try {
            await goTo(site + "scheme.html", "Scheme");
            if ((await told()) !== "light") throw new Error(`following the device (light): told ${await told()}`);
            await setTheme("theme-dark");
            await goTo(site + "scheme.html", "Scheme");
            if ((await told()) !== "dark") throw new Error(`Dark: told ${await told()}`);
            // And the copy's styles go by it, this browser being light.
            await goTo(site + "schemecss.html", "Scheme CSS");
            if ((await frame(`getComputedStyle(document.getElementById("c")).color`)) !== "rgb(2, 2, 2)") throw new Error(`Dark: the copy's styles ${await frame(`getComputedStyle(document.getElementById("c")).color`)}, not the page's dark ones`);
            await goTo(site + "scheme.html", "Scheme");
            // Changed in Site controls (its lightbox), the page shown follows.
            await ev(`document.getElementById("go_site").click()`);
            await waitFor(`(() => { const d = document.querySelector("#go_settings iframe")?.contentDocument; return d?.getElementById("theme")?.value === "dark" && !d.getElementById("theme").disabled; })()`, "the site's Dark mode in Site controls", 15000);
            await ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument, s = d.getElementById("theme"); s.value = "light"; s.dispatchEvent(new Event("change")); })()`);
            await frameWait(`document.getElementById("s")?.textContent === "light"`, "the page told light", 15000);
            await ev(`(() => { const d = document.querySelector("#go_settings iframe").contentDocument; d.getElementById("back").click(); })()`);
            await waitFor(`!document.getElementById("go_settings").open`, "Site controls closed");
        } finally {
            await setTheme("theme-default").catch(() => {});
        }
    });

    await step("Current site: what applies shown in each control, a change marked with its default and ↺, Reload page offered, Not secure said, data counts opening the inspector", async () => {
        const host = new URL(site).hostname;
        await goTo(site + "cookie?set", "Cookie");
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await ev(`document.getElementById("go_site").click()`);
        try {
            await waitFor(`(${d})?.getElementById("site_heading")?.textContent === ${JSON.stringify(host)} && !(${d}).getElementById("popups").disabled`, "the site's controls", 15000);
            const head = await ev(`(${d}).getElementById("site_scope").textContent + "|" + (${d}).getElementById("site_icon").textContent`);
            if (!/Not secure/.test(head) || !/subdomains/.test(head)) throw new Error(`its header says ${head}`);
            // Its icon (its /favicon.ico) by its name, not its initial.
            await waitFor(`(${d}).querySelector("#site_icon img")?.naturalWidth > 0`, "the site's icon shown", 15000);
            if ((await ev(`(${d}).getElementById("popups").selectedOptions[0].textContent`)) !== "Default (Ask)") throw new Error("the default not shown as what applies");
            // Changed: marked, its default said, ↺; and, holding for what loads
            // next, Reload page by what's said.
            await ev(`(() => { const s = (${d}).getElementById("popups"); s.value = "allow"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`(() => { const doc = ${d}, row = doc.getElementById("popups").closest(".setting"); return row.classList.contains("changed") && !row.querySelector(".undo").hidden && /default: Ask/.test(doc.getElementById("popup_scope").textContent) && doc.getElementById("done").textContent === "Setting saved." && !doc.getElementById("done_action").hidden && doc.getElementById("done_action").textContent === "Reload page"; })()`, "the change marked, Reload page offered");
            await ev(`(${d}).querySelector('[data-reset="popups"]').click()`);
            await waitFor(`(() => { const doc = ${d}; return doc.getElementById("popups").value === "default" && !doc.getElementById("popups").closest(".setting").classList.contains("changed"); })()`, "↺ put it back");
            // Its data's counts: links to the inspector, at them.
            await ev(`(${d}).querySelector("#site_data button.link").click()`);
            await waitFor(`(() => { const doc = ${d}; return !doc.getElementById("site_inspect").hidden && doc.getElementById("show_cookies").getAttribute("aria-current") === "true"; })()`, "the inspector, at its cookies", 15000);
        } finally {
            await ev(`document.getElementById("go_settings").open && document.getElementById("go_settings").close()`).catch(() => {});
            await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(host)}, setting: "popups-default" }); t.close(); })`).catch(() => {});
        }
    });

    await step("a phone switches between mobile and Desktop headers, and a video's site is sent its cookies", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(1000);
            await goTo(site + "ua", "UA");
            const ua = await frame(`document.getElementById("ua").textContent`), mobile = await frame(`document.getElementById("m").textContent`);
            if (!/^Mozilla\/5\.0 \(Linux; Android 10; K\) .* Chrome\/\d+\.0\.0\.0 Mobile Safari\/537\.36$/.test(ua) || mobile !== "?1") throw new Error(`the site was told ${ua}, mobile ${mobile}`);
            await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_fullscreen").click();`);
            await waitFor(`getComputedStyle(document.getElementById("go_bar")).display === "none" && !document.getElementById("go_exit_fullscreen").hidden`, "full screen hides the toolbar");
            await ev(`document.getElementById("go_exit_fullscreen").click()`);
            await waitFor(`getComputedStyle(document.getElementById("go_bar")).display !== "none" && document.getElementById("go_menu_fullscreen").getAttribute("aria-pressed") === "false"`, "exiting full screen restores the toolbar");
            const toggleDesktop = () => ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_desktop").click();`);
            await toggleDesktop();
            await frameWait(`document.getElementById("m")?.textContent === "?0" && !/Android|Mobile/.test(document.getElementById("ua")?.textContent)`, "Desktop sends desktop headers on a phone");
            await toggleDesktop();
            await frameWait(`document.getElementById("m")?.textContent === "?1" && /Android/.test(document.getElementById("ua")?.textContent)`, "unchecking Desktop restores the mobile profile");
            // A cookie on the site, and its video played: fetched with it,
            // as the page's own browser would.
            await goTo(site + "cookie?set", "Cookie");
            await goTo(site + "video.html", "Video");
            await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1)`, "the clip's player", 30000);
            await goTo(site + "seen", "Seen");
            const seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
            for (const what of ["/pic.png", "/clip.mp4"]) {
                const s = seen[what];
                if (!s || /tabtop/i.test(s.ua) || !/Android 10; K/.test(s.ua)) throw new Error(`${what} was fetched as ${s?.ua}`);
            }
            if (!seen["/clip.mp4"] || !/(^|; )kept=yes(;|$)/.test(seen["/clip.mp4"].cookie)) throw new Error(`the clip was fetched with cookies ${JSON.stringify(seen["/clip.mp4"])}`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a font is fetched as a browser would: the one source it takes, for a face its text uses", async () => {
        await goTo(site + "fonts.html", "Fonts");
        // Shown in it: not as wide as in the fallback (monospace).
        await frameWait(`(() => { const p = document.getElementById("used"); if (!p) return false; const mono = Object.assign(document.createElement("span"), { textContent: p.textContent }); mono.style.fontFamily = "monospace"; const its = Object.assign(document.createElement("span"), { textContent: p.textContent }); its.style.font = getComputedStyle(p).font; document.body.append(mono, its); const differ = Math.abs(mono.getBoundingClientRect().width - its.getBoundingClientRect().width) > 2; mono.remove(); its.remove(); return differ; })()`, "the text in the font used");
        await sleep(1000);
        await goTo(site + "seen", "Seen");
        const fonts = JSON.parse(await frame(`document.getElementById("s").textContent`)).fonts ?? [];
        // (The stylesheets were sent in Brotli and zstd, and shown: the steps above.)
        const coded = JSON.parse(await frame(`document.getElementById("s").textContent`));
        if (!(coded.brotli > 0) || !(coded.zstd > 0)) throw new Error(`stylesheets weren't sent in Brotli and zstd: ${JSON.stringify(coded)}`);
        if (!fonts.includes("/font.ttf?used")) throw new Error(`the font used wasn't fetched: ${fonts}`);
        const extra = fonts.filter((f) => /eot|svg|fallback|unused/.test(f));
        if (extra.length) throw new Error(`fetched too: ${extra}`);
        const usedLoaded = `[...document.fonts].some((f) => f.family.replaceAll('"', "") === "Used Font" && f.status === "loaded")`;
        // The intermediate page drops the installed face, while the rewritten
        // stylesheet stays cached for the next document.
        await goTo(site + "fonts-next.html", "Shared fonts");
        await frameWait(usedLoaded, "font restored from the cached stylesheet");
        await goTo(site + "fonts.html", "Fonts");
        await frameWait(usedLoaded, "font still loaded after navigation to the first page");
    });

    await step("Clear cached files, in Site controls' Browser-wide settings: a picture is fetched from its site again, not before", async () => {
        const fetched = async () => { await goTo(site + "seen", "Seen"); return JSON.parse(await frame(`document.getElementById("s").textContent`)).cached || 0; };
        const shown = () => frameWait(`document.getElementById("pic")?.naturalWidth > 0`, "the picture");
        await goTo(site + "cache.html", "Cached");
        await shown();
        const first = await fetched();
        if (first < 1) throw new Error("the picture wasn't fetched");
        await goTo(site + "cache.html", "Cached");
        await shown();
        if ((await fetched()) !== first) throw new Error("fetched again, not cleared");
        await ev(`document.getElementById("go_menu").click()`);
        await ev(`document.getElementById("go_site").click()`);
        const settings = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await waitFor(`!!(${settings})?.getElementById("show_browser")`, "Site controls open");
        await ev(`(${settings}).getElementById("show_browser").click()`);
        await waitFor(`(${settings})?.getElementById("clear_cache")?.disabled === false`, "cache action available");
        await ev(`(${settings}).getElementById("clear_cache").click()`);
        await waitFor(`(${settings})?.getElementById("done")?.textContent === "Cached files cleared."`, "cache action succeeded");
        await ev(`document.querySelector("#go_settings .close").click()`);
        await goTo(site + "cache.html", "Cached");
        await shown();
        const after = await fetched();
        if (after !== first + 1) throw new Error(`fetched ${after - first} times after clearing`);
    });

    await step("this machine's addresses are refused", async () => {
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = "http://127.0.0.1:9/"; i.form.requestSubmit(); })()`);
        await waitFor(`!document.getElementById("go_notice").hidden`, "the error", 30000);
        const message = await ev(`document.querySelector("#go_notice p").textContent`);
        if (!(await ev(`document.getElementById("go_progress").hidden && !document.querySelector("#go_notice .edit").hidden`))) throw new Error("missing recovery controls");
        await ev(`document.querySelector("#go_notice .edit").click()`);
        if (!(await ev(`document.activeElement.id === "go_url" && document.activeElement.value === "http://127.0.0.1:9/" && document.getElementById("go_notice").hidden`))) throw new Error("Edit address lost the attempted URL");
        return message;
    });

    await step("reloading the tab carries on where it was", async () => {
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "second.html")}; i.form.requestSubmit(); })()`);
        await waitFor(`document.title.startsWith("Second")`, "the second page", 30000);
        await cdp("Page.reload");
        await waitFor(`document.title.startsWith("Second") && !!document.getElementById("go_url")`, "the second page after reloading", 30000);
        // The page's address is the tab's alone: not in its own (history).
        const own = await ev(`location.href`);
        if (own.includes("second.html") || own.includes("#")) throw new Error(`the tab's address is ${own}`);
    });

    await step("an address in a link from elsewhere waits for Enter", async () => {
        const url = site + "result.html?q=linked";
        // In one go, to a new address: the page there before can't put its
        // own address back in between.
        await ev(`sessionStorage.clear(); location.replace(location.pathname + "?linked#" + ${JSON.stringify(url)})`);
        await waitFor(`!!document.getElementById("go_url") && (document.getElementById("go_url").dataset.url || document.getElementById("go_url").value) === ${JSON.stringify(url)}`, "the address waiting", 30000);
        if ((await ev(`location.hash`)) !== "") throw new Error("the linked address stayed in the tab's address");
        await sleep(1500);
        if (await ev(`document.title.startsWith("Result")`)) throw new Error("it loaded without Enter");
        await ev(`document.getElementById("go_url").form.requestSubmit()`);
        await waitFor(`document.title.startsWith("Result")`, "the page, after Enter", 30000);
    });

    await step("a button that changes the page, done in the engine", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("add")`, "the page");
        await frameClick("#add");
        await frameWait(`document.getElementById("list").textContent.includes("item 1")`, "the item the page's script added");
        await frameClick("#add");
        await frameWait(`document.getElementById("list").children.length === 2`, "a second item");
    });

    await step("a change the page makes by itself, after loading", async () => {
        await frameWait(`document.getElementById("late")?.textContent === "late"`, "the late paragraph");
    });

    await step("typing, then Enter, with no form; the field cleared by the page", async () => {
        await frameClick("#todo");
        await browser.type("milk");
        await browser.press("Enter");
        await frameWait(`document.getElementById("list").textContent.includes("todo milk")`, "the to-do");
        await frameWait(`document.getElementById("todo").value === ""`, "the field cleared");
    });

    await step("rich text (contenteditable): typed, deleted, a new paragraph, text put in (a phone's keyboard, a paste), in the engine's page; a chat box's Enter sends", async () => {
        await goTo(site + "editable.html", "Editable");
        const engine = (text) => frameWait(`document.getElementById("got").textContent === ${JSON.stringify("engine: " + text)}`, `the engine's page to hold ${JSON.stringify(text)}`);
        const shown = (text) => frameWait(`[...document.getElementById("ed").childNodes].map((n) => n.textContent).join("|") === ${JSON.stringify(text)}`, `the copy to show ${JSON.stringify(text)}`);
        // The caret at the end of "hello", here.
        await frameClick("#ed p");
        await frame(`(() => { const t = document.querySelector("#ed p").firstChild; getSelection().setBaseAndExtent(t, 5, t, 5); })()`);
        await browser.type(" world");
        await engine("hello world");
        await shown("hello world");
        // A key that doesn't edit between two that do (Shift, for a capital):
        // the caret's not moved by it.
        await browser.type("a");
        await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
        await browser.type("B");
        await engine("hello worldaB");
        for (let i = 0; i < 2; i++) await browser.press("Backspace");
        await engine("hello world");
        for (let i = 0; i < 5; i++) await browser.press("Backspace");
        await engine("hello ");
        await shown("hello ");
        await browser.press("Enter");
        await browser.type("two");
        await engine("hello |two");
        await shown("hello |two");
        // Text put in, not typed (a phone's keyboard, an IME's word).
        await cdp("Input.insertText", { text: "!" });
        await engine("hello |two!");
        // An IME's word: made here as it's chosen, sent once it's done.
        await cdp("Input.imeSetComposition", { text: "o", selectionStart: 1, selectionEnd: 1 });
        await cdp("Input.imeSetComposition", { text: "ok", selectionStart: 2, selectionEnd: 2 });
        await cdp("Input.insertText", { text: "ok" });
        await engine("hello |two!ok");
        await shown("hello |two!ok");
        // A word begun as soon as a key's typed (its change coming back as
        // the word's chosen): shown once, and in the engine.
        await browser.type("Q");
        await cdp("Input.imeSetComposition", { text: "w", selectionStart: 1, selectionEnd: 1 });
        await sleep(200);
        await cdp("Input.imeSetComposition", { text: "wo", selectionStart: 2, selectionEnd: 2 });
        await sleep(400);
        await cdp("Input.insertText", { text: "wo" });
        await engine("hello |two!okQwo");
        await shown("hello |two!okQwo");
        for (let i = 0; i < 3; i++) await browser.press("Backspace");
        await engine("hello |two!ok");
        // The caret moved here (a click): typed there, not where it was.
        await frameClick("#ed p");
        await frame(`(() => { const t = document.querySelector("#ed p").firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await browser.type("X");
        await engine("Xhello |two!ok");
        // Backspace at a paragraph's start: the two made one.
        await frame(`(() => { const t = document.querySelectorAll("#ed p")[1].firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await frameClick("#ed p:nth-child(2)");
        await frame(`(() => { const t = document.querySelectorAll("#ed p")[1].firstChild; getSelection().setBaseAndExtent(t, 0, t, 0); })()`);
        await browser.press("Backspace");
        await engine("Xhello two!ok");
        await shown("Xhello two!ok");
        // A chat box: Enter sends it (the page's), not a new paragraph.
        await frameClick("#chat");
        await browser.type("hi there");
        await browser.press("Enter");
        await frameWait(`document.getElementById("sent").textContent === "hi there" && document.getElementById("chat").textContent === ""`, "the message sent, the box emptied");
        // A word made by an IME in the box, empty: once, and sent.
        await cdp("Input.imeSetComposition", { text: "y", selectionStart: 1, selectionEnd: 1 });
        await cdp("Input.imeSetComposition", { text: "yo", selectionStart: 2, selectionEnd: 2 });
        await cdp("Input.insertText", { text: "yo" });
        await frameWait(`document.getElementById("chat").textContent === "yo"`, "the word shown once");
        await sleep(500);
        if ((await frame(`document.getElementById("chat").textContent`)) !== "yo") throw new Error(`the box, after the engine's change: ${await frame(`document.getElementById("chat").textContent`)}`);
        await browser.press("Enter");
        await frameWait(`document.getElementById("sent").textContent === "hi thereyo"`, "the word sent");
        // An editor as frameworks make them: typed, deleted, typed where the
        // caret's put, its box made anew each time.
        await frameClick("#fw");
        await browser.type("abc");
        await browser.press("Backspace");
        await browser.type("d");
        await frameWait(`document.getElementById("fwgot").textContent === "model: abd"`, "the editor's model abd");
        await frameWait(`document.getElementById("fw").textContent === "abd"`, "the editor shown");
        await frameClick("#fw");
        await frame(`(() => { const t = document.getElementById("fw").firstChild; getSelection().setBaseAndExtent(t, 1, t, 1); })()`);
        await browser.type("X");
        await frameWait(`document.getElementById("fwgot").textContent === "model: aXbd"`, "X typed where the caret was put");
        // In an embedded page: typed, and Enter a new paragraph, there.
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        await frameWait(`(() => { ${deep} return !!deep(document, "#fed p"); })()`, "the frame's rich text", 30000);
        const r = await frame(`(() => { ${deep} const b = deep(document, "#fed p").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        await frame(`(() => { ${deep} const t = deep(document, "#fed p").firstChild; getSelection().setBaseAndExtent(t, 2, t, 2); })()`);
        await browser.type("!");
        await frameWait(`(() => { ${deep} return deep(document, "#fgot")?.textContent === "frame: in!"; })()`, "the frame's page to hold in!");
        const focused = `(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.id; })()`;
        if ((await frame(focused)) !== "fed") throw new Error(`the frame's rich text lost the focus as it was redrawn (now ${await frame(focused)})`);
        await browser.press("Enter");
        await browser.type("x");
        await frameWait(`(() => { ${deep} return deep(document, "#fgot")?.textContent === "frame: in!|x"; })()`, "the frame's page to hold in!|x");
        await goTo(site + "interact.html", "Interact");  // (the steps after's)
    });

    await step("web components: shadow roots shown (adopted styles, a slot, a closed one, one attached later), a button and rich text in one used, frames in one shown", async () => {
        await goTo(site + "shadow.html" + (adSite ? "?x=" + encodeURIComponent(adSite + "shadow-frame.html") : ""), "Shadow");
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        const at = (sel) => frame(`(() => { ${deep} const e = deep(document, ${JSON.stringify(sel)}); return e ? [e.textContent, getComputedStyle(e).color, !!e.assignedSlot] : null; })()`);
        // Shown, styled by the adopted stylesheet; the host's child in its slot.
        await frameWait(`(() => { ${deep} return deep(document, "#inner")?.textContent === "inner text" && getComputedStyle(deep(document, "#inner")).color === "rgb(10, 20, 30)"; })()`, "the shadow root's content, styled by its adopted stylesheet");
        const slotted = await at("#slotted");
        if (!slotted || slotted[1] !== "rgb(40, 50, 60)" || !slotted[2]) throw new Error(`the slotted child: ${JSON.stringify(slotted)}`);
        // A closed one: shown (the page still told it's closed).
        await frameWait(`(() => { ${deep} const e = deep(document, "#secret"); return e?.textContent === "closed text" && getComputedStyle(e).color === "rgb(70, 80, 90)"; })()`, "the closed shadow root's content, with its <style>");
        // A <style> in a (closed) root filled by script: its rules, and one
        // put in later.
        const ruledColor = (c) => `(() => { ${deep} const e = deep(document, "#ruledtext"); return e?.textContent === "ruled text" && getComputedStyle(e).color === "${c}"; })()`;
        await frameWait(ruledColor("rgb(11, 22, 33)"), "a <style> in a shadow root, its rules put in by script");
        await frameClick("#rerule");
        await frameWait(ruledColor("rgb(44, 55, 66)"), "a rule put in later, in a <style> in a shadow root");
        // A closed one from its HTML (which the page's world can't open):
        // shown all the same, with its <style>.
        await frameWait(`(() => { ${deep} const e = deep(document, "#dsdclosed"); return e?.textContent === "closed, from the HTML" && getComputedStyle(e).color === "rgb(12, 13, 14)"; })()`, "a closed shadow root from the page's HTML", 15000);
        // One from its HTML, taken up by its element; one drawn once seen.
        await frameWait(`(() => { ${deep} const e = deep(document, "#declared"); return e?.getAttribute("data-taken") === "yes" && getComputedStyle(e).color === "rgb(5, 6, 7)"; })()`, "a declarative shadow root, taken up by its element");
        await frame(`(() => { ${deep} deep(document, "#lazybox").scrollIntoView({ block: "center" }); })()`);
        await frameWait(`(() => { ${deep} return deep(document, "#lazybox")?.textContent === "seen"; })()`, "what's in a shadow root seen, as the page's IntersectionObserver is told");
        // Its adopted stylesheet replaced: the copy's restyled.
        await frameClick("#restyle");
        await frameWait(`(() => { ${deep} return getComputedStyle(deep(document, "#inner")).color === "rgb(90, 91, 92)"; })()`, "the shadow root restyled as its adopted stylesheet's replaced");
        // One attached later.
        await frameClick("#define");
        await frameWait(`(() => { ${deep} return deep(document, "#later")?.textContent === "defined later"; })()`, "a shadow root attached later");
        // A button in one: pressed, in the engine.
        const clickDeep = async (sel, dx = 0.5) => {
            const r = await frame(`(() => { ${deep} const e = deep(document, ${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width * ${dx}, y: b.y + b.height / 2 }; })()`);
            const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
        };
        await clickDeep("#btn");
        await frameWait(`document.getElementById("clicks").textContent === "clicks 1"`, "the button in the shadow root pressed in the engine");
        // Rich text in one: typed at its end, in the engine.
        await clickDeep("#ed", 0.9);
        await frame(`(() => { ${deep} const t = deep(document, "#ed").firstChild; getSelection().setBaseAndExtent(t, 7, t, 7); })()`);
        await browser.type("!");
        await frameWait(`document.getElementById("edgot").textContent === "engine: edit me!"`, "typed in rich text in the shadow root");
        // Mid-text there: typed, deleted, a new paragraph, the caret moved.
        const edEngine = (text) => frameWait(`document.getElementById("edgot").textContent === ${JSON.stringify("engine: " + text)}`, `the rich text in the shadow root to hold ${JSON.stringify(text)}`);
        await clickDeep("#ed", 0.3);
        await frame(`(() => { ${deep} const t = deep(document, "#ed").firstChild; getSelection().setBaseAndExtent(t, 4, t, 4); })()`);
        await browser.type("abc");
        await edEngine("editabc me!");
        await browser.press("Backspace");
        await edEngine("editab me!");
        await browser.press("Enter");
        await edEngine("editab| me!");
        // The engine's caret, come back here, at the new line's start (past
        // its space, not shown, as a browser has it): one along, after "m".
        await browser.press("ArrowRight");
        await browser.type("X");
        await edEngine("editab| mXe!");
        // Frames in one: this site's, and another's.
        await frameWait(`(() => { ${deep} return deep(document, "#infr")?.textContent === "in a frame in a shadow root"; })()`, "a frame's page in the shadow root", 30000);
        if (adSite) await frameWait(`(() => { ${deep} const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.id === "infr") all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all.length === 2; })()`, "another site's frame's page in the shadow root too", 30000);
        // A component in each frame: its root and its adopted stylesheet.
        const framed = (n) => `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.classList?.contains("finner")) all.push(getComputedStyle(el).color); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all.length === ${n} && all.every((c) => c === "rgb(33, 44, 55)"); })()`;
        await frameWait(framed(adSite ? 2 : 1), "a component in each frame, styled by its adopted stylesheet", 30000);
        // A closed root from its HTML in each frame (this site's, read by
        // the page's agent; another's, by its own).
        const closedFramed = `(() => { let n = 0; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.classList?.contains("fdsd")) n++; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return n; })()`;
        await frameWait(`${closedFramed} === ${adSite ? 2 : 1}`, "a closed shadow root from its HTML in each frame", 30000);
        // A button in each frame there, pressed: in its page in the engine.
        const frameButtons = `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.id === "fbtn") all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return all; })()`;
        for (let i = 0; i < (adSite ? 2 : 1); i++) {
            const r = await frame(`(() => { const b = ${frameButtons}[${i}]; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
            for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + r.x, y: f.y + r.y, button: "left", clickCount: 1 });
            await frameWait(`${frameButtons}[${i}]?.textContent === "frame pressed"`, `the button in frame ${i + 1} in the shadow root pressed`, 15000);
        }
        await goTo(site + "interact.html", "Interact");  // (the steps after's)
    });

    await step("a checkbox and a select", async () => {
        await frameClick("#cb");
        await frameWait(`document.getElementById("status").textContent === "checked true"`, "the box ticked in the engine");
        await frame(`document.getElementById("sel").focus()`);
        await browser.press("ArrowDown");
        await frameWait(`document.getElementById("status").textContent === "selected b"`, "the option chosen in the engine");
    });

    await step("a route by history.pushState shows in the address bar", async () => {
        await frameClick("#push");
        await waitFor(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value).endsWith("/routed")`, "the routed address");
        await frameWait(`document.getElementById("status").textContent === "routed"`, "the routed status");
    });

    await step("alert and confirm are asked here", async () => {
        await frameClick("#alert");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        if (!said.includes("hello from the page")) throw new Error(`the alert said ${said}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("status").textContent === "after alert"`, "the page carrying on");
        await frameClick("#confirm");
        await waitFor(`document.getElementById("go_dialog").open`, "the question");
        await ev(`document.querySelector("#go_dialog .cancel").click()`);
        await frameWait(`document.getElementById("status").textContent === "confirmed false"`, "the answer");
    });

    await step("a dialog asked after opening a window says who asked, not where the window goes", async () => {
        await frameClick("#openask");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        const asker = new URL(site).host;
        if (!said.startsWith(`${asker} says: who asks`)) throw new Error(`the alert said ${JSON.stringify(said)}, not from ${asker}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("alert")`, "the page");
    });

    await step("a click on a button's SVG icon presses the button", async () => {
        await frameClick("#svgpath");
        await frameWait(`document.getElementById("status").textContent === "icon pressed"`, "the button pressed");
    });

    await step("a GET form, sent in the engine", async () => {
        await frameClick("#q");
        await browser.type("cats");
        await frameClick("#go");
        await waitFor(`document.title.startsWith("Result")`, "the result page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query cats"`, "the query");
        if (!(await ev(`(document.getElementById("go_url").dataset.url || document.getElementById("go_url").value)`)).includes("result.html?q=cats")) throw new Error("the address bar didn't follow");
    });

    await step("a custom search engine: words typed are searched there, and shown as words", async () => {
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        const openSettings = async () => {
            await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
            await waitFor(`${d}?.getElementById("search_engine")?.disabled === false`, "Settings", 15000);
        };
        const closeSettings = async () => {
            await ev(`document.querySelector("#go_settings .close").click()`);
            await waitFor(`!document.getElementById("go_settings").open`, "Settings closed");
        };
        await openSettings();
        await ev(`(() => { const s = ${d}.getElementById("search_engine"); s.value = "custom"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`!${d}.getElementById("search_custom").hidden`, "its address asked for");
        const setURL = (u) => ev(`(() => { const d = ${d}; const i = d.getElementById("search_url"); i.value = ${JSON.stringify(u)}; i.dispatchEvent(new Event("input")); d.getElementById("search_custom").requestSubmit(); })()`);
        await setURL(site + "result.html?q=x%s");
        await waitFor(`!${d}.getElementById("search_error").hidden && /whole value/.test(${d}.getElementById("search_error").textContent)`, "%s not a whole value, said by the field");
        await setURL(site + "result.html?q=%s");
        await waitFor(`${d}.getElementById("done").textContent === "Search engine saved."`, "the custom engine saved", 15000);
        await closeSettings();
        await sleep(1000); // (the browser asks for the engine again as it's told)
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = "cats and dogs"; i.form.requestSubmit(); })()`);
        await waitFor(`document.title.startsWith("Result")`, "the custom engine's result page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query cats and dogs"`, "the words searched for");
        await waitFor(`document.getElementById("go_url").value === "cats and dogs"`, "the address bar showing the words");
        // What isn't an address at all (a space in its host) is searched for.
        await goTo(site + "index.html", "Fixture");
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = "https://exa mple.com/x"; i.form.requestSubmit(); })()`);
        await waitFor(`document.title.startsWith("Result")`, "an address that isn't one, searched for", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "query https://exa mple.com/x"`, "searched for as typed");
        // Back to the default.
        await openSettings();
        if ((await ev(`${d}.getElementById("search_engine").value`)) !== "custom") throw new Error("Settings doesn't show the custom engine");
        await ev(`(() => { const s = ${d}.getElementById("search_engine"); s.value = "duckduckgo"; s.dispatchEvent(new Event("change")); })()`);
        await waitFor(`${d}.getElementById("done").textContent === "Search engine saved." && ${d}.getElementById("search_custom").hidden`, "DuckDuckGo again", 15000);
        await closeSettings();
    });

    await step("a POST form", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("send")`, "the page");
        await frameClick("#send");
        await waitFor(`document.title.startsWith("Posted")`, "the posted page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "pq=posted+value"`, "what was posted");
    });

    await step("a page's file input: its chooser answered here, its files the page's (read, posted); a shown one shows them; none opened without a press", async () => {
        // The files, on this machine; this browser's chooser taken (not
        // shown), and the files put in it as a person would pick them.
        const dir = mkdtempSync(join(tmpdir(), "go-check-files-"));
        writeFileSync(join(dir, "a.txt"), "first file's text");
        writeFileSync(join(dir, "b.txt"), "second file's text");
        const pickHere = async (paths) => {
            await waitFor(`!!document.getElementById("go_file_input")?.dataset.chooser`, "the page's chooser, here", 15000);
            const { root } = await cdp("DOM.getDocument", { depth: 0 });
            const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#go_file_input" });
            await cdp("DOM.setFileInputFiles", { nodeId, files: paths });
        };
        // Waited for, TabTop's side said if it doesn't come: its chooser,
        // its notice, what the page shows.
        const pageGets = (expr, what) => frameWait(expr, what, 30000).catch(async (err) => {
            const here = await ev(`JSON.stringify({ chooser: document.getElementById("go_file_input").dataset.chooser ?? null, files: document.getElementById("go_file_input").files.length, notice: document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent, status: document.getElementById("go_status")?.textContent ?? "" })`).catch(() => "?");
            const there = await frame(`JSON.stringify([document.getElementById("fgot")?.textContent, document.getElementById("fshown")?.textContent])`).catch(() => "?");
            throw new Error(`${err.message} (here ${here}; the page ${there})`);
        });
        await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
        try {
            await goTo(site + "fileinput.html", "File input");
            await frameWait(`!!document.getElementById("pick")`, "the page");
            // Opened by its button: two files, read and posted by the page.
            await frameClick("#pick");
            await pickHere([join(dir, "a.txt"), join(dir, "b.txt")]);
            await pageGets(`document.getElementById("fgot").textContent === "a.txt=first file's text, b.txt=second file's text"`, "the files, read by the page");
            await frameWait(`document.getElementById("fposted").textContent === "both posted"`, "the files, posted to the site", 15000);
            // A shown one, pressed: its file, and shown in it here.
            await frameClick("#shown");
            await pickHere([join(dir, "b.txt")]);
            await pageGets(`document.getElementById("fshown").textContent === "b.txt=second file's text"`, "the shown field's file, read by the page");
            const here = await frame(`(() => { const f = document.getElementById("shown"); return f.files.length + " " + (f.files[0]?.name ?? ""); })()`);
            if (here !== "1 b.txt") throw new Error(`the shown field here holds ${JSON.stringify(here)}`);
            // One a timer opens, no press: nothing asked here.
            await goTo(site + "fileauto.html", "File auto");
            await sleep(2000);
            if (await ev(`!!document.getElementById("go_file_input").dataset.chooser`)) throw new Error("a chooser opened without a press was asked here");
        } finally {
            await cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
            rmSync(dir, { recursive: true, force: true });
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("files dropped on the page: sent, then dropped there, each a drop of its own (Moli gives a drop one file)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "go-check-drop-"));
        writeFileSync(join(dir, "a.txt"), "first file's text");
        writeFileSync(join(dir, "b.txt"), "second file's text");
        try {
            await goTo(site + "filedrop.html", "File drop");
            await frameWait(`!!document.getElementById("zone")`, "the page");
            const r = await frame(`(() => { const b = document.getElementById("zone").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
            const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
            const to = { x: f.x + r.x, y: f.y + r.y };
            const data = { items: [], files: [join(dir, "a.txt"), join(dir, "b.txt")], dragOperationsMask: 1 };
            for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, ...to, data });
            await sleep(200);
            await cdp("Input.dispatchDragEvent", { type: "drop", ...to, data });
            await frameWait(`document.getElementById("dropped").textContent === "a.txt=first file's text, b.txt=second file's text"`, "both files, dropped on the page", 30000);
            const types = await frame(`document.getElementById("dtypes").textContent`);
            if (types !== "Files") throw new Error(`the page's drag had ${JSON.stringify(types)}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        await goTo(site + "index.html", "Fixture");
    });

    await step("Settings: Restart remote web engine, confirmed with the password + code (a wrong one refused): the tab loads its page again in a new engine", async () => {
        await goTo(site + "restart.html", "Restart");
        await frameWait(`!!document.getElementById("born")?.textContent`, "the page");
        const born = await frame(`document.getElementById("born").textContent`);
        const d = `document.querySelector("#go_settings iframe")?.contentDocument`;
        await ev(`document.getElementById("go_menu").click(); document.getElementById("go_menu_settings").click()`);
        await waitFor(`${d}?.getElementById("engine_restart")?.disabled === false`, "Settings' Restart", 15000);
        const said = `${d}.getElementById("done").textContent`;
        const dialog = `${d}.getElementById("restart_dialog")`;
        await ev(`${d}.getElementById("engine_restart").click()`);
        await waitFor(`${dialog}.open && ${d}.activeElement === ${d}.getElementById("restart_code")`, "the restart's dialog, its field focused");
        const enter = (code) => ev(`(() => { const d = ${d}; const c = d.getElementById("restart_code"); c.value = ${JSON.stringify(code)}; c.dispatchEvent(new Event("input")); d.getElementById("restart_go").click(); })()`);
        // A wrong password + code: said in the dialog, still open, its field
        // cleared to try again; nothing restarted.
        await enter("0000000");
        await waitFor(`${d}.getElementById("restart_error").textContent.startsWith("That password and code are wrong") && ${dialog}.open && !${d}.getElementById("restart_code").value`, "a wrong code refused, said in the dialog", 15000);
        if ((await frame(`document.getElementById("born").textContent`)) !== born) throw new Error("the page was loaded again on a wrong code");
        // The right one, in the same dialog: restarted (every tab's: others
        // the steps before left too, kept to be taken back), the dialog closed.
        await enter(await totp());
        await waitFor(`!${dialog}.open && /^Engine restarted · (1 tab|[0-9]+ tabs) reloaded\\.$/.test(${said})`, "the restart done, the dialog closed", 30000);
        await frameWait(`document.title === "Restart" && !!document.getElementById("born")?.textContent && document.getElementById("born").textContent !== ${JSON.stringify(born)}`, "the page, loaded again in a new engine", 30000);
        if (await ev(`!document.getElementById("go_notice").hidden && document.getElementById("go_notice").dataset.connection === "1"`)) throw new Error("asked to reconnect, not connected again by itself");
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, "Settings closed");
        await goTo(site + "index.html", "Fixture");
    });

    await step("a redirect by script, and a window the page opens, stay in this tab", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("redirect")`, "the page");
        await frameClick("#redirect");
        await waitFor(`document.title.startsWith("Second")`, "the redirect", 30000);
        await ev(`document.getElementById("go_back").click()`);
        await waitFor(`document.title.startsWith("Interact")`, "back", 30000);
        await frameWait(`!!document.getElementById("open")`, "the page");
        await frameClick("#open");
        // Asked first (a site with nothing said of its pop-ups): opened, the
        // answer not kept (the pop-ups' step, below, has that).
        await waitFor(`!document.getElementById("go_popup").hidden`, "asked about the pop-up", 30000);
        await ev(`(() => { document.querySelector("#go_popup .remember input").checked = false; document.querySelector("#go_popup .open").click(); })()`);
        await waitFor(`document.title.startsWith("Second")`, "the opened window, here", 30000);
    });

    await step("pop-ups are asked about, the answer kept for the site; blocked sites aren't loaded; both in Site controls", async () => {
        const host = new URL(site).hostname;
        const settings = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        const openPopup = async () => {
            await goTo(site + "interact.html", "Interact");
            await frameWait(`!!document.getElementById("open")`, "the page");
            await frameClick("#open");
        };
        // Asked; opened, and kept: the next opens without asking.
        await openPopup();
        await waitFor(`!document.getElementById("go_popup").hidden && document.getElementById("go_popup_text").textContent.includes(${JSON.stringify(host)})`, "asked, naming the site", 30000);
        await ev(`document.querySelector("#go_popup .open").click()`);
        await waitFor(`document.title.startsWith("Second")`, "the pop-up opened", 30000);
        if (JSON.parse(await settings({ type: "go-settings" })).popups[host] !== "allow") throw new Error("the answer wasn't kept");
        await openPopup();
        await waitFor(`document.title.startsWith("Second")`, "opened without asking", 30000);
        if (await ev(`!document.getElementById("go_popup").hidden`)) throw new Error("asked again");
        // Blocked for the site: not opened, and said.
        await settings({ type: "go-settings-set", name: host, setting: "popups-block" });
        await openPopup();
        await waitFor(`/pop-up from .* was blocked/.test(document.getElementById("go_status").textContent)`, "the pop-up refused, and said", 30000);
        await sleep(1500);
        if (!(await ev(`document.title.startsWith("Interact")`))) throw new Error("the refused pop-up loaded");
        // A blocked site: not loaded, nor its pictures for others; then
        // unblocked.
        await settings({ type: "go-settings-set", name: host, setting: "block" });
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "second.html")}; i.form.requestSubmit(); })()`);
        await waitFor(`!document.getElementById("go_notice").hidden && /blocked/.test(document.querySelector("#go_notice p").textContent)`, "the blocked site refused", 30000);
        await settings({ type: "go-settings-set", name: host, setting: "unblock" });
        // The page: both listed, a site blocked and unblocked from it.
        await ev(`location.href = ${JSON.stringify(new URL("go/sites", base).href)}`);
        const siteRow = `document.querySelector('#sites li[data-site="${host}"]')`;
        // (The page left may answer first: ?.)
        await waitFor(`document.getElementById("sort_sites")?.value === "recent" && /Pop-ups: blocked/.test((${siteRow})?.textContent)`, "the site's pop-ups listed with Most recent selected", 20000);
        await ev(`(${siteRow}).querySelector("button").click()`);
        await waitFor(`!document.getElementById("site_settings").hidden && document.getElementById("popups").value === "block"`, "the site's pop-up setting");
        await ev(`document.getElementById("back_to_sites").click()`);
        await waitFor(`!document.getElementById("all_sites").hidden && document.activeElement === (${siteRow})?.querySelector("button")`, "back to All sites returns focus to the selected row");
        await ev(`document.getElementById("filter").value = "https://www.ads.example/x"; document.getElementById("find_site").requestSubmit();`);
        await waitFor(`document.getElementById("site_heading").textContent === "ads.example" && !document.getElementById("site_settings").hidden`, "settings for a newly entered site");
        await ev(`window.confirm = () => true; document.getElementById("access").click()`);
        await waitFor(`document.getElementById("access").textContent === "Unblock site"`, "a site blocked from the page");
        await ev(`document.getElementById("access").click()`);
        await waitFor(`document.getElementById("access").textContent === "Block site"`, "unblocked from the page");
        // Back to asking, for the steps after.
        await settings({ type: "go-settings-set", name: host, setting: "popups-default" });
        await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
        // (The page it was at, loaded again, before the next.)
        await waitFor(`!!document.getElementById("go_url") && document.title.startsWith("Second")`, "the browser page again, at its page", 30000);
    });

    if (adSite) await step("ad blocking: a list added in Settings blocks another site's picture on a page (the shield says one site), not on a site allowed in Site controls, nor the site's own pages; My filters block it too; off, it's fetched", async () => {
        const call = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        // What the other site was asked for, said by it (not through TabTop).
        const adsSeen = async () => {
            const text = await (await fetch(adSite + "seen")).text();
            return JSON.parse(text.match(/<pre id=s>(.*)<\/pre>/s)[1]).ads || 0;
        };
        const adHost = new URL(adSite).hostname;
        // Off at first, and the built-in lists (from the internet) not wanted here.
        const first = JSON.parse(await call({ type: "go-adblock" }));
        if (first.enabled) throw new Error("ad blocking was on at first");
        await call({ type: "go-adblock-set", setting: "list-off", name: "easylist" });
        await call({ type: "go-adblock-set", setting: "list-off", name: "easyprivacy" });
        try {
            await ev(`location.href = ${JSON.stringify(new URL("go/settings", base).href)}`);
            await waitFor(`document.getElementById("adblock_on")?.disabled === false && /^Off/.test(document.getElementById("adblock_about").textContent)`, "Settings, ad blocking off", 20000);
            const list = site + "filters.txt?host=" + adHost + "&page=" + new URL(site).hostname;
            await ev(`(() => { const i = document.getElementById("ad_url"); i.value = ${JSON.stringify(list)}; i.dispatchEvent(new Event("input")); document.getElementById("ad_add").requestSubmit(); })()`);
            await waitFor(`document.getElementById("done").textContent === "List added." && [...document.querySelectorAll("#ad_lists li")].some((li) => /TabTop check list/.test(li.textContent) && /7 rules\\b/.test(li.textContent) && li.querySelector("input").checked)`, "the list added, named as it says, ticked", 20000);
            await ev(`document.getElementById("adblock_on").click()`);
            await waitFor(`document.getElementById("done").textContent === "Ad blocking is on." && /^7 rules in force, from 1 of 1 ticked list/.test(document.getElementById("adblock_about").textContent)`, "on, the rule in force", 20000);
            await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
            // (The page it was at, loaded again, before the next.)
            await waitFor(`!!document.getElementById("go_url") && document.title.startsWith("Second")`, "the browser page again, at its page", 30000);
            const before = await adsSeen();
            await goTo(site + "ads?ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("own")?.naturalWidth > 0`, "the page's own picture");
            await sleep(1500);
            if (await frame(`document.getElementById("ad")?.naturalWidth > 0`)) throw new Error("the other site's picture was shown");
            if ((await adsSeen()) !== before) throw new Error("the other site's picture was fetched");
            // Hidden: the ad, the site's own native ad, and one the page's script added after; not the page.
            const hidden = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display === "none"`;
            await frameWait(`!!document.getElementById("late")`, "the late ad, added by the page");
            await frameWait(`${hidden("#banner")} && ${hidden(".native")} && ${hidden("#late")} && getComputedStyle(document.getElementById("content")).display !== "none"`, "the ads hidden, the page shown", 5000);
            // By address, on the page's own site: its script under /ads/ not run nor asked for, but the one an
            // exception lets through run; its picture under /banner/ not fetched for the copy.
            const pageSeen = async () => JSON.parse((await (await fetch(site + "seen")).text()).match(/<pre id=s>(.*)<\/pre>/s)[1]);
            await frameWait(`document.getElementById("ok").textContent === "ran"`, "the script an exception lets through, run");
            if ((await frame(`document.getElementById("tracked").textContent`)) !== "not run") throw new Error("a script blocked by its address ran");
            const asked = await pageSeen();
            if (asked["/ads/track.js"] || asked["/banner/ad.png"] || !asked["/ads/ok.js"]) throw new Error(`the page's site was asked for ${JSON.stringify(asked)}`);
            if (await frame(`document.getElementById("pathad").naturalWidth > 0`)) throw new Error("a picture blocked by its address shown");
            // The shield: three blocked on this page (the other site, the script, the picture).
            await waitFor(`document.getElementById("go_site").dataset.glyph === "insecure,shield" && document.querySelector("#go_site .count").textContent === "3" && /3 ads and trackers blocked/.test(document.getElementById("go_site").title)`, "the site's button, saying three", 5000);
            // The site's ads allowed, in its controls (from the shield): fetched, shown, no shield.
            const pageHost = new URL(site).hostname;
            await ev(`document.getElementById("go_site").click()`);
            const sites = `document.querySelector("#go_settings iframe")?.contentDocument`;
            await waitFor(`(${sites})?.getElementById("ads")?.disabled === false && (${sites}).getElementById("site_heading").textContent === ${JSON.stringify(pageHost)} && (${sites}).getElementById("ads").selectedOptions[0].textContent === "Default (Block)"`, "the site's controls, from the shield", 15000);
            await ev(`(() => { const s = (${sites}).getElementById("ads"); s.value = "allow"; s.dispatchEvent(new Event("change")); })()`);
            await waitFor(`(${sites}).getElementById("done").textContent === "Setting saved."`, "the site's ads allowed");
            await ev(`document.querySelector("#go_settings .close").click()`);
            await goTo(site + "ads?v=allowed&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("ad")?.naturalWidth > 0`, "the other site's picture, ads allowed on the page's site");
            await frameWait(`getComputedStyle(document.getElementById("banner")).display !== "none"`, "the ad shown, ads allowed on the page's site");
            if ((await ev(`document.querySelector("#go_site .count").textContent`)) !== "") throw new Error("a count on the site's button, with ads allowed");
            await call({ type: "go-settings-set", name: pageHost, setting: "ads-default" });
            // My filters: the list off, the site named there instead.
            const listId = JSON.parse(await call({ type: "go-adblock" })).lists.find((l) => !l.builtIn).id;
            await call({ type: "go-adblock-set", setting: "list-off", name: listId });
            await ev(`location.href = ${JSON.stringify(new URL("go/settings", base).href)}`);
            await waitFor(`document.getElementById("my_filters")?.disabled === false && document.querySelectorAll("#ad_lists li").length > 0`, "My filters", 20000);
            await ev(`(() => { const t = document.getElementById("my_filters"); t.value = "! mine\\n" + ${JSON.stringify("||" + adHost + "^")} + "\\n/ads[0-9]+/"; t.dispatchEvent(new Event("input")); document.getElementById("save_filters").click(); })()`);
            await waitFor(`document.getElementById("done").textContent === "Filters saved." && /Line 3, can't be used here/.test(document.getElementById("filter_problems").textContent)`, "My filters saved, the line it can't use said").catch(async (err) => {
                throw new Error(`${err.message} (it shows ${await ev(`JSON.stringify({ done: document.getElementById("done").textContent, problems: document.getElementById("filter_problems").textContent, value: document.getElementById("my_filters").value, save: document.getElementById("save_filters").disabled })`)})`);
            });
            await ev(`location.href = ${JSON.stringify(new URL("go/tab", base).href)}`);
            await waitFor(`!!document.getElementById("go_url") && document.title.startsWith("Ads")`, "the browser page again, at its page", 30000);
            const seenBefore = await adsSeen();
            await goTo(site + "ads?v=mine&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("own")?.naturalWidth > 0`, "the page's own picture");
            await sleep(1500);
            if (await frame(`document.getElementById("ad")?.naturalWidth > 0`)) throw new Error("shown, with the site in My filters");
            if ((await adsSeen()) !== seenBefore) throw new Error("fetched, with the site in My filters");
            // Its own pages load: a page's own site is never blocked.
            await goTo(adSite + "second.html", "Second");
            // Off: fetched, and shown.
            await call({ type: "go-adblock-set", setting: "off" });
            await goTo(site + "ads?v=off&ad=" + encodeURIComponent(adSite), "Ads");
            await frameWait(`document.getElementById("ad")?.naturalWidth > 0`, "the other site's picture, blocking off");
            if (!((await adsSeen()) > before)) throw new Error("the other site's picture wasn't fetched, blocking off");
        } finally {
            const state = JSON.parse(await call({ type: "go-adblock" }));
            await call({ type: "go-adblock-set", setting: "off" });
            await call({ type: "go-adblock-set", setting: "filters", filters: "" });
            await call({ type: "go-settings-set", name: new URL(site).hostname, setting: "ads-default" });
            for (const l of state.lists ?? []) if (!l.builtIn) await call({ type: "go-adblock-set", setting: "list-remove", name: l.id });
        }
    });

    await step("an on-demand stream can be saved from the video player", async () => {
        // The page's video taken into the /go player (Watch, in the menu);
        // closed again.
        const watch = async () => {
            await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
            await waitFor(`[...document.querySelectorAll("#go_menu_media li .acts button")].some((b) => /^Watch /.test(b.getAttribute("aria-label") || "") && !b.disabled)`, "Watch offered", 30000);
            await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Watch /.test(b.getAttribute("aria-label") || "")).click()`);
            await waitFor(`!!document.querySelector("#video_player")`, "the player");
        };
        const unwatch = () => ev(`document.querySelector("#video_player button[aria-label^='Close the player']")?.click()`);
        const save = `#video_player button[aria-label^="Save stream"]`;
        // What's offered: the page's streams' names, the picker's (with what
        // the player's buffered, after them) or, one alone, Save's.
        const offered = () => ev(`(() => {
            const picker = document.querySelector("#video_player .stream-picker");
            const names = picker ? [...picker.options].map((o) => o.text) : [document.querySelector(${JSON.stringify(save)}).getAttribute("aria-label").replace(/^Save stream into Downloads · /, "")];
            return names.filter((n) => n !== "Buffered stream");
        })()`);
        await goTo(site + "stream-save.html", "Save stream");
        if (process.env.GO_NO_FS === "1") {
            await sleep(1500);
            await watch();
            if (await ev(`!!document.querySelector(${JSON.stringify(save)})`)) throw new Error("Save stream offered with Files off");
            return await unwatch();
        }
        await sleep(1500);  // (the manifest read by now)
        if (await ev(`!!document.getElementById("go_streams")`)) throw new Error("Save stream in the menu, not only the player");
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "Save stream in the player");
        // The page's stream, first (the picker's choice), named: how long it
        // lasts, and its site.
        const named = await offered();
        if (named.length !== 1 || !named[0].startsWith("0:03 · ")) throw new Error(`the streams offered: ${JSON.stringify(named)}`);
        if (await ev(`document.querySelector("#video_player .stream-picker")?.selectedIndex ?? 0`) !== 0) throw new Error("the page's stream not first");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`document.querySelector("#video_player .note")?.textContent.startsWith("Saved movie.mp4")`, "the assembled stream in Downloads", 30000);
        await unwatch();
        // A master playlist and the variant it names: one stream, the master's (the variant,
        // saved alone, would be the video without its sound), named by how long the variant says.
        await goTo(site + "stream-master.html", "Master stream");
        await sleep(1500);  // (the variant's fetched, and read, by now)
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "the master's stream");
        const master = await offered();
        if (master.length !== 1 || !master[0].startsWith("0:03 · ")) throw new Error(`a master and its variant offered as ${JSON.stringify(master)}`);
        await unwatch();
        // One that's slow, followed through the page's reload, and cancelled.
        await goTo(site + "stream-save.html?cancel", "Save stream");
        await sleep(1500);
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "the slow stream");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`Object.keys(sessionStorage).some(k => k.startsWith("tabtop-go-downloads:") && JSON.parse(sessionStorage[k]).length)`, "the download ID kept");
        await ev(`location.reload()`);
        await waitFor(`!!document.querySelector("#go_downloads button")`, "Cancel available after reconnecting");
        await ev(`document.querySelector("#go_downloads button").click()`);
        await waitFor(`document.querySelector("#go_notice p")?.textContent === "Download cancelled." && !document.querySelector("#go_downloads button")`, "the download cancelled");
        // A page that only streams through Media Source (no .m3u8): Save from the buffered capture.
        await goTo(site + "mse-save.html", "MSE save");
        await sleep(1500);
        await watch();
        await waitFor(`!!document.querySelector(${JSON.stringify(save)})`, "Save buffered MSE stream");
        await ev(`document.querySelector(${JSON.stringify(save)}).click()`);
        await waitFor(`/^Saved .* into Downloads\\.$/.test(document.querySelector("#video_player .note")?.textContent ?? "")`, "the buffered MSE stream in Downloads", 30000);
        await unwatch();
    });

    if (process.env.GO_NO_FS !== "1") await step("after the page moves to its next video (pushState), the menu doesn't offer to save the last one's stream", async () => {
        await goTo(site + "mse-moved.html", "MSE moved");
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        try {
            await waitFor(`document.querySelectorAll("#go_menu_media li").length >= 1`, "the video in the menu", 20000);
            await sleep(3000);  // (the page moved, its video playing)
            const said = await ev(`JSON.stringify([...document.querySelectorAll("#go_menu_media li .acts button")].map((b) => b.getAttribute("aria-label")))`);
            if (/0:03/.test(said)) throw new Error(`the menu offers the last video's stream: ${said}`);
        } finally {
            await ev(`document.getElementById("go_menu_panel").hidden || document.getElementById("go_menu").click()`);
        }
    });

    if (process.env.GO_NO_FS !== "1") await step("a stream no player here plays (the site's own): Save offered in the menu", async () => {
        await goTo(site + "onlystream.html", "Only stream");
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        try {
            await waitFor(`[...document.querySelectorAll("#go_menu_media li")].some((li) => li.querySelector(".state")?.textContent === "Stream" && /^Save the stream of 0:03/.test(li.querySelector(".acts button")?.getAttribute("aria-label") || ""))`, "the stream's row, with Save", 15000);
        } finally {
            await ev(`document.getElementById("go_menu_panel").hidden || document.getElementById("go_menu").click()`);
        }
    });

    await step("a link to a file offers to save it", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("pdf")`, "the page");
        await frameClick("#pdf");
        // With Files off, nothing's said: the page stays, no notice.
        if (process.env.GO_NO_FS === "1") {
            await sleep(3000);
            await waitFor(`document.getElementById("go_progress").hidden`, "the click's load to end", 30000);
            const shown = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
            if (shown) throw new Error(`with Files off, a notice: ${shown}`);
            if (!(await frame(`document.title === "Interact"`))) throw new Error("the page didn't stay");
            return "nothing said, Files off";
        }
        await waitFor(`!document.getElementById("go_notice").hidden && document.querySelector("#go_notice p").textContent.includes("application/pdf")`, "the file notice", 30000);
        await ev(`document.querySelector("#go_notice button").click()`);
        await waitFor(`document.querySelector("#go_notice p").textContent.startsWith("Saved doc.pdf")`, "the file saved", 30000);
        if (!(await ev(`document.querySelector("#go_notice .primary").textContent === "Open Downloads" && !document.querySelector("#go_notice .primary").hidden`))) throw new Error("no action to open Downloads");
        return await ev(`document.querySelector("#go_notice p").textContent`);
    });

    await step("a page that never stops changing stays usable", async () => {
        await goTo(site + "churn.html", "Churn");
        await sleep(3000);
        const n = Number(await frame(`document.getElementById("n").textContent`));
        if (!(n > 10)) throw new Error(`the counter shows ${n}`);
        await goTo(site + "second.html", "Second");
        return `counter seen at ${n}`;
    });

    await step("the page is laid out at the frame's size, and follows it", async () => {
        // The width it's laid out in here: the frame's, but for a scroll bar.
        const frameWidth = () => frame(`document.documentElement.clientWidth`);
        // Taller than the frame, with a scroll bar here: the engine's window
        // is the width left beside it (what's placed by the width, a
        // carousel's slides, is where it's shown).
        await goTo(site + "view.html?tall", "View");
        let fw = await frameWidth();
        if (fw >= await ev(`Math.round(document.getElementById("go_view").getBoundingClientRect().width)`)) throw new Error("no scroll bar to leave out");
        await frameWait(`document.getElementById("w")?.textContent === "width ${fw}"`, `the tall page at ${fw} wide, beside its scroll bar`);
        await goTo(site + "view.html", "View");
        fw = await frameWidth();
        await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "wide"`, `the page at ${fw} wide`);
        // Narrower: the page's own resize handler and media query follow.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
        try {
            fw = await frameWidth();
            await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "narrow"`, `the page at ${fw} wide`);
            // A menu placed by measuring its header lands under it.
            await frameClick("#menu");
            await frameWait(`document.getElementById("overlay")?.style.top === "123px"`, "the menu under the header");
            // Turned: the page's screen.orientation and (orientation: …)
            // follow this device's, a half turn (no size change) too.
            await cdp("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "portraitPrimary", angle: 0 } });
            await frameWait(`document.getElementById("or")?.textContent === "portrait-primary 0 portrait"`, "the page held upright");
            await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "landscapePrimary", angle: 90 } });
            await frameWait(`document.getElementById("or")?.textContent === "landscape-primary 90 landscape"`, "the page turned");
            await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 500, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: "landscapeSecondary", angle: 270 } });
            await frameWait(`document.getElementById("or")?.textContent === "landscape-secondary 270 landscape"`, "the page turned the other way");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        return `${fw} wide`;
    });

    await step("what the page observes is seen as it's shown here: a picture loads once scrolled to", async () => {
        await goTo(site + "lazy.html", "Lazy");
        await frameWait(`document.getElementById("feature")?.textContent === "feature yes"`, "the feature test passing");
        await frameWait(`document.getElementById("state")?.textContent === "not visible"`, "the picture seen as not visible");
        const before = await frame(`document.getElementById("lazy").getAttribute("src") || ""`);
        if (before) throw new Error(`the picture loaded before it was scrolled to: ${before.slice(0, 40)}`);
        await frame(`document.getElementById("lazy").scrollIntoView()`);
        await frameWait(`(document.getElementById("lazy").getAttribute("src") || "").startsWith("blob:") && document.getElementById("state").textContent.startsWith("loaded")`, "the picture loaded once scrolled to");
        return await frame(`document.getElementById("state").textContent`);
    });

    await step("an observer's callback can ask a question, and the page carries on", async () => {
        await goTo(site + "ioalert.html", "Observed alert");
        await waitFor(`document.getElementById("go_dialog").open`, "the alert");
        const said = await ev(`document.querySelector("#go_dialog p").textContent`);
        if (!said.includes("seen it")) throw new Error(`the alert said ${said}`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("after")?.textContent === "after the alert"`, "the page carrying on");
    });

    // at is where on the screen the element in the frame that sel finds is,
    // fx and fy across and down it.
    async function at(sel, fx = 0.5, fy = 0.5) {
        const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width * ${fx}, y: b.y + b.height * ${fy} }; })()`);
        const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
        return { x: f.x + r.x, y: f.y + r.y };
    }
    const mouse = (type, p, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "none", ...extra });
    async function clickAt(p, { button = "left", count = 1 } = {}) {
        const buttons = { left: 1, right: 2, middle: 4 }[button];
        await mouse("mousePressed", p, { button, buttons, clickCount: count });
        await mouse("mouseReleased", p, { button, buttons: 0, clickCount: count });
    }
    const pageLog = () => frame(`document.getElementById("log").textContent`);

    await step("the mouse and keys reach the page as a browser's own input, each once", async () => {
        await goTo(site + "input.html", "Input");
        await frameWait(`!!document.getElementById("count")`, "the page");
        await frameClick("#count");
        await frameWait(`document.getElementById("n").textContent === "1"`, "a click, by the mouse");
        await frame(`document.getElementById("count").focus()`);
        await browser.press(" ");
        await frameWait(`document.getElementById("n").textContent === "2"`, "a press, by Space");
        await browser.press("Enter");
        await frameWait(`document.getElementById("n").textContent === "3"`, "a press, by Enter");
        await sleep(1000);
        const n = await frame(`document.getElementById("n").textContent`);
        if (n !== "3") throw new Error(`pressed 3 times, counted ${n}`);
        const log = await pageLog();
        if (log !== "count true;count true;count true;") throw new Error(`the page saw ${log}`);
    });

    await step("hover, a button that listens for the pointer, double and right clicks, the wheel, where in an element", async () => {
        await mouse("mouseMoved", await at("#trigger"));
        await frameWait(`document.getElementById("host").classList.contains("open")`, "the menu shown by hovering");
        await frameClick("#pointer");
        await frameWait(`document.getElementById("log").textContent.includes("pointer pressed")`, "the pointer-only button pressed");
        const pad = await at("#pad", 0.75, 0.5);
        await clickAt(pad);
        await frameWait(`document.getElementById("log").textContent.includes("pad right")`, "the click on the pad's right half");
        await clickAt(pad, { count: 2 });
        await frameWait(`document.getElementById("log").textContent.includes("dblclick")`, "the double click");
        await clickAt(pad, { button: "right" });
        await frameWait(`document.getElementById("log").textContent.includes("contextmenu")`, "the right click");
        await mouse("mouseWheel", pad, { deltaX: 0, deltaY: 120 });
        await frameWait(`document.getElementById("log").textContent.includes("wheel down")`, "the wheel");
    });

    await step("what the engine has covered is clicked all the same; a press let go outside isn't a click", async () => {
        await frameClick("#under");
        await frameWait(`document.getElementById("log").textContent.includes("under clicked")`, "the covered button clicked");
        // Pressed in the frame, let go over the address bar.
        await mouse("mousePressed", await at("#count"), { button: "left", buttons: 1, clickCount: 1 });
        await mouse("mouseReleased", { x: 200, y: 40 }, { button: "left", buttons: 0, clickCount: 1 });
        await frameClick("#count");
        await frameWait(`document.getElementById("n").textContent === "4"`, "the next click");
        await sleep(800);
        const n = await frame(`document.getElementById("n").textContent`);
        if (n !== "4") throw new Error(`counted ${n}, not 4: the press let go outside clicked too`);
    });

    await step("the same video switches from a file to a MediaSource stream", async () => {
        await frame(`window.addEventListener("message", (e) => {
            if (e.source === parent && e.data?.type === "render") window.relayGeneration = e.data.gen;
        })`);
        await goTo(site + "relay.html", "Relay");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 2 && Math.abs(v.duration - 5) < 0.5)`, "the preroll", 30000);
        await ev(`(() => { const v = document.querySelector("video"); v.currentTime = v.duration - 0.2; return v.play(); })()`);
        await frameWait(`document.getElementById("status").textContent === "stream supplied"`, "the site handed over the stream");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.src.startsWith("blob:") && Math.abs(v.duration - 3) < 0.5 && v.currentTime > 0.25)`,
            "the relayed main video advancing", 30000);
        await ev(`window.relayPlayer = document.querySelector("video")`);
        await frame(`window.relayBox = document.getElementById("player");
            window.dispatchEvent(new MessageEvent("message", { source: parent,
                data: { type: "changes", gen: window.relayGeneration, ops: [{ i: -1 }] } }))`);
        await frameWait(`window.relayBox !== document.getElementById("player")`, "the rebuilt player box");
        await sleep(300);
        if (!await ev(`window.relayPlayer === document.querySelector("video") && window.relayPlayer.isConnected`)) {
            throw new Error("a same-page snapshot replaced the native stream player");
        }
    });

    // WebGL drawn in the engine is replayed in the copy (gogl.js, gocanvasgl.go,
    // go-frame-gl.js): webgl.html's canvases, in the steps that follow in turn.
    // The copy's canvas's pixel at (x, y) is within 4 of want's.
    const glAt = (id, x, y, want) => `(() => { const c = document.getElementById(${JSON.stringify(id)}); const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
        if (!gl) return false; const p = new Uint8Array(4); gl.readPixels(${x}, ${y}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return ${JSON.stringify(want)}.every((v, i) => v === null || Math.abs(v - p[i]) <= 4); })()`;

    await step("WebGL drawn in the engine is replayed in the copy: WebGL1 and WebGL2", async () => {
        await goTo(site + "webgl.html", "WebGL");
        await frameWait(`${glAt("still", 32, 32, [0, 255, 0, 255])} && ${glAt("still", 2, 2, [255, 0, 0, 255])}`, "the WebGL1 square, green on red");
        await frameWait(`${glAt("two", 32, 32, [0, 0, 255, 255])} && ${glAt("two", 2, 2, [255, 0, 0, 255])}`, "the WebGL2 square, blue on red");
    });

    await step("a WebGL animation is shown frame by frame, through its log's compaction, and its canvas still takes clicks and is seen by the page's IntersectionObserver", async () => {
        // The animation, started by a click given to the engine's page: frames
        // as it goes (sent as the calls since the last), then its last one,
        // after its log has been compacted and sent whole (the canvas
        // replaced for it), and a click there still reaches the page.
        await frameWait(glAt("moving", 32, 32, [0, 0, 0, 255]), "the animation's first frame");
        const t0 = Date.now();
        await frameClick("#moving");
        const seen = new Set();
        for (const end = Date.now() + 20000; Date.now() < end; await sleep(150)) {
            const p = await frame(`(() => { const gl = document.getElementById("moving").getContext("webgl"); const p = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p.join(); })()`);
            seen.add(p);
            if (p === "255,0,128,255") break;
        }
        if (!seen.has("255,0,128,255")) throw new Error(`the animation's last frame not shown: ${[...seen].join(" ")}`);
        if (seen.size < 3) throw new Error(`the animation shown in ${seen.size} frames`);
        const animated = Date.now() - t0;
        await frameClick("#moving");
        await frameWait(`${glAt("moving", 32, 32, [0, 0, 255, 255])} && document.getElementById("n").textContent === "clicked"`, "the animated canvas, clicked again, blue");
        // The page's IntersectionObserver still sees it, scrolled out and in.
        await frameWait(`document.getElementById("io").textContent === "in"`, "the page told its canvas is in view");
        await frame(`scrollTo(0, 2500)`);
        await frameWait(`document.getElementById("io").textContent === "out"`, "the page told its canvas, replaced, is out of view");
        await frame(`scrollTo(0, 0)`);
        await frameWait(`document.getElementById("io").textContent === "in"`, "the page told its canvas is in view again");
        return `${seen.size} frames of the animation seen, its last ${animated} ms after the click`;
    });

    await step("a WebGL canvas drawn past its log's cap is shown unavailable, its context given up, greyed", async () => {
        // Drawn past the cap: not shown, and its last frame not left either.
        await frameWait(glAt("overrun", 32, 32, [0, 255, 0, 255]), "the canvas to overrun, green");
        await frameClick("#overrun");
        // (Its replay context given up, freeing the GPU's memory: nothing
        // drawn, on a grey background.)
        await frameWait(`(() => { const c = document.getElementById("overrun"); return /unsupported|unavailable/.test(c.title) && c.style.backgroundColor === "rgb(221, 221, 221)" && c.getContext("webgl").isContextLost(); })()`, "the overrun canvas unavailable, its context given up, greyed out");
    });

    await step("a WebGL canvas the page resizes is resized in the copy", async () => {
        // Resized by the page and drawn again: the copy's canvas too.
        await frameWait(glAt("sized", 32, 32, [0, 255, 0, 255]), "the canvas to resize, green");
        await frameClick("#sized");
        await frameWait(`document.getElementById("sized").width === 96 && document.getElementById("sized").height === 48 && ${glAt("sized", 48, 24, [0, 0, 255, 255])} && ${glAt("sized", 2, 2, [255, 0, 0, 255])}`, "the resized canvas, 96 by 48, blue on red");
    });

    await step("a WebGL update past a batch's budget still comes", async () => {
        // An update past a batch's WebGL budget still comes (first in its batch).
        await frameWait(glAt("upload", 32, 32, [0, 255, 0, 255]), "the canvas to upload to, green");
        await frameClick("#upload");
        await frameWait(`/mirrored/.test(document.getElementById("upload").title) && ${glAt("upload", 32, 32, [0, 0, 255, 255])}`, "the big upload's canvas, blue, still mirrored", 30000);
    });

    await step("the viewer's WebGL contexts lost together are given back and drawn again; a shader the viewer can't compile shown unavailable", async () => {
        // The viewer's contexts lost together, as a GPU reset loses them, and
        // given back: each replayed from what it kept (one reset, however
        // many contexts it took).
        await frame(`(window.__lose = ["still", "two", "moving"].map((id) => { const c = document.getElementById(id), lose = (c.getContext("webgl2") || c.getContext("webgl")).getExtension("WEBGL_lose_context"); lose.loseContext(); return lose; }), 0)`);
        await frameWait(`["still", "two", "moving"].every((id) => /unavailable/.test(document.getElementById(id).title))`, "the lost contexts labelled");
        await frame(`(window.__lose.forEach((lose) => lose.restoreContext()), 0)`);
        await frameWait(`["still", "two", "moving"].every((id) => /mirrored/.test(document.getElementById(id).title)) && ${glAt("still", 32, 32, [0, 255, 0, 255])} && ${glAt("still", 2, 2, [255, 0, 0, 255])} && ${glAt("two", 32, 32, [0, 0, 255, 255])} && ${glAt("moving", 32, 32, [0, 0, 255, 255])}`, "the contexts given back, drawn again");
        const titles = await frame(`["still", "two", "moving", "broken"].map((id) => document.getElementById(id).title)`);
        if (titles.slice(0, 3).some((t) => !/mirrored/.test(t)) || !/unavailable/.test(titles[3])) throw new Error(`the canvases say ${JSON.stringify(titles)}`);
    });

    await step("WebGL in embedded pages of the same site and another, still and animating", async () => {
        // In embedded pages: the same site's (read by the page's agent, its
        // canvases by way of the page's gogl.js) and another site's (read in
        // a world of its own), still and animating.
        const pixelIn = (id) => `(() => { let c; const walk = (r) => { for (const e of r.querySelectorAll("*")) { if (e.id === ${JSON.stringify(id)} && e.localName === "canvas") c = e; if (e.shadowRoot) walk(e.shadowRoot); } }; walk(document);
            const gl = c?.getContext("webgl2") || c?.getContext("webgl"); if (!gl) return ""; const p = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return p.join(); })()`;
        const inFrame = (id, want) => `${pixelIn(id)} === ${JSON.stringify(want.join())}`;
        for (const [frameSite, which] of [[site, "the same site's"], [adSite, "another site's"]]) {
            await goTo(site + "glframe.html?src=" + encodeURIComponent(frameSite + "webgl.html"), "GL frame");
            await frameWait(`${inFrame("still", [0, 255, 0, 255])} && ${inFrame("two", [0, 0, 255, 255])}`, `WebGL in ${which} frame`);
            await goTo(site + "glframe.html?src=" + encodeURIComponent(frameSite + "glanim.html"), "GL frame");
            const frames = new Set();
            for (const end = Date.now() + 25000; Date.now() < end && !frames.has("255,0,0,255"); await sleep(100)) frames.add(await frame(pixelIn("a")));
            frames.delete("");
            if (!frames.has("255,0,0,255")) throw new Error(`the animation in ${which} frame not shown to its end: ${[...frames].join(" ")}`);
            if (frameSite === site && frames.size < 5) throw new Error(`the animation in ${which} frame shown in ${frames.size} frames`);
        }
    });

    await step("a page's WebGL canvases past 16 are labelled; one replacing its canvas 20 times still shows its last", async () => {
        // A page with more WebGL canvases than are mirrored: the rest so labelled.
        await goTo(site + "glmany.html", "GL many");
        await frameWait(`(() => { const t = [...document.querySelectorAll("canvas")].map((c) => c.title); return t.length === 20 && t.filter((x) => /mirrored/.test(x)).length === 16 && t.filter((x) => /unsupported|unavailable/.test(x)).length === 4; })()`, "16 of 20 canvases mirrored, 4 labelled");
        // A page replacing its WebGL canvas more times than may be mirrored at
        // once: those gone aren't counted, so its last is still shown.
        await goTo(site + "glswap.html", "GL swap");
        await frameWait(`document.querySelectorAll("canvas").length === 1 && /mirrored/.test(document.getElementById("c")?.title) && ${glAt("c", 16, 16, [0, 0, 255, 255])}`, "the 20th WebGL canvas, mirrored, blue", 20000).catch(async (err) => {
            const shows = await frame(`JSON.stringify({ canvases: document.querySelectorAll("canvas").length, title: document.getElementById("c")?.title, n: document.getElementById("n")?.textContent })`).catch((e) => e.message);
            throw new Error(`${err.message} (it shows ${shows})`);
        });
    });

    await step("three.js draws in the engine and in the copy", async () => {
        // three.js: a red box on blue; a lit, textured green ball on black.
        await goTo(site + "three.html", "Three");
        await frameWait(`document.getElementById("s").textContent === "drawn"`, "three.js drawing in the engine");
        await frameWait(`${glAt("three", 64, 64, [255, 0, 0, 255])} && ${glAt("three", 2, 2, [0, 0, 255, 255])}`, "three.js's red box on blue");
        await frameWait(`document.getElementById("f").textContent === "20"`, "three.js's 20 frames of requestAnimationFrame", 20000);
        await frameWait(`(() => { const gl = document.getElementById("lit").getContext("webgl2"); const p = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
            return p[1] > 100 && p[0] < 100 && p[2] < 100; })() && ${glAt("lit", 2, 2, [0, 0, 0, 255])}`, "three.js's lit green ball on black");
    });

    await step("the page's view is white where a page draws nothing, and a dark page keeps its colour around a video played under it", async () => {
        // A screenshot's pixel, in the view's right half, clear of its notes.
        const viewPixel = async () => {
            const shot = (await cdp("Page.captureScreenshot", { format: "png" })).data;
            const at = await ev(`(() => { const r = document.getElementById("go_view").getBoundingClientRect(); return { x: Math.round(r.right - 40), y: Math.round(r.top + 300) }; })()`);
            return ev(`new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); r([...g.getImageData(${at.x}, ${at.y}, 1, 1).data].slice(0, 3).join()); }; i.src = "data:image/png;base64,${shot}"; })`);
        };
        await goTo(site + "second.html", "Second");
        await sleep(500);
        if (await viewPixel() !== "255,255,255") throw new Error(`a page with no background of its own shows ${await viewPixel()}, not white`);
        await goTo(site + "darkvideo.html", "Dark video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the video's player under the copy", 30000);
        await sleep(1000);
        if (await viewPixel() !== "16,32,48") throw new Error(`the dark page shows ${await viewPixel()} around its video, not its own #102030`);
        // Black (its blue 0: not taken for no colour), kept too.
        await goTo(site + "blackvideo.html", "Black video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the black page's video under the copy", 30000);
        await sleep(1000);
        if (await viewPixel() !== "0,0,0") throw new Error(`the black page shows ${await viewPixel()} around its video, not its own black`);
        // Its colour written as oklch() (Tailwind 4's), kept too.
        await goTo(site + "darkvideo-oklch.html", "Oklch video");
        await waitFor(`document.getElementById("go_view").classList.contains("go-underlaid")`, "the oklch page's video under the copy", 30000);
        await sleep(1000);
        const oklch = (await viewPixel()).split(",").map(Number);
        if (!oklch.every((v) => v < 90)) throw new Error(`the oklch() dark page shows ${oklch} around its video, not its own colour`);
    });

    await step("a video in another site's embedded page is seen: the page's backgrounds cleared over it", async () => {
        await goTo(site + "framevideo.html", "Frame video");
        await frameWait(`!!document.getElementById("f")?.shadowRoot?.querySelector("[data-go-video].go-media-live")`, "the embedded page's video, its player made", 30000);
        await frameWait(`(() => { const f = document.getElementById("f"), clear = (el) => /^rgba\\(\\d+, \\d+, \\d+, 0\\)$/.test(getComputedStyle(el).backgroundColor);
            return clear(document.body) && clear(document.documentElement) && clear(f.parentElement); })()`, "the page's backgrounds cleared over it", 15000);
    });

    await step("the wheel turned over a sound's player (laid over the page) scrolls the page", async () => {
        await goTo(site + "audiopage.html", "Audio page");
        await waitFor(`!!document.querySelector("audio")`, "the sound's player, over its box", 30000);
        await sleep(500);
        const p = await ev(`(() => { const r = document.querySelector("audio").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (let i = 0; i < 3; i++) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, button: "none", deltaX: 0, deltaY: 200 });
            await sleep(200);
        }
        await frameWait(`scrollY > 100`, "the page scrolled by the wheel over the sound's player");
    });

    await step("a video's box, its style set again by the page as it plays, stays clear over it", async () => {
        await goTo(site + "restyle.html", "Restyle");
        await frameWait(`!!document.querySelector("#clip.go-media-live")`, "the video, its player made", 30000);
        await waitFor(`document.title.startsWith("Restyle done")`, "the page's restyle", 15000);
        await sleep(1000);
        const after = await frame(`getComputedStyle(document.getElementById("box")).backgroundColor`);
        if (after !== "rgba(0, 0, 0, 0)") throw new Error(`the box's background covers the video again: ${after}`);
    });

    await step("a video plays in a player under the copy, its file read through the server", async () => {
        await goTo(site + "video.html", "Video");
        await frameWait(`document.querySelector("#clip[data-go-video]")?.classList.contains("go-media-live")`, "the clip's box, its player made");
        const notes = await frame(`[document.getElementById("streamed").textContent, document.getElementById("silent").textContent]`);
        if (!/own player/.test(notes[0]) || !/nothing to play/.test(notes[1])) throw new Error(`the other boxes say ${JSON.stringify(notes)}`);
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1 && Math.abs(v.duration - 5) < 0.5)`, "the player's clip, 5 s", 30000);
        await ev(`document.querySelector("video").play()`);
        await waitFor(`document.querySelector("video").currentTime > 0.5`, "the clip playing", 30000);
        // Aligned with its box, under the transparent frame.
        const over = await ev(`(() => { const v = document.querySelector("video"), f = document.getElementById("go_view");
            const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
            const under = v.parentElement && f.compareDocumentPosition(v.parentElement) & Node.DOCUMENT_POSITION_PRECEDING;
            return under && vr.width > 100 && vr.left >= fr.left && vr.right <= fr.right + 1 && vr.top >= fr.top; })()`);
        if (!over) throw new Error("the player isn't under its box, within the frame");
        // The page in the engine told the file's size and length, as a
        // browser's player would (gomedia.js): the engine has no media.
        await frameWait(`/^[1-9][0-9]*x[1-9][0-9]* 5 s$/.test(document.getElementById("meta").textContent)`, "the page told the video's size and length");
        // The wheel turned over the video hole scrolls the page (hits the frame).
        const y0 = await frame(`scrollY`);
        const p = await ev(`(() => { const r = document.querySelector("video").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, button: "none", deltaX: 0, deltaY: 200 });
        await frameWait(`scrollY > ${y0} + 100`, "the page scrolled by the wheel over the player");
        await frame(`scrollTo(0, scrollY + document.getElementById("clip").getBoundingClientRect().top + 50)`);
        await waitFor(`(() => {
            const video = document.querySelector("video"), view = document.getElementById("go_view");
            const rect = video.getBoundingClientRect(), style = getComputedStyle(video);
            return Math.abs(rect.top - view.getBoundingClientRect().top + 50) < 1 &&
                rect.width === 320 && rect.height === 180 && style.clipPath.startsWith("inset(50px") &&
                style.objectFit === "cover" && style.objectPosition === "75% 25%";
        })()`, "the partly scrolled video retains its size and fit");
        await ev(`(() => {
            const v = window.rotatingPlayer = document.querySelector("video");
            v.currentTime = 0;
            return v.play();
        })()`);
        await frame(`window.addEventListener("resize", () => {
            setTimeout(() => {
                const box = document.getElementById("clip");
                const landscape = innerWidth > innerHeight;
                box.style.width = landscape ? "440px" : "280px";
                box.style.height = landscape ? "248px" : "158px";
            }, 120);
        })`);
        try {
            for (const [width, height, type, angle, expected] of [
                [500, 800, "portraitPrimary", 0, 280],
                [900, 500, "landscapePrimary", 90, 440],
                [500, 800, "portraitPrimary", 0, 280],
            ]) {
                await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenOrientation: { type, angle } });
                await frameWait(`document.getElementById("clip").getBoundingClientRect().width === ${expected}`, "the delayed player layout");
                const box = await frame(`(() => { const r = document.getElementById("clip").getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
                await waitFor(`(() => {
                    const v = window.rotatingPlayer, f = document.getElementById("go_view").getBoundingClientRect();
                    const r = v.getBoundingClientRect(), b = ${JSON.stringify(box)};
                    return v.isConnected && Math.abs(r.x - f.x - b.x) < 1 && Math.abs(r.y - f.y - b.y) < 1 &&
                        Math.abs(r.width - b.w) < 1 && Math.abs(r.height - b.h) < 1 &&
                        b.y < -1 && Math.abs(parseFloat(getComputedStyle(v).clipPath.slice(6)) + b.y) < 1 &&
                        getComputedStyle(v).objectFit === "cover";
                })()`, "the same clipped overlay follows the rotated box");
            }
            const time = await ev(`window.rotatingPlayer.currentTime`);
            await waitFor(`window.rotatingPlayer.currentTime > ${time}`, "playback continues after rotation");
        } finally {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        await goTo(site + "second.html", "Second");
        await waitFor(`!document.querySelector("video")`, "the player gone with its page");
    });

    await step("the menu's videos each have Save: pressed, a ring as it saves, then said saved", async () => {
        await goTo(site + "video.html", "Video");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1)`, "the player", 30000);
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        // Download sits left of Play/Pause (Watch … Download … Play/Pause … Skip).
        const order = await ev(`(() => {
            const labels = [...document.querySelectorAll("#go_menu_media li .acts button")].map((b) => b.getAttribute("aria-label") || "");
            const i = (re) => labels.findIndex((l) => re.test(l));
            return { labels: labels.map((l) => l.split(" ")[0]), download: i(/^Download /), play: i(/^(Play|Pause) /) };
        })()`);
        // With Files off there's nowhere to save it: no Download.
        if (process.env.GO_NO_FS === "1") {
            if (order.download >= 0 || order.play < 0) throw new Error(`with Files off, the menu's acts: ${JSON.stringify(order)}`);
            await ev(`document.getElementById("go_menu").click()`);
            return "no Download, Files off";
        }
        if (order.download < 0 || order.play < 0 || order.download >= order.play) {
            throw new Error(`menu acts order (want Download left of Play/Pause): ${JSON.stringify(order)}`);
        }
        const save = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Download video/.test(b.getAttribute("aria-label")) || /^Cancel/.test(b.getAttribute("aria-label")) || b.classList.contains("saving"))`;
        await waitFor(`!!${save}`, "the clip's Save in the menu");
        await ev(`${save}.click()`);
        let ring = false;
        for (const end = Date.now() + 30000; Date.now() < end; await sleep(50)) {
            const at = await ev(`(() => { const b = ${save}; const n = b?.closest("li").querySelector(".note"); return { saving: !!b?.classList.contains("saving"), note: n?.hidden ? "" : n?.textContent }; })()`);
            ring = ring || at.saving;
            if (/^Saved /.test(at.note || "")) break;
        }
        const said = await ev(`${save}?.closest("li").querySelector(".note").textContent`);
        if (!/^Saved /.test(said)) throw new Error(`the save said ${JSON.stringify(said)}`);
        if (await ev(`${save}.classList.contains("saving")`)) throw new Error("still a ring, saved");
        await ev(`document.getElementById("go_menu").click()`);
        return ring ? "its ring seen" : "saved before its ring was seen";
    });

    await step("a video loading shows so over its box till it can play; the menu has its address", async () => {
        await goTo(site + "slow.html", "Slow video");
        await waitFor(`(() => { const l = document.querySelector(".go-media-loading"); return !!l && !l.hidden && !!l.querySelector(".bar") && /Asking|Loading|Buffering/.test(l.querySelector(".what").textContent); })()`, "the loading box", 15000);
        const over = await ev(`(() => { const l = document.querySelector(".go-media-loading").getBoundingClientRect(), f = document.getElementById("go_view").getBoundingClientRect();
            return Math.round(l.width) === 320 && Math.round(l.height) === 180 && l.left >= f.left && l.top >= f.top; })()`);
        if (!over) throw new Error("the loading box isn't over the video's box");
        // The menu: marked; its list has the video, its site and file name.
        await waitFor(`document.getElementById("go_menu").classList.contains("has-media")`, "the menu marked");
        await ev(`document.getElementById("go_menu").click()`);
        const row = await ev(`(() => { const li = document.querySelector("#go_menu_media li"); return li && { state: li.querySelector(".state").textContent, where: li.querySelector(".where").textContent, title: li.querySelector(".where").title, label: li.querySelector("button").getAttribute("aria-label") }; })()`);
        if (!row || !row.where.endsWith("/clip.mp4?…") || !row.title.endsWith("/clip.mp4?slow") || !row.label.includes("/clip.mp4?slow") || !/Asking|Loading|Buffering/.test(row.state)) throw new Error(`the menu lists ${JSON.stringify(row)}`);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`!document.querySelector(".go-media-loading") && document.querySelector("video")?.readyState >= 2`, "the video ready, the loading box gone", 60000);
    });

    await step("on a phone, a video loading fits its box, small or not; the menu's list of them fits the screen", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await goTo(site + "phone.html", "Phone video");
            await waitFor(`document.querySelectorAll(".go-media-loading:not([hidden])").length === 2`, "both loading", 15000);
            await ev(`document.getElementById("go_menu").click()`);
            await waitFor(`document.querySelectorAll("#go_menu_media li").length === 2`, "both in the menu");
            if (process.env.GO_SHOT) writeFileSync(process.env.GO_SHOT, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
            const got = await ev(`(() => {
                const r = (e) => e.getBoundingClientRect();
                const boxes = [...document.querySelectorAll(".go-media-loading")].sort((a, b) => r(a).top - r(b).top);
                const panel = r(document.getElementById("go_menu_panel"));
                const buttons = [...document.querySelectorAll("#go_menu_media button")].map((b) => Math.round(Math.min(r(b).height, r(b).width)));
                return { fits: boxes.every((b) => b.scrollHeight <= b.clientHeight + 1), small: boxes[1].classList.contains("small"),
                    panel: panel.left >= 0 && panel.right <= innerWidth, buttons };
            })()`);
            if (!got.fits || !got.small || !got.panel || got.buttons.some((h) => h < 44)) throw new Error(`on a phone: ${JSON.stringify(got)}`);
            // Numbered, top first; a row focused outlines its video on the page.
            await ev(`document.querySelectorAll("#go_menu_media li")[1].querySelector("button:not(:disabled)").focus()`);
            const marked = await ev(`(() => { const r = (e) => e.getBoundingClientRect(); const boxes = [...document.querySelectorAll(".go-media-loading")].sort((a, b) => r(a).top - r(b).top);
                return { states: [...document.querySelectorAll("#go_menu_media .state")].map((s) => s.textContent.split(" · ")[0]), outlines: boxes.map((b) => !!b.style.outline) }; })()`);
            if (marked.states.join() !== "Video 1,Video 2" || marked.outlines.join() !== "false,true") throw new Error(`the rows and their videos: ${JSON.stringify(marked)}`);
            await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
            await waitFor(`!document.querySelector(".go-media-loading")`, "both ready", 60000);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a video playing, the phone turned: its player stays shown, and on its box, after a quarter or a half turn", async () => {
        const turn = (w, h, type, angle) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type, angle } });
        await turn(390, 844, "portraitPrimary", 0);
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        // Where the player is against its box (in the frame, so asked of it).
        const offBy = async () => {
            const box = await frame(`(() => { const r = document.getElementById("v").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
            return ev(`(() => { const f = document.getElementById("go_view").getBoundingClientRect(), v = document.querySelector("video").getBoundingClientRect(), b = ${JSON.stringify(box)};
                return Math.max(Math.abs(v.x - f.x - b.x), Math.abs(v.y - f.y - b.y), Math.abs(v.width - b.w), Math.abs(v.height - b.h)); })()`);
        };
        // Frames the player wasn't shown in, from now.
        const watch = () => ev(`(() => { window.__hidden = 0; window.__watching = true; const tick = () => { const v = document.querySelector("video"); if (!v || getComputedStyle(v).display === "none") __hidden++; if (__watching) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 0; })()`);
        const watched = () => ev(`(() => { __watching = false; return __hidden; })()`);
        let insets = false;
        try {
            await goTo(site + "rotate.html", "Rotate");
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3 && getComputedStyle(v).display !== "none"; })()`, "the video playing, shown", 30000);
            const found = [];
            // A quarter turn.
            await watch();
            await turn(844, 390, "landscapePrimary", 90);
            await sleep(1500);
            const quarter = { hidden: await watched(), off: await offBy() };
            found.push(`quarter turn: hidden ${quarter.hidden} frames, off by ${Math.round(quarter.off)} px`);
            if (quarter.hidden > 0 || quarter.off > 1) throw new Error(found.join("; "));
            // A half turn, a notch's side swapped (where the browser can say).
            insets = (await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { left: 47, right: 0, top: 0, bottom: 0 } }).then(() => true, () => false));
            if (insets) {
                await sleep(1000);
                const before = Math.round(await offBy());
                await watch();
                await cdp("Emulation.setSafeAreaInsetsOverride", { insets: { left: 0, right: 47, top: 0, bottom: 0 } });
                await turn(844, 390, "landscapeSecondary", 270);
                await sleep(1500);
                const half = { hidden: await watched(), off: await offBy() };
                found.push(`half turn: off by ${before} px before, hidden ${half.hidden} frames, off by ${Math.round(half.off)} px after`);
                if (before > 1 || half.hidden > 0 || half.off > 1) throw new Error(found.join("; "));
            } else {
                found.push("half turn: this browser can't emulate a notch");
            }
            return found.join("; ");
        } finally {
            if (insets) await cdp("Emulation.setSafeAreaInsetsOverride", { insets: {} }).catch(() => {});
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("the menu's autoplay switch pauses every video and holds pages back; its player: full screen, speed, back, given back as closed", async () => {
        // A real click (the person's: full screen needs one), where sel is.
        const press = async (sel) => {
            const p = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 });
        };
        await goTo(site + "auto.html", "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()`, "the page's video playing", 30000);
        // (Opened, not toggled: a step before may have left it open.)
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        await waitFor(`!!document.querySelector("#go_menu_media li") && document.getElementById("go_menu_autoplay").getAttribute("aria-checked") === "true"`, "the menu's videos");
        // Autoplay paused: the video paused, its page told; the page
        // playing it again held back; played from the menu, it plays.
        // (Pressed where it is once the menu's list has settled: rows drawn
        // as the players report move it.)
        for (let last = "", end = Date.now() + 5000; Date.now() < end; await sleep(150)) {
            const at = await ev(`JSON.stringify(document.getElementById("go_menu_autoplay").getBoundingClientRect())`);
            if (at === last) break;
            last = at;
        }
        await press("#go_menu_autoplay");
        try {
            await waitFor(`document.querySelector("video").paused && document.getElementById("go_menu_autoplay").getAttribute("aria-checked") === "false"`, "paused by the switch");
            await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
            await frameClick("#again");
            await sleep(1500);
            if (!(await ev(`document.querySelector("video").paused`))) throw new Error("the page played it, autoplay paused");
            await ev(`document.getElementById("go_menu").click()`);
            await waitFor(`!!document.querySelector("#go_menu_media li .acts button")`, "the menu again");
            await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "")).click()`);
            await waitFor(`!document.querySelector("video").paused`, "played from the menu");
        } finally {
            await ev(`(() => { if (document.getElementById("go_menu_panel").hidden) document.getElementById("go_menu").click(); const b = document.getElementById("go_menu_autoplay"); if (b.getAttribute("aria-checked") === "false") b.click(); })()`);
        }
        // The player: the video taken into it, full screen, kept to its
        // proportions; its speed and back 10 s; closed, given back.
        // Watch stays first in the acts row: the first video's, pressed once
        // it's offered (any's offered, the first's could still be loading).
        await waitFor(`(() => { const b = document.querySelector("#go_menu_media li .acts button:nth-child(1)"); return /^Watch /.test(b?.getAttribute("aria-label") || "") && !b.disabled; })()`, "Watch offered for the first video");
        await press("#go_menu_media li .acts button:nth-child(1)");
        await waitFor(`!!document.querySelector("#video_player .stage video") && document.fullscreenElement?.id === "video_player"`, "the video in the player, full screen", 10000);
        const shape = await ev(`(() => { const v = document.querySelector("#video_player video"); return { fit: getComputedStyle(v).objectFit, controls: v.controls }; })()`);
        if (shape.fit !== "contain" || shape.controls) throw new Error(`in the player: ${JSON.stringify(shape)}`);
        // Its controls hidden as it plays untouched; a tap where its play
        // button is (unseen) shows them, and doesn't pause it.
        await ev(`document.querySelector("#video_player video").play()`);
        await waitFor(`!document.getElementById("video_player").classList.contains("awake") && !document.querySelector("#video_player video").paused`, "its controls hidden, playing", 8000);
        await press('#video_player .glyph.big');
        await waitFor(`document.getElementById("video_player").classList.contains("awake")`, "its controls shown by the tap");
        if (await ev(`document.querySelector("#video_player video").paused`)) throw new Error("a tap on its hidden controls paused it");
        await ev(`(() => { const s = document.querySelector("#video_player .speed"); s.value = "2"; s.dispatchEvent(new Event("change")); })()`);
        if ((await ev(`document.querySelector("#video_player video").playbackRate`)) !== 2) throw new Error("its speed wasn't set");
        await ev(`document.querySelector("#video_player video").currentTime = 3`);
        await waitFor(`document.querySelector("#video_player video").currentTime >= 3`, "at 3 s");
        await press('#video_player button[aria-label^="Back"]');
        await waitFor(`document.querySelector("#video_player video").currentTime < 2`, "back 10 s (to its start)");
        // A double tap at the right: on 10 s (to its end), marked there.
        // Download: offered where Files are on (it saves into Downloads), not where they're off.
        const offered = await ev(`!!document.querySelector('#video_player button[aria-label^="Download"]')`);
        if (offered !== (process.env.GO_NO_FS !== "1")) throw new Error(`Download ${offered ? "offered, Files off" : "not offered"}`);
        if (offered) {
            // Saved, it's asked for as it was played: the tab's user agent, the site's cookies, the page as Referer.
            const told = async () => JSON.parse((await (await fetch(site + "seen")).text()).match(/<pre id=s>(.*)<\/pre>/s)[1]);
            const savesBefore = (await told()).saved?.length ?? 0;
            await press('#video_player button[aria-label^="Download"]');
            await waitFor(`/^Saved .* into Downloads\\.$/.test(document.querySelector("#video_player .note")?.textContent ?? "")`, "the clip saved into Downloads", 30000);
            const s = await told();
            const saved = s.saved?.at(-1), played = s["/clip.mp4"];
            if (!(s.saved?.length > savesBefore) || !played?.ua || !played.referer || saved.ua !== played.ua || saved.cookie !== played.cookie || saved.referer !== played.referer) {
                throw new Error(`saved with ${JSON.stringify(saved)}, played with ${JSON.stringify(played)}`);
            }
        }
        // (Paused: the clip loops, and 10 s on is its end, looped back from;
        // its mark noted as it's shown: it's gone in a moment.)
        await ev(`(() => { const v = document.querySelector("#video_player video"); v.pause(); v.currentTime = 1; const f = document.querySelector("#video_player .flash"); window.__flashed = ""; new MutationObserver(() => { if (f.classList.contains("shown")) window.__flashed = f.className; }).observe(f, { attributes: true }); return 0; })()`);
        await waitFor(`Math.abs(document.querySelector("#video_player video").currentTime - 1) < 0.2`, "at 1 s, paused");
        const right = await ev(`(() => { const r = document.getElementById("video_player").getBoundingClientRect(); return { x: Math.round(r.right - r.width * 0.2), y: Math.round(r.top + r.height * 0.3) }; })()`);
        for (const n of [1, 2]) {
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...right, button: "left", buttons: 1, clickCount: n });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...right, button: "left", buttons: 0, clickCount: n });
        }
        await waitFor(`document.querySelector("#video_player video").currentTime > 4 && /\\bright\\b/.test(window.__flashed)`, "on 10 s by a double tap at the right, marked there");
        await press('#video_player button[aria-label^="Close the player"]');
        await waitFor(`!document.getElementById("video_player") && !document.fullscreenElement && !!document.querySelector("video") && !document.querySelector("video").controls && getComputedStyle(document.querySelector("video")).display !== "none"`, "given back to its box, under the copy (no native controls)", 10000);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("Skip held blocks videos from the video's own host, not the page's site: stopped, kept in Site controls, and Undo has them again", async () => {
        const press = async (sel, hold = 0) => {
            const p = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 });
            if (hold) await sleep(hold);
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 });
        };
        const settings = async () => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings" }); t.close(); return { hosts: t.reply.videoHosts ?? [], sites: t.reply.noVideos ?? [] }; })`);
        const host = new URL(site).hostname;
        // The page this site's, its video another's (as test.com's page with a video from
        // something.com): that one's host is what's blocked.
        const page = adSite ? site + "auto-from?from=" + encodeURIComponent(adSite) : site + "auto.html";
        const videoHost = adSite ? new URL(adSite).hostname : host;
        await goTo(page, "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "the video playing", 30000);
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(`!!document.querySelector("#go_menu_media li .acts button:last-child:not(:disabled)")`, "Skip offered");
        // Held by a finger (a phone's), wavering a little as fingers do. (Where it is
        // measured with touch on: a touch screen's layout is roomier, and moves it.)
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(300);
            const at = await ev(`(() => { const r = document.querySelector("#go_menu_media li .acts button:last-child").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
            await sleep(300);
            await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + 3, y: at.y + 2 }] });
            await sleep(600);
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
        try {
            await waitFor(`!document.querySelector("video") && document.getElementById("go_notice").textContent.includes(${JSON.stringify("Videos from " + videoHost + " are blocked")})`, "its video stopped, said so");
            await frameWait(`/blocked/.test(document.getElementById("v").textContent)`, "its box says why");
            await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
            const set = await settings();
            if (!set.hosts.includes(videoHost) || set.sites.includes(host) || adSite && set.hosts.includes(host)) throw new Error(`the settings: ${JSON.stringify(set)}`);
            // Loaded again: still none.
            await ev(`document.getElementById("go_reload").click()`);
            await sleep(3000);
            await frameWait(`/blocked/.test(document.getElementById("v").textContent)`, "blocked, loaded again");
            if (await ev(`!!document.querySelector("video")`)) throw new Error("a player, its host's videos blocked");
            // The page's site's own video, from its own host: played.
            if (adSite) {
                await goTo(site + "auto.html", "Autoplay");
                await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "the site's own video playing", 30000);
            }
            // Undo (from the notice, still there? if not, the setting).
        } finally {
            const undo = await ev(`(() => { const n = document.getElementById("go_notice"); const b = n.querySelector(".primary"); if (!n.hidden && b && !b.hidden && b.textContent === "Undo") { b.click(); return true; } return false; })()`);
            if (!undo) await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", name: ${JSON.stringify(videoHost)}, setting: "videos-host-allow" }); t.close(); })`);
        }
        if ((await settings()).hosts.includes(videoHost)) throw new Error("still blocked after Undo");
        await goTo(page, "Autoplay");
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused; })()`, "its video playing again", 30000);
    });

    await step("a video skipped is, to the page, played to its end, whether playing or still loading: from the menu, or Shift+N", async () => {
        await goTo(site + "skip.html", "Skip");
        // The second still loading (sent slowly): skipped from the menu's list
        // (the page's videos, top first), it stops.
        await waitFor(`!!document.querySelector(".go-media-loading:not([hidden])")`, "the second loading", 15000);
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(`document.querySelectorAll("#go_menu_media li").length === 2`, "both videos in the menu");
        await ev(`document.querySelectorAll("#go_menu_media li")[1].querySelector(".acts button:last-child").click()`);
        await frameWait(`document.getElementById("b-out").textContent === "b ended at 0 true"`, "the second ended, to its page");
        await waitFor(`!document.querySelector(".go-media-loading")`, "its loading gone");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        // The first playing: Shift+N on it skips it, at its end.
        await waitFor(`[...document.querySelectorAll("video")].some((v) => !v.paused && v.currentTime > 0.3)`, "the first playing", 30000);
        await ev(`[...document.querySelectorAll("video")].find((v) => !v.paused).focus()`);
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "N", code: "KeyN", modifiers: 8, windowsVirtualKeyCode: 78 });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "N", code: "KeyN", modifiers: 8, windowsVirtualKeyCode: 78 });
        await frameWait(`document.getElementById("a-out").textContent === "a ended at 5 true"`, "the first ended at its end, to its page");
        await waitFor(`(() => { const v = [...document.querySelectorAll("video")]; return v.length === 1 && v[0].paused && Math.round(v[0].currentTime) === 5; })()`, "its player paused at the end, the other's closed");
        // In the menu: a skipped video can be hidden, then restored by
        // opening it in the /go player or by playing it again.
        await ev(`document.getElementById("go_menu").click()`);
        const rows = await ev(`[...document.querySelectorAll("#go_menu_media li")].map((li) => ({ state: li.querySelector(".state").textContent, hide: li.querySelector(".acts button:last-child").getAttribute("aria-label"), playDisabled: [...li.querySelectorAll(".acts button")].find((b) => /^(Play|Pause) /.test(b.getAttribute("aria-label") || ""))?.disabled }))`);
        if (rows.length !== 1 || rows[0].state !== "Skipped" || !rows[0].hide.startsWith("Hide") || rows[0].playDisabled) throw new Error(`the menu, after: ${JSON.stringify(rows)}`);
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display === "none"`, "the skipped video hidden");
        await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "")).click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display !== "none" && !document.querySelector("video").paused`, "the video restored by Play");
        // (Each pressed once it's offered: Skip as the video can be skipped again, Hide once it's skipped.)
        const offered = (what) => `(() => { const b = document.querySelector("#go_menu_media li .acts button:last-child"); return !!b && !b.disabled && b.getAttribute("aria-label").startsWith(${JSON.stringify(what)}); })()`;
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(offered("Skip"), "Skip offered again");
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`document.querySelector("#go_menu_media .state").textContent === "Skipped"`, "the video ended again");
        await ev(`document.getElementById("go_menu").click()`);
        await waitFor(offered("Hide"), "Hide offered again");
        await ev(`document.querySelector("#go_menu_media li .acts button:last-child").click()`);
        await waitFor(`getComputedStyle(document.querySelector("video")).display === "none"`, "the video hidden again");
        await ev(`document.getElementById("go_menu").click()`);
        await ev(`[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Watch /.test(b.getAttribute("aria-label") || "")).click()`);
        await waitFor(`!!document.querySelector("#video_player video")`, "the hidden video opened in the /go player");
        await ev(`document.querySelector("#video_player button[aria-label^='Close the player']").click()`);
        await waitFor(`!!document.querySelector("video") && getComputedStyle(document.querySelector("video")).display !== "none"`, "the video restored from the /go player");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("prompt, a page asking as it loads, a frame asking, and a page asking in a loop", async () => {
        const answer = async (text, ok = true) => {
            await waitFor(`document.getElementById("go_dialog").open`, "the dialog", 30000).catch(async (err) => {
                // What the page and the frame were doing (an intermittent miss in CI).
                const state = await ev(`JSON.stringify({ status: document.getElementById("go_status").textContent, busy: document.getElementById("go_view").getAttribute("aria-busy"),
                    notice: document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent })`).catch((e) => e.message);
                const there = await frame(`document.getElementById("status")?.textContent`).catch((e) => e.message);
                throw new Error(`${err.message}; page ${state}; frame status ${there}; exceptions ${JSON.stringify(exceptions)}`);
            });
            if (text !== undefined) await ev(`document.querySelector("#go_dialog input[type=text]").value = ${JSON.stringify(text)}`);
            await ev(`document.querySelector("#go_dialog ${ok ? ".ok" : ".cancel"}").click()`);
        };
        await goTo(site + "ask-prompt.html", "Prompts");
        await frameClick("#ask");
        await waitFor(`document.getElementById("go_dialog").open && document.querySelector("#go_dialog input[type=text]").value === "nobody"`, "the prompt, its default", 30000);
        await answer("Ann");
        await frameWait(`document.getElementById("status").textContent === "prompted Ann"`, "the answer typed");
        await frameClick("#ask");
        await answer(undefined, false);
        await frameWait(`document.getElementById("status").textContent === "prompted null"`, "no answer");
        await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "ask-load.html")}; i.form.requestSubmit(); })()`);
        await answer();
        await waitFor(`document.title.startsWith("Asks")`, "the page", 30000);
        await frameWait(`!!document.getElementById("after")`, "the rest of the page, once answered");
        await goTo(site + "ask-frame.html", "Frame asks");
        await answer();
        await frameWait(`document.getElementById("status").textContent === "answered true"`, "the frame's answer");
        // A page asking in a loop: from its second, the person may stop it.
        await goTo(site + "ask-loop.html", "Loop");
        await frameClick("#loop");
        await waitFor(`document.getElementById("go_dialog").open`, "the first", 30000);
        if (!(await ev(`document.querySelector("#go_dialog .quiet").hidden`))) throw new Error("offered to stop it at its first");
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await waitFor(`document.getElementById("go_dialog").open && !document.querySelector("#go_dialog .quiet").hidden`, "the second, offering to stop it", 30000);
        await ev(`document.querySelector("#go_dialog .quiet input").click()`);
        await ev(`document.querySelector("#go_dialog .ok").click()`);
        await frameWait(`document.getElementById("status").textContent === "done"`, "the loop through, unasked", 30000);
        if (await ev(`document.getElementById("go_dialog").open`)) throw new Error("still asking");
    });

    await step("the display is this window; drags within the page, drops from outside, and touches go to the engine", async () => {
        await goTo(site + "hands.html", "Hands");
        const win = await ev(`innerWidth + "x" + innerHeight`);
        await frameWait(`document.getElementById("screen").textContent.startsWith(${JSON.stringify(win + " ")})`, `the display, ${win}`);
        // Within the page: the engine's drag, from the mouse.
        const at = async (sel) => {
            const r = await frame(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
            const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
            return { x: f.x + r.x, y: f.y + r.y };
        };
        await pageShown();
        const from = await at("#a"), to = await at("#t");
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 8; i++) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, button: "left", buttons: 1 });
            await sleep(80);
        }
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
        await frameWait(`document.getElementById("status").textContent === "dropped from the page"`, "the drag within the page");
        // From outside: dragged over, then dropped.
        const data = { items: [{ mimeType: "text/plain", data: "from outside" }], dragOperationsMask: 1 };
        for (const type of ["dragEnter", "dragOver"]) await cdp("Input.dispatchDragEvent", { type, ...to, data });
        await sleep(200);
        await cdp("Input.dispatchDragEvent", { type: "drop", ...to, data });
        await frameWait(`document.getElementById("status").textContent === "dropped from outside"`, "the drop from outside");
        // A touch: a tap, the engine's click from it (once).
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            const tap = await at("#tap");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("status").textContent === "tapped, touches 1"`, "the tap, as a touch");
            await sleep(500);
            const now = await frame(`document.getElementById("status").textContent`);
            if (now !== "tapped, touches 1") throw new Error(`then ${now}: clicked twice?`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a page asking for more than a tab fetches at once has them all, in turn, not refused", async () => {
        await goTo(site + "many.html", "Many");
        await frameWait(`(() => { const imgs = [...document.images]; return imgs.length === 80 && imgs.every((i) => i.complete && i.naturalWidth > 0); })()`, "all 80 pictures (each sent slowly)", 90000);
    });

    await step("a swipe over a video a page swipes by its own script (as YouTube's Shorts on a phone) reaches the page, as a tap there does (the player's under the page)", async () => {
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await goTo(site + "swiped.html", "Swiped");
            await waitFor(`(() => { const v = document.querySelector("video"); return !!v && getComputedStyle(v).display !== "none" && v.getBoundingClientRect().height > 300; })()`, "the reel's player, under the page", 30000);
            const p = await ev(`(() => { const r = document.querySelector("video").getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.7) }; })()`);
            // A tap: the page's, as on a page whose own player it is (a click,
            // no swipe): the player is under the copy (go-media.js).
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "at 0, clicks 1"`, "the tap's click, on the page");
            // A swipe up over it: the page's own script goes to the next.
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [p] });
            for (let k = 1; k <= 8; k++) {
                await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x, y: p.y - 30 * k }] });
                await sleep(30);
            }
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "at 1, clicks 1"`, "the next reel, by the page's swipe (no click)");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
    });

    await step("a touch swipe that scrolls the page clicks nothing; a tap still clicks", async () => {
        await goTo(site + "swipe.html", "Swipe");
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            // Swipes over the buttons, the copy scrolling under the finger as
            // it moves (as a browser scrolls it): it stays over the same
            // button, what's under it not moving. Fast and slow.
            const view = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height * 0.7) }; })()`);
            for (const [i, steps] of [[1, 10], [2, 4], [3, 2]]) {
                const y0 = await frame(`scrollY`);
                await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [view] });
                for (let k = 1; k <= steps; k++) {
                    const dy = Math.round(300 * k / steps);
                    await frame(`scrollTo(0, ${y0 + dy})`);
                    await cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: view.x, y: view.y - dy }] });
                    await sleep(30);
                }
                await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                await sleep(800);
                const out = await frame(`document.getElementById("out").textContent`);
                if (out !== "clicks 0") throw new Error(`swipe ${i} clicked: ${out}`);
            }
            // A tap still a click, once.
            await frame(`scrollTo(0, 0)`);
            const tap = await at("#b1");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await frameWait(`document.getElementById("out").textContent === "clicks 1 b1"`, "the tap's click");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a frame's own constructors are never handed the agent's functions", async () => {
        await goTo(site + "trap.html", "Trap");
        await frameWait(`document.getElementById("f")?.shadowRoot?.getElementById("inner")?.textContent === "inner changed"`, "the frame's change, seen all the same");
        const status = await frame(`document.getElementById("status").textContent`);
        if (status !== "safe") throw new Error(status);
    });

    await step("a feed: a video the page gives a file and plays plays here, and a swipe scrolls the page", async () => {
        await goTo(site + "feed.html", "Feed");
        // Empty <source src=""> (a placeholder) is nothing to play, not a
        // stuck empty URL that hides a later real src.
        await frameWait(`/nothing to play/.test(document.getElementById("b").textContent)`, "the second box, empty source");
        await frameClick("#nextclip");
        await frameWait(`document.querySelector("#b[data-go-video]")?.textContent === ""`, "its player made for the file it was given");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5)`, "it playing, as the page played it", 30000);
        // Scrolled by the person (a swipe, say: no wheel), and the page
        // sees itself scrolled. (Headless Chrome doesn't scroll the frame by
        // touch: a press, then the scroll, which is the person's still.)
        await frameClick("#scroller");
        await frame(`document.getElementById("scroller").scrollTop = 300`);
        await frameWait(`/^at [1-9]/.test(document.getElementById("status").textContent)`, "the page told of the scroll");
    });

    await step("a page's address space past a gigabyte, little used, is the page's", async () => {
        await goTo(site + "memory.html", "Memory");
        await frameWait(`document.getElementById("s")?.textContent === "memory 1258291200"`, "the page's memory made");
        await sleep(2000);
        // Still the same engine: not ended and the page loaded again.
        if (await ev(`!document.getElementById("go_notice").hidden || /Loading/.test(document.getElementById("go_status").textContent)`)) throw new Error("the page was loaded again");
    });

    await step("a video from a server without byte ranges plays; what a page loads says the page (Referer), unless that's off", async () => {
        await goTo(site + "norange.html", "No ranges");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.readyState >= 1 && Math.abs(v.duration - 5) < 0.5)`, "the clip, 5 s, from a server without ranges", 30000);
        await ev(`[...document.querySelectorAll("video")].find((v) => v.readyState >= 1).play()`);
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5)`, "it playing", 30000);
        await goTo(site + "seen", "Seen");
        let seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
        if (!(seen.norange >= 1)) throw new Error("the server without ranges wasn't asked");
        if (seen["/pic.png"]?.referer !== site + "norange.html") throw new Error(`the picture said ${JSON.stringify(seen["/pic.png"]?.referer)}`);
        // Off: not said.
        const settings = (req) => ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call(${JSON.stringify(req)}); t.close(); return JSON.stringify(t.reply); })`);
        await settings({ type: "go-settings-set", name: "", setting: "referer-off" });
        try {
            await goTo(site + "noreferer.html", "No referer");
            await frameWait(`document.getElementById("pic")?.naturalWidth > 0`, "a picture not fetched before");
            await goTo(site + "seen", "Seen");
            seen = JSON.parse(await frame(`document.getElementById("s").textContent`));
            if (seen["/pic.png"]?.referer !== "") throw new Error(`with it off, the picture said ${JSON.stringify(seen["/pic.png"]?.referer)}`);
        } finally {
            await settings({ type: "go-settings-set", name: "", setting: "referer-on" });
        }
    });

    await step("a player the page hides till its video plays is played, and shown once it does", async () => {
        await goTo(site + "reel-player.html", "Reel player");
        await frameClick("#load");
        await frameWait(`document.getElementById("status")?.textContent === "playing"`, "the page told its video plays");
        await frameWait(`getComputedStyle(document.getElementById("wrap")).visibility === "visible"`, "the player shown by the page");
        await waitFor(`[...document.querySelectorAll("video")].some((v) => v.currentTime > 0.5 && v.style.display !== "none" && v.getBoundingClientRect().width > 300)`, "it under its box, playing", 30000);
        await frameWait(`/^time [1-9][0-9.]*$/.test(document.getElementById("time")?.textContent)`, "the page reading where it is, going on");
    });

    await step("a video's file picked as a browser picks it: an empty <source> passed over; an element's own empty src, nothing", async () => {
        await goTo(site + "sources.html", "Sources");
        await frameWait(`document.querySelector("#a[data-go-video]")?.textContent === ""`, "the first video's player, for its second <source>");
        await frameWait(`/nothing to play/.test(document.getElementById("b")?.textContent || "")`, "the second, its own src empty, nothing to play");
    });

    await step("a player choosing its MediaSource as dash.js does gets one that works", async () => {
        await goTo(site + "dash-like.html", "DASH-like");
        await frameWait(`/^(made|failed)/.test(document.getElementById("out")?.textContent || "")`, "the player's choice");
        const out = await frame(`document.getElementById("out").textContent`);
        // Our ManagedMediaSource relay is always present and constructible.
        if (out !== "made managed true") throw new Error(`dash.js's choice of MediaSource: ${out}`);
    });

    await step("a MediaSource video the page pauses stops here too (as YouTube Shorts' pause)", async () => {
        await goTo(site + "mse-pause.html", "MSE pause");
        // Its player's made but stays paused till it's played (the page's
        // play() of a stream its own player feeds doesn't start it): played
        // from the menu, as the person would.
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
        await waitFor(`!!${play}`, "Play offered in the menu", 30000);
        await ev(`${play}.click()`);
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3; })()`, "the stream playing", 30000);
        await frameWait(`document.getElementById("out").textContent === "play playing"`, "the page told it plays");
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
        await waitFor(`document.getElementById("go_menu_panel").hidden`, "the menu closed");
        await frameClick("#pause");
        await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused");
        await waitFor(`document.querySelector("video").paused`, "its player paused");
        // Played and paused at once (Shorts' pause, before the player's said
        // it plays): the page told it's paused, and the player stays so.
        await frameClick("#quick");
        await frameWait(`document.getElementById("out").textContent === "pause paused"`, "the page told it's paused, played and paused at once");
        await sleep(1500);
        if (!(await ev(`document.querySelector("video").paused`))) throw new Error("the player plays, the page having paused it at once");
        // A pause each time it was paused, the handler's own pause() nothing;
        // pause() on what's paused (not played since) fires nothing.
        if ((await frame(`document.getElementById("count").textContent`)) !== "2") throw new Error(`pause fired ${await frame(`document.getElementById("count").textContent`)} times, not 2`);
        await frameClick("#idle");
        await sleep(500);
        if ((await frame(`document.getElementById("count").textContent`)) !== "2") throw new Error("pause() on a paused video fired pause");
    });

    await step("a video attached as HLS.js does (empty source, then ManagedMediaSource) plays under its box, not as nothing to play", async () => {
        await goTo(site + "mse-hls-like.html", "MSE HLS-like");
        await frameWait(`document.documentElement.getAttribute("data-mms") === "managed"`, "ManagedMediaSource is our relay");
        await frameWait(`/^start:/.test(document.documentElement.getAttribute("data-stream") || "")`, "startstreaming from the underlaid player");
        // Relayed blob on a <source> (HLS.js ManagedMediaSource attach shape):
        // the box must leave the empty-source placeholder once the stream is known.
        await frameWait(`(() => { const b = document.querySelector("[data-go-video]"); const t = b?.textContent || ""; return !!b && !/nothing to play|own player/.test(t); })()`, "its box no longer a placeholder");
        // Stream play() doesn't start the underlaid player until the person
        // plays it (as mse-pause): from the menu.
        await ev(`document.getElementById("go_menu_panel").hidden && document.getElementById("go_menu").click()`);
        const play = `[...document.querySelectorAll("#go_menu_media li .acts button")].find((b) => /^Play /.test(b.getAttribute("aria-label") || "") && !b.disabled)`;
        await waitFor(`!!${play}`, "Play offered in the menu", 30000);
        await ev(`${play}.click()`);
        await waitFor(`(() => { const v = document.querySelector("video"); return !!v && !v.paused && v.currentTime > 0.3 && getComputedStyle(v).display !== "none"; })()`, "the stream playing under its box", 30000);
        await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    });

    await step("a scrolling video feed releases old players and honors the page's dimensions", async () => {
        await goTo(site + "long-feed.html", "Long feed");
        for (let i = 0; i < 11; i++) {
            await frame(`document.getElementById("clips").scrollTop = ${i * 180}`);
            await frameWait(`document.getElementById("clip-${i}")?.textContent === ""`, `clip ${i + 1}'s player`);
            await waitFor(`(() => {
                const players = document.querySelectorAll("video");
                const video = players[0];
                return players.length === 1 && video.readyState >= 1 &&
                    video.getBoundingClientRect().width > 290 && video.getBoundingClientRect().height === 180;
            })()`, `only clip ${i + 1} retained at the feed dimensions`);
        }
    });

    await step("a press, typing, Enter, hover and a tap in an embedded page of another origin reach it there", async () => {
        await goTo(site + "xframe.html", "Other origin");
        const inner = (expr) => frame(`(() => { const root = document.getElementById("x")?.shadowRoot; return root ? (${expr})(root) : null; })()`);
        await frameWait(`!!document.getElementById("x")?.shadowRoot?.querySelector("#b")`, "the embedded page's copy", 20000);
        const p = JSON.parse(await inner(`(root) => { const b = root.querySelector("#b").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); }`));
        const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + p.x, y: f.y + p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`/^pressed \\[/.test(document.getElementById("x")?.shadowRoot?.querySelector("#s")?.textContent || "")`, "the press in the other origin's page", 15000);
        const inCopy = async (sel) => {
            const q = JSON.parse(await inner(`(root) => { const e = root.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: e.x + e.width / 2, y: e.y + e.height / 2 }); }`));
            return { x: f.x + q.x, y: f.y + q.y };
        };
        // Typing in it, and Enter sending its form.
        const field = await inCopy("#t");
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, ...field, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await browser.type("hi");
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#echo")?.textContent === "typed hi"`, "what was typed, in the other origin's page", 15000);
        await browser.press("Enter");
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#sent")?.textContent === "sent hi"`, "its form sent by Enter", 15000);
        // Hovering.
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await inCopy("#h")), button: "none" });
        await frameWait(`document.getElementById("x")?.shadowRoot?.querySelector("#hs")?.textContent === "hovered"`, "the hover in the other origin's page", 15000);
        // A tap: a press there, on what's under the finger (not the
        // iframe's touch, whose place is the engine's iframe's), once.
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            await sleep(500);  // the toolbar as for touch: the page moves down
            Object.assign(f, await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`));
            const tap = await inCopy("#tb");
            await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
            await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            const said = `document.getElementById("x")?.shadowRoot?.querySelector("#ts")?.textContent`;
            await frameWait(`${said} === "tapped 1"`, "the tap in the other origin's page", 15000);
            await sleep(500);
            const now = await frame(said);
            if (now !== "tapped 1") throw new Error(`then ${now}: pressed twice?`);
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
        }
    });

    await step("a scroll box's sizes and scrolling, as shown, for a page that goes by them", async () => {
        await goTo(site + "reels.html", "Reels");
        await frameWait(`document.getElementById("sized")?.textContent === "box 300 high, reels 300"`, "the box's sizes, as shown");
        const f = await ev(`(() => { const b = document.getElementById("go_view").getBoundingClientRect(); return { x: b.x, y: b.y }; })()`);
        const box = JSON.parse(await frame(`(() => { const b = document.getElementById("box").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const want of [1, 2]) {
            await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: f.x + box.x, y: f.y + box.y, deltaX: 0, deltaY: 300 });
            await frameWait(`document.getElementById("status")?.textContent === "reel ${want}"`, `reel ${want}, scrolled to`);
        }
        // The page scrolling it itself: shown scrolled, and the page told
        // where it went.
        const next = JSON.parse(await frame(`(() => { const b = document.getElementById("next").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: f.x + next.x, y: f.y + next.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await frameWait(`document.getElementById("box")?.scrollTop === 900`, "the box scrolled by the page, shown");
        await frameWait(`document.getElementById("status")?.textContent === "reel 3"`, "reel 3, scrolled to by the page");
    });

    await step("rules put into a stylesheet by script, as it loads and after", async () => {
        await goTo(site + "cssom.html", "Rules");
        await frameWait(`getComputedStyle(document.getElementById("early")).color === "rgb(1, 2, 3)"`, "the rule put in as it loaded");
        await frameWait(`getComputedStyle(document.getElementById("late")).color === "rgb(4, 5, 6)"`, "the rule put in after");
    });

    await step("a large page, sent compressed, and what it changes as it's shown", async () => {
        await goTo(site + "big.html", "Big");
        await frameWait(`document.querySelectorAll("p.row").length === 3000 && document.getElementById("items")?.children.length === 20`, "every row, and the 20 items added as it was shown", 30000);
        const last = await frame(`document.getElementById("items").lastElementChild.textContent`);
        if (last !== "item 20") throw new Error(`the last item says ${last}`);
    });

    await step("tabs: a window a page opens is a tab of its own, tabs are made and closed, back goes back in its tab, and they're kept", async () => {
        await ev(`location.href = ${JSON.stringify(new URL("go/", base).href)}`);
        const inTab = (n, expr) => ev(`(() => { const f = document.querySelectorAll("#frames iframe")[${n}]; const document_ = f?.contentDocument; return document_ ? ((document) => (${expr}))(document_) : null; })()`);
        const count = () => ev(`document.querySelectorAll("#frames iframe").length`);
        const shownTab = () => ev(`[...document.querySelectorAll("#frames iframe")].findIndex((f) => !f.hidden)`);
        // (The tab's script run, connected: the address given it is taken by
        // it, not by the bare form.)
        await waitFor(`document.querySelectorAll("#frames iframe").length === 1 && ((d) => d?.readyState === "complete" && !!d.getElementById("go_url") && d.getElementById("go_progress")?.hidden)(document.querySelector("#frames iframe").contentDocument)`, "the tabs' page, one tab, connected", 30000);
        // The tab loads a page, which opens a window: a tab of its own.
        await inTab(0, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "interact.html")}; i.form.requestSubmit(); return true; })()`);
        await waitFor(`/^Interact/.test(document.querySelector(".tab .title")?.textContent || "")`, "the first tab's page", 30000);
        // (The copy is in the tab's frame here: its place is that frame's,
        // the view's in it, the element's in the copy.)
        for (let i = 0; i < 100 && !(await frame(`!!document.getElementById("open")`).catch(() => false)); i++) await sleep(200);
        await sleep(1000);
        const at = await ev(`(() => { const f = document.querySelectorAll("#frames iframe")[0]; const r = f.getBoundingClientRect(), v = f.contentDocument.getElementById("go_view").getBoundingClientRect(); return { x: r.x + v.x, y: r.y + v.y }; })()`);
        const b = JSON.parse(await frame(`(() => { const b = document.getElementById("open").getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x + b.x, y: at.y + b.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        // Asked about (the site's pop-ups have no setting): opened.
        await waitFor(`!document.querySelector("#frames iframe").contentDocument.getElementById("go_popup").hidden`, "asked about the pop-up", 30000);
        await inTab(0, `(() => { document.querySelector("#go_popup .remember input").checked = false; document.querySelector("#go_popup .open").click(); return true; })()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2 && /^Second/.test(document.querySelectorAll(".tab .title")[1]?.textContent || "")`, "the opened window, in a tab of its own", 30000);
        if ((await shownTab()) !== 1) throw new Error("the new tab isn't shown");
        if (!/^Interact/.test(await inTab(0, "document.title"))) throw new Error("the first tab left its page");
        // Back (the device's): to the first tab's page, in its tab.
        await ev(`history.back()`);
        await waitFor(`[...document.querySelectorAll("#frames iframe")].findIndex((f) => !f.hidden) === 0`, "back, in the first tab", 15000);
        // A new tab, and closing it.
        await ev(`document.getElementById("new").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 3`, "a new tab");
        if ((await shownTab()) !== 2) throw new Error("the new tab isn't shown");
        await ev(`document.querySelectorAll(".tab .close")[2].click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2`, "the tab closed");
        // Kept: the page loaded again has its tabs, each at its page.
        await ev(`location.reload()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === 2 && /^Interact/.test(document.querySelectorAll(".tab .title")[0]?.textContent || "") && /^Second/.test(document.querySelectorAll(".tab .title")[1]?.textContent || "")`, "the tabs again, at their pages", 45000);
        // On a phone: no strip; each tab's bar has a button for the list of
        // tabs, and still fits.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        try {
            const tabDoc = `[...document.querySelectorAll("#frames iframe")].find((f) => !f.hidden).contentDocument`;
            // (A moment with no tab shown, as the window's resized: waited out.)
            await waitFor(`${tabDoc.replace(").contentDocument", ")?.contentDocument")}?.getElementById("go_tabs")?.hidden === false && getComputedStyle(document.getElementById("strip")).display === "none"`, "the tabs' button, no strip");
            const fits = await ev(`(() => { const d = ${tabDoc}; return d.getElementById("go_menu").getBoundingClientRect().right <= d.defaultView.innerWidth && d.querySelector("#go_tabs .count").textContent === "2"; })()`);
            if (!fits) throw new Error("the phone's bar doesn't fit, or doesn't count the tabs");
            await ev(`${tabDoc}.getElementById("go_tabs").click()`);
            await waitFor(`!document.getElementById("overview").hidden && document.querySelectorAll("#overview li").length === 2`, "the list of tabs");
            await ev(`document.querySelector("#overview .done").click()`);
            // Hide browser asks for the browser's full screen, which a page gets only
            // from a person's own press: the mouse's, where the button is (in the tab's
            // frame). (Not a finger's: a phone's browser moves a tap to what's near it
            // that takes one, which may be the tabs' page's, not the button.)
            await waitFor(`document.getElementById("overview").hidden`, "the list of tabs gone");
            // (What the tap brings, and what's asked of full screen, noted to say why, if it isn't.)
            await ev(`(() => { const w = ${tabDoc}.defaultView; w.__said = []; const note = (s) => w.__said.push(s + "@" + Math.round(w.performance.now()));
                for (const t of ["touchend", "pointerdown", "click", "fullscreenchange", "fullscreenerror"]) w.document.addEventListener(t, (e) => note(t + ":" + (e.target.id || e.target.tagName) + ":" + w.navigator.userActivation.isActive), true);
                const ask = w.Element.prototype.requestFullscreen, leave = w.Document.prototype.exitFullscreen;
                w.Element.prototype.requestFullscreen = function (...a) { note("asked"); return ask.apply(this, a).then((v) => (note("granted"), v), (e) => { note("refused:" + e.message); throw e; }); };
                w.Document.prototype.exitFullscreen = function (...a) { note("left:" + new Error().stack.split("\\n")[2]?.trim()); return leave.apply(this, a); }; })()`);
            await ev(`${tabDoc}.getElementById("go_menu").click()`);
            // (Once nothing's over it: the list of tabs going, the menu shown. What's
            // under the point, in the page and in the tab's frame, is the button.)
            // (A touch's point is the screen's: the page's, as zoomed and panned on a phone.)
            const hideAt = `(() => { const f = [...document.querySelectorAll("#frames iframe")].find((f) => !f.hidden), r = f.getBoundingClientRect(), v = visualViewport,
                b = ${tabDoc}.getElementById("go_menu_hide_browser").getBoundingClientRect(), cx = r.left + b.left + b.width / 2, cy = r.top + b.top + b.height / 2;
                return { f, cx, cy, x: Math.round((cx - v.offsetLeft) * v.scale), y: Math.round((cy - v.offsetTop) * v.scale), bx: b.left + b.width / 2, by: b.top + b.height / 2, v: [v.scale, v.offsetLeft, v.offsetTop] }; })()`;
            await waitFor(`(() => { const p = ${hideAt}; return document.elementFromPoint(p.cx, p.cy) === p.f && ${tabDoc}.elementFromPoint(p.bx, p.by)?.closest("#go_menu_hide_browser"); })()`, "Hide browser under the finger");
            const at = await ev(`(() => { const { x, y, v } = ${hideAt}; return { x, y, v }; })()`);
            // (The first input after the phone's emulated can go nowhere, headless Chrome's
            // seen here: the mouse moved to the button till the tab sees it, then pressed.)
            await cdp("Page.bringToFront");
            await ev(`${tabDoc}.defaultView.__moved = false; ${tabDoc}.getElementById("go_menu_hide_browser").addEventListener("mousemove", () => { ${tabDoc}.defaultView.__moved = true; }, { once: true })`);
            for (let i = 0; i < 50 && !(await ev(`${tabDoc}.defaultView.__moved`)); i++) {
                await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x + (i % 2), y: at.y });
                await sleep(200);
            }
            if (!(await ev(`${tabDoc}.defaultView.__moved`))) throw new Error("Chrome did not deliver pointer input to Hide browser");
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
            await waitFor(`${tabDoc}.defaultView.document.fullscreenElement === ${tabDoc}.defaultView.document.documentElement && getComputedStyle(${tabDoc}.getElementById("go_bar")).display !== "none"`, "Hide Original Browser keeps the /go toolbar in fullscreen").catch(async (err) => {
                const state = await ev(`JSON.stringify({ pressed: ${tabDoc}.getElementById("go_menu_hide_browser").getAttribute("aria-pressed"), menu: !${tabDoc}.getElementById("go_menu_panel").hidden,
                    enabled: ${tabDoc}.fullscreenEnabled, top: document.fullscreenElement?.tagName ?? null, notice: ${tabDoc}.getElementById("go_status")?.textContent || ${tabDoc}.querySelector("#go_notice:not([hidden]) p")?.textContent || "" })`).catch((e) => e.message);
                const said = await ev(`JSON.stringify(${tabDoc}.defaultView.__said)`).catch((e) => e.message);
                throw new Error(`${err.message} (it shows ${state}; in the tab: ${said}; tapped at ${JSON.stringify(at)})`);
            });
            await ev(`${tabDoc}.getElementById("go_tabs").click()`);
            await waitFor(`!${tabDoc}.getElementById("go_window_list").hidden && ${tabDoc}.querySelectorAll("#go_window_list li").length === 2`, "the window list opens in fullscreen with the toolbar");
            await ev(`${tabDoc}.querySelector("#go_window_list .done").click(); ${tabDoc}.getElementById("go_menu").click(); ${tabDoc}.getElementById("go_menu_hide_browser").click()`);
            await waitFor(`!${tabDoc}.defaultView.document.fullscreenElement`, "leaving Hide Original Browser exits fullscreen");
        } finally {
            await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
            await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        // No address in any frame's own (go/tab?id=N only).
        const srcs = await ev(`[...document.querySelectorAll("#frames iframe")].map((f) => f.getAttribute("src")).join()`);
        if (!/^tab\?id=\d+,tab\?id=\d+$/.test(srcs)) throw new Error(`the frames are at ${srcs}`);
        // (The page left marked, and the new one's script run, connected:
        // the address it's given next taken by it, not by the bare form.)
        await ev(`(() => { window.__leaving = true; location.href = ${JSON.stringify(new URL("go/tab", base).href)}; })()`);
        await waitFor(`!window.__leaving && document.readyState === "complete" && !!document.getElementById("go_url") && document.getElementById("go_progress").hidden`, "a tab on its own again, connected", 30000);
    });

    await step("private tabs: the account's cookies not given nor added to, shared by private tabs and forgotten with the last; no recent sites; a window one opens is private", async () => {
        await ev(`location.href = ${JSON.stringify(new URL("go/", base).href)}`);
        const host = new URL(site).hostname;
        const tabDoc = (n) => `document.querySelectorAll("#frames iframe")[${n}]?.contentDocument`;
        const inTab = (n, expr) => ev(`((document) => document ? (${expr}) : null)(${tabDoc(n)})`);
        const count = () => ev(`document.querySelectorAll("#frames iframe").length`);
        const connected = (n, what) => waitFor(`((d) => d?.readyState === "complete" && !!d.getElementById("go_url") && d.getElementById("go_progress")?.hidden)(${tabDoc(n)})`, what, 30000);
        const titleOf = (n) => `(document.querySelectorAll(".tab .title")[${n}]?.textContent || "")`;
        // A page loaded in tab n, shown (a hidden tab's view has no size),
        // its title (the strip's) waited for.
        const load = async (n, url, title) => {
            await ev(`document.querySelectorAll(".tab")[${n}].click()`);
            await inTab(n, `(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); return true; })()`);
            await waitFor(`${titleOf(n)}.startsWith(${JSON.stringify(title)})`, `${title} in tab ${n}`, 30000).catch(async (err) => {
                throw new Error(`${err.message} (it shows ${await ev(titleOf(n))})`);
            });
        };
        const sent = async (n) => { await load(n, site + "sent", "Sent "); return (await ev(titleOf(n))).replace(/^Sent /, ""); };
        await waitFor(`document.querySelectorAll("#frames iframe").length >= 1`, "the tabs' page", 30000);
        await connected(0, "the first tab, connected");
        // (Nothing kept for the site from the steps before.)
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); })`);
        // The account's cookie, set in a tab that isn't private.
        await load(0, site + "cookie?set", "Cookie");
        if ((await sent(0)) !== "kept=yes") throw new Error("the account's cookie wasn't set");
        try { await ev(`localStorage.removeItem("tabtop-go-recent")`); } catch { /* none */ }
        // A private tab: marked, not named in this page's title, not given
        // the account's cookie.
        const before = await count();
        await ev(`document.getElementById("new_private").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "a private tab");
        const p1 = before;
        await connected(p1, "the private tab, connected");
        const marked = await ev(`(() => { const d = ${tabDoc(p1)}; return document.querySelectorAll(".tab")[${p1}].classList.contains("private") && d.documentElement.classList.contains("go-private") && d.getElementById("go_back").classList.contains("private") && /^Private tab/.test(d.querySelector("#go_start h1").textContent); })()`);
        if (!marked) throw new Error("the private tab isn't marked as one");
        if ((await sent(p1)) !== "nothing") throw new Error("a private tab was given the account's cookie");
        if ((await ev("document.title")) !== "Private – Browser") throw new Error(`the page's title names the private tab's page: ${await ev("document.title")}`);
        // Its own sign-in: kept for it, and for another private tab (made
        // from its menu), not for the account's tabs nor in their jar.
        await load(p1, site + "cookie?session", "Cookie");
        if ((await sent(p1)) !== "signin=s") throw new Error("a private tab's own cookie wasn't kept for it");
        if ((await ev(`localStorage.getItem("tabtop-go-recent")`)) !== null) throw new Error("a private tab's site was kept in the recent sites");
        await inTab(p1, `(() => { document.getElementById("go_menu").click(); document.getElementById("go_menu_private").click(); return true; })()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 2} && document.querySelectorAll(".tab")[${before + 1}].classList.contains("private")`, "a second private tab, from the menu");
        const p2 = before + 1;
        await connected(p2, "the second private tab, connected");
        if ((await sent(p2)) !== "signin=s") throw new Error("private tabs don't share their cookies");
        if ((await sent(0)) !== "kept=yes") throw new Error("the account's tab got the private tab's cookie");
        const listed = await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies" }); t.close(); return t.reply.sites.find((s) => s.site === ${JSON.stringify(host)})?.cookies ?? 0; })`);
        if (listed !== 1) throw new Error(`the account's jar lists ${listed} cookies for the site (the private tab's too?)`);
        // A window a private tab's page opens: a private tab, nothing
        // asked to be remembered.
        await load(p2, site + "opener.html", "Opener");
        await waitFor(`${tabDoc(p2)}.getElementById("go_view").getAttribute("aria-busy") !== "true"`, "the opener shown", 30000);
        await sleep(1500);
        const at = await ev(`(() => { const f = document.querySelectorAll("#frames iframe")[${p2}]; const r = f.getBoundingClientRect(), v = f.contentDocument.getElementById("go_view").getBoundingClientRect(); return { x: r.x + v.x + v.width / 2, y: r.y + v.y + v.height / 2 }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 3} || !${tabDoc(p2)}.getElementById("go_popup").hidden`, "the window opened, or asked about", 30000);
        if (await count() === before + 2) {
            if (!(await inTab(p2, `document.querySelector("#go_popup .remember").hidden`))) throw new Error("a private tab offers to remember a pop-up's answer");
            await inTab(p2, `(document.querySelector("#go_popup .open").click(), true)`);
        }
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 3} && /^Second/.test(${titleOf(before + 2)})`, "the opened window, in a tab of its own", 30000);
        if (!(await ev(`document.querySelectorAll(".tab")[${before + 2}].classList.contains("private")`))) throw new Error("a window a private tab opened isn't private");
        if ((await sent(before + 2)) !== "signin=s") throw new Error("a window a private tab opened hasn't its sign-in");
        // The private tabs closed: their cookies forgotten; a new one starts
        // with none.
        for (let i = 0; i < 3; i++) {
            await ev(`document.querySelectorAll(".tab .close")[${before}].click()`);
            await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 2 - i}`, "a private tab closed");
        }
        // (Their engines ended and the session's private jar let go: the
        // server's, at once on each tab's close, but not said to the page.)
        await sleep(2000);
        await ev(`document.getElementById("new_private").click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "a private tab again");
        await connected(before, "the new private tab, connected");
        if ((await sent(before)) !== "nothing") throw new Error("a new private tab had the closed ones' cookie");
        // Kept as private through this page's reload.
        await ev(`location.reload()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before + 1}`, "the tabs again", 45000);
        await connected(before, "the private tab again, connected");
        if (!(await ev(`document.querySelectorAll(".tab")[${before}].classList.contains("private") && ${tabDoc(before)}.documentElement.classList.contains("go-private")`))) throw new Error("a private tab came back from a reload as one that isn't");
        await ev(`document.querySelectorAll(".tab .close")[${before}].click()`);
        await waitFor(`document.querySelectorAll("#frames iframe").length === ${before}`, "the private tab closed");
        // (The account's cookie forgotten: the steps after's.)
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-cookies-forget", name: ${JSON.stringify(host)} }); t.close(); })`);
        await ev(`(() => { window.__leaving = true; location.href = ${JSON.stringify(new URL("go/tab", base).href)}; })()`);
        await waitFor(`!window.__leaving && document.readyState === "complete" && !!document.getElementById("go_url") && document.getElementById("go_progress").hidden`, "a tab on its own again, connected", 30000);
    });

    // With GO_SITES (space-separated addresses), real sites too, each with
    // a screenshot in GO_SHOTS (default the working directory).
    for (const url of (process.env.GO_SITES || "").split(/\s+/).filter(Boolean)) {
        await step(`real site ${url}`, async () => {
            const before = await ev(`document.title`);
            await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); })()`);
            await waitFor(`document.title !== ${JSON.stringify(before)} || !document.getElementById("go_notice").hidden`, "the site", 60000);
            await waitFor(`document.getElementById("go_status").textContent === "" || !document.getElementById("go_notice").hidden`, "it shown", 60000).catch(() => {});
            await sleep(1500);
            const shot = await cdp("Page.captureScreenshot", { format: "png" });
            writeFileSync(file, Buffer.from(shot.data, "base64"));
            const notice = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
            if (notice) throw new Error(notice);
            const stats = await frame(`({ elements: document.getElementsByTagName("*").length, images: [...document.images].filter((i) => i.getAttribute("src")?.startsWith("blob:")).length + "/" + document.images.length,
                missing: [...document.images].filter((i) => !i.getAttribute("src")).slice(0, 4).map((i) => i.outerHTML.slice(0, 160)) })`);
            if (process.env.GO_DEBUG) console.log(JSON.stringify(stats.missing, null, 1));
            return `${await ev(`document.title`)}; ${stats.elements} elements, pictures fetched ${stats.images}; ${file}`;
        });
    }

    // With GO_SOAK=N, N pages one after another in the one tab, through
    // GO_SITES or else the test site's pages: a long session, for the
    // engine's memory (go-check.sh reports it).
    const soak = Number(process.env.GO_SOAK || 0);
    if (soak > 0) {
        await step(`a long session: ${soak} pages in one tab`, async () => {
            const sites = (process.env.GO_SITES || "").split(/\s+/).filter(Boolean);
            // Each page's title differs from the one before, to tell it's shown.
            const list = sites.length > 1 ? sites : ["index.html", "second.html"].map((p) => site + p);
            const slow = [];
            for (let i = 0; i < soak; i++) {
                const url = list[i % list.length];
                const t = Date.now();
                const before = await ev(`document.title`);
                await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(url)}; i.form.requestSubmit(); })()`);
                await waitFor(`document.getElementById("go_status").textContent === "" && document.title !== ${JSON.stringify(before)} || !document.getElementById("go_notice").hidden`, `page ${i + 1}, ${url}`, 60000);
                const notice = await ev(`document.getElementById("go_notice").hidden ? "" : document.querySelector("#go_notice p").textContent`);
                if (notice) throw new Error(`page ${i + 1}, ${url}: ${notice}`);
                if (Date.now() - t > 10000) slow.push(`${url} ${Date.now() - t} ms`);
            }
            return `all shown${slow.length ? `; slow: ${slow.slice(0, 5).join(", ")}` : ""}`;
        });
    }

    await step("a 2D canvas in a same-origin frame is shown as it's drawn again", async () => {
        await goTo(site + "c2dframe.html", "Canvas frame");
        const pixel = `(() => { const c = document.getElementById("f")?.shadowRoot?.getElementById("c"); try { return c ? [...c.getContext("2d").getImageData(10, 10, 1, 1).data].slice(0, 3).join() : ""; } catch { return ""; } })()`;
        await frameWait(`${pixel} === "255,0,0"`, "the frame's canvas, red", 20000);
        await frameWait(`${pixel} === "0,0,255"`, "the frame's canvas, drawn blue", 15000);
    });

    await step("a WebGL canvas taken out of the page and put back is mirrored again", async () => {
        await goTo(site + "glback.html", "GL back");
        await frameWait(`document.getElementById("s")?.textContent === "back"`, "the canvas put back", 20000);
        // (Mirrored: its title says so, no aria-label; unavailable: both say that.)
        await frameWait(`document.getElementById("c")?.title === "WebGL rendering mirrored from the remote page"`, "the canvas mirrored again", 15000).catch(async (err) => {
            throw new Error(`${err.message} (it says ${await frame(`document.getElementById("c")?.title`)})`);
        });
    });

    await step("a same-origin frame's own frame is shown, and its changes", async () => {
        await goTo(site + "nestframe.html", "Nest frame");
        const deep = (want) => `(() => { const seen = (root) => { if (root.textContent?.includes(${JSON.stringify(want)})) return true; for (const el of root.querySelectorAll("*")) if (el.shadowRoot && seen(el.shadowRoot)) return true; return false; }; return seen(document); })()`;
        await frameWait(deep("first"), "the inner page", 20000);
        await frameWait(deep("later"), "the inner page's change", 15000);
        await goTo(site + "index.html", "Fixture");
    });

    if (adSite) await step("a field in another origin's frame, in a third's that keeps changing, keeps the focus as it's redrawn", async () => {
        await goTo(site + "nestfocus.html?c=" + encodeURIComponent(adSite + "nestfocusin.html"), "Nest focus");
        const deep = `const deep = (root, sel) => { const hit = root.querySelector(sel); if (hit) return hit; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = deep(el.shadowRoot, sel); if (f) return f; } return null; };`;
        const active = `(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.tagName; })()`;
        await frameWait(`(() => { ${deep} return !!deep(document, "input"); })()`, "the innermost frame's field", 30000);
        // The page's frame given the focus first, as a click into it would:
        // a sandboxed frame without it can't take it by script (Chrome 158,
        // measured; once it has it, script moves it within).
        await ev(`document.getElementById("go_view").focus()`);
        await frame(`(() => { ${deep} deep(document, "input").focus(); })()`);
        if ((await frame(active)) !== "INPUT") throw new Error("the field couldn't be focused");
        const tick = () => frame(`(() => { ${deep} return deep(document, "#tick")?.textContent; })()`);
        const was = await tick();
        await frameWait(`(() => { ${deep} return Number(deep(document, "#tick")?.textContent) >= ${Number(was) + 3}; })()`, "the middle frame redrawn", 15000);
        if ((await frame(active)) !== "INPUT") throw new Error(`the field lost the focus as the frame holding it was redrawn (now on ${await frame(active)})`);
        await goTo(site + "index.html", "Fixture");
    });

    await step("a site whose certificate isn't trusted: TabTop's warning, Back, then Continue (an exception, this tab), its pictures too", async () => {
        // The page's own link to href (certlink.html), clicked: followed by
        // the engine.
        const frameClickLink = async (href) => {
            await goTo(site + "certlink.html?to=" + encodeURIComponent(href), "Cert link");
            await frameWait(`!!document.getElementById("to")`, "the link");
            await sleep(300);  // (its address set by its script, in the engine)
            await frameClick("#to");
        };
        const secure = site.replace(/^http:/, "https:");
        const ask = (u) => ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(u)}; i.form.requestSubmit(); })()`);
        await goTo(site + "second.html", "Second");
        await ask(secure + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the certificate warning", 30000);
        const said = await ev(`[document.getElementById("go_cert_reason").textContent, document.querySelector("#go_cert .details").textContent]`);
        if (!/authority|another site/.test(said[0]) || !/tabtop-untrusted\.test/.test(said[1])) throw new Error(`the warning says ${JSON.stringify(said)}`);
        if ((await frame(`document.title`).catch(() => "")) === "Fixture") throw new Error("the untrusted site's page shown");
        // Back: where it was.
        await ev(`document.querySelector("#go_cert .back").click()`);
        await waitFor(`document.getElementById("go_cert").hidden && document.title.startsWith("Second")`, "back from the warning");
        // Continue: shown, marked, its pictures (TabTop's own fetches) too.
        await ask(secure + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the warning again (nothing's kept without Continue)", 30000);
        await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Fixture")`, "the page, continued to", 30000);
        if (!/certificate isn’t trusted/.test(await ev(`document.getElementById("go_site").title`))) throw new Error(`the site's button says ${await ev(`document.getElementById("go_site").title`)}`);
        // Site controls says so too, not "Secure".
        await ev(`document.getElementById("go_site").click()`);
        await waitFor(`!!document.querySelector("#go_settings iframe")?.contentDocument?.querySelector("#site_scope .badge")`, "Site controls, its badge", 15000);
        const badge = await ev(`document.querySelector("#go_settings iframe").contentDocument.querySelector("#site_scope .badge").textContent`);
        await ev(`document.querySelector("#go_settings .close").click()`);
        await waitFor(`!document.getElementById("go_settings").open`, "Site controls closed");
        if (badge !== "Certificate not trusted") throw new Error(`Site controls says the excepted page is ${JSON.stringify(badge)}`);
        await frameWait(`document.getElementById("img")?.naturalWidth > 0`, "its picture, through the tab's exception");
        // Its link to another page of it: no warning (the tab's exception).
        await ask(secure + "second.html");
        await waitFor(`document.title.startsWith("Second")`, "another page of it, no warning", 30000);
        if (!(await ev(`document.getElementById("go_cert").hidden`))) throw new Error("warned again, the host an exception");
        // A link the page follows to another site whose certificate isn't
        // trusted (not an exception): warned of too.
        const other = adSite.replace(/^http:/, "https:");
        await frameClickLink(other + "index.html");
        await waitFor(`!document.getElementById("go_cert").hidden && document.querySelector("#go_cert .host").textContent === ${JSON.stringify(new URL(other).hostname)}`, "the warning for the link's site", 30000);
        await ev(`document.querySelector("#go_cert .back").click()`);
        await waitFor(`document.getElementById("go_cert").hidden`, "back from it");
        await goTo(site + "index.html", "Fixture");  // (where the steps after begin)
    });

    await step("a local DNS record's name is reached at its address (before the system's DNS, which doesn't know it); removed, it isn't", async () => {
        // (In a tab of its own, its history left to it; each load its own
        // address, not one the engines' shared cache could have from before.)
        await ev(`(() => { window.__leaving = true; sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/tab", base).href)}; })()`);
        await waitFor(`!window.__leaving && document.readyState === "complete" && document.getElementById("go_progress")?.hidden`, "a tab of its own, connected", 30000);
        await goTo(`http://fixture.home.arpa/index.html?local=${Date.now()}`, "Fixture");
        await ev(`import("../tabtop/requests.js").then(async (m) => { const t = await m.call({ type: "go-settings-set", setting: "hosts", hosts: [] }); t.close(); })`);
        const ask = (u) => ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(u)}; i.form.requestSubmit(); })()`);
        await ask(`http://fixture.home.arpa/second.html?local=${Date.now()}`);
        await waitFor(`!document.getElementById("go_notice").hidden`, "the name not found, its record removed", 30000);
        await goTo(site + "index.html", "Fixture");
    });

    await step("a script fetched under a tab's certificate exception isn't run in another tab from the engines' shared cache", async () => {
        const secure = site.replace(/^http:/, "https:");
        const ask = (u) => ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(u)}; i.form.requestSubmit(); })()`);
        // (Each in a tab of its own: the step before excepted this host in its.)
        const freshTab = async () => {
            await ev(`(() => { window.__leaving = true; sessionStorage.clear(); location.href = ${JSON.stringify(new URL("go/tab", base).href)}; })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete" && document.getElementById("go_progress")?.hidden`, "a tab of its own, connected", 30000);
        };
        await freshTab();
        await ask(secure + "certpage.html");
        await waitFor(`!document.getElementById("go_cert").hidden`, "the warning", 30000);
        await ev(`document.querySelector("#go_cert .go").click()`);
        await waitFor(`document.title.startsWith("Cached ran")`, "the excepted page, its script run", 30000);
        // Another tab (no exception): a trusted page using that script.
        await freshTab();
        await goTo(site + "cachehost.html", "Cache host");
        await sleep(4000);
        if (/Cached ran/.test(await ev(`document.title`))) throw new Error("another tab ran the script fetched under the first's certificate exception");
        await goTo(site + "index.html", "Fixture");
    });

    await step("a connection lost, then back another way (a page loaded): its banner goes at once, not at its next try", async () => {
        // The page's sockets known, and while __down, new ones refused (a
        // path of TabTop's own that isn't a tunnel's): as a network gone.
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            const W = WebSocket;
            window.__sockets = [];
            window.__down = false;
            window.WebSocket = class extends W {
                constructor(url, protocols) {
                    super(window.__down ? String(url).replace(/^(wss?:\\/\\/[^/]+).*$/, "$1/go-check-down") : url, protocols);
                    window.__sockets.push(this);
                }
            };
        })()` });
        try {
            await ev(`(() => { window.__leaving = true; location.reload(); })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete" && window.__sockets?.some((s) => s.readyState === 1) && document.getElementById("go_progress")?.hidden`, "the page again, its sockets known", 30000);
            await ev(`window.__down = true; for (const s of window.__sockets) s.close()`);
            await waitFor(`/Connection lost/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "the connection said lost", 15000);
            // Its own tries failing, the next one a while off.
            await waitFor(`/Trying again in [5-8] s/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "its tries failing", 30000);
            await ev(`window.__down = false; (() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(site + "second.html")}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.getElementById("tabtop_reconnect")`, "the banner gone as it's connected", 3000);
            await waitFor(`document.title.startsWith("Second")`, "the page loaded", 30000);
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
    });

    await step("a page coloured by its body's attributes (bgcolor, text) is shown in its colours", async () => {
        await goTo(site + "bgcolor.html", "Bgcolor");
        await frameWait(`!!document.getElementById("t")`, "the page");
        const colours = await frame(`JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.getElementById("t")).color })`);
        if (colours !== JSON.stringify({ bg: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)" })) throw new Error(`the copy's colours: ${colours}`);
    });

    await step("Continue pressed on a certificate warning while the connection's lost is done once it's back", async () => {
        const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
            if (window !== top) return;
            const W = WebSocket;
            window.__sockets = [];
            window.__down = false;
            window.WebSocket = class extends W {
                constructor(url, protocols) {
                    super(window.__down ? String(url).replace(/^(wss?:\\/\\/[^/]+).*$/, "$1/go-check-down") : url, protocols);
                    window.__sockets.push(this);
                }
            };
        })()` });
        try {
            // A tab of its own (no exception yet), its sockets known.
            await ev(`(() => { window.__leaving = true; sessionStorage.clear(); location.href = location.origin + location.pathname.replace(/\\/go\\/.*$/, "/go/tab"); })()`);
            await waitFor(`!window.__leaving && document.readyState === "complete" && document.getElementById("go_progress")?.hidden && window.__sockets?.some((s) => s.readyState === 1)`, "a tab of its own, connected", 30000);
            const secure = site.replace(/^http:/, "https:");
            await ev(`(() => { const i = document.getElementById("go_url"); i.value = ${JSON.stringify(secure + "index.html?offline-continue")}; i.form.requestSubmit(); })()`);
            await waitFor(`!document.getElementById("go_cert").hidden`, "the certificate warning", 30000);
            await ev(`window.__down = true; for (const s of window.__sockets) s.close()`);
            await waitFor(`/Connection lost/.test(document.getElementById("tabtop_reconnect")?.textContent ?? "")`, "the connection said lost", 15000);
            await ev(`document.querySelector("#go_cert .go").click()`);
            await ev(`window.__down = false; document.querySelector("#tabtop_reconnect button")?.click()`);
            await waitFor(`document.title.startsWith("Fixture") && document.getElementById("go_cert").hidden && !document.getElementById("tabtop_reconnect")`, "the page continued to, once connected", 30000);
            // Loaded once: the Continue said on taking the tab back, not
            // the page's address loaded again too (go-reload) to replace it.
            if (process.env.GO_LOG) {
                const ops = readFileSync(process.env.GO_LOG, "utf8").split("\n").filter((l) => /go-debug: op (cert-continue|navigate) /.test(l));
                const after = ops.slice(ops.findLastIndex((l) => / op cert-continue /.test(l)) + 1);
                if (after.length) throw new Error(`loaded again after Continue: ${after.join(" / ")}`);
            }
        } finally {
            await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
    });

    await step("no request left this browser except to TabTop", async () => {
        const elsewhere = requests.filter((u) => !u.startsWith(origin + "/") && !/^(data|blob|about|chrome|devtools):/.test(u));
        if (elsewhere.length) throw new Error(`requests elsewhere: ${[...new Set(elsewhere)].join(", ")}`);
        return `${requests.length} requests, all to ${origin}`;
    });

    if (exceptions.length) {
        console.log(`exceptions on the page:\n  ${exceptions.join("\n  ")}`);
        process.exitCode = 1;
    }
    ws.close();
    browser.close();
}

if (mode === "site") {
    writeSite(args[0]);
} else if (mode === "check") {
    let base = args[0];
    if (process.env.GO_LINK) {
        // A far link between the browser and the server: one-way delay (ms)
        // and bytes a second each way, pipelined as a network's are.
        const [delay, rate] = process.env.GO_LINK.split(",").map(Number);
        const net = await import("node:net");
        const target = new URL(base);
        const port = Number(target.port), host = target.hostname;
        const shaped = (from, to) => {
            let busy = 0;
            from.on("data", (chunk) => {
                const now = Date.now();
                busy = Math.max(now, busy) + chunk.length / rate * 1000;
                setTimeout(() => to.write(chunk), busy + delay - now);
            });
            from.on("end", () => setTimeout(() => to.end(), Math.max(0, busy + delay - Date.now())));
            from.on("error", () => to.destroy());
        };
        const proxy = net.createServer((c) => {
            const u = net.connect(port, host);
            shaped(c, u);
            shaped(u, c);
        }).listen(0, "127.0.0.1");
        await new Promise((r) => proxy.on("listening", r));
        proxy.unref();
        target.port = String(proxy.address().port);
        base = target.href;
        console.log(`link: ${delay} ms each way, ${rate} bytes a second, through ${base}`);
    }
    await check(base, Number(args[1]), args[2], args[3]);
} else {
    console.error("usage: go-check.mjs site DIR | check BASE PORT SITE [ADS]");
    process.exit(2);
}
