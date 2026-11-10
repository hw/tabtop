// Chrome protocol and page interaction helpers shared by all feature groups.
import { existsSync } from "node:fs";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createBrowserHarness({ port, base }) {
    // The DevTools protocol, on the browser's first page.
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("can't reach Chrome's DevTools"));
    });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        } else if (m.method === "Page.javascriptDialogOpening") {
            // Leaving the desktop asks first.
            cdp("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});  // gone already
        } else if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") {
            // With CHECK_LOG set, the pages' console and Chrome's own messages
            // (as why it refused a download) go to stderr.
            const e = m.params.entry ?? { level: m.params.type, text: m.params.args.map((a) => a.value ?? a.description).join(" ") };
            if (process.env.CHECK_LOG) {
                console.error(`[${e.level}] ${e.text}`);
            }
        } else if (m.method === "Runtime.exceptionThrown") {
            const d = m.params.exceptionDetails;
            exceptions.push(`${d.exception?.description ?? d.text} (${d.url ?? "?"}:${d.lineNumber})`);
        }
    };
    // cdp sends Chrome method, to the page, or with sessionId, to a target
    // attached to (as a frame in a process of its own).
    const cdp = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => reject(new Error(`${method}: no answer from Chrome`)), 30000);
        pending.set(n, (m) => {
            clearTimeout(timer);
            m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
        });
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const ev = async (expr) => {
        const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) {
            throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        }
        return r.result.value;
    };
    async function waitFor(expr, what, ms = 30000) {
        for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
            // A navigation can have created its context before its document root.
            if (await ev(`!!document.documentElement && (${expr})`)) {
                return;
            }
        }
        // What the transfers panel says, if there's one, often says why.
        const panel = await ev(`document.getElementById("uploads")?.innerText.replaceAll("\\n", " | ") ?? ""`).catch(() => "");
        throw new Error(`timed out waiting for ${what}${panel ? ` (transfers: ${panel})` : ""}`);
    }
    async function click(expr) {
        const r = await ev(`(() => { const b = (${expr}).getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
        }
    }
    // press sends a key, as the keyboard does, to the focused element.
    const keyCodes = { ArrowLeft: 37, ArrowRight: 39, ArrowDown: 40, ArrowUp: 38, Enter: 13, Backspace: 8, Escape: 27, " ": 32, "=": 187, "0": 48, f: 70 };
    async function press(key, modifiers = 0) {
        const code = { " ": "Space", "=": "Equal", "0": "Digit0", f: "KeyF" }[key] ?? key;
        const text = key === "Enter" ? "\r" : key.length === 1 && !modifiers ? key : undefined;
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCodes[key], modifiers, ...(text ? { text } : {}) });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCodes[key], modifiers });
    }
    // type types text a key at a time: the terminal reads key events, not
    // text input.
    async function type(text) {
        for (const ch of text) {
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
    }
    async function open(path, ready, what) {
        const marker = `navigation-${Date.now()}-${Math.random()}`;
        await ev(`window.__browserCheckNavigation = ${JSON.stringify(marker)}`);
        const navigation = await cdp("Page.navigate", { url: base + path });
        const documentReady = navigation.loaderId ? `window.__browserCheckNavigation !== ${JSON.stringify(marker)}` : "true";
        await waitFor(`(${documentReady}) && (${ready})`, what);
        await ev(`delete window.__browserCheckNavigation`);
    }
    // newTab opens url in another tab, with what a step needs to use it: its
    // own ev, waitFor, click and type, and close.
    async function newTab(url) {
        const { targetId } = await cdp("Target.createTarget", { url });
        const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.id === targetId);
        const tws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((resolve) => (tws.onopen = resolve));
        let n = 0;
        const waiting = new Map();
        tws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            waiting.get(m.id)?.(m);
            waiting.delete(m.id);
        };
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const i = ++n;
            waiting.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
            tws.send(JSON.stringify({ id: i, method, params }));
        });
        const tev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
        return {
            ev: tev,
            async waitFor(expr, what, ms = 30000) {
                for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
                    if (await tev(expr).catch(() => false)) {
                        return;
                    }
                }
                throw new Error(`timed out waiting for ${what}`);
            },
            async click(expr) {
                const r = await tev(`(() => { const b = (${expr}).getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`);
                for (const type of ["mousePressed", "mouseReleased"]) {
                    await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 });
                }
            },
            async type(text) {
                for (const ch of text) {
                    const enter = ch === "\r" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 } : { key: ch };
                    await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: ch, unmodifiedText: ch });
                    await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
                }
            },
            async close() {
                tws.close();
                await cdp("Target.closeTarget", { targetId }).catch(() => {});
            },
        };
    }
    const listed = `[...document.querySelectorAll("td.name a")].map((a) => a.textContent)`;
    const row = (name) => `[...document.querySelectorAll("tr")].find((tr) => tr.querySelector("td.name a")?.textContent === ${JSON.stringify(name)})`;
    // answer chooses the primary button of the page's dialog, after typing
    // text into it if given.
    async function answer(text) {
        // The topmost dialog: a question asked over the preview, say.
        const top = `[...document.querySelectorAll("dialog[open]")].at(-1)`;
        await waitFor(`!!${top}`, "the dialog");
        if (text !== undefined) {
            await ev(`(() => { const i = ${top}.querySelector("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); })()`);
        }
        await ev(`${top}.querySelector("button.primary").click()`);
    }
    async function waitForFile(p, what) {
        for (const end = Date.now() + 30000; Date.now() < end; await sleep(200)) {
            if (existsSync(p)) {
                return;
            }
        }
        throw new Error(`timed out waiting for ${what}`);
    }
    const status = `(document.getElementById("uploads")?.textContent || "")`;
    async function setFiles(selector, files) {
        for (let attempt = 0; ; attempt++) {
            const doc = await cdp("DOM.getDocument", {});
            const input = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
            if (!input.nodeId) throw new Error(`no ${selector}`);
            try {
                await cdp("DOM.setFileInputFiles", { files, nodeId: input.nodeId });
                return;
            } catch (err) {
                if (attempt >= 2 || !err.message.includes("Could not find node")) throw err;
                await sleep(50);
            }
        }
    }
    const inMarkdownFrame = (expr) => inFrame("md-frame.html", expr);
    const inFrame = async (page, expr) => {
        const { targetInfos } = await cdp("Target.getTargets");
        const target = targetInfos.find((t) => t.type === "iframe" && t.url.includes(page));
        if (!target) {
            throw new Error(`no ${page} frame`);
        }
        const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        try {
            const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
            if (r.exceptionDetails) {
                throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
            }
            return r.result.value;
        } finally {
            await cdp("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
    };
    const checkPreviewLink = async (framePage, linkClick, url) => {
        const prompt = 'document.querySelector("dialog.preview-link[open]")';
        const before = (await cdp("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
        await inFrame(framePage, linkClick);
        await waitFor(`!!${prompt}`, "the external link prompt");
        if ((await ev(`${prompt}.querySelector(".link-url").textContent`)) !== url) throw new Error("the prompt shows the wrong URL");
        const after = (await cdp("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
        if (after !== before) throw new Error("a preview link opened before confirmation");
        await cdp("Browser.grantPermissions", { origin: new URL(base).origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
        await cdp("Page.bringToFront");
        await click(`[...${prompt}.querySelectorAll("button")].find((b) => b.textContent === "Copy URL")`);
        await waitFor(`${prompt}?.querySelector('[role="status"]').textContent === "URL copied"`, "the URL copied");
        if ((await ev(`navigator.clipboard.readText()`)) !== url) throw new Error("the copied URL differs from the link");
        await press("Escape");
        try {
            await waitFor(`!${prompt} && !!document.querySelector("dialog.preview[open]")`, "only the link prompt closed", 5000);
        } catch (err) {
            throw new Error(`${err.message}: ${JSON.stringify(await ev(`({ dialogs: [...document.querySelectorAll("dialog")].map((d) => ({className: d.className, open: d.open})), focused: document.activeElement?.outerHTML.slice(0, 200) })`))}`);
        }
        // Middle-click also asks. Confirm without fetching an external site.
        await inFrame(framePage, linkClick.replace('.click()', '.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }))'));
        await waitFor(`!!${prompt}`, "the middle-click prompt");
        await ev(`window.previewRealOpen = window.open; window.previewOpened = null; window.open = (...args) => { window.previewOpened = args; };`);
        try {
            await ev(`[...${prompt}.querySelectorAll("button")].find((b) => b.textContent === "Open in browser").click()`);
            const opened = await ev(`window.previewOpened`);
            if (JSON.stringify(opened) !== JSON.stringify([url, "_blank", "noopener,noreferrer"])) throw new Error(`external open: ${JSON.stringify(opened)}`);
            await waitFor(`!${prompt}`, "the confirmed prompt closed");
        } finally {
            await ev(`window.open = window.previewRealOpen; delete window.previewRealOpen; delete window.previewOpened;`);
        }
    };
    return { cdp, ev, waitFor, click, press, type, open, newTab, listed, row, answer, waitForFile, status, setFiles, inFrame, inMarkdownFrame, checkPreviewLink, exceptions, close: () => ws.close() };
}
