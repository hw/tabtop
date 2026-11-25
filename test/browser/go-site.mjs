// The remote browser check's test site (go-check.mjs, go-check.sh): its
// pages, scripts, media and server, written into a folder a container
// serves. writeSite writes it; png makes the pictures it and the check use.
import { execFileSync } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// --- The test site ------------------------------------------------------

export function png(width, height, [r, g, b]) {
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

export function writeSite(dir) {
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
    // The site's shell stays empty. Its controller creates a second video
    // and uses the ManagedMediaSource <source> attach path.
    const hlsLikeVideo = `<div id="player">
<video class="player-html5" width="320" height="180"><source src=""></video>
<button id="start-load" type="button" disabled>Load segment</button>
</div><script>
const player = document.getElementById("player");
const startLoad = document.getElementById("start-load");
const wrapper = document.createElement("div");
wrapper.className = "videoWrapper";
const streamed = document.createElement("video");
streamed.className = "videoElement";
streamed.width = 320;
streamed.height = 180;
streamed.muted = true;
wrapper.append(streamed);
player.append(wrapper);
const shell = player.querySelector(".player-html5");
shell.addEventListener("canplay", () => shell.setAttribute("data-ready", "unexpected"));
streamed.addEventListener("loadedmetadata", () => streamed.setAttribute("data-metadata", String(streamed.readyState)));
streamed.addEventListener("canplay", () => streamed.setAttribute("data-ready", String(streamed.readyState)));
const Ctor = window.ManagedMediaSource || window.MediaSource;
const source = new Ctor();
const url = URL.createObjectURL(source);
let streaming = 0;
source.addEventListener("startstreaming", () => { streaming++; document.documentElement.setAttribute("data-stream", "start:" + streaming); });
source.addEventListener("sourceopen", () => {
    document.documentElement.setAttribute("data-mms", Ctor === ManagedMediaSource ? "managed" : "plain");
    streamed.setAttribute("data-attached", streamed.querySelector("source").getAttribute("src"));
    const manifest = new XMLHttpRequest();
    manifest.open("GET", "mse-hls-like.m3u8");
    manifest.onload = async () => {
        if (manifest.status !== 200 || !manifest.responseText.startsWith("#EXTM3U")) return;
        document.documentElement.setAttribute("data-manifest", "loaded");
        const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
        startLoad.onclick = async () => {
            startLoad.disabled = true;
            buffer.addEventListener("updateend", () => { source.endOfStream(); }, { once: true });
            buffer.appendBuffer(await (await fetch("part.m4s")).arrayBuffer());
        };
        buffer.addEventListener("updateend", () => { startLoad.disabled = false; }, { once: true });
        buffer.appendBuffer(await (await fetch("init.mp4")).arrayBuffer());
    };
    manifest.send();
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
        // The page's clipboard (goclipboard.js): copies that change nothing
        // in the page (so only the copy is said), one long after its press,
        // one in another origin's frame (on http: https's would be mixed),
        // and a read.
        "clipboard.html": `<!doctype html><title>Clipboard</title>
<textarea id="src">copied by execCommand</textarea>
<button id="exec">Copy</button> <button id="handler">Copy by a handler</button> <button id="write">Copy by writeText</button> <button id="late">Copy later</button> <button id="read">Read</button>
<p id="got">nothing read</p><iframe id="x" width="300" height="80"></iframe>
<script>
const $ = (id) => document.getElementById(id);
if (location.protocol === "http:") $("x").src = "http://[::ffff:" + location.hostname + "]/copyframe.html";
const byHandler = (text) => { document.addEventListener("copy", (e) => { e.clipboardData.setData("text/plain", text); e.preventDefault(); }, { once: true }); document.execCommand("copy"); };
$("exec").onclick = () => { $("src").select(); document.execCommand("copy"); };
$("handler").onclick = () => byHandler("set by a copy handler");
$("write").onclick = () => navigator.clipboard.writeText("copied by writeText");
$("late").onclick = () => setTimeout(() => byHandler("copied too late"), 6500);
$("read").onclick = () => navigator.clipboard.readText().then((t) => { $("got").textContent = "read: " + t; }, (e) => { $("got").textContent = "refused: " + e.name; });
</script>`,
        // The page's fullscreen (gofullscreen.js): its player made so, left
        // by it or by the person; one asked for long after its press; one
        // in another origin's frame.
        // An empty video (nothing to play) laid over a button.
        "emptyvideo.html": `<!doctype html><title>Empty video</title><style>body { margin: 0 } #under { position: absolute; left: 20px; top: 20px; width: 200px; height: 80px } #v { position: absolute; left: 0; top: 0; width: 320px; height: 180px }</style>
<button id="under">under</button><video id="v"></video><p id="r" style="position: absolute; top: 200px">none</p>
<script>
const r = document.getElementById("r");
document.getElementById("under").onclick = () => { r.textContent = "button"; };
document.getElementById("v").onclick = () => { r.textContent = "video"; };
</script>`,
        // A page's pointer lock (gopointerlock.js): a pad that locks it,
        // adds up its moves, counts its presses; a right press leaves it.
        "lock.html": `<!doctype html><title>Lock</title><div id="pad" style="width:240px;height:160px;background:#468"></div><button id="late">Later</button>
<p id="r">-</p><p id="c">0</p><p id="m">0,0</p><p id="k">0</p>
<script>
const $ = (id) => document.getElementById(id);
let mx = 0, my = 0, changes = 0, clicks = 0;
const lock = () => $("pad").requestPointerLock().then(() => { $("r").textContent = "locked " + (document.pointerLockElement === $("pad")); }, (e) => { $("r").textContent = "refused " + e.name; });
$("pad").addEventListener("mousedown", (e) => {
    if (!document.pointerLockElement) return lock();
    if (e.button === 2) document.exitPointerLock();
});
$("pad").addEventListener("mousemove", (e) => { if (document.pointerLockElement) { mx += e.movementX; my += e.movementY; $("m").textContent = mx + "," + my; } });
$("pad").addEventListener("click", () => { if (document.pointerLockElement) $("k").textContent = String(++clicks); });
document.addEventListener("pointerlockchange", () => { $("c").textContent = ++changes + " " + (document.pointerLockElement ? "on" : "off"); });
$("late").onclick = () => setTimeout(lock, 6500);
</script>`,
        // A page's screen wake lock (gowakelock.js).
        "wakelock.html": `<!doctype html><title>Wake lock</title><button id="hold">Hold</button> <button id="release">Release</button> <button id="late">Later</button>
<p id="r">-</p><p id="e">none</p>
<script>
const $ = (id) => document.getElementById(id);
let s = null, n = 0;
const hold = () => navigator.wakeLock.request("screen").then((x) => {
    s = x;
    $("r").textContent = "held " + x.type + " " + x.released + " " + (x instanceof WakeLockSentinel);
    x.onrelease = () => { $("e").textContent = "released " + x.released + " " + (++n); };
}, (e) => { $("r").textContent = "refused " + e.name; });
$("hold").onclick = hold;
$("release").onclick = () => s?.release();
$("late").onclick = () => setTimeout(hold, 6500);
</script>`,
        // What a page's told of its permissions (goperms.js).
        "perms.html": `<!doctype html><title>Perms</title><p id="out">asking</p>
<script>
(async () => {
    const out = {};
    for (const d of [{ name: "geolocation" }, { name: "notifications" }, { name: "clipboard-read" }, { name: "clipboard-write" }, { name: "camera" }, { name: "microphone" },
        { name: "screen-wake-lock" }, { name: "pointer-lock" }, { name: "persistent-storage" }, { name: "push" }, { name: "push", userVisibleOnly: true }, { name: "midi" }]) {
        const key = d.name + (d.userVisibleOnly ? "+uvo" : "");
        try {
            const st = await navigator.permissions.query(d);
            out[key] = st.state + (st instanceof PermissionStatus ? "" : "?");
        } catch (e) { out[key] = e.name; }
    }
    document.getElementById("out").textContent = JSON.stringify(out);
})();
</script>`,
        // A page's vibration (govibrate.js), and another origin's frame's.
        "vibrate.html": `<!doctype html><title>Vibrate</title><button id="buzz">Buzz</button> <button id="long">Long</button> <button id="stop">Stop</button> <button id="late">Later</button>
<p id="r">-</p><iframe id="x" width="300" height="80"></iframe>
<script>
const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).has("frame")) $("x").src = "http://[::ffff:" + location.hostname + "]/vibframe.html";
$("buzz").onclick = () => { $("r").textContent = "buzz " + navigator.vibrate([200, 100, 300]); };
$("long").onclick = () => { $("r").textContent = "long " + navigator.vibrate(Array(150).fill(20000)); };
$("stop").onclick = () => { $("r").textContent = "stop " + navigator.vibrate(0); };
$("late").onclick = () => setTimeout(() => { $("r").textContent = "late " + navigator.vibrate(500); }, 6500);
</script>`,
        "vibframe.html": `<!doctype html><style>body { margin: 0 }</style><button id="b">Buzz here</button><p id="s">none</p>
