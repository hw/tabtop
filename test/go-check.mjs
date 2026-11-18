// The remote browser's end-to-end check, run by go-check.sh.
//
//   node go-check.mjs site DIR            writes the test site into DIR
//   node go-check.mjs check BASE PORT SITE checks /go at BASE with the
//                                         Chrome whose DevTools are on PORT,
//                                         browsing the test site at SITE
//
// Throughout, every request Chrome makes, from the page and from its frames,
// is recorded: none may go anywhere but the TabTop server.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const files = {
        "index.html": `<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="h">Fixture</h1>
<p id="p" onclick="steal()">static</p>
<p id="ws"><a href="a.html">portable</a> <a href="b.html">binary</a>
<b>code</b></p>
<img id="img" src="pic.png" srcset="pic.png 1x, pic2.png 2x" alt="picture">
<div id="bg" style="background-image:url(pic.png);width:10px;height:10px"></div><div id="varbg" style="width:10px;height:10px"></div>
<iframe id="frame" src="https://example.com/"></iframe>
<object data="https://example.com/x.swf"></object>
<a id="next" href="second.html">next</a> <a id="jump" href="#end">end</a>
<form id="form" action="https://example.com/steal"><input name="q"><button>Send</button></form>
<svg width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect id="rect" width="20" height="20" fill="url(#g)"/></svg>
<div style="height:3000px"></div><p id="end">the end</p>
<script>document.getElementById("p").textContent = "scripted"; fetch("https://example.com/beacon").catch(() => {});</script>
</body></html>`,
        "second.html": `<!doctype html><title>Second</title><p id="p">second page</p><a id="back" href="index.html">back</a>`,
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
        "result.html": `<!doctype html><title>Result</title><p id="p"></p><script>document.getElementById("p").textContent = "query " + new URLSearchParams(location.search).get("q");</script>`,
        "view.html": `<!doctype html><title>View</title><style>body { margin: 0 } #hd { height: 123px; background: #eee } .wide-only { display: none } @media (min-width: 900px) { .wide-only { display: block } }</style>
<header id="hd"><button id="menu">Menu</button></header><p id="w"></p><p id="mq"></p><p class="wide-only" id="wide">wide</p>
<script>
const show = () => { document.getElementById("w").textContent = "width " + innerWidth; document.getElementById("mq").textContent = matchMedia("(min-width: 900px)").matches ? "wide" : "narrow"; };
show(); addEventListener("resize", show);
document.getElementById("menu").onclick = () => { const o = document.createElement("div"); o.id = "overlay"; o.style.cssText = "position: fixed; left: 0; right: 0; bottom: 0; background: #def"; o.style.top = document.getElementById("hd").getBoundingClientRect().bottom + "px"; o.textContent = "menu"; document.body.append(o); };
</script>`,
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
        "churn.html": `<!doctype html><title>Churn</title><p id="n">0</p><script>let n = 0; setInterval(() => { document.getElementById("n").textContent = ++n; }, 5);</script>`,
        "doc.pdf": "%PDF-1.4 not really",
        "style.css": `@import "more.css";
@font-face { font-family: "Fixture Font"; src: url(font.ttf) format("truetype"); }
#p { color: teal; }
:root { --pic: url(pic.png); }
#varbg { background-image: var(--pic); }
h1 { font-family: "Fixture Font", sans-serif; }`,
        "more.css": `body { background-color: rgb(250, 250, 240); }`,
        "serve.js": `const http = require("http"), fs = require("fs"), path = require("path");
const types = { ".html": "text/html", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".pdf": "application/pdf" };
http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Posted</title><p id=p>" + body.replace(/[<&]/g, "") + "</p>"); });
    return;
  }
  const file = path.join("/srv", path.normalize(decodeURIComponent(req.url.split("?")[0])));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(80);`,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, "pic.png"), png(4, 4, [200, 30, 30]));
    writeFileSync(join(dir, "pic2.png"), png(8, 8, [30, 30, 200]));
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

