// The clients of the workers a page asks: one ask at a time of one kept
// (OneAtATime: the image editor's AI tools), or an ask of one made for it
// alone (oneShot: a comparison's).

// OneAtATime is a worker asked one thing at a time: made (by make) as it's
// first asked, and kept between asks (its model loaded once); ended, to be
// made again at the next ask, when an ask fails, is cancelled, or isn't
// answered within timeout (ended() is told). what words its failures:
// {busy, tooLong, failed (before the worker's own error), couldntLoad,
// unreadable, cancelled}.
export class OneAtATime {
    worker = null;
    pending = null;

    constructor(make, timeout, what, ended = () => {}) {
        this.make = make;
        this.timeout = timeout;
        this.what = what;
        this.ended = ended;
    }

    // ask posts message (transferring transfer) and is settled by the
    // worker's answer, refused if check says what's wrong with it.
    ask(message, transfer = [], check = () => "") {
        if (this.pending) return Promise.reject(new Error(this.what.busy));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, timer: setTimeout(() => this.cancel(this.what.tooLong), this.timeout) };
            try {
                this.worker ??= this.make();
                this.worker.onmessage = ({ data }) => {
                    if (data.error) {
                        this.cancel(`${this.what.failed}: ${data.error}`);
                        return;
                    }
                    const problem = check(data);
                    if (problem) {
                        this.cancel(problem);
                        return;
                    }
                    const pending = this.pending;
                    this.pending = null;
                    clearTimeout(pending.timer);
                    pending.resolve(data);
                };
                this.worker.onerror = (event) => {
                    event.preventDefault();
                    this.cancel(this.what.couldntLoad);
                };
                this.worker.onmessageerror = () => this.cancel(this.what.unreadable);
                this.worker.postMessage(message, transfer);
            } catch (err) {
                this.cancel(err.message);
            }
        });
    }

    // cancel ends the worker, and the ask waiting, if there is one, with
    // message.
    cancel(message = this.what.cancelled) {
        this.worker?.terminate();
        this.worker = null;
        this.ended();
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(new Error(message));
            this.pending = null;
        }
    }
}

// ByID is a worker asked many things at once, each answer matched to its
// ask by its id (in the message's key field), made (by make) as it's
// first asked and kept. It's ended, every ask waiting refused, as it fails
// to load (loadFailed()'s error) or one isn't answered within timeout (0
// for none; timedOut()'s error); asked again, it's made again. An answer
// that says it failed is failed(data)'s error; one that didn't,
// answered(data).
export class ByID {
    worker = null;
    next = 0;
    waiting = new Map();  // id -> {resolve, reject, timer}

    constructor(make, { key = "id", timeout = 0, failed = (data) => new Error(data.error), answered = (data) => data,
        timedOut = () => new Error("It took too long."), loadFailed = () => new Error("It couldn't be loaded.") } = {}) {
        Object.assign(this, { make, key, timeout, failed, answered, timedOut, loadFailed });
    }

    ask(message, transfer = []) {
        if (!this.worker) {
            this.worker = this.make();
            this.worker.onmessage = ({ data }) => {
                const w = this.waiting.get(data[this.key]);
                if (!w) return;
                this.waiting.delete(data[this.key]);
                clearTimeout(w.timer);
                if (data.error) w.reject(this.failed(data));
                else w.resolve(this.answered(data));
            };
            this.worker.onerror = (event) => {
                event.preventDefault?.();
                this.stop(this.loadFailed());
            };
        }
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            const timer = this.timeout ? setTimeout(() => this.stop(this.timedOut()), this.timeout) : 0;
            this.waiting.set(id, { resolve, reject, timer });
            this.worker.postMessage({ ...message, [this.key]: id }, transfer);
        });
    }

    // stop ends the worker, the asks waiting refused with error.
    stop(error = new Error("Stopped.")) {
        this.worker?.terminate();
        this.worker = null;
        for (const { reject, timer } of this.waiting.values()) {
            clearTimeout(timer);
            reject(error);
        }
        this.waiting.clear();
    }
}

// oneShot asks a worker made (by make) for this alone, and ends it as it's
// answered (its result), fails, is aborted (signal), or isn't answered
// within timeout (tooLong); couldntStart words its failing to load. What
// comes with a failure, or after it's settled, is given to discard (to
// close what it holds).
export function oneShot(make, message, transfer, signal, { timeout, tooLong, couldntStart, discard = () => {} }) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const worker = make();
        let settled = false;
        const finish = (err, result) => {
            if (settled) {
                if (result !== undefined) discard(result);
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            worker.terminate();
            if (err) {
                if (result !== undefined) discard(result);
                reject(err);
            } else resolve(result);
        };
        const cancel = () => finish(signal.reason);
        const timer = setTimeout(() => finish(new Error(tooLong)), timeout);
        signal.addEventListener("abort", cancel, { once: true });
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
        worker.onerror = (event) => {
            event.preventDefault();
            finish(new Error(couldntStart));
        };
        try {
            worker.postMessage(message, transfer);
        } catch (err) {
            finish(err);
        }
    });
}
