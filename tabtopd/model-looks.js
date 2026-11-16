// How a model's surfaces are shown, in the 3D preview (model-view.js),
// for looking it over before printing it:
//   - its look: its own materials; or its overhangs (faces facing down
//     more than an angle from level, but those on the plate), which need
//     support printed under them; or its faces inside out (their backs
//     showing: holes, or faces the wrong way round); or X-ray (see through);
//   - its sharp edges (those between faces more than 30° apart) drawn on it;
//   - smooth (each face's normals as its neighbours', but across sharp
//     edges) or faceted (each face flat);
//   - a section: the model cut away above a height, what's cut filled.
// Every material it has is given the same small addition to its shader
// (see patch): its look, and the cut, as uniforms all share.
import { el } from "./preview-dom.js";

export const LOOKS = { materials: "Materials", overhang: "Overhangs", inside: "Faces inside out", xray: "X-ray" };
const CREASE = 30;            // degrees: an edge sharper than this is drawn, and kept sharp, smooth
const MAX_EDGED = 3e6;        // triangles: more aren't given edges, nor smoothed (made at once, on the page)

// lookTools is the tools for meshes' looks (and what they need): {tools
// (the bar's controls), placed(box) (the model's placed: its plate's
// height, box.min.y), stop()}. button and toggle make the bar's buttons, as
// model-view.js does; redraw draws it again. faceted says its meshes are
// flat facets only (an STL's, a 3MF's: no normals of their own to smooth
// with); otherwise, they're shown smooth as they are to begin with.
export function lookTools(THREE, meshes, { renderer, redraw, button, toggle, faceted = false }) {
    const triangles = meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
    const u = {
        uLook: { value: 0 }, uCos: { value: Math.cos(THREE.MathUtils.degToRad(45)) }, uBed: { value: 0 }, uEps: { value: 1e-3 }, uCap: { value: false },
        uOverhang: { value: new THREE.Color(0xe2462e) }, uBase: { value: new THREE.Color(0xa9b7c9) }, uInside: { value: new THREE.Color(0xd9423b) }, uCut: { value: new THREE.Color(0xe08a3c) },
    };
    const patched = new Set();
    const patch = (material) => {
        if (patched.has(material)) return;
        patched.add(material);
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, u);
            // (Where it is in the scene: an instance's, or a batch's, placed as it is.)
            shader.vertexShader = "varying vec3 vLookWorld;\n" + shader.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
	vec4 lookAt = vec4(transformed, 1.0);
	#ifdef USE_BATCHING
		lookAt = batchingMatrix * lookAt;
	#endif
	#ifdef USE_INSTANCING
		lookAt = instanceMatrix * lookAt;
	#endif
	vLookWorld = (modelMatrix * lookAt).xyz;`);
            shader.fragmentShader = "varying vec3 vLookWorld;\nuniform int uLook;\nuniform float uCos, uBed, uEps;\nuniform bool uCap;\nuniform vec3 uOverhang, uBase, uInside, uCut;\n" +
                shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
	if (uLook == 1) {
		// The face's own normal, outward (its derivatives' cross is towards the eye: a back's, away).
		vec3 faceNormal = normalize(cross(dFdx(vLookWorld), dFdy(vLookWorld)));
		if (!gl_FrontFacing) faceNormal = -faceNormal;
		diffuseColor.rgb = (-faceNormal.y > uCos && vLookWorld.y > uBed + uEps) ? uOverhang : uBase;
	} else if (uLook == 2) {
		diffuseColor.rgb = gl_FrontFacing ? uBase : uInside;
	}
	if (uCap && !gl_FrontFacing) diffuseColor.rgb = uCut;`);
        };
        material.customProgramCacheKey = () => "tabtop-looks";
        material.needsUpdate = true;
    };
    // Each mesh's own material(s), and theirs sides and shading, to go back to.
    const originals = new Map(meshes.map((m) => [m, { material: m.material, sides: [m.material].flat().map((mat) => mat.side), flats: [m.material].flat().map((mat) => mat.flatShading) }]));
    for (const m of meshes) [m.material].flat().forEach(patch);
    const xray = new THREE.MeshStandardMaterial({ color: 0x8fa8c8, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 });
    patch(xray);
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1d2430, transparent: true, opacity: 0.8 });
    let look = "materials", wireframe = false, sectioned = false, edges = null, smooth = !faceted, smoothed = null, smoothing = null;

    // apply shows the meshes as look, wireframe, sectioned and smooth say.
    const apply = () => {
        u.uLook.value = look === "overhang" ? 1 : look === "inside" ? 2 : 0;
        u.uCap.value = sectioned;
        for (const m of meshes) {
            const was = originals.get(m);
            m.material = look === "xray" ? xray : was.material;
            [m.material].flat().forEach((mat, i) => {
                // (Their backs shown, where it's their backs that are looked for, or cut into.)
                const side = look === "inside" || look === "overhang" || sectioned || mat === xray ? THREE.DoubleSide : was.sides[i] ?? mat.side;
                // Smooth: as it is (its own normals; facets made smooth, for
                // a faceted one); faceted: each face flat.
                const flat = smooth ? (mat === xray || smoothed?.has(m) ? false : was.flats[i] ?? false) : true;
                const clip = sectioned ? [plane] : null;
                if (mat.side !== side || mat.flatShading !== flat || (mat.clippingPlanes?.length ?? 0) !== (clip?.length ?? 0)) mat.needsUpdate = true;
                mat.side = side;
                mat.flatShading = flat;
                mat.clippingPlanes = clip;
                mat.wireframe = wireframe;
            });
            if (smoothed) m.geometry = smooth ? smoothed.get(m) ?? smoothed.original.get(m) : smoothed.original.get(m);
        }
        edgeMaterial.clippingPlanes = sectioned ? [plane] : null;
        edgeMaterial.needsUpdate = true;
        renderer.localClippingEnabled = sectioned;
        redraw();
    };

    // The look, and the overhang's angle (shown for overhangs).
    const pick = el("select", { className: "model-look", ariaLabel: "Look", title: "How its surfaces are shown" },
        ...Object.entries(LOOKS).map(([k, name]) => el("option", { value: k, textContent: name })));
    const angle = el("input", { type: "number", className: "model-angle", min: "1", max: "89", step: "1", value: "45", ariaLabel: "Overhang angle, degrees from straight down",
        title: "Faces facing down more steeply than this many degrees from level are overhangs" });
    const angleBox = el("label", { className: "model-angle-box", hidden: true, title: angle.title }, angle, "°");
    pick.addEventListener("change", () => {
        look = pick.value;
        angleBox.hidden = look !== "overhang";
        apply();
    });
    angle.addEventListener("input", () => {
        const a = Math.max(1, Math.min(89, Number(angle.value) || 45));
        // Overhanging: facing down more than a degrees from level, so its normal's within (90 - a) of straight down.
        u.uCos.value = Math.cos(THREE.MathUtils.degToRad(90 - a));
        redraw();
    });
    u.uCos.value = Math.cos(THREE.MathUtils.degToRad(45));

    const wire = toggle("", "Wireframe: show its triangles' edges only", false, (on) => { wireframe = on; apply(); }, "wireframe");
    wire.classList.add("model-wireframe");

    const sharp = toggle("", `Edges: draw its sharp edges (where faces meet at more than ${CREASE}°)`, false, (on) => {
        if (on && !edges) {
            edges = [];
            for (const m of meshes) {
                // (Not an instanced mesh's: its edges would be drawn once, not for each.)
                if (m.isSkinnedMesh || m.isInstancedMesh || m.isBatchedMesh) continue;
                const line = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, CREASE), edgeMaterial);
                line.raycast = () => {};
                m.add(line);
                edges.push(line);
            }
        }
        for (const line of edges ?? []) line.visible = on;
        apply();
    }, "edges");
    sharp.classList.add("model-edges");
    if (triangles > MAX_EDGED) { sharp.disabled = true; sharp.title = `Edges: it has too many triangles (${triangles.toLocaleString("en")}) to find them here`; }

    const said = (b) => {
        b.title = smooth ? "Smooth: its faces shaded smooth, but across sharp edges (click for faceted)" : "Faceted: each face shaded flat (click for smooth)";
        b.setAttribute("aria-label", b.title);
        b.setAttribute("aria-pressed", String(smooth));
    };
    const shading = toggle("", "", smooth, async function (on) {
        smooth = on;
        said(this);
        if (on && faceted && !smoothed) {
            // Facets only (an STL's): normals made smooth, but across sharp
            // edges; made once (clicked again meanwhile: the same making).
            smoothing ??= import("./three/BufferGeometryUtils.js").then(({ toCreasedNormals }) => {
                const made = new Map();
                made.original = new Map(meshes.map((m) => [m, m.geometry]));
                // (Those with faces each their own corners, or no normals at all.)
                for (const m of meshes) {
                    if (m.isSkinnedMesh || m.isInstancedMesh || m.isBatchedMesh) continue;
                    if (!m.geometry.index || !m.geometry.attributes.normal) made.set(m, toCreasedNormals(m.geometry, THREE.MathUtils.degToRad(CREASE)));
                }
                smoothed = made;
            });
            await smoothing;
            said(this); // (as it is now: clicked meanwhile, perhaps)
        }
        apply();
    }, "smooth");
    shading.classList.add("model-smooth");
    said(shading);
    if (triangles > MAX_EDGED && faceted) shading.disabled = true;

    // The section: cut away above the slider's height (of the model's).
    let bottom = 0, top = 1;
    const height = el("input", { type: "range", className: "model-section-height", min: "0", max: "1000", value: "500", step: "1", ariaLabel: "Cut at height", hidden: true });
    const cutAt = () => { plane.constant = bottom + (top - bottom) * Number(height.value) / 1000; redraw(); };
    height.addEventListener("input", cutAt);
    const section = toggle("", "Section: cut it away above a height (the slider), to see inside", false, (on) => {
        sectioned = on;
        height.hidden = !on;
        cutAt();
        apply();
    }, "section");
    section.classList.add("model-section");
    apply();
    return {
        tools: [pick, angleBox, wire, sharp, shading, section, height],
        // The model placed: its plate's height, and how high it is (what's
        // overhanging is above the plate; the section's within it).
        placed(box) {
            bottom = box.min.y;
            top = box.max.y;
            u.uBed.value = box.min.y;
            u.uEps.value = Math.max(1e-6, (box.max.y - box.min.y) * 1e-3);
            cutAt();
        },
        stop() {
            xray.dispose();
            edgeMaterial.dispose();
            for (const line of edges ?? []) line.geometry.dispose();
            // Both forms of each, whichever is shown (the view lets go of that one too).
            for (const g of smoothed?.values() ?? []) g.dispose();
            for (const g of smoothed?.original.values() ?? []) g.dispose();
        },
    };
}
