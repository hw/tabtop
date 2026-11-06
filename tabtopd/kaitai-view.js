import { binaryChunkSize } from "./preview-model.js";
import { el } from "./preview-dom.js";
import { formatCombobox } from "./format-combobox.js";
import { hexView } from "./hex-view.js";

const assets = new URL("./kaitai/", import.meta.url);
let catalog;
function formats() {
    catalog ??= fetch(new URL("formats.json", assets)).then(r => {
        if (!r.ok) throw new Error("Kaitai formats are unavailable on this server");
        return r.json();
    }).catch(err => { catalog = null; throw err; });
    return catalog;
}

export function parameterValues(parameters, inputs) {
    return parameters.map((p, i) => {
        const text = inputs[i].value.trim();
        if (p.type === "bool") return text === "true";
        if (/^[us][1248]$/.test(p.type)) {
            const n = Number(text), bits = Number(p.type.slice(1)) * 8, signed = p.type[0] === "s";
            if (!text || !Number.isSafeInteger(n) || n < (signed ? -(2 ** (bits - 1)) : 0) || n >= 2 ** (bits - Number(signed))) {
                throw new Error(`Enter a valid ${p.type} value for ${p.id}`);
            }
            return n;
        }
        if (p.type === "bytes_with_io") {
            if (!/^(?:[a-f\d]{2}\s*)*$/i.test(text)) throw new Error(`Enter hexadecimal byte pairs for ${p.id}`);
            return { bytes: (text.match(/[a-f\d]{2}/ig) ?? []).map(b => parseInt(b, 16)) };
        }
        return text;
    });
}

