// The 3D preview: models for 3D printing (STL, OBJ, 3MF, AMF, PLY),
// G-code, and scenes (glTF, FBX, Collada and KMZ, VRML), drawn with three.js, turned with the
// mouse (drag to orbit, right-drag or Shift-drag to pan, the wheel to zoom).
//
// glTF's, FBX's, Collada's and OBJ's materials and textures are shown: the
// files they refer to (glTF's buffers and pictures, an OBJ's .mtl and its
// textures, an FBX's or a Collada file's textures) read from beside them
// (see model-resources.js). glTF, FBX and Collada are read on the page, as
// their loaders need it (an FBX or Collada file, so, only up to MAX_FBX or
// MAX_DAE); an OBJ's shapes in the worker, its materials on the page.
//
// Models are read in a worker (model-worker.js), so a big one doesn't
// freeze the page: STL, OBJ and PLY by three.js's loaders, 3MF by
// model-3mf.js, G-code by gcode.js. AMF is read on the page, as its
// loader reads XML with DOMParser, which workers haven't (so only up to
// MAX_AMF). G-code is drawn as lines: what's extruded coloured by
// the kind of thing it is (walls, infill, support…), up to the layer the
// slider says (or that layer alone), and the moves between, if asked for.
//
// three.js is served from -three-dir (see the Dockerfile's three stage):
// tabtopd points this module's "./three/" imports at it. Without it, the
// preview says it isn't available.
import { el } from "./preview-dom.js";
import { FILE_TYPES } from "./file-types.js";
import { iconSVG } from "./glyphs.js";
import { meshFacts, combine, describeMesh, missingText, sizeText, zipTooBig, meshCheck, meshCheckText, combineChecks, MAX_ZIP_ENTRIES } from "./model-info.js";
import { gcodeContent } from "./model-gcode.js";
import { lookTools } from "./model-looks.js";
import { checkCollada } from "./model-limits.js";
import { fetchResources, gltfReferences, glbJSON, COMPRESSED, BLANK, fbxText, fbxTextVersion } from "./model-resources.js";

const MODEL = 0x8fa8c8;          // a model's colour, where it hasn't its own
const FORMATS = { stl: "STL", obj: "OBJ", "3mf": "3MF", amf: "AMF", ply: "PLY", gcode: "G-code", gco: "G-code",
    gltf: "glTF", glb: "glTF", fbx: "FBX", dae: "Collada", kmz: "KMZ", wrl: "VRML", vrml: "VRML", wrz: "VRML", bgcode: "Binary G-code" };
// Those most often made with Y up (scans, and models from 3D software;
// glTF's is, always); the rest, for printing, have Z up.
const Y_UP = new Set(["obj", "ply", "gltf", "glb", "fbx", "dae", "kmz", "wrl", "vrml", "wrz"]);
// The unit each format's sizes are in, where it says ("": its own, unsaid).
const VRML = new Set(["wrl", "vrml", "wrz"]);
const unitOf = (format) => (["gltf", "glb", "dae", "kmz"].includes(format) ? "m" : format === "fbx" || VRML.has(format) ? "" : "mm");

// modelFormat is the format a file named name is shown as, by its
// extension ("stl", "gcode"…), or "" if it isn't one.
export function modelFormat(name) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return Object.hasOwn(FORMATS, ext) ? ext : "";
}

const failed = (message) => el("p", { className: "error", textContent: message });

