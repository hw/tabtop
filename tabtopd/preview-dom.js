export function el(tag, props = {}, ...children) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...children);
    return e;
}

export const join = (dir, name) => (dir ? `${dir}/${name}` : name);

// copyText puts text on the clipboard: with the clipboard API where the
// browser has it (over HTTPS or on localhost) and allows it, else the old
// way, from a box made for it (in the dialog on top, if one is open,
// as what's under it can't be selected). It rejects if neither copied it.
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // No clipboard API here, or not allowed.
    }
    const area = el("textarea", { value: text, readOnly: true });
    Object.assign(area.style, { position: "fixed", opacity: "0" });
    ([...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body).append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) {
        throw new Error("not copied");
    }
}