export function kaitaiView(bytes, { signal, size = bytes.length, readRange = null } = {}) {
    const hex = hexView(bytes, { size, readRange });
    const combo = formatCombobox(entry => { selected = entry?.id ?? ""; choose(); });
    const message = el("p", { className: "hint kaitai-status", role: "status", textContent: "Loading binary formats…" });
    const requiredBytes = el("button", { type: "button", className: "kaitai-required-bytes", hidden: true });
    const diagnosticText = el("pre");
    const diagnostics = el("details", { className: "kaitai-diagnostics", hidden: true },
        el("summary", { textContent: "Decoder details" }), diagnosticText);
    const fieldDetails = el("section", { className: "kaitai-field-details", ariaLabel: "Field details", hidden: true });
    const tree = el("div", { className: "kaitai-tree", ariaLabel: "Decoded structure" });
    const params = el("form", { className: "kaitai-params", hidden: true });
    const structure = el("section", { className: "kaitai-structure", hidden: true }, message, requiredBytes, diagnostics, params, fieldDetails, tree);
    const root = el("div", { className: "kaitai-view" },
        el("div", { className: "kaitai-controls" }, el("label", { htmlFor: combo.input.id, textContent: "Interpret as" }), combo.element, el("span", { className: "hint", textContent: "Kaitai: first 1 MB" })),
        el("div", { className: "kaitai-panes" }, structure, hex));
    let entries = [], worker = null, serial = 0, stopped = false, selected = "", selectedField = null, requiredOffset = null;
    const showStatus = state => {
        message.dataset.state = state.kind;
        message.className = `${["format-mismatch", "truncated", "error"].includes(state.kind) ? "error" : "hint"} kaitai-status`;
        message.textContent = `${state.title ? `${state.title}. ` : ""}${state.message}${state.path ? ` Field: ${state.path}` : ""}`;
        diagnostics.hidden = !state.details;
        diagnosticText.textContent = state.details ?? "";
        requiredOffset = Number.isSafeInteger(state.offset) && state.offset >= 0 && state.offset < size ? state.offset : null;
        requiredBytes.hidden = requiredOffset === null;
        requiredBytes.textContent = requiredOffset === null ? "" : `Jump to required bytes at 0x${requiredOffset.toString(16)}`;
        if (state.length != null) diagnosticText.textContent += `\nMissing bytes: ${state.length.toLocaleString()}`;
    };
    requiredBytes.addEventListener("click", () => { if (requiredOffset !== null) hex.jump?.(requiredOffset); });
    const showField = item => {
        selectedField = item.id;
        fieldDetails.hidden = false;
        fieldDetails.dataset.path = item.path;
        const dl = el("dl");
        const state = { lazy: "Not decoded yet", decoded: "Decoded", incomplete: "Partially decoded", "not-decoded": "Not decoded or not present" };
        const properties = [
            ["Path", item.path], ["Type", item.type], ["Value", item.value], ["Hex value", item.numericHex],
            ["Enum", item.enumName ? `${item.enumName}${item.enumValue ? ` · ${item.enumValue}` : ""}` : ""],
            ["Byte order", item.byteOrder],
            ["Offset", item.range ? `0x${item.range.begin.toString(16)} (${item.range.begin.toLocaleString()})` : item.decoded ? "Decoded data; no original file offset" : "Not available"],
            ["Length", item.range ? `${(item.range.end - item.range.begin).toLocaleString()} ${item.range.end - item.range.begin === 1 ? "byte" : "bytes"}` : "Not available"],
            ["State", state[item.state] ?? item.state],
        ];
        for (const [key, value] of properties) {
            if (!value) continue;
            const cell = el("dd", { textContent: value }); cell.dataset.detail = key;
            dl.append(el("dt", { textContent: key }), cell);
        }
        fieldDetails.replaceChildren(el("strong", { textContent: "Field details" }), dl,
            ...(item.doc ? [el("p", { className: "kaitai-field-doc", textContent: item.doc })] : []));
    };
    const pending = new Map();
    const stopWorker = () => {
        worker?.terminate(); worker = null;
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new DOMException("Decoding cancelled", "AbortError")); }
        pending.clear();
    };
    const stop = () => { stopped = true; combo.stop(); hex.stop?.(); stopWorker(); signal?.removeEventListener("abort", stop); };
    root.stop = stop;
    signal?.addEventListener("abort", stop, { once: true });
    const ask = (type, args = {}, transfer = []) => new Promise((resolve, reject) => {
        const request = ++serial;
        const timer = setTimeout(() => {
            stopWorker();
            if (!stopped) showStatus({ kind: "timeout", title: "Decode timed out", message: "Previously decoded fields and raw hex remain available. Choose another format to try again." });
        }, 3000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, type, ...args }, transfer);
    });
    const showError = err => {
        if (!stopped && err.name !== "AbortError") showStatus(err.decodeStatus ?? { kind: "error", title: "Decoder error", message: err.message });
    };
    const appendRows = (parent, reply, nodeId) => {
        for (const item of reply.children) {
            const children = el("div", { className: "kaitai-children", hidden: true });
            const value = el("span", { className: "kaitai-value", textContent: item.value });
            const toggle = el("button", { type: "button", className: "kaitai-toggle", textContent: item.expandable ? "▸" : "·",
                disabled: !item.expandable, ariaLabel: `Expand ${item.label}`, ariaExpanded: "false" });
            const jump = el("button", { type: "button", className: "kaitai-jump", textContent: item.label,
                title: item.doc || item.path, ariaLabel: `Inspect ${item.path}` });
            const fieldType = el("span", { className: "hint kaitai-type", textContent: item.type });
            const location = el("span", { className: "hint kaitai-offset", textContent: "" });
            let current = item, loaded = false;
            const update = () => {
                fieldType.textContent = current.type;
                if (selectedField === current.id) showField(current);
                location.textContent = current.range ? `0x${current.range.begin.toString(16)} · ${current.range.end - current.range.begin} bytes` : current.decoded ? "Decoded data" : "";
            };
            update();
            jump.addEventListener("click", () => { showField(current); if (current.range) hex.jump?.(current.range.begin, current.range.end); });
            toggle.addEventListener("click", async () => {
                if (!children.hidden) { children.hidden = true; toggle.textContent = "▸"; toggle.ariaExpanded = "false"; return; }
                children.hidden = false; toggle.textContent = "▾"; toggle.ariaExpanded = "true";
                if (loaded) return;
                toggle.disabled = true;
                try {
                    const expanded = await ask("expand", { id: item.id });
                    if (stopped) return;
                    current = { ...current, ...expanded.node }; value.textContent = current.value; update();
                    appendRows(children, expanded, item.id); loaded = true;
                    if (expanded.status) showStatus(expanded.status);
                } catch (err) {
                    if (err.node) { current = { ...current, ...err.node }; value.textContent = current.value; update(); }
                    children.textContent = err.decodeStatus?.message ?? err.message; showError(err);
                }
                finally { toggle.disabled = !current.expandable; }
            });
            parent.append(el("div", { className: "kaitai-node" }, el("div", { className: "kaitai-row" }, toggle, jump, fieldType, value, location), children));
        }
        if (reply.more) {
            const more = el("button", { type: "button", textContent: "Show next 100 fields" });
            more.addEventListener("click", async () => {
                more.disabled = true;
                try { const next = await ask("expand", { id: nodeId, start: reply.next }); more.remove(); appendRows(parent, next, nodeId); if (next.status) showStatus(next.status); }
                catch (err) { showError(err); more.disabled = false; }
            });
            parent.append(more);
        }
    };
    const decode = async (entry, inputs) => {
        stopWorker(); tree.replaceChildren(); fieldDetails.hidden = true; selectedField = null;
        try {
            const values = parameterValues(entry.params, inputs);
            showStatus({ kind: "loading", title: "", message: `Decoding as ${entry.title}…` });
            worker = new Worker(new URL("./kaitai-worker.js", import.meta.url), { type: "module" });
            worker.onmessage = ({ data }) => {
                const p = pending.get(data.request);
                if (!p) return;
                clearTimeout(p.timer); pending.delete(data.request);
                data.error ? p.reject(Object.assign(new Error(data.error), { decodeStatus: data.status, node: data.node })) : p.resolve(data);
            };
            worker.onerror = () => { stopWorker(); showStatus({ kind: "error", title: "Decoder failed", message: "Previously decoded fields and raw hex remain available." }); };
            const copy = bytes.slice(0, binaryChunkSize).buffer;
            const reply = await ask("parse", { bytes: copy, module: new URL(entry.module, assets).href,
                schemas: new URL("schemas.json", assets).href, format: entry.id, size, params: values }, [copy]);
            if (stopped) return;
            showStatus(reply.status);
            appendRows(tree, reply, reply.node.id);
        } catch (err) { showError(err); }
    };
    const choose = () => {
        stopWorker(); tree.replaceChildren(); params.replaceChildren(); params.hidden = fieldDetails.hidden = true; selectedField = null;
        const entry = entries.find(f => f.id === selected);
        structure.hidden = !entry;
        if (!entry) return;
        if (!entry.params.length) { decode(entry, []); return; }
        showStatus({ kind: "parameters", title: "Parameters required", message: "Enter this format's parameters before decoding." });
        const inputs = entry.params.map(p => {
            const input = p.type === "bool" ? el("select", {}, el("option", { value: "false", textContent: "False" }), el("option", { value: "true", textContent: "True" }))
                : el("input", { type: "text", required: p.type !== "bytes_with_io", placeholder: p.type === "bytes_with_io" ? "Hexadecimal byte pairs" : p.type });
            params.append(el("label", { title: p.doc ?? "" }, p.id.replaceAll("_", " "), input));
            return input;
        });
        params.append(el("button", { type: "submit", textContent: "Decode" }));
        params.onsubmit = e => { e.preventDefault(); decode(entry, inputs); };
        params.hidden = false;
    };
    formats().then(data => {
        if (stopped) return;
        entries = data.formats;
        combo.setFormats(entries);
        message.textContent = `${entries.length} binary formats available.`;
    }).catch(err => {
        if (!stopped) { structure.hidden = false; showError(err); }
    });
    return root;
}