// modelView shows the model in blob, the file file ({dir, name}); it
// resolves to the view (with .stop), or to a note that it can't be shown.
// Aborting signal stops reading it. read(path, signal) reads a file it
// refers to (see model-resources.js; model-read.js's, from the server, if
// not given). saveFile(blob, name), if given, saves a file made of it (as
// "Save as STL" makes), resolving to what to say of it ("Saved as a.stl.").
export async function modelView({ file, blob, signal = null, read = null, saveFile = null }) {
    const format = modelFormat(file.name);
    let THREE, OrbitControls;
    try {
        THREE = await import("./three/three.module.js");
        ({ OrbitControls } = await import("./three/OrbitControls.js"));
    } catch {
        return failed("3D previews aren't available on this server: three.js isn't installed.");
    }
    const worker = { current: null, signal };
    read ??= async (path, s) => (await import("./model-read.js")).readResource(path, s);
    // changed.redraw: once there's a view, what draws it again (as a model's
    // textures come in). near: folders beside it its textures may be in.
    const base = file.name.replace(/\.[^.]*$/, "");
    const around = { THREE, dir: file.dir ?? "", read, signal, changed: {}, near: [`${base}.fbm`, "textures", "Textures", "texture", "maps"] };
    let content;
    try {
        if (format === "amf") {
            content = await amfContent(THREE, blob);
        } else if (format === "gltf" || format === "glb") {
            content = await gltfContent(around, format, blob);
        } else if (format === "fbx") {
            content = await fbxContent(around, blob);
        } else if (format === "dae") {
            content = await daeContent(around, blob);
        } else if (format === "kmz") {
            content = await kmzContent(around, blob);
        } else {
            const reply = await fromWorker(format, blob, worker, file.name);
            if (reply.gcode) {
                content = gcodeContent(THREE, reply.gcode);
            } else {
                const names = new Set(reply.parts.flatMap((p) => p.materials ?? []));
                const materials = reply.libraries?.length ? await objMaterials(around, reply.libraries, names) : null;
                try {
                    content = partsContent(THREE, reply, materials, unitOf(format));
                } catch (err) {
                    materials?.release();
                    throw err;
                }
            }
            // (A sliced 3MF's plate, drawn as its G-code.)
            if (reply.gcode && format === "3mf") content.label = "Sliced 3MF";
        }
    } catch (err) {
        // Given up on: nothing, quietly (what's drawn now is another's).
        if (signal?.aborted) return failed("");
        // What this module says of a file it reads ("it's too big…"); what
        // a loader throws reading a damaged one is said plainly.
        const said = String(err?.message || err);
        const why = /^(it|its|nothing)\b/.test(said) ? said : "it's damaged, or isn't really one";
        return failed(`This ${FORMATS[format] ?? "model"} file can't be shown: ${why}.`);
    } finally {
        worker.current?.terminate();
    }
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
        dispose(content.object);
        content.revoke?.();
        return failed("This browser can't draw 3D: WebGL isn't available.");
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    // A scene's materials (glTF's: physically based) reflect a room, and
    // are toned as glTF viewers do.
    let environment = null;
    if (content.environment) {
        const { RoomEnvironment } = await import("./three/RoomEnvironment.js");
        const pmrem = new THREE.PMREMGenerator(renderer);
        environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
        pmrem.dispose();
        renderer.toneMapping = THREE.NeutralToneMapping;
    }

    // The model, in a group turned so its up is the scene's (Y).
    const scene = new THREE.Scene();
    const turned = new THREE.Group(), centred = new THREE.Group();
    centred.add(content.object);
    turned.add(centred);
    scene.add(turned);
    if (environment) scene.environment = environment.texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x606070, environment ? 0.4 : 2.2));
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    const lamp = new THREE.DirectionalLight(0xffffff, environment ? 1 : 1.6);
    lamp.position.set(1, 2, 3);
    camera.add(lamp);
    scene.add(camera);
    let grid = null;

    const canvas = renderer.domElement;
    canvas.className = "model-canvas";
    const stage = el("div", { className: "model-stage", tabIndex: 0, ariaLabel: `${file.name}: drag to turn, right-drag to move, the wheel to zoom` }, canvas);
    const controls = new OrbitControls(camera, canvas);
    controls.screenSpacePanning = true;

    let requested = false, stopped = false;
    const render = () => {
        requested = false;
        if (stopped) return;
        renderer.render(scene, camera);
    };
    const redraw = () => {
        if (!requested && !stopped) {
            requested = true;
            requestAnimationFrame(render);
        }
    };
    controls.addEventListener("change", redraw);
    around.changed.redraw = redraw;
    const resize = () => {
        const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        redraw();
    };
    const resized = new ResizeObserver(resize);
    resized.observe(stage);

    // place sets which way is up, puts the model on the plate (a grid
    // under it, in 10 mm squares), centred, and the camera to see it all.
    let zUp = !Y_UP.has(format);
    let looks = null;
    const box = new THREE.Box3();
    const place = () => {
        turned.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
        centred.position.set(0, 0, 0);
        turned.updateMatrixWorld(true);
        box.setFromObject(content.measure ?? centred);
        if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
        const c = box.getCenter(new THREE.Vector3());
        // (In the model's own frame, which, Z up, is turned: its Y is the
        // scene's -Z, its Z the scene's Y.)
        if (zUp) centred.position.set(-c.x, c.z, -box.min.y);
        else centred.position.set(-c.x, -box.min.y, -c.z);
        turned.updateMatrixWorld(true);
        box.setFromObject(content.measure ?? centred);
        if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
        // A print's plate in 10 mm squares; a scene's (in its own units)
        // in squares a power of ten, some tens of them across.
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.z, 1e-6) * 1.4;
        const square = content.scene ? 10 ** Math.floor(Math.log10(span / 10)) : 10;
        const squares = Math.max(1, Math.min(200, Math.ceil(span / square)));
        grid = new THREE.GridHelper(squares * square, squares, 0x888888, 0x888888);
        grid.material.transparent = true;
        grid.material.opacity = 0.35;
        grid.position.y = box.min.y;
        scene.add(grid);
        looks?.placed(box);
        fit();
    };
    const fit = () => {
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = Math.max(sphere.radius, 1e-3);
        const d = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
        camera.near = d / 200;
        camera.far = d * 50;
        camera.position.copy(sphere.center).add(new THREE.Vector3(0.9, 0.7, 1.1).normalize().multiplyScalar(d));
        camera.updateProjectionMatrix();
        controls.target.copy(sphere.center);
        controls.update();
        redraw();
    };

    // The bar: what it is, and what can be done.
    const button = (label, title, onClick, icon = "") => {
        const b = el("button", { type: "button", className: icon ? "glyph" : "", title, textContent: icon ? "" : label });
        if (icon) b.innerHTML = iconSVG(icon);
        b.setAttribute("aria-label", title);
        b.addEventListener("click", onClick);
        return b;
    };
    const toggle = (label, title, on, onChange, icon = "") => {
        const b = button(label, title, () => {
            on = !on;
            b.setAttribute("aria-pressed", String(on));
            onChange.call(b, on);
            redraw();
        }, icon);
        b.setAttribute("aria-pressed", String(on));
        return b;
    };
    // The up axis's button shows which is up, and says what a click does.
    const showAxis = (b) => {
        b.innerHTML = iconSVG(zUp ? "axis-z-up" : "axis-y-up");
        b.title = zUp ? "Z is up (as printers have it): click for Y up" : "Y is up: click for Z up (as printers have it)";
        b.setAttribute("aria-label", b.title);
    };
    // (Not a pressed toggle: its glyph says which axis is up.)
    const axis = button("", "", () => {
        zUp = !zUp;
        showAxis(axis);
        place();
    }, "axis-z-up");
    showAxis(axis);
    axis.classList.add("model-axis");
    const tools = [button("", "Fit it in the window (0)", fit, "fit-page"), axis];
    // A model's surfaces: how they're shown (see model-looks.js).
    // (An STL's and a 3MF's are flat facets only: shown so, till smoothed.)
    looks = content.meshes.length ? lookTools(THREE, content.meshes, { renderer, redraw, button, toggle, faceted: format === "stl" || format === "3mf" || !!content.faceted }) : null;
    if (looks) tools.push(...looks.tools);
    // Save as STL: its meshes as shown (not G-code's lines, nor a sliced 3MF's).
    const said = el("span", { className: "hint model-saved", role: "status" });
    if (saveFile && content.meshes.length && !FILE_TYPES[format]?.toolpath && !content.label) {
        const name = file.name.replace(/\.[^.]*$/, "") + ".stl";
        const save = button("", `Save as STL: ${name}, as shown (its up as Z${unitOf(format) === "m" ? ", in millimetres" : ""})`, async () => {
            save.disabled = true;
            said.textContent = "Saving…";
            try {
                turned.updateMatrixWorld(true);
                const { stlFrom } = await import("./model-export.js");
                const stl = new Blob([stlFrom(THREE, content.meshes, { scale: unitOf(format) === "m" ? 1000 : 1 })], { type: "model/stl" });
                said.textContent = await saveFile(stl, name);
            } catch (err) {
                said.textContent = `It couldn't be saved: ${String(err?.message || err).replace(/^it /, "")}`;
            } finally {
                save.disabled = false;
            }
        }, "download");
        save.classList.add("model-save-stl");
        tools.push(save);
    }
    const info = el("span", { className: "hint model-info", textContent: `${content.label ?? FORMATS[format]} · ${content.info}` });
    const bar = el("div", { className: "model-bar" }, ...tools, ...(content.tools?.(redraw, { toggle }) ?? []), said, info);
    const view = el("div", { className: "model-view" }, bar, stage);
    if (content.legend) view.append(content.legend);
    stage.addEventListener("keydown", (e) => {
        if (e.key === "0" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fit(); }
    });
    // The bar's first draw is once it's in the page, with a size.
    requestAnimationFrame(() => { if (!stopped) { resize(); place(); } });
    place();

    view.stop = () => {
        if (stopped) return;
        stopped = true;
        resized.disconnect();
        controls.dispose();
        looks?.stop();
        content.stop?.();
        dispose(scene);
        environment?.dispose();
        content.revoke?.();
        renderer.dispose();
        renderer.forceContextLoss();
    };
    return view;
}

