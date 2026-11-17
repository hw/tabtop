// G-code, drawn for the 3D preview (model-view.js), as gcode.js reads it:
// what's extruded as boxes the width and height of the lines the printer
// lays down (or, asked for, or past MAX_TUBES, as lines), coloured by the
// kind of thing each is (walls, infill, support…), or by its speed, flow,
// width, layer height, nozzle temperature or fan, a legend saying which;
// up to the layer the slider says (or that layer alone); the moves
// between, if asked for.
import { el, glyphChoice } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { featureCategory } from "./gcode.js";
import { describeGCode } from "./model-info.js";

// The kinds G-code's moves are, as drawn: names and colours.
export const CATEGORIES = {
    "outer-wall": ["Outer wall", 0xf28e2b], "inner-wall": ["Inner wall", 0xedc948], infill: ["Infill", 0xe15759],
    "solid-infill": ["Solid infill", 0xb07aa1], "top-bottom": ["Top/bottom", 0xff9da7], bridge: ["Bridge/overhang", 0x76b7b2],
    support: ["Support", 0x59a14f], skirt: ["Skirt/brim", 0x9c755f], other: ["Other", 0x4e79a7],
};

// What lines can be coloured by: its name, its unit, its values (of
// gcode.js's extrude), times scale.
export const COLOURINGS = {
    feature: { name: "Feature" },
    speed: { name: "Speed", unit: "mm/s", of: (x) => x.speed },
    flow: { name: "Flow", unit: "mm³/s", of: (x) => x.flow },
    width: { name: "Line width", unit: "mm", of: (x) => x.width },
    height: { name: "Layer height", unit: "mm", of: (x) => x.height },
    temp: { name: "Temperature", unit: "°C", of: (x) => x.temp },
    fan: { name: "Fan", unit: "%", of: (x) => x.fan, scale: 100 / 255 },
};

// The colours values run through, low to high (Google's Turbo): even to
// the eye, and telling apart where most are.
export const RAMP = ["#30123b", "#4686fb", "#1ae4b6", "#a2fc3c", "#faba39", "#e4460a", "#7a0403"];
const NONE = 0x8a8a8a;    // a line whose value isn't known
// Past this many segments, lines (boxes as many would be slow to draw).
export const MAX_TUBES = 3e6;

// valueRange is the span of values (times scale) shown in colour: from
// the 1st to the 99th of each hundred, so a few far out don't make the
// rest one colour; [lo, hi], hi > lo; null if none is a number.
export function valueRange(values, scale = 1) {
    const sample = [];
    const step = Math.max(1, Math.floor(values.length / 20000));
    for (let i = 0; i < values.length; i += step) {
        const v = values[i] * scale;
        if (Number.isFinite(v)) sample.push(v);
    }
    if (!sample.length) return null;
    sample.sort((a, b) => a - b);
    let lo = sample[Math.floor((sample.length - 1) * 0.01)], hi = sample[Math.ceil((sample.length - 1) * 0.99)];
    if (!(hi > lo)) {
        const pad = Math.abs(lo) * 0.05 || 1;
        lo -= pad;
        hi += pad;
    }
    return [lo, hi];
}

// rampAt is RAMP's colour at t (0 to 1), as sRGB [r, g, b], 0 to 1.
export function rampAt(t) {
    const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
    const rgb = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
    const a = rgb(RAMP[i]), b = rgb(RAMP[i + 1]);
    return a.map((v, k) => v + (b[k] - v) * f);
}

// A number as the legend says it: as many places as tell values apart.
const shown = (v, span) => v.toLocaleString("en", { maximumFractionDigits: span >= 20 ? 0 : span >= 2 ? 1 : span >= 0.2 ? 2 : 3 });

