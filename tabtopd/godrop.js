// Files dropped on an embedded page (gouploads.go: the engine's own drag
// can't be aimed into a frame), in that page's own world: the server puts
// them in a hidden input of the agent's making (DOM.setFileInputFiles), and
// the agent says which, and where they were dropped ("__tabtop_drop": its
// id, as text: an object in an event's detail isn't passed between the
// worlds, the input in the document both share is). Here they're given as
// a browser gives a drop of files: dragenter, dragover and drop, a
// DataTransfer of them all (its files, and an item each), at that place.
(() => {
    document.addEventListener("__tabtop_drop", (e) => {
        let d;
        try { d = JSON.parse(e.detail); } catch { return; }
        const input = typeof d?.input === "string" ? document.getElementById(d.input) : null;
        if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
        const files = [...(input.files ?? [])];
        input.remove();
        if (!files.length) return;
        const x = Number(d.x) || 0, y = Number(d.y) || 0;
        // (Told on the element dropped on: where the person dropped them in
        // the copy, as the engine's layout may not have it.)
        const on = e.composedPath?.()[0] ?? e.target;
        const target = on instanceof Element ? on : document.body ?? document.documentElement;
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        dt.effectAllowed = "all";
        const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, dataTransfer: dt,
            shiftKey: !!d.shift, ctrlKey: !!d.ctrl, altKey: !!d.alt, metaKey: !!d.meta };
        // Dropped only where the page said it would take it (its
        // dragover's default prevented), as in a browser; else left.
        target.dispatchEvent(new DragEvent("dragenter", init));
        const taken = !target.dispatchEvent(new DragEvent("dragover", init));
        target.dispatchEvent(new DragEvent(taken ? "drop" : "dragleave", init));
        if (taken) e.preventDefault();  // (the agent's told it was taken)
    });
})();
