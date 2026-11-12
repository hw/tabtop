// Document rectification and paper cleanup. All geometry and tone changes
// operate on the original pixels; no text is recognized or regenerated.
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";

const MAX_PIXELS = 16e6, MAX_SIDE = 8192, MAX_FOLDS = 6;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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

// A folded paper (a letter folded to fit an envelope, say) lies in flat
// panels, one above another, each in its own perspective. Each fold is a
// straight line across it, from a point on its left side to one on its
// right: [left, right], top to bottom. scanPanels is the panels' corners
// (clockwise from top left), top to bottom.
export function scanPanels(corners, folds = []) {
    const lefts = [corners[0], ...folds.map(f => f[0]), corners[3]];
    const rights = [corners[1], ...folds.map(f => f[1]), corners[2]];
    return lefts.slice(1).map((left, i) => [lefts[i], rights[i], rights[i + 1], left]);
}

// scanFolds is where n folds, evenly spaced down the paper in the corners'
// perspective, would be: where their points start.
export function scanFolds(corners, n = 2) {
    const m = homography(corners), flat = convex(corners) && m.every(Number.isFinite);
    const at = (u, v) => flat
        ? [(m[0] * u + m[1] * v + m[2]) / (m[6] * u + m[7] * v + 1), (m[3] * u + m[4] * v + m[5]) / (m[6] * u + m[7] * v + 1)]
        // Corners that fold it: (only to place the points) between them.
        : [0, 1].map(i => (1 - v) * corners[u ? 1 : 0][i] + v * corners[u ? 2 : 3][i]);
    return Array.from({ length: n }, (_, i) => [at(0, (i + 1) / (n + 1)), at(1, (i + 1) / (n + 1))]);
}