// gcodeContent is G-code the worker read, g: {object, meshes (none), info,
// tools (the colouring, the layer slider, boxes or lines, travel), legend,
// measure (what's extruded, for the view's size)}.
export function gcodeContent(THREE, g) {
    const layers = g.layers.z.length;
    const x = g.extrude, n = x.types.length;
    if (!layers || !n) throw new Error("nothing in it is printed");

    // As lines: each segment's two ends, coloured.
    const lineColours = new Uint8Array(n * 6);
    const printed = new THREE.BufferGeometry();
    printed.setAttribute("position", new THREE.BufferAttribute(x.positions, 3));
    printed.setAttribute("color", new THREE.BufferAttribute(lineColours, 3, true));
    const lines = new THREE.LineSegments(printed, new THREE.LineBasicMaterial({ vertexColors: true }));

    // As boxes: one each, made by the shader from its ends (read where the
    // lines' are), its width and height, and its colour.
    const tubeColours = new Uint8Array(n * 3), sizes = new Float32Array(n * 2);
    for (let s = 0; s < n; s++) {
        sizes[s * 2] = x.width[s] > 0 ? x.width[s] : 0.4;
        sizes[s * 2 + 1] = x.height[s] > 0 ? x.height[s] : 0.2;
    }
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, -0.5);
    const tubesGeometry = new THREE.InstancedBufferGeometry();
    tubesGeometry.index = box.index;
    tubesGeometry.setAttribute("position", box.attributes.position);
    tubesGeometry.setAttribute("normal", box.attributes.normal);
    const ends = new THREE.InstancedInterleavedBuffer(x.positions, 6);
    tubesGeometry.setAttribute("iStart", new THREE.InterleavedBufferAttribute(ends, 3, 0));
    tubesGeometry.setAttribute("iEnd", new THREE.InterleavedBufferAttribute(ends, 3, 3));
    tubesGeometry.setAttribute("iSize", new THREE.InstancedBufferAttribute(sizes, 2));
    tubesGeometry.setAttribute("iColor", new THREE.InstancedBufferAttribute(tubeColours, 3, true));
    tubesGeometry.instanceCount = n;
    const uniforms = { uFrom: { value: 0 } };
    const tubes = new THREE.Mesh(tubesGeometry, new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `
            attribute vec3 iStart;
            attribute vec3 iEnd;
            attribute vec2 iSize;
            attribute vec3 iColor;
            uniform float uFrom;
            varying vec3 vColor;
            varying vec3 vNormal;
            void main() {
                // (Before the first shown: nowhere.)
                if (float(gl_InstanceID) < uFrom) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
                vec3 d = iEnd - iStart;
                float len = length(d);
                vec3 along = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
                // (A right-handed frame: along, side, up; else the boxes are
                // inside out, their outsides culled, their insides lit.)
                vec3 side = cross(vec3(0.0, 0.0, 1.0), along);
                float sl = length(side);
                side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
                vec3 up = cross(along, side);
                float w = iSize.x, h = iSize.y;
                // Along it, half its width past each end (so corners meet);
                // across it, its width; down from the nozzle, its height.
                vec3 p = iStart + along * (position.x * (len + w) - 0.5 * w) + side * (position.y * w) + up * (position.z * h);
                vColor = iColor;
                vNormal = normalize(normalMatrix * (along * normal.x + side * normal.y + up * normal.z));
                gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            }`,
        fragmentShader: `
            varying vec3 vColor;
            varying vec3 vNormal;
            void main() {
                float lit = 0.4 + 0.6 * max(dot(normalize(vNormal), normalize(vec3(0.3, 0.5, 1.0))), 0.0);
                gl_FragColor = vec4(vColor * lit, 1.0);
                #include <colorspace_fragment>
            }`,
    }));
    // (Its own geometry is a unit box: it's never out of sight, as far as three.js knows.)
    tubes.frustumCulled = false;

    const moves = new THREE.BufferGeometry();
    moves.setAttribute("position", new THREE.BufferAttribute(g.travel.positions, 3));
    const travel = new THREE.LineSegments(moves, new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.4 }));
    travel.visible = false;
    const object = new THREE.Group();
    object.add(lines, tubes, travel);
    let asTubes = n <= MAX_TUBES;
    lines.visible = !asTubes;
    tubes.visible = asTubes;

    // Colouring: each segment's colour, linear (as three.js works: the
    // legend's sRGB colours made so), in both forms.
    const legend = el("div", { className: "model-legend", ariaLabel: "Colours" });
    const categories = g.types.map((t) => (t ? featureCategory(t) : "other"));
    const linear = (rgb) => {
        const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
        return [c.r, c.g, c.b].map((v) => Math.round(v * 255));
    };
    const hexLinear = (hex) => {
        const c = new THREE.Color(hex);
        return [c.r, c.g, c.b].map((v) => Math.round(v * 255));
    };
    const put = (s, [r, gr, b]) => {
        tubeColours[s * 3] = r; tubeColours[s * 3 + 1] = gr; tubeColours[s * 3 + 2] = b;
        lineColours[s * 6] = lineColours[s * 6 + 3] = r;
        lineColours[s * 6 + 1] = lineColours[s * 6 + 4] = gr;
        lineColours[s * 6 + 2] = lineColours[s * 6 + 5] = b;
    };
    const colour = (by) => {
        const how = COLOURINGS[by];
        if (by === "feature") {
            const each = categories.map((cat) => hexLinear(CATEGORIES[cat][1]));
            const used = new Set();
            for (let s = 0; s < n; s++) {
                used.add(categories[x.types[s]]);
                put(s, each[x.types[s]]);
            }
            legend.replaceChildren(el("ul", {}, ...Object.entries(CATEGORIES).filter(([k]) => used.has(k)).map(([, [name, c]]) =>
                el("li", {}, el("span", { className: "swatch", style: `background:#${c.toString(16).padStart(6, "0")}` }), name))));
        } else {
            const values = how.of(x), scale = how.scale ?? 1, span = valueRange(values, scale);
            // 64 steps of the ramp, made once.
            const steps = Array.from({ length: 64 }, (_, i) => linear(rampAt(i / 63))), none = hexLinear(NONE);
            let unknown = false;
            for (let s = 0; s < n; s++) {
                const v = values[s] * scale;
                if (!span || !Number.isFinite(v)) { put(s, none); unknown = true; continue; }
                put(s, steps[Math.round(Math.max(0, Math.min(1, (v - span[0]) / (span[1] - span[0]))) * 63)]);
            }
            const said = span ? [shown(span[0], span[1] - span[0]), shown(span[1], span[1] - span[0])] : ["", ""];
            const note = (by === "flow" || by === "width") && g.diameterGuessed ? `For ${g.filamentDiameter} mm filament (it doesn't say: guessed).` : "";
            legend.replaceChildren(el("p", { className: "model-ramp-name", textContent: `${how.name}${how.unit ? ` (${how.unit})` : ""}` }),
                el("div", { className: "model-ramp", style: `background:linear-gradient(to right,${RAMP.join(",")})` }),
                el("p", { className: "model-ramp-ends" }, el("span", { textContent: span ? said[0] : "not said" }), el("span", { textContent: said[1] })),
                ...(unknown && span ? [el("p", { className: "hint" }, el("span", { className: "swatch", style: "background:#8a8a8a" }), " not said")] : []),
                ...(note ? [el("p", { className: "hint", textContent: note })] : []));
        }
        printed.attributes.color.needsUpdate = true;
        tubesGeometry.attributes.iColor.needsUpdate = true;
    };
    colour("feature");

    let upTo = layers - 1, only = false;
    const label = el("span", { className: "hint model-layer-label", role: "status" });
    const show = () => {
        const from = only && upTo > 0 ? g.layers.extrudeEnd[upTo - 1] : 0, to = g.layers.extrudeEnd[upTo];
        printed.setDrawRange(from * 2, (to - from) * 2);
        tubesGeometry.instanceCount = to;
        uniforms.uFrom.value = from;
        const tFrom = only && upTo > 0 ? g.layers.travelEnd[upTo - 1] : 0;
        moves.setDrawRange(tFrom * 2, (g.layers.travelEnd[upTo] - tFrom) * 2);
        const z = g.layers.z[upTo];
        label.textContent = `Layer ${(upTo + 1).toLocaleString("en")} of ${layers.toLocaleString("en")}${Number.isFinite(z) ? ` · Z ${z.toFixed(2)} mm` : ""}`;
    };
    show();
    const tools = (redraw, { toggle }) => {
        const slider = el("input", { type: "range", className: "model-layer", min: "0", max: String(layers - 1), value: String(upTo), step: "1", ariaLabel: "Layers shown, up to" });
        slider.addEventListener("input", () => { upTo = Number(slider.value); show(); redraw(); });
        const colourIcons = { feature: "materials", speed: "speed", flow: "flow", width: "fit-width", height: "layer-only", temp: "temperature", fan: "fan" };
        const by = glyphChoice({ className: "model-colour", title: "Colour lines by", value: "feature",
            choices: Object.entries(COLOURINGS).map(([value, c]) => ({ value, label: c.name, icon: colourIcons[value] })),
            change(value) { colour(value); redraw(); },
        });
        const shape = toggle("", asTubes ? "Lines as laid: their width and height (click for thin lines)" : "Thin lines (click for lines as laid: their width and height)", asTubes, function (on) {
            asTubes = on;
            tubes.visible = on;
            lines.visible = !on;
            this.title = on ? "Lines as laid: their width and height (click for thin lines)" : "Thin lines (click for lines as laid: their width and height)";
            this.setAttribute("aria-label", this.title);
        }, "tubes");
        shape.classList.add("model-tubes");
        if (n > MAX_TUBES) shape.title += ` (slow: it has ${n.toLocaleString("en")} of them)`;
        return [by, shape, el("span", { className: "model-layers" }, slider, label),
            toggle("", "Show only the layer the slider is at", false, (on) => { only = on; show(); }, "layer-only"),
            toggle("", "Show the moves that don't extrude", false, (on) => { travel.visible = on; }, "travel")];
    };
    const notes = [g.truncated ? "only the first part is shown: it has too many moves" : "", g.skipped ? `${g.skipped.toLocaleString("en")} moves out of range left out` : ""].filter(Boolean);
    return {
        object, meshes: [], measure: lines, tools, legend,
        info: describeGCode(g) + (notes.length ? ` · ${notes.join("; ")}` : ""),
        stop: () => box.dispose(),
    };
}
