// Document rectification and paper cleanup. All geometry and tone changes
// operate on the original pixels; no text is recognized or regenerated.
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";

const MAX_PIXELS = 16e6, MAX_SIDE = 8192;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const EDGE_SAMPLES = 16;
// The middle of each edge, clockwise from the top, where (u, v) runs over
// the page from (0, 0) at its top left to (1, 1) at its bottom right.
export const SCAN_EDGES = [[.5, 0], [1, .5], [.5, 1], [0, .5]];
const NO_EDGES = [[0, 0], [0, 0], [0, 0], [0, 0]];

// Whether corners go clockwise round a convex outline: crossed or concave
// ones would fold the projective transform.
function convex(p) {
    for (let i = 0; i < 4; i++) {
        const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= .01) return false;
    }
    return true;
}

// The projective transform taking the unit square onto corners a, b, c, d.
function homography([a, b, c, d]) {
    const dx1 = b[0] - c[0], dx2 = d[0] - c[0], dx3 = a[0] - b[0] + c[0] - d[0];
    const dy1 = b[1] - c[1], dy2 = d[1] - c[1], dy3 = a[1] - b[1] + c[1] - d[1];
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / det, k = (dx1 * dy3 - dx3 * dy1) / det;
    return [b[0] - a[0] + g * b[0], d[0] - a[0] + k * d[0], a[0],
        b[1] - a[1] + g * b[1], d[1] - a[1] + k * d[1], a[1], g, k];
}

// scanMapper is where each point (u, v) of the scanned page comes from in
// the photo: the corners' perspective, with each edge bent through its
// middle point, which is edges[i] (an offset) from where the perspective
// alone would put it. The bend fades towards the opposite edge and is none
// at the corners, so an edge left alone stays straight.
export function scanMapper(corners, edges = NO_EDGES) {
    const m = homography(corners);
    const flat = convex(corners) && m.every(Number.isFinite)
        ? (u, v) => { const den = m[6] * u + m[7] * v + 1; return [(m[0] * u + m[1] * v + m[2]) / den, (m[3] * u + m[4] * v + m[5]) / den]; }
        // Corners that fold it: no perspective, so (only to draw the outline) between them.
        : (u, v) => [0, 1].map(i => (1 - u) * (1 - v) * corners[0][i] + u * (1 - v) * corners[1][i] + u * v * corners[2][i] + (1 - u) * v * corners[3][i]);
    if (edges.every(([x, y]) => !x && !y)) return flat;
    const [top, right, bottom, left] = edges;
    return (u, v) => {
        const [x, y] = flat(u, v), across = 4 * u * (1 - u), down = 4 * v * (1 - v);
        return [0, 1].map(i => [x, y][i] + across * ((1 - v) * top[i] + v * bottom[i]) + down * ((1 - u) * left[i] + u * right[i]));
    };
}

// scanOutline is the page's outline in the photo, clockwise from its top
// left: n points along each edge.
export function scanOutline(corners, edges, n = EDGE_SAMPLES) {
    const at = scanMapper(corners, edges), out = [];
    for (const [u0, v0, du, dv] of [[0, 0, 1, 0], [1, 0, 0, 1], [1, 1, -1, 0], [0, 1, 0, -1]])
        for (let i = 0; i < n; i++) out.push(at(u0 + du * i / n, v0 + dv * i / n));
    return out;
}

// scanHandles is where the eight points are drawn: the corners, then the
// middle of each edge.
export function scanHandles(corners, edges = NO_EDGES) {
    const flat = scanMapper(corners);
    return [...corners.map(p => [...p]), ...SCAN_EDGES.map(([u, v], i) => flat(u, v).map((c, j) => c + edges[i][j]))];
}

const turn = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
// Whether a closed outline's edges cross one another.
function crosses(points) {
    const n = points.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const a = points[i], b = points[(i + 1) % n], c = points[j], d = points[(j + 1) % n];
        if (turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0) return true;
    }
    return false;
}
const length = (points) => points.reduce((sum, p, i) => i ? sum + distance(points[i - 1], p) : 0, 0);

