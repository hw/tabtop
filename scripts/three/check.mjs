// Checks a folder vendor.sh made: every file in it loads as the page loads
// it (by its relative imports alone), and the loaders the 3D preview uses
// parse a small model of each kind, ASCII and binary, to the triangles it
// has. (AMF is XML, which its loader reads with DOMParser: only loaded
// here, as Node hasn't it.)
//
// Usage: node scripts/three/check.mjs <folder>
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.argv[2] ?? "");
const load = (name) => import(pathToFileURL(`${dir}/${name}`).href);
for (const name of readdirSync(dir).filter((n) => n.endsWith(".js"))) await load(name);

const THREE = await load("three.module.js");
const { STLLoader } = await load("STLLoader.js");
const { OBJLoader } = await load("OBJLoader.js");
const { PLYLoader } = await load("PLYLoader.js");
await load("AMFLoader.js");
const { unzipSync, zipSync } = await load("fflate.module.js");
await load("OrbitControls.js");

const triangles = (geometry) => (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
const expect = (what, got, want) => {
    if (got !== want) throw new Error(`${what}: ${got}, not ${want}`);
    console.log(`ok - ${what}: ${got}`);
};
const enc = (s) => new TextEncoder().encode(s).buffer;
expect("fflate round trip", new TextDecoder().decode(unzipSync(zipSync({ a: new TextEncoder().encode("model") })).a), "model");

// A tetrahedron, as each format has it.
const P = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
const F = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const ascii = `solid t\n${F.map((f) => `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${P[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid t\n`;
expect("ASCII STL triangles", triangles(new STLLoader().parse(enc(ascii))), 4);
const binary = new DataView(new ArrayBuffer(84 + 50 * F.length));
binary.setUint32(80, F.length, true);
F.forEach((f, n) => f.forEach((i, k) => P[i].forEach((v, c) => binary.setFloat32(84 + n * 50 + 12 + k * 12 + c * 4, v, true))));
expect("binary STL triangles", triangles(new STLLoader().parse(binary.buffer)), 4);
const obj = new OBJLoader().parse(`${P.map((p) => `v ${p.join(" ")}`).join("\n")}\n${F.map((f) => `f ${f.map((i) => i + 1).join(" ")}`).join("\n")}\n`);
let objTriangles = 0;
obj.traverse((o) => { if (o.isMesh) objTriangles += triangles(o.geometry); });
expect("OBJ triangles", objTriangles, 4);
const plyHead = (format) => `ply\nformat ${format} 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n`;
expect("ASCII PLY triangles", triangles(new PLYLoader().parse(enc(plyHead("ascii") + P.map((p) => p.join(" ")).join("\n") + "\n" + F.map((f) => `3 ${f.join(" ")}`).join("\n") + "\n"))), 4);
const head = new Uint8Array(enc(plyHead("binary_little_endian")));
const body = new DataView(new ArrayBuffer(4 * 12 + 4 * 13));
P.forEach((p, i) => p.forEach((v, c) => body.setFloat32(i * 12 + c * 4, v, true)));
F.forEach((f, n) => { body.setUint8(48 + n * 13, 3); f.forEach((i, k) => body.setInt32(48 + n * 13 + 1 + k * 4, i, true)); });
const ply = new Uint8Array(head.length + body.byteLength);
ply.set(head);
ply.set(new Uint8Array(body.buffer), head.length);
expect("binary PLY triangles", triangles(new PLYLoader().parse(ply.buffer)), 4);
expect("one three.js", new THREE.Mesh().isMesh, true);