<script>document.getElementById("b").onclick = () => { document.getElementById("s").textContent = "frame " + navigator.vibrate(300); };</script>`,
        "fullscreen.html": `<!doctype html><title>Fullscreen</title><style>body { margin: 8px }</style>
<div id="player" style="width:320px;height:180px;background:#246"><button id="fs">Full</button> <button id="exit">Exit</button> <button id="lock">Lock</button></div>
<p id="change">none</p><p id="result">-</p><button id="late">Later</button> <p id="o">-</p> <iframe id="x" width="300" height="80"></iframe>
<script>
const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).has("frame")) $("x").src = "http://[::ffff:" + location.hostname + "]/fullframe.html";
document.addEventListener("fullscreenchange", () => { $("change").textContent = "change " + (document.fullscreenElement?.id ?? "none"); });
$("fs").onclick = () => $("player").requestFullscreen().then(() => { $("result").textContent = "full " + document.fullscreenEnabled; }, (e) => { $("result").textContent = "refused " + e.message; });
$("exit").onclick = () => document.exitFullscreen();
$("lock").onclick = () => screen.orientation.lock("landscape").then(() => { $("o").textContent = "lock ok"; }, (e) => { $("o").textContent = "lock " + e.name; });
$("late").onclick = () => setTimeout(() => $("player").requestFullscreen().catch((e) => { $("result").textContent = "late refused " + e.message; }), 6500);
</script>`,
        "fullframe.html": `<!doctype html><style>body { margin: 0 }</style><div id="inner" style="width:100%;height:60px;background:#642"><button id="b">Full here</button></div><p id="s">none</p>