async function check(base, port, site) {
    const browser = await createBrowserHarness({ port, base });
    const { cdp, ev, waitFor, open, inFrame, exceptions } = browser;
    const frame = (expr) => inFrame("go-frame.html", expr);
    // frameClick clicks the element in the frame that sel finds, at its place
    // on the screen: a click the page sees as a person's.
    async function frameClick(sel) {
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
        await waitFor(`document.title.startsWith(${JSON.stringify(title)})`, title, 30000);
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
        await open("go/", `!!document.querySelector("#tabtop_login input")`, "the login form");
        const code = await totp();
        await ev(`(() => { const i = document.querySelector("#tabtop_login input"); i.value = ${JSON.stringify(code)}; i.form.requestSubmit(); })()`);
        await waitFor(`!document.querySelector("#tabtop_login") && !!document.getElementById("go_url")`, "the browser page");
    });

    await step("the browser toolbar fits a mobile viewport", async () => {
        try {
            await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
            await waitFor(`document.getElementById("go_view").getBoundingClientRect().width === 390`, "mobile layout");
            const layout = await ev(`(() => {
                const input = document.getElementById("go_url"), bar = document.getElementById("go_bar");
                const view = document.getElementById("go_view").getBoundingClientRect();
                return { font: parseFloat(getComputedStyle(input).fontSize), radius: parseFloat(getComputedStyle(input).borderRadius),
                    targets: [...bar.querySelectorAll("button")].every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44),
                    top: view.top, barBottom: bar.getBoundingClientRect().bottom, bottom: view.bottom, height: visualViewport.height,
                    overflow: document.documentElement.scrollWidth > innerWidth };
            })()`);
            if (layout.font < 16 || layout.radius > 6 || !layout.targets || layout.overflow || layout.top !== layout.barBottom || Math.abs(layout.bottom - layout.height) > 1) {
                throw new Error(JSON.stringify(layout));
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
        return await ev(`document.getElementById("go_url").value`);
    });

    await step("stylesheets, imports, fonts and pictures through the server", async () => {
        await frame(`document.fonts.ready`);
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
        if (!(await ev(`document.getElementById("go_url").value`)).endsWith("/second.html")) throw new Error("the address bar didn't follow");
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
        for (let i = 0; i < 50 && !(await frame(`!!document.getElementById("jump")`).catch(() => false)); i++) await sleep(100);
        await frameClick("#jump");
        await waitFor(`document.getElementById("go_url").value.endsWith("#end")`, "the address with #end");
        const y = await frame(`scrollY`);
        if (!(y > 1000)) throw new Error(`scrolled to ${y}`);
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
    });

    await step("an address in a link from elsewhere waits for Enter", async () => {
        const url = site + "result.html?q=linked";
        // In one go, to a new address: the page there before can't put its
        // own address back in between.
        await ev(`sessionStorage.clear(); location.replace(location.pathname + "?linked#" + ${JSON.stringify(url)})`);
        await waitFor(`!!document.getElementById("go_url") && document.getElementById("go_url").value === ${JSON.stringify(url)}`, "the address waiting", 30000);
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

    await step("a checkbox and a select", async () => {
        await frameClick("#cb");
        await frameWait(`document.getElementById("status").textContent === "checked true"`, "the box ticked in the engine");
        await frame(`document.getElementById("sel").focus()`);
        await browser.press("ArrowDown");
        await frameWait(`document.getElementById("status").textContent === "selected b"`, "the option chosen in the engine");
    });

    await step("a route by history.pushState shows in the address bar", async () => {
        await frameClick("#push");
        await waitFor(`document.getElementById("go_url").value.endsWith("/routed")`, "the routed address");
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
        if (!(await ev(`document.getElementById("go_url").value`)).includes("result.html?q=cats")) throw new Error("the address bar didn't follow");
    });

    await step("a POST form", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("send")`, "the page");
        await frameClick("#send");
        await waitFor(`document.title.startsWith("Posted")`, "the posted page", 30000);
        await frameWait(`document.getElementById("p")?.textContent === "pq=posted+value"`, "what was posted");
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
        await waitFor(`document.title.startsWith("Second")`, "the opened window, here", 30000);
    });

    await step("a link to a file offers to save it", async () => {
        await goTo(site + "interact.html", "Interact");
        await frameWait(`!!document.getElementById("pdf")`, "the page");
        await frameClick("#pdf");
        await waitFor(`!document.getElementById("go_notice").hidden && document.querySelector("#go_notice p").textContent.includes("application/pdf")`, "the file notice", 30000);
        if (process.env.GO_NO_FS === "1") {
            if (!(await ev(`document.querySelector("#go_notice p").textContent.includes("turned off") && document.querySelector("#go_notice button").hidden`))) throw new Error("offered to save with files off");
        } else {
            await ev(`document.querySelector("#go_notice button").click()`);
            await waitFor(`document.querySelector("#go_notice p").textContent.startsWith("Saved doc.pdf")`, "the file saved", 30000);
            if (!(await ev(`document.querySelector("#go_notice .primary").textContent === "Open Downloads" && !document.querySelector("#go_notice .primary").hidden`))) throw new Error("no action to open Downloads");
        }
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
        await goTo(site + "view.html", "View");
        const frameWidth = () => ev(`Math.round(document.getElementById("go_view").getBoundingClientRect().width)`);
        let fw = await frameWidth();
        await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "wide"`, `the page at ${fw} wide`);
        // Narrower: the page's own resize handler and media query follow.
        await cdp("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
        try {
            fw = await frameWidth();
            await frameWait(`document.getElementById("w")?.textContent === "width ${fw}" && document.getElementById("mq").textContent === "narrow"`, `the page at ${fw} wide`);
            // A menu placed by measuring its header lands under it.
            await frameClick("#menu");
            await frameWait(`document.getElementById("overlay")?.style.top === "123px"`, "the menu under the header");
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
            const file = join(process.env.GO_SHOTS || ".", new URL(url).host + ".png");
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
    await check(args[0], Number(args[1]), args[2]);
} else {
    console.error("usage: go-check.mjs site DIR | check BASE PORT SITE");
    process.exit(2);
}
