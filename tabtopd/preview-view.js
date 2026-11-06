/**
 * @typedef {object} PreviewView
 * @property {HTMLElement} element The DOM mounted by the preview controller.
 * @property {() => void} stop Releases listeners, streams and other resources.
 * @property {(location: object) => void} [restore] Restores a reading position.
 * @property {(html: string) => void} [update] Updates an editable rendered view.
 */

/** Adapt format renderers to one controller-owned, idempotent lifecycle. */
export function previewView(element) {
    let stopped = false;
    const view = { element, stop() {
        if (stopped) return;
        stopped = true;
        element.stop?.();
    } };
    if (element.restore) view.restore = (location) => { if (!stopped) element.restore(location); };
    if (element.update) view.update = (html) => { if (!stopped) element.update(html); };
    return view;
}