<script>document.getElementById("b").onclick = () => document.getElementById("inner").requestFullscreen().then(() => { document.getElementById("s").textContent = "full"; }, (e) => { document.getElementById("s").textContent = "refused " + e.message; });
document.addEventListener("fullscreenchange", () => { document.getElementById("s").textContent = "change " + (document.fullscreenElement?.id ?? "none"); });</script>`,
        // Pictures copied and read (goclipboard.js): a canvas's, made a
        // Blob by toBlob (which the engine lacks), with its text; and what's
        // read, its picture's size and its text.
        "clipimage.html": `<!doctype html><title>Clip image</title>
<canvas id="c" width="8" height="6"></canvas> <button id="copyimg">Copy picture</button> <button id="readimg">Read</button> <button id="copybig">Copy a big one</button> <button id="copyhuge">Copy one too big</button> <p id="got">nothing</p>
<script>
const $ = (id) => document.getElementById(id);
const got = (t) => { $("got").textContent = t; };
const g = $("c").getContext("2d");
g.fillStyle = "#f00"; g.fillRect(0, 0, 4, 6); g.fillStyle = "#00f"; g.fillRect(4, 0, 4, 6);
$("copyimg").onclick = () => $("c").toBlob((b) => navigator.clipboard.write([new ClipboardItem({ "image/png": b, "text/plain": new Blob(["a picture"], { type: "text/plain" }) })])
    .then(() => got("written"), (e) => got("write refused " + e.name)));
// Noise (a PNG as large as its pixels' colours, 3 bytes each): 1200x900,
// about 3.3 MB; 2000x1500, about 9 MB, past 8 MiB.
const noise = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"), d = g.createImageData(w, h);
    for (let i = 0; i < d.data.length; i += 65536) crypto.getRandomValues(d.data.subarray(i, i + 65536));
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
    g.putImageData(d, 0, 0); return c; };
const copyNoise = (w, h) => noise(w, h).toBlob((b) => { got("made " + b.size); navigator.clipboard.write([new ClipboardItem({ "image/png": b })]).then(() => got("written " + b.size), (e) => got("write refused " + e.name)); });
$("copybig").onclick = () => copyNoise(1200, 900);
$("copyhuge").onclick = () => copyNoise(2000, 1500);
const size = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => { const i = new Image(); i.onload = () => resolve(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => resolve("undecoded"); i.src = r.result; }; r.readAsDataURL(blob); });
$("readimg").onclick = () => navigator.clipboard.read().then(async (items) => {
    const it = items[0], out = [it ? it.types.join(",") : "none"];
    if (it?.types.includes("image/png")) out.push(await size(await it.getType("image/png")));
    if (it?.types.includes("text/plain")) out.push(await (await it.getType("text/plain")).text());
    got("read " + out.join(" "));
}, (e) => got("refused " + e.name));
</script>`,
        // The page's notifications (gonotify.js): its permission as it
        // loads (its first script's), asked for, one shown (its icon on
        // another site, never fetched), clicked and closed.
        "notify.html": `<!doctype html><title>Notify</title><script>const atLoad = Notification.permission;</script>