// dispose lets go of what's under object: its geometries, materials and
// their textures.
function dispose(object) {
    object.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat().filter(Boolean)) {
            for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
            m.dispose();
        }
    });
}

// fromWorker is what model-worker.js makes of blob, a file of format named name.
// How long the model worker may take to read one file.
const WORKER_TIMEOUT = 120_000;

async function fromWorker(format, blob, worker, name) {
    const bytes = await blob.arrayBuffer();
    const w = new Worker(new URL("./model-worker.js", import.meta.url), { type: "module" });
    worker.current = w;
    const { signal } = worker;
    return new Promise((resolve, reject) => {
        let late = null;
        const abort = () => { clearTimeout(late); w.terminate(); reject(signal.reason); };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        const done = (f) => (v) => { clearTimeout(late); signal?.removeEventListener("abort", abort); f(v); };
        // (One that takes too long, as a file made to: ended, said so.)
        late = setTimeout(() => { w.terminate(); done(reject)(new Error("it took too long to read (more than 2 minutes)")); }, WORKER_TIMEOUT);
        w.onmessage = ({ data }) => (data.error ? done(reject)(new Error(data.error)) : done(resolve)(data));
        w.onerror = (e) => { e.preventDefault?.(); done(reject)(new Error("it couldn't be read")); };
        w.postMessage({ format, bytes, name }, [bytes]);
    });
}

