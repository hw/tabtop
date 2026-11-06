// Registration is shared by downloads and media, but their scopes and
// controller requirements differ. Browser APIs and clocks are injectable so
// lifecycle tests import this module without modifying its source.
export const STREAM_WORKER_VERSION = 8;
const scriptURL = new URL(`./download-sw.js?v=${STREAM_WORKER_VERSION}`, import.meta.url);

export function createWorkerRegistration({ scope, requireController = false, serviceWorker,
    now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeout = 5000 }) {
    let pending = null;
    return function getWorker() {
        pending ??= (async () => {
            try {
                const api = serviceWorker ?? globalThis.navigator?.serviceWorker;
                if (!api) return null;
                const reg = await api.register(scriptURL, { scope: typeof scope === "function" ? scope() : scope });
                const ready = () => reg.active && !reg.installing && !reg.waiting &&
                    (!requireController || api.controller === reg.active);
                const end = now() + timeout;
                while (!ready() && now() < end) await delay(50);
                return ready() ? reg.active : null;
            } catch {
                return null;
            }
        })();
        const attempt = pending;
        return attempt.then((worker) => {
            // A timed-out activation or temporary error can succeed next time.
            if (!worker && pending === attempt) pending = null;
            return worker;
        });
    };
}

export const streamWorker = createWorkerRegistration({ scope: new URL("./stream/", import.meta.url).pathname });
export const mediaWorker = createWorkerRegistration({ scope: () => new URL("./", location.href).pathname, requireController: true });