<p id="perm"></p><p id="log"></p><p id="early"></p><button id="ask">Ask</button> <button id="show">Show</button> <button id="close">Close</button> <button id="late">Later</button> <button id="svg">SVG</button> <button id="big">Big</button>
<script>
// As it loads, before the agent's there: asked, and (allowed) one shown.
Notification.requestPermission().then((s) => { document.getElementById("early").textContent += "load-ask " + s + ";"; });
if (atLoad === "granted") { const n0 = new Notification("At load"); n0.onshow = () => { document.getElementById("early").textContent += "load-show;"; }; n0.onerror = () => { document.getElementById("early").textContent += "load-error;"; }; }
const $ = (id) => document.getElementById(id);
const log = (t) => { $("log").textContent += t + ";"; };
const perm = async () => { const q = await navigator.permissions.query({ name: "notifications" }); $("perm").textContent = "load " + atLoad + " now " + Notification.permission + " query " + q.state; };
perm(); setInterval(perm, 500);
let n;
$("ask").onclick = () => Notification.requestPermission().then((s) => log("asked " + s));
// A picture of about 900 KB (a PNG's start, then noise): given whole, and
// what the page shows meanwhile too.
$("big").onclick = () => {
    let bin = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==");
    const r = new Uint8Array(60000);
    for (let i = 0; i < 15; i++) { crypto.getRandomValues(r); bin += String.fromCharCode(...r); }
    new Notification("Big", { image: "data:image/png;base64," + btoa(bin) });
    log("big");
};
$("svg").onclick = () => { new Notification("Drawn", { icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" }); };
$("show").onclick = () => { n = new Notification("Hello", { body: "from the page", tag: "t1", icon: "pic.png" }); n.onshow = () => log("show"); n.onclick = () => log("click"); n.onclose = () => log("close"); n.onerror = () => log("error"); };
$("close").onclick = () => n.close();
$("late").onclick = () => setTimeout(() => Notification.requestPermission().then((s) => log("late " + s)), 6500);
</script>`,
        // Encrypted media (goeme.js, go-eme.js): a Clear Key player, its
        // stream encrypted (enc.mp4, CENC, its pssh naming its key), fed by
        // Media Source; its license given by the page itself, as a site's
        // license server would. Each step said in #log.
        "eme.html": `<!doctype html><title>EME</title><video id="v" width="320" height="180" muted></video><p id="log"></p><script src="eme.js"></script>`,
        "eme.js": `const log = (t) => { document.getElementById("log").textContent += t + ";"; };
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const b64url = (u) => btoa(String.fromCharCode(...u)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const KEY = hex("76a6c65c5ea762046bd749a2e632ccbb");
const type = 'video/mp4; codecs="avc1.42c00c"';
const v = document.getElementById("v");
v.addEventListener("encrypted", async (e) => {
    log("encrypted " + e.initDataType);
    const s = v.mediaKeys.createSession();
    s.addEventListener("message", (m) => {
        log("message");
        const req = JSON.parse(new TextDecoder().decode(m.message));
        s.update(new TextEncoder().encode(JSON.stringify({ keys: req.kids.map((kid) => ({ kty: "oct", kid, k: b64url(KEY) })), type: "temporary" })))
            .then(() => log("updated"), (err) => log("update failed " + err.name));
    });
    s.addEventListener("keystatuseschange", () => { for (const [, st] of s.keyStatuses) log("key " + st); });
    await s.generateRequest(e.initDataType, e.initData).catch((err) => log("generate failed " + err.name + " " + err.message));
}, { once: true });
(async () => {
    try {
        const access = await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: type }] }]);
        log("access " + access.keySystem);
        await v.setMediaKeys(await access.createMediaKeys());
        log("keys");
        const ms = new MediaSource();
        v.src = URL.createObjectURL(ms);
        await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
        const sb = ms.addSourceBuffer(type);
        sb.appendBuffer(await (await fetch("enc.mp4")).arrayBuffer());
        await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
        ms.endOfStream();
        log("appended");
        v.play().catch(() => {});
    } catch (err) { log("failed " + err.name + " " + err.message); }
})();
`,
        // The same player, with one in a frame of its origin and one in a
        // frame of another (?other: its https origin), each its own keys,
        // sessions and license: the page's, and its frames', at once.
        "emeframe.html": `<!doctype html><title>EME frames</title><video id="v" width="320" height="180" muted></video><p id="log"></p>