const material = (THREE, colours) => new THREE.MeshStandardMaterial({ color: colours ? 0xffffff : MODEL, vertexColors: !!colours,
    roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });

// partsContent is the shapes the worker read (an STL, OBJ, PLY or 3MF):
// {object, meshes, info}. With materials (an OBJ's, see objMaterials),
// each mesh has those its parts are made of, by name.
function partsContent(THREE, { parts, facts }, materials = null, unit = "mm") {
    if (!parts.length) throw new Error("it has no shapes in it");
    const object = new THREE.Group(), meshes = [];
    for (const p of parts) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
        if (p.normal) geometry.setAttribute("normal", new THREE.BufferAttribute(p.normal, 3));
        if (p.color) geometry.setAttribute("color", new THREE.BufferAttribute(p.color, 3, p.colorNormalized));
        if (p.uv) geometry.setAttribute("uv", new THREE.BufferAttribute(p.uv, 2));
        if (p.index) geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
        for (const g of p.groups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
        const own = materials && p.kind === "mesh" && p.materials?.map((name) => materials.byName.get(name));
        if (own?.some(Boolean)) {
            const made = own.map((m) => m ?? material(THREE, null));
            const mesh = new THREE.Mesh(geometry, made.length === 1 ? made[0] : made);
            meshes.push(mesh);
            object.add(mesh);
        } else if (p.kind === "mesh") {
            const mesh = new THREE.Mesh(geometry, material(THREE, p.color));
            meshes.push(mesh);
            object.add(mesh);
        } else if (p.kind === "lines") {
            object.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x666666 })));
        } else {
            // Points the same size on screen however near: 3 pixels.
            object.add(new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors: !!p.color, color: p.color ? 0xffffff : MODEL,
                size: 3, sizeAttenuation: false })));
        }
    }
    let info = facts.points && !facts.triangles
        ? `${describeMesh({ ...facts, triangles: 0, volume: 0 }, { unit }).replace(/ · 0 triangles$/, "")} · ${facts.points.toLocaleString("en")} points`
        : describeMesh(facts, { unit, volume: unit === "mm", textures: materials ? usedTextures(meshes, materials.missing.length) || null : null });
    if (facts.check) info += ` · ${meshCheckText(facts.check)}`;
    if (materials?.missing.length) info += ` · ${missingText(materials.missing)}`;
    // (Materials not used by a mesh: let go of now.)
    const used = new Set(meshes.flatMap((m) => [m.material].flat()));
    for (const m of materials?.byName.values() ?? []) if (!used.has(m)) disposeMaterial(m);
    // (Facets only, made flat by the worker: an STL's, an OBJ's without normals.)
    return { object, meshes, info, revoke: materials?.revoke, faceted: parts.some((p) => p.madeFlat) };
}

// usedTextures is how many textures meshes' materials have, but missing
// (those they name that weren't there, and so are nothing).
function usedTextures(meshes, missing) {
    const textures = new Set();
    for (const m of meshes) for (const mat of [m.material].flat().filter(Boolean)) for (const v of Object.values(mat)) if (v?.isTexture) textures.add(v);
    return Math.max(0, textures.size - missing);
}

