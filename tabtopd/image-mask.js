// Shared mask shapes, enclosed-region filling, and compact brush controls.
import { el } from "./preview-dom.js";
import { glyphs, iconSVG } from "./glyphs.js";

// Image edges can lie just beyond the last reachable screen pixel when
// fitted or clipped. Rectangle endpoints snap within a few screen pixels.
export function imageMaskPoint(px, py, { x, y, scale, width, height }, snap = 0) {
    const coordinate = (at, origin, side) => {
        const value = (at - origin) / scale, tolerance = snap / scale;
        if (value <= tolerance) return 0;
        if (side - value <= tolerance) return side;
        return Math.max(0, Math.min(side, value));
    };
    return [coordinate(px, x, width), coordinate(py, y, height)];
}

export function brushPath(ctx, { points, radius }) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
        const [x, y] = points[i];
        ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
        if (!i) continue;
        const [px, py] = points[i - 1], length = Math.hypot(x - px, y - py);
        if (!length) continue;
        const nx = -(y - py) / length * radius, ny = (x - px) / length * radius;
        ctx.moveTo(px + nx, py + ny); ctx.lineTo(px - nx, py - ny);
        ctx.lineTo(x - nx, y - ny); ctx.lineTo(x + nx, y + ny); ctx.closePath();
    }
}

export function maskPath(ctx, mark) {
    if (mark.scale) {
        ctx.save(); ctx.scale(...mark.scale); maskPath(ctx, { ...mark, scale: null }); ctx.restore(); return;
    }
    if (mark.points) { brushPath(ctx, mark); return; }
    ctx.beginPath();
    if (mark.circle) ctx.arc(mark.circle.cx, mark.circle.cy, mark.circle.r, 0, Math.PI * 2);
    else if (mark.rect) ctx.rect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height);
    else for (const [y, left, right] of mark.fill.spans) ctx.rect(mark.fill.x + left, mark.fill.y + y, right - left + 1, 1);
}

export function newMaskMark(shape, point, radius, erase = false) {
    if (shape === "circle") return { circle: { cx: point[0], cy: point[1], r: 0 }, erase };
    if (shape === "rectangle") return { rect: { x: point[0], y: point[1], width: 0, height: 0 }, erase };
    return { points: [point], radius, erase };
}

export function extendMaskMark(mark, from, to) {
    if (mark.circle) mark.circle.r = Math.hypot(to[0] - from[0], to[1] - from[1]);
    else if (mark.rect) mark.rect = { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]) };
    else mark.points.push(to);
}

export function maskBounds(marks, width, height) {
    let left = width, top = height, right = 0, bottom = 0;
    for (const mark of marks) {
        if (mark.erase) continue;
        if (mark.scale) {
            const [sx, sy] = mark.scale, bounds = maskBounds([{ ...mark, scale: null }], width / sx, height / sy);
            left = Math.min(left, bounds.left * sx); top = Math.min(top, bounds.top * sy);
            right = Math.max(right, bounds.right * sx); bottom = Math.max(bottom, bounds.bottom * sy);
            continue;
        }
        let points, radius = 0;
        if (mark.fill) {
            const b = mark.fill.bounds; points = [[b.x, b.y], [b.x + b.width, b.y + b.height]];
        } else if (mark.rect) points = [[mark.rect.x, mark.rect.y], [mark.rect.x + mark.rect.width, mark.rect.y + mark.rect.height]];
        else if (mark.circle) { points = [[mark.circle.cx, mark.circle.cy]]; radius = mark.circle.r; }
        else { points = mark.points; radius = mark.radius; }
        for (const [x, y] of points) {
            left = Math.min(left, x - radius); top = Math.min(top, y - radius);
            right = Math.max(right, x + radius); bottom = Math.max(bottom, y + radius);
        }
    }
    if (right <= left || bottom <= top) throw new Error("Select an area or paint a closed outline first.");
    return { left, top, right, bottom };
}

