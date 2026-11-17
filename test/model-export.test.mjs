// "Save as STL" (model-export.js): meshes as shown, read back by three.js's
// STL loader: every triangle (an instanced mesh's, each instance's), Y up
// made Z up, scaled, and a mirrored mesh's faces still outwards.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stlFrom, MAX_STL_TRIANGLES } from "../tabtopd/model-export.js";

const assets = process.env.THREE_ASSETS;
const load = (name) => import(`${pathToFileURL(resolve(assets)).href}/${name}`);

test("Save as STL: meshes as shown, Z up, scaled, faces outwards", { skip: !assets && "THREE_ASSETS isn't set" }, async () => {
    const THREE = await load("three.module.js");
    const { STLLoader } = await load("STLLoader.js");
    const scene = new THREE.Group();
    // A box 10 wide, 20 high, 30 deep, standing on the plate (y from 0 to 20).
    const box = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 30).translate(0, 10, 0));
    scene.add(box);
    // Two instances of a small box, beside it.
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), undefined, 2);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(20, 1, 0));
    instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(30, 1, 0));
    scene.add(instanced);
    // A mirrored box (scaled -1 in x): its faces must still face out.
    const mirrored = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
    mirrored.position.set(-20, 2, 0);
    mirrored.scale.set(-1, 1, 1);
    scene.add(mirrored);
    scene.updateMatrixWorld(true);

    const read = (buffer) => new STLLoader().parse(buffer);
    let geometry = read(stlFrom(THREE, [box, instanced, mirrored]));
    assert.equal(geometry.attributes.position.count / 3, 12 * 4);
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    // Shown Y up is the STL's Z: the box 20 high stands from z 0 to 20; its depth (30) is y.
    assert.deepEqual([min.z, max.z].map((v) => Math.round(v) + 0), [0, 20]);
    assert.deepEqual([min.y, max.y].map((v) => Math.round(v) + 0), [-15, 15]);
    assert.deepEqual([min.x, max.x].map((v) => Math.round(v) + 0), [-22, 31]);

    // Every face outwards: its normal (from its corners' order) away from its box's centre.
    const centres = [[0, 0, 10], [20, 0, 1], [30, 0, 1], [-20, 0, 2]];
    const p = geometry.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
        n.crossVectors(b.clone().sub(a), c.clone().sub(a));
        const mid = a.clone().add(b).add(c).divideScalar(3);
        const centre = centres.reduce((best, x) => (mid.distanceTo(new THREE.Vector3(...x)) < mid.distanceTo(new THREE.Vector3(...best)) ? x : best));
        assert.ok(n.dot(mid.sub(new THREE.Vector3(...centre))) > 0, `face ${i / 3} faces in`);
    }

    // Metres to millimetres.
    geometry = read(stlFrom(THREE, [box], { scale: 1000 }));
    geometry.computeBoundingBox();
    assert.equal(Math.round(geometry.boundingBox.max.z), 20000);

    assert.throws(() => stlFrom(THREE, []), /no triangles/);
    const many = new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, Math.ceil(MAX_STL_TRIANGLES / 12) + 1);
    assert.throws(() => stlFrom(THREE, [many]), /too many triangles/);
});