// disposeMaterial lets go of a material and its textures.
function disposeMaterial(m) {
    for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
    m.dispose();
}

// managerFor is a loading manager that gives a loader the files urls has
// (a Map of what it asks for to blob: URLs) and, for any other, nothing
// (BLANK: never the web, nor the server's own pages); blob: and data: URLs
// as they are. TGA pictures are read as such. As each comes in, what's
// drawn is drawn again (changed.redraw), as a texture loads after the
// model's made.
async function managerFor(THREE, urls, changed = {}) {
    const manager = new THREE.LoadingManager();
    manager.onProgress = () => changed.redraw?.();
    manager.setURLModifier((u) => (/^(blob|data):/i.test(u) ? u : urls.get(u) ?? BLANK));
    const { TGALoader } = await import("./three/TGALoader.js");
    manager.addHandler(/\.tga$/i, new TGALoader(manager));
    return manager;
}

// withResources makes a model (or its materials) by make(manager), once to
// learn what files it asks for, then, if any, again with those read from
// dir (relative to it, or in near), what was made the first time let go by
// discard. It resolves to {made, missing, revoke}: revoke lets go of the
// files read, and of the blob: URLs make made itself (an FBX's loader
// makes one of each picture in it, and lets none go).
async function withResources({ THREE, dir, read, signal, changed = {}, near = [] }, make, discard) {
    const asked = new Set();
    const probe = new THREE.LoadingManager();
    probe.onProgress = () => changed.redraw?.();
    probe.setURLModifier((u) => {
        if (/^(blob|data):/i.test(u)) return u;
        asked.add(u);
        return BLANK;
    });
    const firstMade = madeURLs(() => make(probe));
    const first = firstMade.value;
    const revokeFirst = () => firstMade.urls.forEach((u) => URL.revokeObjectURL(u));
    if (!asked.size) return { made: first, missing: [], revoke: revokeFirst };
    discard(first);
    revokeFirst();
    const found = await fetchResources(dir, [...asked], read, { signal, near });
    let again = { urls: [] };
    try {
        const manager = await managerFor(THREE, found.urls, changed);
        again = madeURLs(() => make(manager));
        return { made: again.value, missing: found.missing, revoke: () => { found.revoke(); again.urls.forEach((u) => URL.revokeObjectURL(u)); } };
    } catch (err) {
        found.revoke();
        again.urls.forEach((u) => URL.revokeObjectURL(u));
        throw err;
    }
}

// madeURLs runs make (which does its work at once, not later), and is
// {value: what it returns, urls: the blob: URLs it made meanwhile}.
function madeURLs(make) {
    const urls = [], create = URL.createObjectURL;
    URL.createObjectURL = (o) => {
        const u = create.call(URL, o);
        urls.push(u);
        return u;
    };
    try {
        return { value: make(), urls };
    } finally {
        URL.createObjectURL = create;
    }
}

// objMaterials reads an OBJ's materials, those named names, from its .mtl
// files (libraries, relative to dir), and their textures (relative to
// each): {byName, missing (files that aren't there), revoke, release}.
// release lets go of all of it (when the model isn't, after all, shown).
async function objMaterials(around, libraries, names) {
    const { THREE, dir, read, signal } = around;
    const libs = await fetchResources(dir, libraries, read, { signal });
    libs.revoke();
    const { MTLLoader } = await import("./three/MTLLoader.js");
    const byName = new Map(), missing = [...libs.missing], revokes = [];
    const revoke = () => revokes.forEach((r) => r());
    const release = () => {
        revoke();
        for (const m of byName.values()) disposeMaterial(m);
        byName.clear();
    };
    try {
        for (const lib of libraries) {
            const blob = libs.blobs.get(lib);
            if (!blob) continue;
            const text = await blob.text();
            const path = libs.paths.get(lib);
            const at = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
            // The materials it has that the OBJ uses (and no others) made,
            // so it asks for their textures.
            const make = (manager) => {
                const creator = new MTLLoader(manager).setMaterialOptions({ side: THREE.DoubleSide }).parse(text, "");
                for (const name of names) if (!byName.has(name) && Object.hasOwn(creator.materialsInfo, name)) creator.create(name);
                return creator;
            };
            const discard = (creator) => Object.values(creator.materials).forEach(disposeMaterial);
            const { made, missing: lost, revoke: let_go } = await withResources({ ...around, dir: at }, make, discard);
            revokes.push(let_go);
            missing.push(...lost);
            for (const [name, m] of Object.entries(made.materials)) {
                if (byName.has(name)) disposeMaterial(m);
                else byName.set(name, m);
            }
        }
    } catch (err) {
        release();
        throw err;
    }
    return { byName, missing, revoke, release };
}