<iframe id="same" width="340" height="260" src="eme.html"></iframe> <iframe id="other" width="340" height="260"></iframe>
<script>const other = new URLSearchParams(location.search).get("other"); if (other) document.getElementById("other").src = other + "eme.html";</script>
<script src="eme.js"></script>`,
        // The page's location (godevice.js): once, and followed
        // (watchPosition) till cleared; each position, and error, in #log.
        "where.html": `<!doctype html><title>Where</title><button id="once">Once</button> <button id="follow">Follow</button> <button id="stop">Stop</button><p id="log"></p>
<script>
const log = (t) => { document.getElementById("log").textContent += t + ";"; };
let watch = null;
document.getElementById("once").onclick = () => navigator.geolocation.getCurrentPosition((p) => log("once " + p.coords.latitude), (e) => log("once error " + e.code));
document.getElementById("follow").onclick = () => { watch = navigator.geolocation.watchPosition((p) => log("pos " + p.coords.latitude), (e) => log("error " + e.code), { enableHighAccuracy: true }); };
document.getElementById("stop").onclick = () => { navigator.geolocation.clearWatch(watch); log("cleared"); };
</script>`,
        // Files the page makes to be downloaded (gomedia.js): a CSV made as
        // its button's pressed (a link made, clicked, let go), a picture's
        // link (data:), and the CSV made long after its press.
        "export.html": `<!doctype html><title>Export</title><button id="csv">Export CSV</button> <a id="png" download="dot.png" href="data:image/png;base64,${png(2, 2, [10, 200, 90]).toString("base64")}">Download the picture</a> <button id="later">Export later</button> <button id="two">Export twice</button><p id="log"></p>
