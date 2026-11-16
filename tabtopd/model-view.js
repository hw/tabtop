// The 3D preview: models for 3D printing (STL, OBJ, 3MF, AMF, PLY) and
// G-code, drawn with three.js, turned with the mouse (drag to orbit,
// right-drag or Shift-drag to pan, the wheel to zoom).
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
import { iconSVG } from "./glyphs.js";
import { featureCategory } from "./gcode.js";
import { meshFacts, combine, describeMesh, describeGCode, zipTooBig } from "./model-info.js";

// The kinds G-code's moves are, as drawn: names and colours.
export const CATEGORIES = {
    "outer-wall": ["Outer wall", 0xf28e2b], "inner-wall": ["Inner wall", 0xedc948], infill: ["Infill", 0xe15759],
    "solid-infill": ["Solid infill", 0xb07aa1], "top-bottom": ["Top/bottom", 0xff9da7], bridge: ["Bridge/overhang", 0x76b7b2],
    support: ["Support", 0x59a14f], skirt: ["Skirt/brim", 0x9c755f], other: ["Other", 0x4e79a7],
};
const MODEL = 0x8fa8c8;          // a model's colour, where it hasn't its own
const FORMATS = { stl: "STL", obj: "OBJ", "3mf": "3MF", amf: "AMF", ply: "PLY", gcode: "G-code", gco: "G-code" };
// Those most often made with Y up (scans, and models from 3D software);
// the rest, for printing, have Z up.
const Y_UP = new Set(["obj", "ply"]);

// modelFormat is the format a file named name is shown as, by its
// extension ("stl", "gcode"…), or "" if it isn't one.
export function modelFormat(name) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return Object.hasOwn(FORMATS, ext) ? ext : "";
}

const failed = (message) => el("p", { className: "error", textContent: message });

// modelView shows the model in blob, the file file; it resolves to the
// view (with .stop), or to a note that it can't be shown. Aborting signal
// stops reading it.
export async function modelView({ file, blob, signal = null }) {
    const format = modelFormat(file.name);
    let THREE, OrbitControls;
    try {
        THREE = await import("./three/three.module.js");
        ({ OrbitControls } = await import("./three/OrbitControls.js"));
    } catch {
        return failed("3D previews aren't available on this server: three.js isn't installed.");
    }
    const worker = { current: null, signal };
    let content;
    try {
        if (format === "amf") {
            content = await amfContent(THREE, blob);
        } else {
            const reply = await fromWorker(format, blob, worker, file.name);
            content = reply.gcode ? gcodeContent(THREE, reply.gcode) : partsContent(THREE, reply);
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
        return failed("This browser can't draw 3D: WebGL isn't available.");
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);

    // The model, in a group turned so its up is the scene's (Y).
    const scene = new THREE.Scene();
    const turned = new THREE.Group(), centred = new THREE.Group();
    centred.add(content.object);
    turned.add(centred);
    scene.add(turned);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x606070, 2.2));
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    const lamp = new THREE.DirectionalLight(0xffffff, 1.6);
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
        const size = box.getSize(new THREE.Vector3());
        const side = Math.max(10, Math.ceil(Math.max(size.x, size.z) * 1.4 / 10) * 10);
        grid = new THREE.GridHelper(side, Math.min(200, side / 10), 0x888888, 0x888888);
        grid.material.transparent = true;
        grid.material.opacity = 0.35;
        grid.position.y = box.min.y;
        scene.add(grid);
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
    const toggle = (label, title, on, onChange) => {
        const b = button(label, title, () => {
            on = !on;
            b.setAttribute("aria-pressed", String(on));
            onChange.call(b, on);
            redraw();
        });
        b.setAttribute("aria-pressed", String(on));
        return b;
    };
    const tools = [button("", "Fit it in the window (0)", fit, "fit-page"),
        toggle(zUp ? "Z up" : "Y up", "Which way is up: Z (as printers have it), or Y", zUp, function (on) {
            zUp = on;
            this.textContent = on ? "Z up" : "Y up";
            place();
        })];
    if (content.meshes.length) {
        tools.push(toggle("Wireframe", "Show its triangles' edges only", false, (on) => {
            for (const m of content.meshes) for (const mat of [m.material].flat()) mat.wireframe = on;
        }));
    }
    const info = el("span", { className: "hint model-info", textContent: `${content.label ?? FORMATS[format]} · ${content.info}` });
    const bar = el("div", { className: "model-bar" }, ...tools, ...(content.tools?.(redraw) ?? []), info);
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
        dispose(scene);
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
async function fromWorker(format, blob, worker, name) {
    const bytes = await blob.arrayBuffer();
    const w = new Worker(new URL("./model-worker.js", import.meta.url), { type: "module" });
    worker.current = w;
    const { signal } = worker;
    return new Promise((resolve, reject) => {
        const abort = () => { w.terminate(); reject(signal.reason); };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        const done = (f) => (v) => { signal?.removeEventListener("abort", abort); f(v); };
        w.onmessage = ({ data }) => (data.error ? done(reject)(new Error(data.error)) : done(resolve)(data));
        w.onerror = (e) => { e.preventDefault?.(); done(reject)(new Error("it couldn't be read")); };
        w.postMessage({ format, bytes, name }, [bytes]);
    });
}

const material = (THREE, colours) => new THREE.MeshStandardMaterial({ color: colours ? 0xffffff : MODEL, vertexColors: !!colours,
    roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });

// partsContent is the shapes the worker read (an STL, OBJ, PLY or 3MF):
// {object, meshes, info}.
function partsContent(THREE, { parts, facts }) {
    if (!parts.length) throw new Error("it has no shapes in it");
    const object = new THREE.Group(), meshes = [];
    for (const p of parts) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
        if (p.normal) geometry.setAttribute("normal", new THREE.BufferAttribute(p.normal, 3));
        if (p.color) geometry.setAttribute("color", new THREE.BufferAttribute(p.color, 3, p.colorNormalized));
        if (p.index) geometry.setIndex(new THREE.BufferAttribute(p.index, 1));
        if (p.kind === "mesh") {
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
    const info = facts.points && !facts.triangles
        ? `${describeMesh({ ...facts, triangles: 0, volume: 0 }).replace(/ · 0 triangles$/, "")} · ${facts.points.toLocaleString("en")} points`
        : describeMesh(facts);
    return { object, meshes, info };
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
    const meshes = [], facts = [];
    object.updateMatrixWorld(true);
    object.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        meshes.push(o);
        for (const m of [o.material].flat()) m.side = THREE.DoubleSide;
        facts.push(meshFacts(worldPositions(THREE, o), o.geometry.index?.array));
    });
    if (!facts.length) throw new Error("it has no shapes in it");
    return { object, meshes, info: describeMesh(combine(facts)) };
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

// gcodeContent is G-code the worker read, g: {object, meshes (none), info,
// tools (the layer slider, travel), legend, measure (what's extruded)}.
function gcodeContent(THREE, g) {
    const layers = g.layers.z.length;
    if (!layers || !g.extrude.positions.length) throw new Error("nothing in it is printed");

    // What's extruded, coloured by kind; what's not, faint, off at first.
    // (Vertex colours are linear, as three.js works: the legend's sRGB
    // colours made so once each, or the lines are paler than the legend.)
    const categories = g.types.map((t) => (t ? featureCategory(t) : "other"));
    const linear = categories.map((cat) => {
        const c = new THREE.Color(CATEGORIES[cat][1]);
        return [c.r, c.g, c.b].map((v) => Math.round(v * 255));
    });
    const colours = new Uint8Array(g.extrude.types.length * 6);
    const used = new Set();
    for (let s = 0; s < g.extrude.types.length; s++) {
        const t = g.extrude.types[s];
        used.add(categories[t]);
        const [r, gr, b] = linear[t];
        colours[s * 6] = colours[s * 6 + 3] = r;
        colours[s * 6 + 1] = colours[s * 6 + 4] = gr;
        colours[s * 6 + 2] = colours[s * 6 + 5] = b;
    }
    const printed = new THREE.BufferGeometry();
    printed.setAttribute("position", new THREE.BufferAttribute(g.extrude.positions, 3));
    printed.setAttribute("color", new THREE.BufferAttribute(colours, 3, true));
    const lines = new THREE.LineSegments(printed, new THREE.LineBasicMaterial({ vertexColors: true }));
    const moves = new THREE.BufferGeometry();
    moves.setAttribute("position", new THREE.BufferAttribute(g.travel.positions, 3));
    const travel = new THREE.LineSegments(moves, new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.4 }));
    travel.visible = false;
    const object = new THREE.Group();
    object.add(lines, travel);

    let upTo = layers - 1, only = false;
    const show = () => {
        const from = only && upTo > 0 ? g.layers.extrudeEnd[upTo - 1] : 0;
        printed.setDrawRange(from * 2, (g.layers.extrudeEnd[upTo] - from) * 2);
        const tFrom = only && upTo > 0 ? g.layers.travelEnd[upTo - 1] : 0;
        moves.setDrawRange(tFrom * 2, (g.layers.travelEnd[upTo] - tFrom) * 2);
        const z = g.layers.z[upTo];
        label.textContent = `Layer ${(upTo + 1).toLocaleString("en")} of ${layers.toLocaleString("en")}${Number.isFinite(z) ? ` · Z ${z.toFixed(2)} mm` : ""}`;
    };
    const slider = el("input", { type: "range", className: "model-layer", min: "0", max: String(layers - 1), value: String(upTo), step: "1", ariaLabel: "Layers shown, up to" });
    const label = el("span", { className: "hint model-layer-label", role: "status" });
    show();
    const tools = (redraw) => {
        slider.addEventListener("input", () => { upTo = Number(slider.value); show(); redraw(); });
        const check = (text, title, on, change) => {
            const box = el("input", { type: "checkbox", checked: on });
            box.addEventListener("change", () => { change(box.checked); show(); redraw(); });
            return el("label", { className: "model-check", title }, box, ` ${text}`);
        };
        return [el("span", { className: "model-layers" }, slider, label),
            check("This layer only", "Show only the layer the slider is at", false, (on) => { only = on; }),
            check("Travel", "Show the moves that don't extrude", false, (on) => { travel.visible = on; })];
    };
    const legend = el("ul", { className: "model-legend", ariaLabel: "Colours" },
        ...Object.entries(CATEGORIES).filter(([k]) => used.has(k)).map(([, [name, c]]) =>
            el("li", {}, el("span", { className: "swatch", style: `background:#${c.toString(16).padStart(6, "0")}` }), name)));
    const notes = [g.truncated ? "only the first part is shown: it has too many moves" : "", g.skipped ? `${g.skipped.toLocaleString("en")} moves out of range left out` : ""].filter(Boolean);
    return { object, meshes: [], measure: lines, tools, legend, info: describeGCode(g) + (notes.length ? ` · ${notes.join("; ")}` : "") };
}