export function drawMaskMarks(ctx, marks) {
    ctx.fillStyle = "white";
    for (const mark of marks) {
        ctx.globalCompositeOperation = mark.erase ? "destination-out" : "source-over";
        maskPath(ctx, mark); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
}

// Scanline flood fill of an unmasked component. Reaching an edge means the
// outline is open; fail without modifying the mask instead of filling outside it.
export function floodSpans(rgba, width, height, x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= width || y >= height || rgba.length !== width * height * 4) throw new Error("Click inside a closed outline.");
    if (rgba[(y * width + x) * 4 + 3]) return [];
    const visited = new Uint8Array(width * height), stack = [y * width + x], spans = [];
    const free = (xx, yy) => !visited[yy * width + xx] && !rgba[(yy * width + xx) * 4 + 3];
    while (stack.length) {
        const at = stack.pop(), cy = Math.floor(at / width), cx = at % width;
        if (!free(cx, cy)) continue;
        let left = cx, right = cx;
        while (left > 0 && free(left - 1, cy)) left--;
        while (right + 1 < width && free(right + 1, cy)) right++;
        if (!left || right === width - 1 || !cy || cy === height - 1) throw new Error("The outline is open. Close it, then click inside to fill.");
        for (let xx = left; xx <= right; xx++) visited[cy * width + xx] = 1;
        spans.push([cy, left, right]);
        for (const yy of [cy - 1, cy + 1]) {
            let inRun = false;
            for (let xx = left; xx <= right; xx++) {
                const available = free(xx, yy);
                if (available && !inRun) stack.push(yy * width + xx);
                inRun = available;
            }
        }
    }
    return spans;
}

export function enclosedFill(marks, width, height, point) {
    const b = maskBounds(marks, width, height);
    const x = Math.max(0, Math.floor(b.left - 2)), y = Math.max(0, Math.floor(b.top - 2));
    const w = Math.min(width, Math.ceil(b.right + 2)) - x, h = Math.min(height, Math.ceil(b.bottom + 2)) - y;
    if (w * h > 16e6) throw new Error("Draw a smaller outline to fill (under 16 megapixels).");
    const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.translate(-x, -y); drawMaskMarks(ctx, marks);
    const spans = floodSpans(ctx.getImageData(0, 0, w, h).data, w, h, point[0] - x, point[1] - y);
    if (!spans.length) return null;
    let left = w, top = h, right = 0, bottom = 0;
    for (const [yy, a, z] of spans) { left = Math.min(left, a); right = Math.max(right, z); top = Math.min(top, yy); bottom = Math.max(bottom, yy); }
    return { fill: { x, y, spans, bounds: { x: x + left, y: y + top, width: right - left + 1, height: bottom - top + 1 } } };
}

export function maskSVGShape(mark) {
    if (mark.scale) {
        const [tag, props] = maskSVGShape({ ...mark, scale: null });
        return [tag, { ...props, transform: `scale(${mark.scale.join(" ")})` }];
    }
    if (mark.rect) return ["rect", mark.rect];
    if (mark.circle) return ["circle", mark.circle];
    if (mark.fill) return ["path", { d: mark.fill.spans.map(([y, a, z]) => `M${mark.fill.x + a} ${mark.fill.y + y}h${z - a + 1}v1h-${z - a + 1}z`).join("") }];
    if (mark.points.length === 1) return ["circle", { cx: mark.points[0][0], cy: mark.points[0][1], r: mark.radius }];
    return ["path", { d: mark.points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" "), "stroke-width": mark.radius * 2, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }];
}

// glyphCaption puts text, a caption (required: "Undo", "Redo"…), under
// button's glyph.
export function glyphCaption(button, text) {
    if (!text) throw new Error("A caption is needed.");
    button.classList.add("glyph-caption-button");
    button.append(el("small", { className: "glyph-caption", textContent: text, ariaHidden: "true" }));
    return button;
}

