// A model's meshes as a binary STL, for printing (model-view.js's "Save as
// STL"): as the preview shows them, placed on the plate, its up (Z or Y,
// as chosen) as the STL's Z, as printers have it; in millimetres, from a
// format whose sizes are in metres (glTF, Collada, KMZ). Instances are
// each written; a skinned mesh as it stands (its rest pose).

// The most triangles written: 50 bytes each, so 250 MB.
export const MAX_STL_TRIANGLES = 5e6;

// stlFrom is meshes (three.js's, their world matrices up to date) as a
// binary STL's bytes, scaled by scale (1000 for metres to millimetres);
// or throws, saying why ("it …").
export function stlFrom(THREE, meshes, { scale = 1 } = {}) {
    const triangles = meshes.reduce((n, m) => {
        const corners = m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
        return n + Math.floor(corners / 3) * (m.isInstancedMesh ? m.count : 1);
    }, 0);
    if (!triangles) throw new Error("it has no triangles to save");
    if (triangles > MAX_STL_TRIANGLES) throw new Error(`it has too many triangles (${triangles.toLocaleString("en")}) to save as STL here`);
    const out = new DataView(new ArrayBuffer(84 + triangles * 50));
    new Uint8Array(out.buffer).set(new TextEncoder().encode("TabTop STL export"));
    out.setUint32(80, triangles, true);
    // Shown Y up, with the plate at y = 0; an STL's (as printers') is Z: (x, y, z) shown is (x, -z, y).
    const toSTL = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
    const matrix = new THREE.Matrix4(), instance = new THREE.Matrix4();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
    let at = 84;
    const write = (v) => { out.setFloat32(at, v.x, true); out.setFloat32(at + 4, v.y, true); out.setFloat32(at + 8, v.z, true); at += 12; };
    for (const mesh of meshes) {
        const index = mesh.geometry.index, count = index ? index.count : mesh.geometry.attributes.position.count;
        // (A mesh turned inside out by its placing, as by a mirror: its faces turned back.)
        for (let k = 0; k < (mesh.isInstancedMesh ? mesh.count : 1); k++) {
            matrix.copy(mesh.matrixWorld);
            if (mesh.isInstancedMesh) matrix.multiply(mesh.getMatrixAt(k, instance));
            matrix.premultiply(toSTL);
            const mirrored = matrix.determinant() < 0;
            for (let i = 0; i + 2 < count; i += 3) {
                const corner = (j, v) => mesh.getVertexPosition(index ? index.getX(i + j) : i + j, v).applyMatrix4(matrix);
                corner(0, a); corner(mirrored ? 2 : 1, b); corner(mirrored ? 1 : 2, c);
                n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
                write(n); write(a); write(b); write(c);
                at += 2; // (its attribute byte count: 0)
            }
        }
    }
    return out.buffer;
}