export function scanGeometry(width, height, settings) {
    const p = settings?.corners;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS)
        throw new Error("Resize the picture to under 16 megapixels before scanning.");
    if (!Array.isArray(p) || p.length !== 4 || p.some(a => !Array.isArray(a) || a.length !== 2 || !a.every(Number.isFinite)
        || a[0] < 0 || a[0] > width || a[1] < 0 || a[1] > height)) throw new Error("Place all four corners inside the picture.");
    // Clockwise on screen: top left, top right, bottom right, bottom left.
    if (!convex(p)) throw new Error("Keep the corners in order around the paper without crossing the edges.");
    let area = 0;
    for (let i = 0; i < 4; i++) area += p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1];
    if (area < 8) throw new Error("Select a larger document area.");
    const edges = settings.edges ?? NO_EDGES;
    if (!Array.isArray(edges) || edges.length !== 4 || edges.some(a => !Array.isArray(a) || a.length !== 2 || !a.every(Number.isFinite)))
        throw new Error("Invalid document edges.");
    const bent = edges.some(([x, y]) => x || y);
    let w, h;
    if (bent) {
        if (scanHandles(p, edges).slice(4).some(([x, y]) => x < 0 || x > width || y < 0 || y > height))
            throw new Error("Place the middle of each edge inside the picture.");
        if (crosses(scanOutline(p, edges))) throw new Error("Bend the edges less: they mustn't cross each other.");
        // As long as the bent edges are.
        const at = scanMapper(p, edges), along = (f) => length(Array.from({ length: 33 }, (_, i) => at(...f(i / 32))));
        w = Math.max(2, Math.round((along(t => [t, 0]) + along(t => [t, 1])) / 2));
        h = Math.max(2, Math.round((along(t => [0, t]) + along(t => [1, t])) / 2));
    } else {
        w = Math.max(2, Math.round((distance(p[0], p[1]) + distance(p[3], p[2])) / 2));
        h = Math.max(2, Math.round((distance(p[0], p[3]) + distance(p[1], p[2])) / 2));
    }
    if (w * h > MAX_PIXELS || Math.max(w, h) > MAX_SIDE) throw new Error("The scanned page exceeds 16 megapixels or 8192 pixels per side.");
    if (!["color", "gray", "bw"].includes(settings.mode) || !Number.isFinite(settings.whiten) || settings.whiten < 0 || settings.whiten > 100
        || !Number.isFinite(settings.ink) || settings.ink < 0 || settings.ink > 40) throw new Error("Invalid scan adjustments.");
    return { width: w, height: h, matrix: homography(p), map: scanMapper(p, edges) };
}

// A small background field: enlarge bright paper regions to bridge ink,
// then smooth. The full-size output never needs full-size filter buffers.
function paperField(data, width, height) {
    const scale = Math.min(1, 192 / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const field = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (const [u, v] of [[.2, .2], [.8, .2], [.5, .5], [.2, .8], [.8, .8]]) {
            const i = (Math.min(height - 1, Math.floor((y + v) * height / h)) * width + Math.min(width - 1, Math.floor((x + u) * width / w))) * 4;
            const at = (y * w + x) * 3;
            for (let c = 0; c < 3; c++) field[at + c] = Math.max(field[at + c], data[i + c] * data[i + 3] / 255 + 255 - data[i + 3]);
        }
    }
    let src = field;
    for (const [horizontal, radius, maximum] of [[true, 3, true], [false, 3, true], [true, 6, false], [false, 6, false]]) {
        const out = new Float32Array(field.length);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
            let value = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = horizontal ? Math.max(0, Math.min(w - 1, x + k)) : x;
                const yy = horizontal ? y : Math.max(0, Math.min(h - 1, y + k));
                const sample = src[(yy * w + xx) * 3 + c];
                value = maximum ? Math.max(value, sample) : value + sample;
            }
            out[(y * w + x) * 3 + c] = maximum ? value : value / (radius * 2 + 1);
        }
        src = out;
    }
    return { data: src, width: w, height: h };
}