export function brushControls(paintButton, { prefix, sizeClass, selectionButton, onShape }) {
    const size = el("input", { type: "range", min: "1", max: "200", value: "30", className: sizeClass, ariaLabel: "Brush size in pixels" });
    const value = el("output", { textContent: "30 px" });
    size.addEventListener("input", () => { value.textContent = `${size.value} px`; });
    const panel = el("div", { className: `mask-brush-options ${prefix}-brush-options`, role: "dialog", ariaLabel: "Brush size" }, el("label", {}, "Brush size ", size, value));
    panel.setAttribute("popover", "auto");
    const makeArrow = (name, label, role) => {
        const button = el("button", { type: "button", className: `mask-size-toggle ${prefix}-${name}-toggle`, textContent: glyphs.chevronDown, title: label, ariaLabel: label });
        button.setAttribute("aria-haspopup", role); button.setAttribute("aria-expanded", "false");
        return button;
    };
    const arrow = makeArrow("size", "Brush size", "dialog");
    const shapeArrow = makeArrow("shape", "Selection shape", "menu");
    const shapePanel = el("div", { className: `mask-shape-options ${prefix}-shape-options`, role: "menu", ariaLabel: "Selection shape" });
    shapePanel.setAttribute("popover", "auto");
    let selected = "rectangle";
    const choices = [ ["rectangle", "Rectangle", "select-area"], ["circle", "Circle", "select-circle"] ].map(([key, title, icon]) => {
        const button = el("button", { type: "button", className: `glyph ${prefix}-shape-${key}`, role: "menuitemradio", title });
        button.innerHTML = iconSVG(icon);
        button.append(el("span", { textContent: title }));
        button.addEventListener("click", () => { shape.value = key; shapePanel.hidePopover(); onShape(key); });
        return { key, button };
    });
    shapePanel.append(...choices.map(({ button }) => button));
    const shape = {
        get value() { return selected; },
        set value(value) {
            selected = value === "circle" ? "circle" : "rectangle";
            for (const { key, button } of choices) button.setAttribute("aria-checked", String(key === selected));
            selectionButton.innerHTML = iconSVG(selected === "circle" ? "select-circle" : "select-area");
            selectionButton.title = selected === "circle" ? "Select area: Circle (drag from centre to edge)" : "Select area: Rectangle";
            selectionButton.setAttribute("aria-label", selectionButton.title);
        },
    };
    shape.value = "rectangle";
    const positionPanel = (popup, at) => {
        if (!popup.matches(":popover-open")) return;
        const rect = at.getBoundingClientRect(), box = popup.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
        popup.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
    };
    const position = () => { positionPanel(panel, arrow); positionPanel(shapePanel, shapeArrow); };
    for (const [popup, trigger] of [[panel, arrow], [shapePanel, shapeArrow]]) {
        trigger.addEventListener("click", () => {
            popup.togglePopover(); position();
            if (popup === shapePanel && popup.matches(":popover-open")) choices.find(({ key }) => key === selected).button.focus();
        });
        popup.addEventListener("toggle", event => trigger.setAttribute("aria-expanded", String(event.newState === "open")));
        popup.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.preventDefault(); popup.hidePopover(); trigger.focus(); }
            if (popup === shapePanel && ["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                const index = choices.findIndex(({ button }) => button === document.activeElement);
                choices[(index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length].button.focus();
            }
            event.stopPropagation();
        });
    }
    const group = el("span", { className: "mask-paint-group" }, paintButton, arrow, panel);
    const selectionGroup = el("span", { className: "mask-paint-group mask-selection-group" }, selectionButton, shapeArrow, shapePanel);
    window.addEventListener("resize", position);
    return { group, selectionGroup, shape, size, value, panel, shapePanel,
        update(disabled) {
            size.disabled = arrow.disabled = shapeArrow.disabled = disabled;
            for (const { button } of choices) button.disabled = disabled;
            if (disabled) { panel.hidePopover(); shapePanel.hidePopover(); }
        },
        close() { panel.hidePopover(); shapePanel.hidePopover(); },
        stop() { panel.hidePopover(); shapePanel.hidePopover(); window.removeEventListener("resize", position); panel.remove(); shapePanel.remove(); },
    };
}