// The most instances of a mesh (glTF's EXT_mesh_gpu_instancing) each
// looked at, for a scene's size.
const MAX_INSTANCES = 1000;

// sceneFacts is what a scene (glTF's, FBX's) object has: its meshes,
// their facts together (or, with only lines and points, the size of
// those), and how many textures they use.
function sceneFacts(THREE, object) {
    const meshes = [], facts = [], textures = new Set();
    let drawn = false;
    object.updateMatrixWorld(true);
    object.traverse((o) => {
        if ((o.isLine || o.isPoints) && o.geometry?.attributes?.position) drawn = true;
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        meshes.push(o);
        for (const m of [o.material].flat().filter(Boolean)) for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
        if (o.isInstancedMesh) {
            // Each instance, placed (up to MAX_INSTANCES of them: the rest as many again).
            const placed = new THREE.Matrix4(), world = o.matrixWorld.clone(), n = Math.min(o.count, MAX_INSTANCES);
            for (let i = 0; i < n; i++) {
                o.getMatrixAt(i, placed);
                o.matrixWorld.multiplyMatrices(world, placed);
                facts.push(meshFacts(worldPositions(THREE, o), o.geometry.index?.array));
            }
            o.matrixWorld.copy(world);
            if (o.count > n) {
                // The rest: as many triangles again, where they all are (the bounds of all of them).
                o.computeBoundingBox();
                const all = o.boundingBox.clone().applyMatrix4(world);
                facts.push({ triangles: facts.at(-1).triangles * (o.count - n), min: all.min.toArray(), max: all.max.toArray(), volume: 0 });
            }
        } else {
            facts.push(meshFacts(worldPositions(THREE, o), o.geometry.index?.array));
        }
    });
    if (!facts.length && drawn) {
        const box = new THREE.Box3().setFromObject(object);
        return { meshes, facts: { triangles: 0, min: box.min.toArray(), max: box.max.toArray(), volume: 0 }, textures: 0 };
    }
    if (!facts.length) throw new Error("it has no shapes in it");
    return { meshes, facts: combine(facts), textures: textures.size };
}

// drawnAs is what a scene with no surfaces is drawn as: "lines only",
// "points only", or "lines and points".
function drawnAs(object) {
    let lines = false, points = false;
    object.traverse((o) => { lines ||= !!o.isLine; points ||= !!o.isPoints; });
    return lines && points ? "lines and points" : points ? "points only" : "lines only";
}

// gltfContent reads a glTF (its JSON, .gltf, with its buffers and pictures
// beside it, or all in one, .glb), on the page: {object, meshes, info,
// environment, revoke}. Its size is in metres, as glTF's are.
async function gltfContent(around, format, blob) {
    const { THREE, dir, read, signal } = around;
    const buffer = await blob.arrayBuffer();
    const json = format === "glb" ? glbJSON(buffer) : JSON.parse(new TextDecoder().decode(buffer));
    // Compressed (Draco's meshes, meshopt's buffers, KTX2 textures): decoded in a worker of their own.
    const compressed = (json.extensionsUsed ?? []).some((e) => COMPRESSED.has(e));
    const found = await fetchResources(dir, gltfReferences(json), read, { uri: true, signal });
    try {
        const lost = (json.buffers ?? []).map((b) => b?.uri).filter((u) => u && found.missing.includes(u));
        const big = lost.filter((u) => found.tooBig.includes(u));
        if (big.length) throw new Error(`its data, ${big.join(", ")}, is too big to read here`);
        if (lost.length) throw new Error(`its data, ${lost.join(", ")}, isn't here beside it`);
        const { GLTFLoader } = await import("./three/GLTFLoader.js");
        const manager = await managerFor(THREE, found.urls, around.changed);
        const loader = new GLTFLoader(manager);
        if (compressed) {
            const { draco, meshopt, ktx2 } = (await import("./model-decode.js")).gltfDecoders(THREE, manager);
            loader.setDRACOLoader(draco).setMeshoptDecoder(meshopt).setKTX2Loader(ktx2);
        }
        const gltf = await loader.parseAsync(buffer, "");
        const object = gltf.scene ?? gltf.scenes?.[0];
        if (!object) throw new Error("nothing was found in it");
        const { meshes, facts, textures: all } = sceneFacts(THREE, object);
        // (Not pictures it names that aren't there: they're nothing.)
        const textures = Math.max(0, all - found.missing.length);
        let info = meshes.length ? describeMesh(facts, { unit: "m", volume: false, textures }) : `${sizeText(facts.min, facts.max, "m")} · ${drawnAs(object)}`;
        if (found.missing.length) info += ` · ${missingText(found.missing)}`;
        // (A glTF's mesh without normals is drawn flat: facets, to smooth if asked.)
        return { object, meshes, info, environment: true, scene: true, revoke: found.revoke, faceted: meshes.some((m) => !m.geometry.attributes.normal) };
    } catch (err) {
        found.revoke();
        throw err;
    }
}

