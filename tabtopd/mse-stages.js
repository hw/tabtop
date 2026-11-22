// The server's staging sessions of buffered streams (go.js: a stream's
// capture, mse-capture.js, spilled to one as it plays): one a stream,
// opened as its first piece is spilled (open: a session's), let go as the
// capture begins again (abort).
//
// An opening's noted before it's awaited: spills meanwhile wait for it
// (one session, not two), and a capture begun again meanwhile has it let
// go as it opens, its spill failing (the old generation's: ignored), not
// left for the new generation's pieces to go into.
export function mseStageKeeper(open) {
    const stages = new WeakMap(); // stream -> stage session, or {opening, aborted}
    function ensure(stream) {
        const had = stages.get(stream);
        if (had?.opening) return had.opening;
        if (had && !had.closed) return Promise.resolve(had);
        const pending = { aborted: false };
        pending.opening = open().then((stage) => {
            if (pending.aborted || stages.get(stream) !== pending) {
                stage.abort();
                throw new Error("buffered stream was restarted");
            }
            stages.set(stream, stage);
            return stage;
        }, (err) => {
            if (stages.get(stream) === pending) stages.delete(stream);
            throw err;
        });
        stages.set(stream, pending);
        return pending.opening;
    }
    function abort(stream) {
        const had = stages.get(stream);
        if (!had) return;
        stages.delete(stream);
        if (had.opening) had.aborted = true;
        else had.abort();
    }
    // get is the stream's session, if one's open (not opening).
    const get = (stream) => {
        const had = stages.get(stream);
        return had?.opening ? undefined : had;
    };
    // forget lets the stream's session go from here (the save's now).
    const forget = (stream) => {
        if (get(stream)) stages.delete(stream);
    };
    return { ensure, abort, get, forget };
}