// choiceMenu is a choice of one of choices ([{key, title, icon, className}])
// as the selection shape's is (see brushControls): a button showing the
// one chosen, and an arrow beside it, either opening a menu of them all.
// onChoose(key) is told of a choice made there.
export function choiceMenu({ className, label, choices, onChoose }) {
    const current = el("button", { type: "button", className: `glyph ${className}-current` });
    const arrow = el("button", { type: "button", className: `mask-size-toggle ${className}-toggle`, textContent: glyphs.chevronDown, title: label, ariaLabel: label });
    for (const trigger of [current, arrow]) { trigger.setAttribute("aria-haspopup", "menu"); trigger.setAttribute("aria-expanded", "false"); }
    const panel = el("div", { className: `mask-shape-options ${className}-options`, role: "menu", ariaLabel: label });
    panel.setAttribute("popover", "auto");
    let value = choices[0].key;
    const items = choices.map((choice) => {
        const button = el("button", { type: "button", className: `glyph ${choice.className}`, role: "menuitemradio", title: choice.title });
        button.innerHTML = iconSVG(choice.icon);
        button.append(el("span", { textContent: choice.title }));
        button.addEventListener("click", () => { panel.hidePopover(); onChoose(choice.key); });
        return { ...choice, button };
    });
    panel.append(...items.map(({ button }) => button));
    const position = () => {
        if (!panel.matches(":popover-open")) return;
        const rect = arrow.getBoundingClientRect(), box = panel.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - box.height - 8))}px`;
    };
    const enabled = () => items.filter(({ button }) => !button.disabled);
    for (const trigger of [current, arrow]) trigger.addEventListener("click", () => {
        panel.togglePopover(); position();
        if (panel.matches(":popover-open")) (items.find(({ key }) => key === value)?.button ?? enabled()[0]?.button)?.focus();
    });
    panel.addEventListener("toggle", (event) => { for (const trigger of [current, arrow]) trigger.setAttribute("aria-expanded", String(event.newState === "open")); });
    panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); panel.hidePopover(); arrow.focus(); }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            const on = enabled(), index = on.findIndex(({ button }) => button === document.activeElement);
            on[(index + (event.key === "ArrowDown" ? 1 : on.length - 1)) % on.length]?.button.focus();
        }
        event.stopPropagation();
    });
    window.addEventListener("resize", position);
    const group = el("span", { className: `mask-paint-group mask-choice-group ${className}-group` }, current, arrow, panel);
    return {
        group,
        get value() { return value; },
        // set shows key as the one chosen.
        set(key) {
            const chosen = items.find((item) => item.key === key);
            if (!chosen) return;
            value = key;
            for (const { key: k, button } of items) button.setAttribute("aria-checked", String(k === key));
            current.innerHTML = iconSVG(chosen.icon);
            current.title = `${label}: ${chosen.title}`;
            current.setAttribute("aria-label", current.title);
        },
        // item is a choice's button (to disable).
        item: (key) => items.find((it) => it.key === key)?.button ?? null,
        // retitle calls a choice title, in the menu, and on the button if
        // it's the one chosen.
        retitle(key, title) {
            const it = items.find((item) => item.key === key);
            if (!it || it.title === title) return;
            it.title = it.button.title = title;
            it.button.querySelector("span").textContent = title;
            if (value === key) this.set(key);
        },
        disable(disabled) { current.disabled = arrow.disabled = disabled; if (disabled) panel.hidePopover(); },
        close() { panel.hidePopover(); },
        stop() { panel.hidePopover(); window.removeEventListener("resize", position); panel.remove(); },
    };
}