const isPoint = (a, width, height) => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite) && a[0] >= 0 && a[0] <= width && a[1] >= 0 && a[1] <= height;
export function scanGeometry(width, height, settings) {
    const p = settings?.corners, folds = settings?.folds ?? [];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS)
        throw new Error("Resize the picture to under 16 megapixels before scanning.");
    if (!Array.isArray(p) || p.length !== 4 || p.some(a => !isPoint(a, width, height))) throw new Error("Place all four corners inside the picture.");
    if (!Array.isArray(folds) || folds.length > MAX_FOLDS || folds.some(f => !Array.isArray(f) || f.length !== 2 || f.some(a => !isPoint(a, width, height))))
        throw new Error("Place every fold point inside the picture.");
    // Clockwise on screen: top left, top right, bottom right, bottom left.
    const panels = scanPanels(p, folds);
    if (!folds.length && !convex(p)) throw new Error("Keep the corners in order around the paper without crossing the edges.");
    if (folds.length && !panels.every(convex)) throw new Error("Keep the corners and fold points in order down each side, without crossing.");
    let area = 0;
    for (const q of panels) for (let i = 0; i < 4; i++) area += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    if (area < 8) throw new Error("Select a larger document area.");
    // As wide as the paper is across, on average; each panel as tall as its sides.
    const across = [[p[0], p[1]], ...folds, [p[3], p[2]]];
    const w = Math.max(2, Math.round(across.reduce((sum, [a, b]) => sum + distance(a, b), 0) / across.length));
    let top = 0;
    const parts = panels.map(q => {
        const tall = Math.max(panels.length > 1 ? 1 : 2, Math.round((distance(q[0], q[3]) + distance(q[1], q[2])) / 2));
        const part = { matrix: homography(q), top, height: tall };
        top += tall;
        return part;
    });
    const h = top;
    if (w * h > MAX_PIXELS || Math.max(w, h) > MAX_SIDE) throw new Error("The scanned page exceeds 16 megapixels or 8192 pixels per side.");
    if (!["color", "gray", "bw"].includes(settings.mode) || !Number.isFinite(settings.whiten) || settings.whiten < 0 || settings.whiten > 100
        || !Number.isFinite(settings.ink) || settings.ink < 0 || settings.ink > 40) throw new Error("Invalid scan adjustments.");
    return { width: w, height: h, matrix: parts[0].matrix, panels: parts };
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
    const out = new Uint8ClampedArray(size.width * size.height * 4);
    let panel = 0;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        // Each panel's rows from its own perspective.
        while (y >= size.panels[panel].top + size.panels[panel].height) panel++;
        const { matrix: m, top: start, height: tall } = size.panels[panel];
        const u = (x + .5) / size.width, v = (y - start + .5) / tall, den = m[6] * u + m[7] * v + 1;
        const sx = Math.max(0, Math.min(width - 1, (m[0] * u + m[1] * v + m[2]) / den - .5));
        const sy = Math.max(0, Math.min(height - 1, (m[3] * u + m[4] * v + m[5]) / den - .5));
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
    let active = false, corners = [], moved = [], base = null, frame = null, gesture = null, previewing = false;
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
    const ns = "http://www.w3.org/2000/svg", outline = document.createElementNS(ns, "svg"), polygon = document.createElementNS(ns, "polygon"), foldLines = document.createElementNS(ns, "path");
    outline.setAttribute("class", "image-scan-outline"); outline.setAttribute("aria-hidden", "true"); foldLines.setAttribute("class", "image-scan-fold-lines"); outline.append(polygon, foldLines); outline.style.display = "none";
    const output = el("canvas", { className: "image-scan-result", hidden: true, ariaLabel: "Scanned document preview", role: "img" });
    // Four points down each side: the corners (0-3), then the two folds'
    // left and right points (4-7). A fold point follows the corners, evenly
    // spaced, until it's moved itself (moved[i - 4]).
    const folds = () => scanFolds(corners).map((fold, f) => fold.map((p, side) => moved[f * 2 + side] ?? p));
    const params = () => ({ corners: corners.map(p => [...p]), ...(moved.some(Boolean) ? { folds: folds() } : {}),
        mode: mode.value, whiten: Number(whiten.value), ink: Number(ink.value) });
    const names = ["Top left document corner", "Top right document corner", "Bottom right document corner", "Bottom left document corner",
        "Upper fold, left side", "Upper fold, right side", "Lower fold, left side", "Lower fold, right side"];
    const pointOf = i => i < 4 ? corners[i] : folds()[(i - 4) >> 1][(i - 4) & 1];
    const moveTo = (i, [x, y]) => {
        const p = [Math.max(0, Math.min(base.width, x)), Math.max(0, Math.min(base.height, y))];
        if (i < 4) corners[i] = p; else moved[i - 4] = p;
    };
    const handles = names.map((name, i) => {
        const b = el("button", { type: "button", className: `image-scan-corner${i < 4 ? "" : " image-scan-fold"}`, textContent: i < 4 ? String(i + 1) : "", ariaLabel: name, hidden: true });
        b.addEventListener("pointerdown", e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation(); b.focus(); b.setPointerCapture(e.pointerId);
            gesture = { i, corners: corners.map(p => [...p]), moved: [...moved], id: e.pointerId };
        });
        b.addEventListener("pointermove", e => {
            if (!gesture || gesture.i !== i || gesture.id !== e.pointerId) return;
            e.stopPropagation(); const g = geometry(), r = stage.getBoundingClientRect();
            moveTo(i, [(e.clientX - r.left - g.x) / g.scale, (e.clientY - r.top - g.y) / g.scale]);
            refresh();
        });
        const end = e => { e.stopPropagation(); if (gesture?.i === i) { if (e.type === "pointercancel") ({ corners, moved } = gesture); gesture = null; refresh(); } };
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
        outline.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`); const across = folds(), points = [...corners, ...across.flat()];
        polygon.setAttribute("points", [corners[0], corners[1], ...across.map(f => f[1]), corners[2], corners[3], ...across.map(f => f[0]).reverse()].map(p => p.join(",")).join(" "));
        foldLines.setAttribute("d", across.map(([a, b]) => `M${a.join(",")}L${b.join(",")}`).join(""));
        handles.forEach((b, i) => { const [x, y] = points[i]; Object.assign(b.style, { left: `${g.x + x * g.scale}px`, top: `${g.y + y * g.scale}px` }); b.title = `${names[i]}: ${Math.round(x)}, ${Math.round(y)}; drag or use arrow keys${i < 4 ? "" : "; place it where the paper's folded, if it is"}`; });
        if (!output.hidden) {
            const s = Math.min(g.width * g.scale / output.width, g.height * g.scale / output.height);
            Object.assign(output.style, { left: `${g.x + (g.width * g.scale - output.width * s) / 2}px`, top: `${g.y + (g.height * g.scale - output.height * s) / 2}px`, width: `${output.width * s}px`, height: `${output.height * s}px` });
        }
    }
    function refresh() {
        if (!active) return;
        let valid = true;
        try { scanGeometry(base.width, base.height, params()); note.textContent = previewing ? "Preview: adjust the finish, or return to Corners. Apply keeps the scan." : "Drag the four numbered corners onto the paper. If it's folded, drag the points down each side onto the folds. Arrow keys move a focused point; Shift moves 10 pixels."; }
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
                p.corners = p.corners.map(fit); if (p.folds) p.folds = p.folds.map(f => f.map(fit));
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
            moved = [];
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
