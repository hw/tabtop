// Run by TestTunnelInteropWithJS from a directory holding tunnel.js and
// noble/: checks the Elligator2 map, then logs in, lists Downloads and
// fetches a file through tabtopd's tunnel with the page's own tunnel.js.
// Exits 3 if this Node can't run it.

if (typeof WebSocket === "undefined" || !globalThis.crypto?.subtle) {
    console.log("no WebSocket or WebCrypto");
    process.exit(3);
}
try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
} catch {
    console.log("no X25519");
    process.exit(3);
}

const { Tunnel, login, elligator2 } = await import(new URL("./tunnel.js", import.meta.url));
const [url, credential, vectors] = process.argv.slice(2);

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
    elligator: ell,
    session: session.id,
    entries: list.reply.entries,
    fileSHA: Array.from(sum, (b) => b.toString(16).padStart(2, "0")).join(""),
}));
