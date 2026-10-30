// Run by TestTunnelInteropWithJS from a directory holding tunnel.js and
// noble/: checks the Elligator2 map, then logs in, lists Downloads and
// fetches a file through tabtopd's tunnel with the page's own tunnel.js,
// using the crypto backend named by the last argument ("noble" forces it;
// otherwise tunnel.js picks, as in a browser).
// Exits 3 if this Node can't run it.

if (typeof WebSocket === "undefined") {
    console.log("no WebSocket");
    process.exit(3);
}

const { Tunnel, login, elligator2, cryptoBackend } = await import(new URL("./tunnel.js", import.meta.url));
const [url, credential, vectors, backend] = process.argv.slice(2);
const crypto_ = await cryptoBackend({ useNoble: backend === "noble" });

const ell = JSON.parse(vectors).map((v) => elligator2(BigInt("0x" + v.in)).toString(16));

const session = await login(credential, url);
const list = await Tunnel.open({ type: "list", path: "" }, session, url);
list.close();

const file = await Tunnel.open({ type: "file", path: "f.bin" }, session, url);
const chunks = [];
for (let m; (m = await file.next());) {
    chunks.push(new Uint8Array(m.data));
}
const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(chunks).arrayBuffer()));

console.log(JSON.stringify({
    backend: crypto_.name,
    elligator: ell,
    session: session.id,
    entries: list.reply.entries,
    fileSHA: Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join(""),
}));
