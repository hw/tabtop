// Drawing on a picture: a rectangle or circle, filled or outlined, or
// strokes with a pen; any of them as a highlighter's, see-through, would
// be. In a colour typed, chosen, or picked from the picture itself. What's drawn is
// a step ({draw}) like a crop's: replayed by transform, and recorded, and
// scaled to other pages, as a recipe's step of kind "draw".
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { storedJSON, storeJSON } from "./stored.js";
import { floodFill, MAX_FILL_POINTS } from "./image-fill.js";
import { choiceMenu } from "./image-mask.js";

export const SHAPES = new Set(["rect", "circle", "pen"]), SHAPE_MODES = new Set(["fill", "outline", "highlight"]);
export const MAX_LINE = 1000, MAX_STROKES = 500, MAX_STROKE_POINTS = 10000;
// A highlighter's ink: multiplied, so what's under it (dark text) shows.
const HIGHLIGHT_ALPHA = 0.4;
const COLOR = /^#[0-9a-f]{6}$/i;
const SETTINGS = "tabtop.image-draw";

// validShape is draw if it's one that can be drawn, else it throws: a
// recipe's may come from elsewhere. It's {shape, mode, color, line} and,
// for a rectangle or circle, rect ({x, y, width, height}); for a pen,
// strokes ([[x, y, x, y, …], …]), drawn with a line, not filled.
export function validShape(draw) {
    const bad = () => { throw new Error("Not a shape that can be drawn."); };
    if (!SHAPES.has(draw?.shape) || !SHAPE_MODES.has(draw?.mode) || !COLOR.test(draw?.color ?? "")) bad();
    const pen = draw.shape === "pen";
    if ((draw.mode === "outline" || pen) && !(Number.isFinite(draw.line) && draw.line > 0 && draw.line <= MAX_LINE)) bad();
    if (pen) {
        const strokes = draw.strokes;
        if (draw.mode === "fill" || !Array.isArray(strokes) || !strokes.length || strokes.length > MAX_STROKES ||
            !strokes.every((s) => Array.isArray(s) && s.length >= 2 && s.length % 2 === 0 && s.length <= 2 * MAX_STROKE_POINTS && s.every(Number.isFinite))) bad();
    } else {
        const r = draw.rect;
        if (![r?.x, r?.y, r?.width, r?.height].every(Number.isFinite) || r.width < 0 || r.height < 0) bad();
    }
    return draw;
}

// drawShape draws draw on ctx, in its pixels. An outline is drawn inside
// its rectangle, as a border would be; one too thick for it, filled. A
// pen's strokes are one line, so where a highlighter's cross, they're no
// darker.
export function drawShape(ctx, draw) {
    const { shape, rect, color, mode, line, strokes } = validShape(draw);
    if (shape !== "pen" && (rect.width < 1 || rect.height < 1)) return;
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = color;
    if (mode === "highlight") {
        ctx.globalAlpha = HIGHLIGHT_ALPHA;
        ctx.globalCompositeOperation = "multiply";
    }
    if (shape === "pen") {
        ctx.beginPath();
        for (const s of strokes) {
            ctx.moveTo(s[0], s[1]);
            // (A dot: a line too short to see, its round ends a circle.)
            if (s.length === 2) ctx.lineTo(s[0] + 0.01, s[1]);
            for (let i = 2; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]);
        }
        ctx.lineWidth = line;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
        return;
    }
    const inset = mode === "outline" ? line / 2 : 0;
    const w = rect.width - 2 * inset, h = rect.height - 2 * inset;
    const outline = mode === "outline" && w > 0 && h > 0;
    ctx.beginPath();
    if (shape === "circle") {
        const [rx, ry] = outline ? [w / 2, h / 2] : [rect.width / 2, rect.height / 2];
        ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rx, ry, 0, 0, Math.PI * 2);
    } else if (outline) ctx.rect(rect.x + inset, rect.y + inset, w, h);
    else ctx.rect(rect.x, rect.y, rect.width, rect.height);
    if (outline) { ctx.lineWidth = line; ctx.stroke(); } else ctx.fill();
    ctx.restore();
}