<script>
const csv = () => {
    const url = URL.createObjectURL(new Blob(["name,count\\nalpha,1\\nbeta,2\\n"], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "report.csv";
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    document.getElementById("log").textContent += "exported;";
};
document.getElementById("csv").onclick = csv;
document.getElementById("later").onclick = () => setTimeout(csv, 11000);
document.getElementById("two").onclick = () => { csv(); setTimeout(csv, 1500); };
</script>`,
        // Files shared (godevice.js: navigator.share({files})), and a link.
        "share.html": `<!doctype html><title>Share</title><button id="share">Share</button> <button id="link">Share a link</button><p id="log"></p>
<script>
const log = (t) => { document.getElementById("log").textContent += t + ";"; };
const files = () => [new File(["hello from the page"], "note.txt", { type: "text/plain" }), new File([new Uint8Array([1, 2, 3, 4, 5])], "data.bin", { type: "application/octet-stream" })];
log("canShare " + navigator.canShare({ files: files() }));
document.getElementById("share").onclick = () => navigator.share({ title: "Notes", files: files() }).then(() => log("shared"), (e) => log("failed " + e.name));
document.getElementById("link").onclick = () => navigator.share({ url: "https://example.com/" }).then(() => log("shared link"), (e) => log("failed " + e.name));
</script>`,
        // File System Access (godevice.js, gofs.go): a file opened and read,
        // but not written (read only, as chosen); and one saved (a string, a
        // Blob at a position, 2 MB in many pieces, a truncate), then read
        // back from its handle.
        "fsa.html": `<!doctype html><title>Pickers</title><button id="open">Open</button> <button id="save">Save</button><p id="log"></p>
<script>
const log = (t) => { document.getElementById("log").textContent += t + ";"; };
log("pickers " + (typeof showOpenFilePicker) + " " + (typeof showSaveFilePicker));
document.getElementById("open").onclick = async () => {
    try {
        const [h] = await showOpenFilePicker({ types: [{ description: "Text", accept: { "text/plain": [".txt"] } }] });
        const f = await h.getFile();
        log("read " + h.kind + " " + f.name + " " + f.size + " " + (f instanceof File) + " " + JSON.stringify(await f.text()));
        const again = await h.getFile();
        log("again " + JSON.stringify(await again.text()));
        log("may write " + await h.queryPermission({ mode: "readwrite" }));
        await h.createWritable().then(() => log("written"), (e) => log("not written " + e.name));
    } catch (e) { log("failed " + e.name + " " + e.message); }
};
document.getElementById("save").onclick = async () => {
    try {
        const h = await showSaveFilePicker({ suggestedName: "out.txt" });
        const w = await h.createWritable();
        await w.write("hello ");
        await w.write({ type: "write", position: 6, data: new Blob(["world"]) });
        const big = new Uint8Array(2000000);
        for (let i = 0; i < big.length; i++) big[i] = i % 251;
        await w.write(big);
        await w.write("TAIL-cut");
        await w.truncate(11 + big.length + 4);
        await w.close();
        const f = await h.getFile();
        const bytes = new Uint8Array(await f.arrayBuffer());
        let sum = 0;
        for (const b of bytes) sum = (sum * 31 + b) >>> 0;
        log("saved " + h.name + " " + f.size + " " + sum);
    } catch (e) { log("failed " + e.name + " " + e.message); }
};
</script>`,
        "copyframe.html": `<!doctype html><button id="b" style="width:100%;height:60px">Copy here</button>
<script>document.getElementById("b").onclick = () => { document.addEventListener("copy", (e) => { e.clipboardData.setData("text/plain", "copied in another origin's frame"); e.preventDefault(); }, { once: true }); document.execCommand("copy"); };</script>`,
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
        // A box the page puts 16 pixels down each time it hears it scrolled
        // (as Shorts does till a job of its own says not to), where its
        // snapping puts it back.
        "snapback.html": `<!doctype html><title>Snap back</title><style>#box { height: 300px; width: 200px; overflow-y: scroll; scroll-snap-type: y mandatory } .reel { height: 300px; scroll-snap-align: start; background: #ddd }</style>
<div id="box">${Array.from({ length: 5 }, (_, i) => `<div class="reel">reel ${i}</div>`).join("")}</div><p id="heard">0</p>
<script>
const box = document.getElementById("box");
let heard = 0;
new ResizeObserver(() => { if (!box.dataset.sized) { box.dataset.sized = "1"; box.scrollTop = 16; } }).observe(box);
box.addEventListener("scroll", () => {
    document.getElementById("heard").textContent = String(++heard);
    requestAnimationFrame(() => { box.scrollTop = 16; });
});
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
        // The drop zone, embedded in a page of another origin.
        "filedropframe.html": `<!doctype html><title>File drop frame</title><p>around it</p><iframe id="x" width="460" height="300"></iframe>
<script>document.getElementById("x").src = "http://[::ffff:" + location.hostname + "]/filedrop.html";</script>`,
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
        // The page of another origin hidden (displayed none, as YouTube's
        // sign-in check is), then shown by its button.
        "xframe-hidden.html": `<!doctype html><title>Hidden frame</title><button id="show">Show it</button><iframe id="x" width="300" height="120" style="display: none"></iframe>
<script>
document.getElementById("x").src = "http://[::ffff:" + location.hostname + "]/xinner.html";
document.getElementById("show").onclick = () => { document.getElementById("x").style.display = ""; };
</script>`,
        // A page that goes on to its next address itself (pushState, as
        // YouTube's Shorts at each reel), a cookie set just before; its own
        // number for each load of it, to tell a fresh one.
        "swap.html": `<!doctype html><title>Swap</title><p id="load"></p><p id="where"></p><p id="c"></p><p id="ls"></p><input id="t"> <button id="next">Next</button>
<script>
document.getElementById("load").textContent = String(Math.random()).slice(2, 10);
document.getElementById("where").textContent = location.search || "first";
document.getElementById("c").textContent = document.cookie || "none";
try { document.getElementById("ls").textContent = localStorage.getItem("justset") ?? "none"; } catch (e) { document.getElementById("ls").textContent = e.name; }
document.getElementById("next").onclick = () => {
    const n = String(Date.now() % 100000);
    document.cookie = "justset=" + n + "; path=/";
    try { localStorage.setItem("justset", n); } catch { /* none */ }
    history.pushState({}, "", "?next" + (Date.now() % 100000));
    document.getElementById("where").textContent = location.search;
};
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
        // A WebM stream, its video and its sound in SourceBuffers of their own.
        "mse-webm.html": `<!doctype html><title>MSE WebM</title><video id="streamed" muted width="320" height="180"></video><script>
const streamed = document.getElementById("streamed"), source = new MediaSource();
source.onsourceopen = async () => {
    const feed = async (mime, file) => {
        const buffer = source.addSourceBuffer(mime);
        const data = await (await fetch(file)).arrayBuffer();
        await new Promise((done) => { buffer.addEventListener("updateend", done, { once: true }); buffer.appendBuffer(data); });
    };
    await Promise.all([feed('video/webm; codecs="vp8"', "stream-v.webm"), feed('audio/webm; codecs="opus"', "stream-a.webm")]);
    source.endOfStream();
    streamed.play().catch(() => {});
};
streamed.src = URL.createObjectURL(source);
</script>`,
        // A video fetched whole and played from a plain Blob's URL (gomedia.js
        // relays its bytes); in a frame of another origin too (?frame).
        "blob-video.html": `<!doctype html><title>Blob video</title><video id="v" muted width="320" height="180"></video><iframe id="x" width="360" height="220"></iframe>
<script>
if (location.search === "?frame") { document.getElementById("v").remove(); document.getElementById("x").src = "http://[::ffff:" + location.hostname + "]/blob-video.html"; }
else { document.getElementById("x").remove(); fetch("clip.mp4").then((r) => r.blob()).then((b) => { document.getElementById("v").src = URL.createObjectURL(b); }); }
</script>`,
        // A MediaSource stream in an embedded page: of this origin (?same),
        // or another's (goframestreams.go).
        "mse-frame.html": `<!doctype html><title>MSE frame</title><p>a stream in a frame:</p><iframe id="x" width="360" height="220"></iframe>
<script>document.getElementById("x").src = (location.search === "?same" ? "" : "http://[::ffff:" + location.hostname + "]/") + "mse-save.html";</script>`,
        // HLS-style attach and playback on a controller-created video.
        "mse-hls-like.html": `<!doctype html><title>MSE HLS-like</title>${hlsLikeVideo}`,
        "mse-hls-like.m3u8": "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:3,\npart.m4s\n#EXT-X-ENDLIST\n",
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
        // A stream played at once, by the page's first script, before the
        // agent's world is made (YouTube's Shorts' player, starting as the
        // page loads): its play() said once the agent's there.
        "mse-early.html": `<!doctype html><title>MSE early</title>
<video id="streamed" muted width="320" height="180"></video>
<script>
const streamed = document.getElementById("streamed"), source = new MediaSource();
streamed.src = URL.createObjectURL(source);
streamed.play().catch(() => {});
source.onsourceopen = async () => {
    const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42c00c"');
    buffer.onupdateend = () => { buffer.onupdateend = null; source.endOfStream(); };
    buffer.appendBuffer(await (await fetch("stream.mp4")).arrayBuffer());
};
</script>`,
        "mse-pause.html": `<!doctype html><title>MSE pause</title>
<video id="streamed" muted width="320" height="180"></video>
<button type="button" id="pause">Pause</button>
<button type="button" id="quick">Play and pause</button>
<button type="button" id="idle">Pause again</button>
<button type="button" id="again">Stop and play</button>
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
// (Shorts' "stopVideo" then "playVideo", within a task.)
document.getElementById("again").onclick = () => { streamed.play().catch(() => {}); streamed.pause(); streamed.play().catch(() => {}); };
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
    // A WebM stream's video and sound, each a SourceBuffer's (mse-webm.html).
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "3",
        "-c:v", "libvpx", "-g", "12", "-b:v", "300k", "-f", "webm", join(dir, "stream-v.webm")]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:a", "libopus", "-f", "webm", join(dir, "stream-a.webm")]);
    writeFileSync(join(dir, "part.m4s"), fragmented.subarray(split));
    // A stream encrypted (CENC) for a Clear Key player (eme.html), with the
    // key and key ID eme.html's: its own clip, 4 s, so the file saved from
    // it decrypted is told from the clear stream's saves (go-check.sh).
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12", "-t", "4",
        "-c:v", "libx264", "-profile:v", "baseline", "-level:v", "1.2", "-pix_fmt", "yuv420p",
        "-movflags", "+empty_moov+frag_keyframe+default_base_moof", join(dir, "enc-clear.mp4")]);
    writeFileSync(join(dir, "enc.mp4"), cenc(readFileSync(join(dir, "enc-clear.mp4")), "76a6c65c5ea762046bd749a2e632ccbb", "a7e61c373e219033c21091fa607bf3b8"));
    rmSync(join(dir, "enc-clear.mp4"));
    writeFileSync(join(dir, "pic2.png"), png(8, 8, [30, 30, 200]));
    writeFileSync(join(dir, "favicon.ico"), png(16, 16, [30, 160, 60]));  // (a PNG, as many sites' are)
    writeFileSync(join(dir, "font.ttf"), systemFont());
}

