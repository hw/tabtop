// One transfer attempt, independent of DOM presentation and wire protocol.
// Resources registered with own are released once, on cancellation or finish.
// Retry starts a fresh attempt; cancelled transfers never offer a retry.
export async function runTransfer({ signal, run, progress = () => {}, retry }) {
    const releases = [];
    const release = () => {
        for (const close of releases.splice(0).reverse()) {
            try { close(); } catch { /* Cleanup must not hide the result. */ }
        }
    };
    const own = (close) => {
        if (signal.aborted) {
            close();
            signal.throwIfAborted();
        }
        releases.push(close);
    };
    signal.addEventListener("abort", release);
    try {
        signal.throwIfAborted();
        const value = await run({ signal, own, progress: (...args) => {
            if (!signal.aborted) { progress(...args); }
        } });
        signal.throwIfAborted();
        return { state: "succeeded", value };
    } catch (error) {
        return signal.aborted ? { state: "cancelled" } : { state: "failed", error, retry };
    } finally {
        signal.removeEventListener("abort", release);
        release();
    }
}