// hexColor is the [r, g, b] given as #rrggbb.
export const hexColor = (rgb) => "#" + [...rgb].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");

// drawTool is the tool, in toolbar, for the picture shown in stage at
// geometry() ({width, height, x, y, scale}), whose pixels source() (a
// canvas) has. apply(op) is given what's drawn, as an op: {draw}, or with
// the paint bucket, {fill} (see image-fill.js).
export function drawTool({ toolbar, stage, button, geometry, source, apply, changed }) {
    const saved = storedJSON(SETTINGS, {});
    let active = false, picking = false, box = null, gesture = null, strokes = [];
    // The paint bucket's: points clicked, and the selection it's kept in.
    let points = [], selection = null, selectShape = saved.selectShape === "circle" ? "circle" : "rect", filled = 0, fillFrame = 0;
    let shape = SHAPES.has(saved.shape) || saved.shape === "bucket" ? saved.shape : "rect";
    let mode = SHAPE_MODES.has(saved.mode) ? saved.mode : "fill";
    // A pen draws lines: Filled is for shapes.
    if (shape === "pen" && mode === "fill") mode = "outline";
    const makeButton = (icon, title, cls, fn) => {
        const b = el("button", { type: "button", className: `glyph ${cls}`, title, ariaLabel: title });
        b.innerHTML = iconSVG(icon);
        b.addEventListener("click", fn);
        return b;
    };
    const keepSettings = () => storeJSON(SETTINGS, { shape, mode, color: color.value, line: Number(line.value), tolerance: Number(tolerance.value), selectShape });
    const choose = (set) => () => { set(); keepSettings(); update(); stage.focus({ preventScroll: true }); };
    // Another shape: what was drawn with the last one is let go.
    const setShape = (next) => choose(() => {
        if (next !== shape) { box = null; strokes = []; points = []; selection = null; gesture = null; }
        shape = next;
        if (shape === "pen" && mode === "fill") mode = "outline";
    });
    // What's drawn with, and how, as menus as the selection shape's are.
    const toolMenu = choiceMenu({ className: "image-draw-shape-menu", label: "Draw with", onChoose: (key) => setShape(key)(), choices: [
        { key: "rect", title: "Rectangle", icon: "shape-rect", className: "image-draw-rect" },
        { key: "circle", title: "Circle", icon: "shape-circle", className: "image-draw-circle" },
        { key: "pen", title: "Pen (P)", icon: "pen", className: "image-draw-pen" },
        { key: "bucket", title: "Paint bucket (B)", icon: "flood-fill", className: "image-draw-bucket" },
    ] });
    const tolerance = el("input", { type: "number", className: "image-draw-tolerance", min: "0", max: "100", step: "1",
        value: String(Number.isFinite(saved.tolerance) && saved.tolerance >= 0 && saved.tolerance <= 100 ? saved.tolerance : 15), ariaLabel: "Tolerance, in percent" });
    const toleranceLabel = el("label", { className: "image-draw-tolerance-label", title: "How far from the colour clicked a pixel may be, and still be filled" }, "Tolerance ", tolerance, "%");
    const selectMenu = choiceMenu({ className: "image-draw-select-menu", label: "Selection shape", choices: [
        { key: "rect", title: "Rectangle", icon: "select-area", className: "image-draw-select-rect" },
        { key: "circle", title: "Circle", icon: "select-circle", className: "image-draw-select-circle" },
    ], onChoose: (key) => choose(() => { if (selectShape !== key) selection = null; selectShape = key; refill(); })() });
    const selectAll = makeButton("select-all", "Fill anywhere in the picture", "image-draw-select-all", choose(() => { selection = null; refill(); }));
    const styleMenu = choiceMenu({ className: "image-draw-style-menu", label: "Style", onChoose: (key) => choose(() => { mode = key; })(), choices: [
        { key: "fill", title: "Filled", icon: "shape-fill", className: "image-draw-fill" },
        { key: "outline", title: "Outline", icon: "shape-outline", className: "image-draw-outline" },
        { key: "highlight", title: "Highlight", icon: "highlighter", className: "image-draw-highlight" },
    ] });
    const line = el("input", { type: "number", className: "image-draw-line", min: "1", max: String(MAX_LINE), step: "1",
        value: String(Number.isFinite(saved.line) && saved.line >= 1 && saved.line <= MAX_LINE ? saved.line : 4), ariaLabel: "Line width in pixels" });
    const lineLabel = el("label", { className: "image-draw-line-label", title: "Line width, in the picture's pixels" }, "Line ", line);
    const color = el("input", { type: "color", className: "image-draw-color", value: COLOR.test(saved.color ?? "") ? saved.color.toLowerCase() : "#ff0000",
        title: "Colour (or press I, then click the picture, to take its colour)", ariaLabel: "Colour" });
    const undoStroke = makeButton("undo", "Undo stroke", "image-draw-undo-stroke", () => {
        if (shape === "bucket") { points.pop(); refill(); } else strokes.pop();
        update(); stage.focus({ preventScroll: true });
    });
    const accept = makeButton("check", "Draw it (Enter)", "image-draw-apply", () => commit());
    const cancel = makeButton("close-circle", "Cancel (Esc)", "image-draw-cancel", () => close());
    const note = el("span", { className: "hint image-draw-note", role: "status" });
    line.addEventListener("input", () => { keepSettings(); place(); });
    color.addEventListener("input", () => { keepSettings(); place(); refill(); });
    tolerance.addEventListener("input", () => { keepSettings(); refill(); });
    for (const input of [line, color, tolerance]) input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.preventDefault(); close(); }
        e.stopPropagation();
    });
    const bar = el("div", { className: "image-draw-tools", hidden: true }, toolMenu.group, styleMenu.group,
        lineLabel, selectMenu.group, selectAll, toleranceLabel, color, undoStroke, accept, cancel, note);
    toolbar.append(bar);
    // What's being drawn, shown over the picture as it'll be: a shape as a
    // box, strokes as an SVG of them, in the picture's pixels.
    const overlay = el("div", { className: "image-draw-shape", hidden: true, ariaHidden: "true" });
    const SVG = "http://www.w3.org/2000/svg";
    const lines = document.createElementNS(SVG, "svg");
    lines.setAttribute("class", "image-draw-strokes");
    lines.setAttribute("aria-hidden", "true");
    const linePath = document.createElementNS(SVG, "path");
    for (const [k, v] of [["fill", "none"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) linePath.setAttribute(k, v);
    lines.append(linePath);
    lines.style.display = "none";
    // The bucket's: the picture as it'll be, filled; and the selection.
    const filling = el("canvas", { className: "image-draw-filled", hidden: true, ariaHidden: "true" });
    const selectionBox = el("div", { className: "image-draw-selection", hidden: true, ariaHidden: "true" });
    stage.append(overlay, lines, filling, selectionBox);

    const lineWidth = () => Math.max(1, Math.min(MAX_LINE, Number(line.value) || 1));
    const shown = () => shape === "bucket" ? points.length > 0 && filled > 0 : shape === "pen" ? strokes.length > 0 : !!box && box.width >= 1 && box.height >= 1;
    const fillOf = () => ({ points: points.map((p) => [...p]), color: color.value.toLowerCase(), tolerance: Math.max(0, Math.min(100, Number(tolerance.value) || 0)),
        selection: selection && selection.width >= 1 && selection.height >= 1 ? { shape: selectShape, ...selection } : null });
    // refill shows the picture as the bucket would leave it (soon: it's
    // the whole picture's pixels, so once a frame at most).
    function refill() {
        cancelAnimationFrame(fillFrame);
        fillFrame = requestAnimationFrame(() => {
            filled = 0;
            const canvas = source(), g = geometry();
            if (active && shape === "bucket" && points.length && canvas?.getContext) {
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                const image = ctx.getImageData(0, 0, g.width, g.height);
                filled = floodFill(image.data, g.width, g.height, fillOf());
                Object.assign(filling, { width: g.width, height: g.height });
                filling.getContext("2d").putImageData(image, 0, 0);
            }
            update();
        });
    }
    const pointOf = (px, py, clamp = true) => {
        const g = geometry();
        const p = [(px - g.x) / g.scale, (py - g.y) / g.scale];
        return clamp ? [Math.max(0, Math.min(g.width, p[0])), Math.max(0, Math.min(g.height, p[1]))] : p;
    };
    function update() {
        const bucket = shape === "bucket";
        toolMenu.set(shape);
        styleMenu.set(mode);
        selectMenu.set(selectShape);
        styleMenu.item("fill").disabled = shape === "pen";
        styleMenu.retitle("outline", shape === "pen" ? "Solid line" : "Outline");
        styleMenu.group.hidden = bucket;
        for (const b of [selectMenu.group, selectAll, toleranceLabel]) b.hidden = !bucket;
        selectAll.disabled = !selection;
        lineLabel.hidden = bucket || !(shape === "pen" || mode === "outline");
        undoStroke.hidden = shape !== "pen" && !bucket;
        undoStroke.title = bucket ? "Undo fill" : "Undo stroke";
        undoStroke.setAttribute("aria-label", undoStroke.title);
        undoStroke.disabled = bucket ? !points.length : !strokes.length;
        accept.disabled = !shown();
        stage.classList.toggle("drawing", active && !picking);
        stage.classList.toggle("picking-colour", active && picking);
        note.textContent = picking ? "Click the picture to take its colour."
            : bucket ? (points.length && !filled ? "Nothing there to fill: is it outside the selection?"
                : points.length ? `${filled.toLocaleString()} pixels filled. Click to fill more, then Apply.`
                : `Click to fill an area of a colour; drag a ${selectShape === "circle" ? "circle" : "rectangle"} to keep the fill within it.`)
            : shape === "pen" ? (mode === "highlight" ? "Highlight with the pointer, then Apply." : "Draw with the pointer, then Apply.")
            : shape === "circle" ? "Drag from the circle's centre to its edge." : "Drag a rectangle over the picture.";
        place();
        changed();
    }
    function place() {
        const g = geometry(), highlight = mode === "highlight";
        const bucket = active && shape === "bucket";
        filling.hidden = !bucket || !points.length || !filled;
        if (!filling.hidden) Object.assign(filling.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width * g.scale}px`, height: `${g.height * g.scale}px` });
        selectionBox.hidden = !bucket || !selection || selection.width < 1 || selection.height < 1;
        if (!selectionBox.hidden) {
            Object.assign(selectionBox.style, { left: `${g.x + selection.x * g.scale}px`, top: `${g.y + selection.y * g.scale}px`,
                width: `${selection.width * g.scale}px`, height: `${selection.height * g.scale}px`, borderRadius: selectShape === "circle" ? "50%" : "0" });
            selectionBox.dataset.size = `${Math.round(selection.width)}×${Math.round(selection.height)}`;
        }
        const showLines = active && shape === "pen" && strokes.length > 0;
        lines.style.display = showLines ? "" : "none";
        if (showLines) {
            Object.assign(lines.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width * g.scale}px`, height: `${g.height * g.scale}px`,
                opacity: highlight ? String(HIGHLIGHT_ALPHA) : "1", mixBlendMode: highlight ? "multiply" : "normal" });
            lines.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`);
            linePath.setAttribute("d", strokes.map((s) => `M${s[0]} ${s[1]}` + (s.length === 2 ? `l0.01 0` : "")
                + Array.from({ length: s.length / 2 - 1 }, (_, i) => `L${s[2 * i + 2]} ${s[2 * i + 3]}`).join("")).join(""));
            linePath.setAttribute("stroke", color.value);
            linePath.setAttribute("stroke-width", String(lineWidth()));
        }
        overlay.hidden = !active || shape === "pen" || bucket || !shown();
        if (overlay.hidden) return;
        Object.assign(overlay.style, {
            left: `${g.x + box.x * g.scale}px`, top: `${g.y + box.y * g.scale}px`,
            width: `${box.width * g.scale}px`, height: `${box.height * g.scale}px`,
            borderRadius: shape === "circle" ? "50%" : "0",
            background: mode === "outline" ? "transparent" : color.value,
            opacity: highlight ? String(HIGHLIGHT_ALPHA) : "1", mixBlendMode: highlight ? "multiply" : "normal",
            borderWidth: mode === "outline" ? `${Math.min(lineWidth(), box.width / 2, box.height / 2) * g.scale}px` : "0",
            borderColor: color.value,
        });
        overlay.dataset.size = `${Math.round(box.width)}×${Math.round(box.height)}`;
    }
    function setPicking(on) {
        if (!active) return;
        picking = on;
        update();
        stage.focus({ preventScroll: true });
    }
    // The picture's colour at [x, y], in its pixels, as #rrggbb.
    function sample([px, py]) {
        const canvas = source(), g = geometry();
        const sx = Math.min(g.width - 1, Math.floor(px)), sy = Math.min(g.height - 1, Math.floor(py));
        const ctx = canvas?.getContext?.("2d", { willReadFrequently: true });
        if (!ctx) return;
        color.value = hexColor(ctx.getImageData(sx, sy, 1, 1).data);
        keepSettings();
    }
    function open() {
        active = true;
        picking = false;
        box = gesture = null;
        strokes = [];
        points = [];
        selection = null;
        filled = 0;
        bar.hidden = false;
        button.setAttribute("aria-pressed", "true");
        update();
        stage.focus({ preventScroll: true });
    }
    function close() {
        for (const menu of [toolMenu, styleMenu, selectMenu]) menu.close();
        if (!active) return;
        active = picking = false;
        box = gesture = null;
        strokes = [];
        points = [];
        selection = null;
        filled = 0;
        cancelAnimationFrame(fillFrame);
        filling.width = filling.height = 0;
        bar.hidden = true;
        button.setAttribute("aria-pressed", "false");
        update();
        stage.focus({ preventScroll: true });
    }
    // (A tenth of a pixel is as fine as a stroke's points need be kept.)
    const tenth = (v) => Math.round(v * 10) / 10;
    function draw() {
        if (!shown()) return null;
        if (shape === "bucket") return fillOf();
        const made = { shape, mode, color: color.value.toLowerCase(), line: lineWidth() };
        if (shape === "pen") made.strokes = strokes.map((s) => s.map(tenth));
        else made.rect = { x: box.x, y: box.y, width: box.width, height: box.height };
        return made;
    }
    function commit() {
        const made = draw();
        if (!active || !made) return;
        const bucket = shape === "bucket";
        close();
        apply(bucket ? { fill: made } : { draw: made });
    }
    update();
    return {
        active: () => active,
        painting: () => active,
        open, close, commit,
        pick: () => setPicking(!picking),
        pen: () => setShape("pen")(),
        bucket: () => setShape("bucket")(),
        place,
        // The shape as a recipe's pending step (see editRecipe), or null.
        recipe() {
            const made = draw(), g = geometry();
            return made ? { kind: shape === "bucket" ? "fill" : "draw", width: g.width, height: g.height, ...structuredClone(made) } : null;
        },
        down(px, py) {
            if (!active) return false;
            if (picking) {
                const p = pointOf(px, py, false), g = geometry();
                if (p[0] >= 0 && p[1] >= 0 && p[0] < g.width && p[1] < g.height) { sample(p); picking = false; update(); }
                return true;
            }
            const from = pointOf(px, py);
            if (shape === "bucket") {
                // A click fills; a drag selects what may be.
                gesture = { bucket: true, at: [px, py], from: pointOf(px, py, false), dragged: false };
                return true;
            }
            if (shape === "pen") {
                if (strokes.length >= MAX_STROKES) { note.textContent = `That's ${MAX_STROKES} strokes: apply them before drawing more.`; return true; }
                gesture = { stroke: [...from] };
                strokes.push(gesture.stroke);
            } else {
                gesture = { from };
                box = { x: from[0], y: from[1], width: 0, height: 0 };
            }
            update();
            return true;
        },
        move(px, py) {
            if (!active) return false;
            if (!gesture) return true;
            if (gesture.bucket) {
                if (!gesture.dragged && Math.hypot(px - gesture.at[0], py - gesture.at[1]) < 4) return true;
                gesture.dragged = true;
                const [fx, fy] = gesture.from, [cx, cy] = pointOf(px, py, false);
                if (selectShape === "circle") {
                    const r = Math.hypot(cx - fx, cy - fy);
                    selection = { x: fx - r, y: fy - r, width: 2 * r, height: 2 * r };
                } else selection = { x: Math.min(fx, cx), y: Math.min(fy, cy), width: Math.abs(cx - fx), height: Math.abs(cy - fy) };
                place();
                return true;
            }
            if (gesture.stroke) {
                // A point a screen pixel or more from the last; only lines
                // are redrawn, as the pointer moves.
                const s = gesture.stroke, [x, y] = pointOf(px, py), g = geometry();
                if (s.length >= 2 * MAX_STROKE_POINTS || Math.hypot(x - s.at(-2), y - s.at(-1)) * g.scale < 1) return true;
                s.push(x, y);
                place();
                return true;
            }
            const [fx, fy] = gesture.from;
            if (shape === "circle") {
                const [cx, cy] = pointOf(px, py, false), r = Math.hypot(cx - fx, cy - fy);
                box = { x: fx - r, y: fy - r, width: 2 * r, height: 2 * r };
            } else {
                const [cx, cy] = pointOf(px, py);
                box = { x: Math.min(fx, cx), y: Math.min(fy, cy), width: Math.abs(cx - fx), height: Math.abs(cy - fy) };
            }
            update();
            return true;
        },
        up(cancelled = false, px, py) {
            if (gesture?.bucket) {
                const was = gesture;
                if (!cancelled && Number.isFinite(px) && Number.isFinite(py)) this.move(px, py);
                gesture = null;
                if (cancelled) return;
                const g = geometry(), [x, y] = was.from;
                if (was.dragged) {
                    if (selection && (selection.width < 1 || selection.height < 1)) selection = null;
                } else if (x >= 0 && y >= 0 && x < g.width && y < g.height) {
                    if (points.length >= MAX_FILL_POINTS) { note.textContent = `That's ${MAX_FILL_POINTS} fills: apply them before filling more.`; return; }
                    points.push([Math.floor(x) + 0.5, Math.floor(y) + 0.5]);
                }
                refill();
                return;
            }
            if (gesture?.stroke && !cancelled && Number.isFinite(px) && Number.isFinite(py)) this.move(px, py);
            if (gesture?.stroke && cancelled) strokes.pop();
            const was = gesture;
            gesture = null;
            if (was?.stroke) update();
        },
        stop() {
            close();
            bar.remove();
            overlay.remove();
            lines.remove();
            filling.remove();
            selectionBox.remove();
            for (const menu of [toolMenu, styleMenu, selectMenu]) menu.stop();
        },
    };
}