export function scanPixels(rgba, width, height, settings) {
    const size = scanGeometry(width, height, settings);
    if (rgba.length !== width * height * 4) throw new Error("Invalid scan pixels.");
    const out = new Uint8ClampedArray(size.width * size.height * 4), map = size.map;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const [px, py] = map((x + .5) / size.width, (y + .5) / size.height);
        const sx = Math.max(0, Math.min(width - 1, px - .5)), sy = Math.max(0, Math.min(height - 1, py - .5));
        const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top, at = (y * size.width + x) * 4;
        let alpha = 0;
        const color = [0, 0, 0];
        for (const [xx, yy, weight] of [[left, top, (1 - fx) * (1 - fy)], [Math.min(width - 1, left + 1), top, fx * (1 - fy)],
            [left, Math.min(height - 1, top + 1), (1 - fx) * fy], [Math.min(width - 1, left + 1), Math.min(height - 1, top + 1), fx * fy]]) {
            const i = (yy * width + xx) * 4, a = rgba[i + 3] * weight;
            alpha += a;
            for (let c = 0; c < 3; c++) color[c] += rgba[i + c] * a;
        }
        for (let c = 0; c < 3; c++) out[at + c] = alpha ? color[c] / alpha : 0;
        out[at + 3] = alpha;
    }
    const field = settings.whiten ? paperField(out, size.width, size.height) : null;
    const blend = settings.whiten / 100, black = settings.ink * 2.55;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const at = (y * size.width + x) * 4;
        const f = field ? (Math.min(field.height - 1, Math.floor(y * field.height / size.height)) * field.width + Math.min(field.width - 1, Math.floor(x * field.width / size.width))) * 3 : 0;
        const color = [0, 1, 2].map(c => {
            const value = out[at + c], paper = field ? Math.max(32, field.data[f + c]) : 255;
            const cleaned = value * (1 - blend) + Math.min(255, value * 255 / paper) * blend;
            return Math.max(0, Math.min(255, (cleaned - black) * 255 / (255 - black)));
        });
        const gray = .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
        for (let c = 0; c < 3; c++) out[at + c] = settings.mode === "color" ? color[c] : settings.mode === "bw" ? (gray >= 160 ? 255 : 0) : gray;
    }
    return { data: out, width: size.width, height: size.height };
}

export function scanCanvas(source, settings) {
    scanGeometry(source.width, source.height, settings);
    const input = Object.assign(document.createElement("canvas"), { width: source.width, height: source.height });
    const ctx = input.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const image = scanPixels(ctx.getImageData(0, 0, source.width, source.height).data, source.width, source.height, settings);
    input.width = image.width; input.height = image.height;
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return input;
}

