// Run by TestTunnelInteropWithJS from a directory holding tunnel.js and
// noble/: checks the Elligator2 map, then logs in, lists Downloads and
// fetches a file through tabtopd's tunnel with the page's own tunnel.js,
// using the crypto backend named by the last argument ("noble" forces it;
// otherwise tunnel.js picks, as in a browser). Logging in and opening a
// tunnel at a URL that refuses the WebSocket must fail rather than hang.
// Exits 3 if this Node can't run it.

if (typeof WebSocket === "undefined") {
    console.log("no WebSocket");
    process.exit(3);
}

const { Tunnel, login, elligator2, cpaceGenerator, cpaceISK, cryptoBackend } = await import(new URL("./tunnel.js", import.meta.url));
const [url, credential, vectors, backend, refusing, cpaceVectors] = process.argv.slice(2);
const crypto_ = await cryptoBackend({ useNoble: backend === "noble" });

const ell = JSON.parse(vectors).map((v) => elligator2(BigInt("0x" + v.in)).toString(16));

// The draft's CPace vectors: the generator, and the ISK from the given K and
// shares (X25519 itself is the backend's).
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const tohex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const cv = JSON.parse(cpaceVectors);
const cpace = {
    generator: tohex(await cpaceGenerator(crypto_, cv.prs, unhex(cv.sid), cv.ci)),
    isk: tohex(await cpaceISK(crypto_, unhex(cv.sid), unhex(cv.k), unhex(cv.ya), unhex(cv.yb),
        new TextEncoder().encode(cv.ada), new TextEncoder().encode(cv.adb))),
};

const refused = [];
for (const attempt of [() => login(credential, refusing), () => Tunnel.open({ type: "list", path: "" }, { id: "x", secret: "" }, refusing)]) {
    let timer;
    const err = await Promise.race([
        attempt().then(() => "succeeded", (e) => e),
        new Promise((resolve) => (timer = setTimeout(resolve, 5000, "hung"))),
    ]);
    clearTimeout(timer);
    refused.push(err?.constructor?.name === "TunnelError" ? "TunnelError" : String(err));
}

const session = await login(credential, url);
const list = await Tunnel.open({ type: "list", path: "" }, session, url);
list.close();

const file = await Tunnel.open({ type: "file", path: "f.bin" }, session, url);
const chunks = [];
for (let data; (data = await file.nextChunk());) {
    chunks.push(new Uint8Array(data));
}
const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(chunks).arrayBuffer()));

console.log(JSON.stringify({
    backend: crypto_.name,
    refused,
    elligator: ell,
    cpace,
    session: session.id,
    entries: list.reply.entries,
    fileSHA: tohex(sum),
}));