// (ffmpeg 7.1 writes no senc, saiz or saio in an encrypted fragment's
// traf, so a browser can't decrypt its CENC: done here.)
// cenc encrypts a clear fragmented MP4 (one AVC track) with CENC, AES-CTR:
// its sample entry made encv (sinf: frma, schm cenc, tenc with kid), a
// common-system pssh in its moov; each sample's NAL units' payloads
// encrypted (their lengths and headers clear), each traf given its
// saiz, saio and senc.
function cenc(clear, keyHex, kidHex) {
    const key = Buffer.from(keyHex, "hex"), kid = Buffer.from(kidHex, "hex");
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
    const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, "ascii"), body]); };
    const full = (type, version, flags, ...parts) => box(type, u32((version << 24) | flags), ...parts);
    const kids = (buf) => {
        const out = [];
        for (let o = 0; o + 8 <= buf.length;) {
            const size = buf.readUInt32BE(o);
            out.push({ type: buf.toString("ascii", o + 4, o + 8), data: buf.subarray(o + 8, o + size) });
            o += size;
        }
        return out;
    };
    const pssh = full("pssh", 1, 0, Buffer.from("1077efecc0b24d02ace33c1e52e2fb4b", "hex"), u32(1), kid, u32(0));
    const sinf = box("sinf", box("frma", Buffer.from("avc1")), full("schm", 0, 0, Buffer.from("cenc"), u32(0x10000)),
        box("schi", full("tenc", 0, 0, Buffer.from([0, 0, 1, 8]), kid)));
    const containers = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    const init = (type, data) => {
        if (containers.has(type)) return box(type, ...kids(data).map((c) => init(c.type, c.data)), ...(type === "moov" ? [pssh] : []));
        if (type === "stsd") return box("stsd", data.subarray(0, 8), ...kids(data.subarray(8)).map((c) => c.type === "avc1" ? box("encv", c.data, sinf) : box(c.type, c.data)));
        return box(type, data);
    };
    const out = [];
    let iv = 1n;
    const top = kids(clear);
    for (let i = 0; i < top.length; i++) {
        const { type, data } = top[i];
        if (type === "moov") { out.push(init(type, data)); continue; }
        if (type !== "moof") { if (type !== "mdat") out.push(box(type, data)); continue; }
        const mdat = top[i + 1];
        if (mdat?.type !== "mdat") throw new Error("a moof without its mdat");
        i++;
        const [mfhd, traf] = [kids(data).find((c) => c.type === "mfhd"), kids(data).find((c) => c.type === "traf")];
        const parts = kids(traf.data);
        const tfhd = parts.find((c) => c.type === "tfhd").data, trun = parts.find((c) => c.type === "trun").data;
        const tf = tfhd.readUInt32BE(0) & 0xffffff;
        let o = 8, defaultSize = 0;
        if (tf & 0x1) o += 8;
        if (tf & 0x2) o += 4;
        if (tf & 0x8) o += 4;
        if (tf & 0x10) defaultSize = tfhd.readUInt32BE(o);
        const rf = trun.readUInt32BE(0) & 0xffffff, count = trun.readUInt32BE(4);
        if (!(rf & 0x1)) throw new Error("a trun without its data offset");
        let at = 12 + (rf & 0x4 ? 4 : 0);
        const sizes = [];
        for (let s = 0; s < count; s++) {
            if (rf & 0x100) at += 4;
            sizes.push(rf & 0x200 ? trun.readUInt32BE(at) : defaultSize);
            if (rf & 0x200) at += 4;
            if (rf & 0x400) at += 4;
            if (rf & 0x800) at += 4;
        }
        const body = Buffer.from(mdat.data), aux = [];
        let p = 0;
        for (const size of sizes) {
            const ivBytes = Buffer.alloc(8);
            ivBytes.writeBigUInt64BE(iv++);
            const cipher = createCipheriv("aes-128-ctr", key, Buffer.concat([ivBytes, Buffer.alloc(8)]));
            const subs = [];
            for (let n = p; n < p + size;) {
                const len = body.readUInt32BE(n), clearBytes = 5, prot = len - 1;
                const enc = cipher.update(body.subarray(n + clearBytes, n + 4 + len));
                enc.copy(body, n + clearBytes);
                subs.push([clearBytes, prot]);
                n += 4 + len;
            }
            p += size;
            const entry = Buffer.alloc(8 + 2 + subs.length * 6);
            ivBytes.copy(entry, 0);
            entry.writeUInt16BE(subs.length, 8);
            subs.forEach(([c, e], k) => { entry.writeUInt16BE(c, 10 + k * 6); entry.writeUInt32BE(e, 12 + k * 6); });
            aux.push(entry);
        }
        const saiz = full("saiz", 0, 0, Buffer.from([0]), u32(count), Buffer.from(aux.map((a) => a.length)));
        const senc = full("senc", 0, 0x2, u32(count), ...aux);
        const build = (saioOffset, dataOffset) => {
            const t = Buffer.from(trun);
            t.writeInt32BE(dataOffset, 8);
            const others = parts.filter((c) => c.type !== "trun").map((c) => box(c.type, c.data));
            return box("moof", box("mfhd", mfhd.data), box("traf", ...others, box("trun", t), saiz, full("saio", 0, 0, u32(1), u32(saioOffset)), senc));
        };
        const first = build(0, 0);
        const sencAt = first.indexOf(Buffer.from("senc")) - 4;
        const moof = build(sencAt + 16, first.length + 8);
        out.push(moof, box("mdat", body));
    }
    return Buffer.concat(out);
}
