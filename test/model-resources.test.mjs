import test from "node:test";
import assert from "node:assert/strict";
import { resourceCandidates, fetchResources, gltfReferences, glbJSON, UNSUPPORTED, MAX_RESOURCE_FILES, MAX_RESOURCE, MAX_RESOURCE_LOOKUPS, fbxText, fbxTextVersion } from "../tabtopd/model-resources.js";

test("where a model's files are looked for: relative to it, then by name beside it; never outside the root, nor the web", () => {
    assert.deepEqual(resourceCandidates("models/car", "textures/paint.png"), ["models/car/textures/paint.png", "models/car/paint.png"]);
    assert.deepEqual(resourceCandidates("models/car", "../shared/wood.jpg"), ["models/shared/wood.jpg", "models/car/wood.jpg"]);
    // Above the root: only by name, beside it.
    assert.deepEqual(resourceCandidates("models", "../../../etc/passwd"), ["models/passwd"]);
    // Where it was made: by name alone.
    assert.deepEqual(resourceCandidates("m", "C:\\Users\\me\\Documents\\wood floor.tga"), ["m/wood floor.tga"]);
    assert.deepEqual(resourceCandidates("m", "/tmp/monkey.fbm/UVTexture.png"), ["m/UVTexture.png"]);
    assert.deepEqual(resourceCandidates("", "monkey.fbm/UVTexture.png"), ["monkey.fbm/UVTexture.png", "UVTexture.png"]);
    // An MTL's or FBX's names are names: a % is a %. (Paths are as the files are named.)
    assert.deepEqual(resourceCandidates("m", "100%.png"), ["m/100%.png"]);
    // glTF's are URIs: percent-encoded.
    assert.deepEqual(resourceCandidates("m", "my%20texture.png", { uri: true }), ["m/my texture.png"]);
    for (const ref of ["https://example.com/a.png", "data:image/png;base64,AAAA", "blob:https://x/1", "", "  "]) {
        assert.deepEqual(resourceCandidates("m", ref), [], ref);
    }
});

test("reading them: the first place each is, each once; what isn't, said; no more than the limits", async () => {
    globalThis.URL.createObjectURL ??= () => "blob:x";
    const made = [];
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (b) => { made.push(b); return `blob:${made.length}`; };
    const revoked = [];
    URL.revokeObjectURL = (u) => revoked.push(u);
    try {
        const files = { "m/a.png": "A", "m/b.png": "B", "m/sub/c.png": "C" };
        const asked = [];
        const read = async (path) => {
            asked.push(path);
            if (!(path in files)) throw new Error("not there");
            return new Blob([files[path]]);
        };
        const r = await fetchResources("m", ["sub/c.png", "x/a.png", "a.png", "gone.png", "https://e/x.png"], read);
        assert.deepEqual([...r.urls.keys()], ["sub/c.png", "x/a.png", "a.png"]);
        assert.deepEqual(r.missing, ["gone.png"]);
        assert.equal(r.paths.get("x/a.png"), "m/a.png");
        assert.equal(await r.blobs.get("sub/c.png").text(), "C");
        assert.deepEqual(asked, ["m/sub/c.png", "m/x/a.png", "m/a.png", "m/a.png", "m/gone.png"]);
        r.revoke();
        assert.equal(revoked.length, 3);
        // Too many, or too big: not read, said to be missing.
        const many = Array.from({ length: MAX_RESOURCE_FILES + 2 }, (_, i) => `f${i}.png`);
        const lots = await fetchResources("", many, async () => new Blob(["x"]));
        assert.equal(lots.urls.size, MAX_RESOURCE_FILES);
        assert.equal(lots.missing.length, 2);
        // Thousands named, none there: only so many looked for.
        let reads = 0;
        const none = await fetchResources("", Array.from({ length: 5000 }, (_, i) => `x${i}.png`), async () => { reads++; throw new Error("not there"); });
        assert.equal(none.missing.length, 5000);
        assert.equal(reads, MAX_RESOURCE_LOOKUPS);
        const big = await fetchResources("", ["huge.png"], async () => ({ size: MAX_RESOURCE + 1 }));
        assert.deepEqual(big.missing, ["huge.png"]);
        // Given up on: stops.
        const stop = new AbortController();
        stop.abort();
        await assert.rejects(fetchResources("", ["a.png"], read, { signal: stop.signal }));
    } finally {
        URL.createObjectURL = saved.create;
        URL.revokeObjectURL = saved.revoke;
    }
});

test("glTF: what it refers to; a .glb's JSON; extensions it can't show", () => {
    assert.deepEqual(gltfReferences({ buffers: [{ uri: "a.bin" }, { uri: "data:application/octet-stream;base64,AA==" }, {}],
        images: [{ uri: "t.png" }, { bufferView: 1 }] }), ["a.bin", "t.png"]);
    const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" } }) + "  ");
    const glb = new Uint8Array(20 + json.length);
    const v = new DataView(glb.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, glb.length, true);
    v.setUint32(12, json.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    glb.set(json, 20);
    assert.deepEqual(glbJSON(glb.buffer), { asset: { version: "2.0" } });
    assert.throws(() => glbJSON(new ArrayBuffer(8)), /isn't a binary glTF/);
    assert.ok(UNSUPPORTED.KHR_draco_mesh_compression);
});

test("text (ASCII) FBX: its property values without spaces after commas, as three.js reads them; its version", () => {
    const enc = (t) => new TextEncoder().encode(t);
    const file = `; FBX 7.5.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 7500
}
\tP: "Lcl Rotation", "Lcl Rotation", "", "A", -90, -0, 0
\tP: "Lcl Scaling", "Lcl Scaling", "", "A",100,100,100
\tP: "Scaling", "Vector", "", "A", 1, 1, 0
\tP: "Name", "KString", "", "", "a, b"
\ta: 1, 2, 3
`;
    const out = fbxText(enc(file));
    assert.match(out, /"A",-90,-0,0\n/);
    assert.match(out, /"A",100,100,100\n/);
    assert.match(out, /P: "Scaling", "Vector3D", "", "A",1,1,0\n/);
    // What's in quotes, and what isn't a property, as it was.
    assert.match(out, /"a, b"\n/);
    assert.match(out, /a: 1, 2, 3\n/);
    assert.equal(fbxTextVersion(out), 7500);
    assert.equal(fbxTextVersion("; FBX 6.1.0 project file\n"), 6100);
    assert.equal(fbxTextVersion("nothing said"), 0);
    assert.equal(fbxText(enc("Kaydara FBX Binary  \0\x1a\0")), null);
});