// The most an FBX is: it's read on the page (its loader needs it), which
// a big one would freeze.
const MAX_FBX = 32 << 20;

// fbxContent reads an FBX (binary, or text: ASCII), on the page, its
// textures (inside it, or files beside it): {object, meshes, info, revoke}. Its unit isn't said (FBX's
// are the program's that made it).
async function fbxContent(around, blob) {
    const { THREE } = around;
    if (blob.size > MAX_FBX) throw new Error(`it's too big to read here (it's more than ${MAX_FBX >> 20} MB)`);
    let buffer = await blob.arrayBuffer();
    // A text (ASCII) one: of a version its loader reads, and as it reads it.
    const text = fbxText(new Uint8Array(buffer));
    if (text !== null) {
        const version = fbxTextVersion(text);
        if (version && version < 7000) throw new Error(`it's an FBX ${Math.floor(version / 1000)}.${Math.floor(version % 1000 / 100)} file, older than this preview reads (7.0 and later)`);
        buffer = new TextEncoder().encode(text).buffer;
    }
    const { FBXLoader } = await import("./three/FBXLoader.js");
    const { made: object, missing, revoke } = await withResources(around, (manager) => new FBXLoader(manager).parse(buffer, ""), dispose);
    try {
        const { meshes, facts, textures: all } = sceneFacts(THREE, object);
        // (Not those it names that aren't there: they're nothing.)
        const textures = Math.max(0, all - missing.length);
        let info = meshes.length ? describeMesh(facts, { unit: "", volume: false, textures }) : `${sizeText(facts.min, facts.max, "")} · ${drawnAs(object)}`;
        if (missing.length) info += ` · ${missingText(missing)}`;
        return { object, meshes, info, scene: true, revoke };
    } catch (err) {
        revoke();
        throw err;
    }
}

// The most a Collada file is: it's read on the page (its loader needs
// DOMParser), which a big one would freeze.
const MAX_DAE = 32 << 20;

// daeContent reads a Collada (.dae) file, on the page, and the textures
// it names, beside it: {object, meshes, info, revoke}. Its loader turns it
// Y-up (if it says it's Z-up) and to metres (its <unit>), so its size is
// in metres.
async function daeContent(around, blob) {
    if (blob.size > MAX_DAE) throw new Error(`it's too big to read here (it's more than ${MAX_DAE >> 20} MB)`);
    return colladaContent(around, await blob.text(), (make, discard) => withResources(around, make, discard));
}

// The most a KMZ is, unpacked (it's read on the page, as Collada is).
const MAX_KMZ = 32 << 20;