export function scanTool({ toolbar, hints, stage, button, geometry, source, apply, changed }) {
    let active = false, corners = [], edges = [], base = null, frame = null, gesture = null, previewing = false;
    const control = (icon, label, cls, action) => {
        const b = el("button", { type: "button", className: `glyph ${cls}`, title: label, ariaLabel: label });
        b.innerHTML = iconSVG(icon); b.addEventListener("click", action); return b;
    };
    const cornerView = control("scan-corners", "Adjust document corners", "image-scan-corners", () => { previewing = false; refresh(); });
    const preview = control("scan-preview", "Preview scanned document", "image-scan-preview", () => { previewing = true; refresh(); });
    const mode = el("select", { className: "image-scan-mode", ariaLabel: "Scan color mode" },
        ...[["gray", "Grayscale"], ["color", "Color"], ["bw", "Black & white"]].map(([value, textContent]) => el("option", { value, textContent })));
    mode.value = "gray";
    const whiten = el("input", { type: "range", min: 0, max: 100, value: 85, className: "image-scan-whiten", ariaLabel: "Paper whitening" });
    const ink = el("input", { type: "range", min: 0, max: 40, value: 8, className: "image-scan-ink", ariaLabel: "Ink strength" });
    const settings = el("div", { className: "mask-brush-options image-scan-options", role: "dialog", ariaLabel: "Scan adjustments" },
        el("label", {}, "Finish ", mode), el("label", {}, "Paper whitening ", whiten), el("label", {}, "Ink strength ", ink));
    settings.setAttribute("popover", "auto");
    const adjust = control("save-options", "Scan adjustments", "image-scan-settings", () => {});
    adjust.popoverTargetElement = settings; adjust.popoverTargetAction = "toggle";
    adjust.setAttribute("aria-haspopup", "dialog"); adjust.setAttribute("aria-expanded", "false");
    const positionSettings = () => {
        adjust.setAttribute("aria-expanded", String(settings.matches(":popover-open")));
        if (!settings.matches(":popover-open")) return;
        const r = adjust.getBoundingClientRect(), box = settings.getBoundingClientRect();
        settings.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.width - 8))}px`;
        settings.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - box.height - 8))}px`;
    };
    settings.addEventListener("toggle", positionSettings);
    window.addEventListener("resize", positionSettings);
    settings.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); settings.hidePopover(); adjust.focus(); } e.stopPropagation(); });
    for (const input of [mode, whiten, ink]) input.addEventListener("input", () => { previewing = true; refresh(); });
    const accept = control("check", "Apply document scan", "image-scan-apply", () => tool.commit());
    const cancel = control("close-circle", "Cancel document scan", "image-scan-cancel", () => tool.close());
    const bar = el("div", { className: "image-scan-tools", hidden: true }, cornerView, preview, adjust, accept, cancel, settings);
    const note = el("span", { className: "hint image-scan-note", role: "status", hidden: true });
    toolbar.append(bar); hints.append(note);
    const ns = "http://www.w3.org/2000/svg", outline = document.createElementNS(ns, "svg"), polygon = document.createElementNS(ns, "polygon");
    outline.setAttribute("class", "image-scan-outline"); outline.setAttribute("aria-hidden", "true"); outline.append(polygon); outline.style.display = "none";
    const output = el("canvas", { className: "image-scan-result", hidden: true, ariaLabel: "Scanned document preview", role: "img" });
    const params = () => ({ corners: corners.map(p => [...p]), edges: edges.map(p => [...p]), mode: mode.value, whiten: Number(whiten.value), ink: Number(ink.value) });
    // Eight points: the corners (0-3), then the middle of each edge (4-7).
    const names = ["Top left document corner", "Top right document corner", "Bottom right document corner", "Bottom left document corner",
        "Middle of the top edge", "Middle of the right edge", "Middle of the bottom edge", "Middle of the left edge"];
    const pointOf = i => scanHandles(corners, edges)[i];
    // Moves point i to x, y (kept inside the picture): a corner, or an edge's middle, which bends it.
    const moveTo = (i, [x, y]) => {
        const p = [Math.max(0, Math.min(base.width, x)), Math.max(0, Math.min(base.height, y))];
        if (i < 4) corners[i] = p;
        else { const flat = scanHandles(corners)[i]; edges[i - 4] = [p[0] - flat[0], p[1] - flat[1]]; }
    };
    const handles = names.map((name, i) => {
        const b = el("button", { type: "button", className: `image-scan-corner${i < 4 ? "" : " image-scan-edge"}`, textContent: i < 4 ? String(i + 1) : "", ariaLabel: name, hidden: true });
        b.addEventListener("pointerdown", e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); b.focus(); b.setPointerCapture(e.pointerId);
            gesture = { i, corners: corners.map(p => [...p]), edges: edges.map(p => [...p]), id: e.pointerId };
        });
        b.addEventListener("pointermove", e => {
            if (!gesture || gesture.i !== i || gesture.id !== e.pointerId) return;
            e.stopPropagation(); const g = geometry(), r = stage.getBoundingClientRect();
            moveTo(i, [(e.clientX - r.left - g.x) / g.scale, (e.clientY - r.top - g.y) / g.scale]);
            refresh();
        });
        const end = e => { e.stopPropagation(); if (gesture?.i === i) { if (e.type === "pointercancel") ({ corners, edges } = gesture); gesture = null; refresh(); } };
        b.addEventListener("pointerup", end); b.addEventListener("pointercancel", end);
        b.addEventListener("keydown", e => {
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!d) return; e.preventDefault(); e.stopPropagation();
            const step = e.shiftKey ? 10 : 1;
            const p = pointOf(i); moveTo(i, [p[0] + d[0] * step, p[1] + d[1] * step]); refresh();
        });
        return b;
    });
    stage.append(outline, output, ...handles);
    function place() {
        if (!active) return;
        const g = geometry();
        Object.assign(outline.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width * g.scale}px`, height: `${g.height * g.scale}px` });
        outline.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`); polygon.setAttribute("points", scanOutline(corners, edges).map(p => p.join(",")).join(" "));
        const points = scanHandles(corners, edges);
        handles.forEach((b, i) => { const [x, y] = points[i]; Object.assign(b.style, { left: `${g.x + x * g.scale}px`, top: `${g.y + y * g.scale}px` }); b.title = `${names[i]}: ${Math.round(x)}, ${Math.round(y)}; drag or use arrow keys${i < 4 ? "" : " to bend the edge"}`; });
        if (!output.hidden) {
            const s = Math.min(g.width * g.scale / output.width, g.height * g.scale / output.height);
            Object.assign(output.style, { left: `${g.x + (g.width * g.scale - output.width * s) / 2}px`, top: `${g.y + (g.height * g.scale - output.height * s) / 2}px`, width: `${output.width * s}px`, height: `${output.height * s}px` });
        }
    }
    function refresh() {
        if (!active) return;
        let valid = true;
        try { scanGeometry(base.width, base.height, params()); note.textContent = previewing ? "Preview: adjust the finish, or return to Corners. Apply keeps the scan." : "Drag the four numbered corners onto the paper, and the middle of an edge to bend it along a curled page. Arrow keys move a focused point; Shift moves 10 pixels."; }
        catch (err) { valid = false; note.textContent = err.message; }
        accept.disabled = preview.disabled = !valid; note.classList.toggle("error", !valid);
        cornerView.setAttribute("aria-pressed", String(!previewing)); preview.setAttribute("aria-pressed", String(previewing));
        outline.style.display = previewing ? "none" : "block"; handles.forEach(b => { b.hidden = previewing; });
        base.style.visibility = previewing && valid ? "hidden" : "";
        cancelAnimationFrame(frame); output.hidden = true;
        if (previewing && valid) frame = requestAnimationFrame(() => {
            frame = null;
            try {
                const s = Math.min(1, 900 / Math.max(base.width, base.height));
                const sample = Object.assign(document.createElement("canvas"), { width: Math.max(2, Math.round(base.width * s)), height: Math.max(2, Math.round(base.height * s)) });
                sample.getContext("2d").drawImage(base, 0, 0, sample.width, sample.height);
                const p = params(), fit = ([x, y]) => [x * sample.width / base.width, y * sample.height / base.height];
                p.corners = p.corners.map(fit); p.edges = p.edges.map(fit);
                const result = scanCanvas(sample, p); output.width = result.width; output.height = result.height; output.getContext("2d").drawImage(result, 0, 0); output.hidden = false; place();
            } catch (err) { note.textContent = err.message; accept.disabled = true; base.style.visibility = ""; }
        });
        place(); changed();
    }
    const tool = {
        active: () => active, painting: () => active, place,
        recipe: () => active && !accept.disabled ? { kind: "scan", width: base.width, height: base.height, settings: params() } : null,
        open() {
            base = source(); scanGeometry(base.width, base.height, { corners: [[0, 0], [base.width, 0], [base.width, base.height], [0, base.height]], mode: "gray", whiten: 85, ink: 8 });
            corners = [[.03, .03], [.97, .03], [.97, .97], [.03, .97]].map(([x, y]) => [x * base.width, y * base.height]);
            edges = NO_EDGES.map(p => [...p]);
            mode.value = "gray"; whiten.value = "85"; ink.value = "8";
            active = true; previewing = false; bar.hidden = note.hidden = false; button.setAttribute("aria-pressed", "true"); refresh(); handles[0].focus({ preventScroll: true });
        },
        close() {
            active = false; gesture = null; cancelAnimationFrame(frame); frame = null; settings.hidePopover();
            if (base) base.style.visibility = "";
            outline.style.display = "none"; output.hidden = true; handles.forEach(b => { b.hidden = true; });
            output.width = output.height = 0; bar.hidden = note.hidden = true; button.setAttribute("aria-pressed", "false"); base = null; changed();
        },
        commit() { if (active && !accept.disabled) { const op = { scan: params() }; tool.close(); apply(op); } },
        stop() { tool.close(); window.removeEventListener("resize", positionSettings); bar.remove(); note.remove(); outline.remove(); output.remove(); handles.forEach(b => b.remove()); },
    };
    bar.addEventListener("keydown", e => { if (e.target.matches("input, select")) return; if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (e.key === "Escape") tool.close(); else tool.commit(); } });
    return tool;
}