// kmzContent reads a KMZ (a zip: KML, which names its Collada model, and
// that model's textures, inside it), on the page: as daeContent, its
// textures only from inside it (never fetched from where it says). Its
// place on Earth (its KML's Location) isn't.
async function kmzContent(around, blob) {
    const { THREE } = around;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const why = zipTooBig(bytes, MAX_KMZ);
    if (why) throw new Error(`it's too big to unpack here (${why})`);
    const { unzipSync } = await import("./three/fflate.module.js");
    let count = 0, unpacked = 0;
    const files = unzipSync(bytes, { filter: (f) => {
        if (++count > MAX_ZIP_ENTRIES) throw new Error("it holds too many files");
        if ((unpacked += f.originalSize) > MAX_KMZ) throw new Error(`it's too big to unpack here (it unpacks to more than ${MAX_KMZ >> 20} MB)`);
        return true;
    } });
    // The model its KML names (as Google Earth's are), else the first .dae in it.
    const names = Object.keys(files);
    let model = null;
    const kml = names.find((n) => /\.kml$/i.test(n));
    if (kml) {
        const href = new DOMParser().parseFromString(new TextDecoder().decode(files[kml]), "application/xml").querySelector("Model Link href")?.textContent?.trim();
        if (href) model = names.find((n) => n === href.replace(/^\.\//, "")) ?? null;
    }
    model ??= names.find((n) => /\.dae$/i.test(n));
    if (!model) throw new Error("it has no 3D model in it");
    const base = model.includes("/") ? model.slice(0, model.lastIndexOf("/") + 1) : "";
    // Its textures: by their path, relative to the model, else by name alone.
    const inside = (u) => {
        const path = base + String(u).replace(/^\.\//, "");
        if (files[path]) return path;
        const name = String(u).split(/[\\/]/).pop();
        return names.find((n) => n.split("/").pop() === name) ?? null;
    };
    const load = async (make, discard) => {
        const urls = new Map(), missing = [];
        const manager = new THREE.LoadingManager();
        manager.onProgress = () => around.changed.redraw?.();
        manager.setURLModifier((u) => {
            if (/^(blob|data):/i.test(u)) return u;
            if (!urls.has(u)) {
                const found = inside(u);
                urls.set(u, found ? URL.createObjectURL(new Blob([files[found]])) : BLANK);
                if (!found) missing.push(u);
            }
            return urls.get(u);
        });
        const revoke = () => { for (const url of urls.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url); };
        try {
            return { made: make(manager), missing, revoke };
        } catch (err) {
            revoke();
            throw err;
        }
    };
    return colladaContent(around, new TextDecoder().decode(files[model]), load);
}

// colladaContent reads Collada text (a .dae's, or a KMZ's), its textures
// by load(make, discard) ({made, missing, revoke}).
async function colladaContent(around, text, load) {
    const { THREE } = around;
    if (!/<COLLADA\b/.test(text.slice(0, 4096))) throw new Error("it isn't a Collada file");
    // (What it makes, counted first: its loader copies a shared part each time it's used.)
    checkCollada(text);
    const { ColladaLoader } = await import("./three/ColladaLoader.js");
    const { made, missing, revoke } = await load((manager) => new ColladaLoader(manager).parse(text, "")?.scene, (scene) => scene && dispose(scene));
    try {
        if (!made) throw new Error("nothing was found in it");
        const { meshes, facts, textures: all } = sceneFacts(THREE, made);
        const textures = Math.max(0, all - missing.length);
        let info = meshes.length ? describeMesh(facts, { unit: "m", volume: false, textures }) : `${sizeText(facts.min, facts.max, "m")} · ${drawnAs(made)}`;
        if (missing.length) info += ` · ${missingText(missing)}`;
        // (A mesh without normals is drawn flat: facets, to smooth if asked.)
        return { object: made, meshes, info, scene: true, revoke, faceted: meshes.some((m) => !m.geometry.attributes.normal) };
    } catch (err) {
        dispose(made);
        revoke();
        throw err;
    }
}

// The most an AMF is, unpacked: it's read on the page (its loader needs
// DOMParser), which a big one would freeze.
const MAX_AMF = 32 << 20;

// amfContent reads an AMF model, on the page: {object, meshes, info}.
async function amfContent(THREE, blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const why = zipped ? zipTooBig(bytes, MAX_AMF) : bytes.length > MAX_AMF ? `it's more than ${MAX_AMF >> 20} MB` : "";
    if (why) throw new Error(`it's too big to read here (${why})`);
    const { AMFLoader } = await import("./three/AMFLoader.js");
    const object = new AMFLoader().parse(buffer);
    if (!object) throw new Error("nothing was found in it");
    const meshes = [], facts = [], checks = [];
    object.updateMatrixWorld(true);
    object.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        meshes.push(o);
        for (const m of [o.material].flat()) m.side = THREE.DoubleSide;
        const at = worldPositions(THREE, o);
        facts.push(meshFacts(at, o.geometry.index?.array));
        checks.push(meshCheck(at, o.geometry.index?.array));
    });
    if (!facts.length) throw new Error("it has no shapes in it");
    const check = meshCheckText(combineChecks(checks));
    return { object, meshes, info: describeMesh(combine(facts)) + (check ? ` · ${check}` : "") };
}

// worldPositions is o's vertices, where they are in the model (3MF's
// parts are placed by transforms).
function worldPositions(THREE, o) {
    const attr = o.geometry.attributes.position;
    const identity = o.matrixWorld.equals(new THREE.Matrix4());
    if (identity && !attr.isInterleavedBufferAttribute && attr.itemSize === 3) return attr.array;
    const out = new Float32Array(attr.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i).applyMatrix4(o.matrixWorld);
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
}
