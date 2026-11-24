// The browser acting as the viewer owns every CDM object. Handles are local
// to one remote document. Only transient, non-identifying sessions can use
// this shared viewer origin.
//
// A Clear Key stream's keys (its page's license answers with them, here in
// the open) are given onKeys as they become usable, for the element they're
// attached to: its stream's capture spills them, and is saved decrypted
// (mse-capture.js, gostreammse.go). Another key system's aren't: its CDM
// keeps them, and nothing is taken from it.
export function encryptedMedia(reply, allowed, onKeys = null) {
    const accesses = new Map(), keys = new Map(), sessions = new Map(), elements = new Map();
    const active = new Map();
    let stopped = false, tail = Promise.resolve(), pending = 0;
    const invalid = () => new DOMException("Invalid media key handle", "InvalidStateError");
    const unsupported = () => new DOMException("This key system configuration is unavailable", "NotSupportedError");
    // A Clear Key stream's keys, as they come: an access's, a keys' and a
    // session's key system; a keys' key IDs and keys (hex, the key IDs');
    // a session's key IDs its CDM says are usable.
    const accessSystems = new Map(), keySystems = new Map(), keyData = new Map(), sessionUsable = new Map();
    function send(message, node = 0) {
        if (!stopped) reply(message, node);
    }
    function bytes(data) {
        if (typeof data !== "string" || data.length > 43692) throw new RangeError("EME message too large");
        return Uint8Array.from(atob(data), c => c.charCodeAt(0));
    }
    function encode(buffer) {
        if (!buffer || buffer.byteLength > 32768) throw new RangeError("EME message too large");
        return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    }
    function hex(bytes) {
        return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    function b64urlDecode(s) {
        return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
    }
    // clearKey takes a Clear Key license's keys (`{keys: [{kty: "oct", kid,
    // k}]}`, its key ID and key base64url) into the keys' keyData.
    function clearKey(handle, data) {
        if (keySystems.get(handle) !== "org.w3.clearkey") return;
        const known = keyData.get(handle);
        if (!known) return;
        let parsed;
        try { parsed = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
        if (!Array.isArray(parsed?.keys)) return;
        for (const k of parsed.keys.slice(0, 16)) {
            if (k?.kty !== "oct" || typeof k.kid !== "string" || typeof k.k !== "string" ||
                k.kid.length > 64 || k.k.length > 64 || k.kid === "" || k.k === "") continue;
            try {
                const kid = hex(b64urlDecode(k.kid)), key = hex(b64urlDecode(k.k));
                if (kid.length === 32 && (key.length === 32 || key.length === 64)) known.set(kid, key);
            } catch { /* not base64url */ }
        }
    }
    // noteKeys tells onKeys, for each element the keys are attached to,
    // those of its key IDs its CDM says are usable ({}, its keys coming,
    // says only that the stream may expect them).
    function noteKeys(handle) {
        if (stopped || !onKeys) return;
        const known = keyData.get(handle);
        if (!known) return;
        const usable = new Set();
        for (const [session, of] of keysOfSessions) if (of === handle) {
            for (const kid of sessionUsable.get(session) ?? []) usable.add(kid);
        }
        const coming = {};
        let n = 0;
        for (const [kid, key] of known) if (usable.has(kid) && n < 16) { coming[kid] = key; n++; }
        for (const [node, of] of keysAttached) if (of === handle) onKeys(node, coming);
    }
    function lookup(map, id) {
        if (!map.has(id)) throw invalid();
        return map.get(id);
    }
    function reserve(map, id) {
        if (map.size >= 32 || !Number.isSafeInteger(id) || id <= 0 || map.has(id)) throw invalid();
    }
    // admit makes room in a map of handles for id: its oldest that may go
    // (keep says which mustn't) goes, if it's full (returned). A page probing formats
    // (decodingInfo, each answer an access) and making keys episode after
    // episode would otherwise run out, its later requests all refused.
    function admit(map, id, keep = () => false) {
        if (!Number.isSafeInteger(id) || id <= 0 || map.has(id)) throw invalid();
        if (map.size < 32) return;
        for (const old of map.keys()) {
            if (!keep(old)) {
                map.delete(old);
                return old;
            }
        }
        throw invalid();
    }
    // Keys in use: attached to a player, or a live session's.
    const keysOfSessions = new Map();  // session -> its keys' handle
    const keysAttached = new Map();    // node -> its keys' handle
    const keysInUse = (id) => [...keysAttached.values(), ...keysOfSessions.values()].includes(id);
    function listen(element, node) {
        if (!node) return;
        element.addEventListener("encrypted", e => {
            if (e.initData) send({ event: "encrypted", type: e.initDataType, data: encode(e.initData) }, node);
        });
    }
    function player(node, kind) {
        const existing = elements.get(node);
        if (existing) return existing;
        const el = document.createElement(kind);
        listen(el, node);
        return el;
    }
    function opened(node, element) {
        if (node) active.set(node, element);
    }
    function closed(node, element) {
        if (active.get(node) === element) active.delete(node);
    }
    function temporaryConfig(config) {
        if (!config || config.persistentState === "required" || config.distinctiveIdentifier === "required" ||
            (config.sessionTypes && !(Array.isArray(config.sessionTypes) && config.sessionTypes.every(t => t === "temporary")))) return null;
        return { ...config, persistentState: "not-allowed", distinctiveIdentifier: "not-allowed", sessionTypes: ["temporary"] };
    }
    function keepAccess(id, access) {
        if (stopped) throw invalid();
        const gone = admit(accesses, id);
        if (gone !== undefined) accessSystems.delete(gone);
        accessSystems.set(id, access.keySystem);
        accesses.set(id, access);
        return { system: access.keySystem, handle: id, config: access.getConfiguration() };
    }
    async function run(c) {
        if (!allowed() || stopped) throw unsupported();
        const id = c.request;
        switch (c.op) {
            case "access": {
                admit(accesses, id);
                if (!navigator.requestMediaKeySystemAccess || !Array.isArray(c.configs)) throw unsupported();
                const configs = c.configs.map(temporaryConfig).filter(Boolean);
                if (!configs.length) throw unsupported();
                return keepAccess(id, await navigator.requestMediaKeySystemAccess(c.system, configs));
            }
            case "decoding": {
                if (!navigator.mediaCapabilities?.decodingInfo) throw unsupported();
                const config = { ...c.config };
                if (config.keySystemConfiguration) {
                    config.keySystemConfiguration = temporaryConfig(config.keySystemConfiguration);
                    if (!config.keySystemConfiguration) return { supported: false, smooth: false, powerEfficient: false, access: null };
                }
                const result = await navigator.mediaCapabilities.decodingInfo(config);
                return { supported: result.supported, smooth: result.smooth, powerEfficient: result.powerEfficient,
                    access: result.keySystemAccess ? keepAccess(id, result.keySystemAccess) : null };
            }
            case "keys": {
                const gone = admit(keys, id, keysInUse);
                if (gone !== undefined) { keySystems.delete(gone); keyData.delete(gone); }
                const value = await lookup(accesses, c.access).createMediaKeys();
                if (stopped) throw invalid();
                keys.set(id, value);
                keySystems.set(id, accessSystems.get(c.access));
                keyData.set(id, new Map());
                return id;
            }
            case "attach": {
                if (!Number.isSafeInteger(c.node) || c.node <= 0 || !["audio", "video"].includes(c.kind)) throw invalid();
                const el = active.get(c.node) || player(c.node, c.kind);
                if (!elements.has(c.node)) {
                    // A page making a player per item (a feed), never
                    // detaching keys: the oldest not playing goes, and its
                    // keys are no longer held by it.
                    const gone = admit(elements, c.node, (old) => active.has(old));
                    if (gone !== undefined) keysAttached.delete(gone);
                }
                const nativeKeys = c.keys === null ? null : lookup(keys, c.keys);
                const previous = elements.get(c.node);
                elements.set(c.node, el); // an arriving stream must use this same element during the await
                try { await el.setMediaKeys(nativeKeys); }
                catch (error) {
                    if (!previous) elements.delete(c.node);
                    throw error;
                }
                if (!stopped) {
                    if (c.keys === null) {
                        elements.delete(c.node);
                        keysAttached.delete(c.node);
                    } else {
                        elements.set(c.node, el);
                        keysAttached.set(c.node, c.keys);
                        // Its stream's capture may expect the keys ({}:
                        // none usable yet), or hear them again (attach:
                        // noteKeys).
                        noteKeys(c.keys);
                    }
                }
                return;
            }
            case "session": {
                reserve(sessions, c.session);
                const session = lookup(keys, c.keys).createSession("temporary");
                sessions.set(c.session, session);
                keysOfSessions.set(c.session, c.keys);
                const event = (name, fields) => send({ event: name, session: c.session, sessionId: session.sessionId, expiration: session.expiration, ...fields });
                session.addEventListener("message", e => event("message", { type: e.messageType, data: encode(e.message) }));
                session.addEventListener("keystatuseschange", () => {
                    const usable = new Set();
                    for (const [key, status] of session.keyStatuses) if (status === "usable") usable.add(hex(new Uint8Array(key)));
                    sessionUsable.set(c.session, usable);
                    noteKeys(keysOfSessions.get(c.session));
                    event("keystatuseschange", {
                        statuses: Array.from(session.keyStatuses, ([key, status]) => [encode(key), status]),
                    });
                });
                session.closed?.then(reason => {
                    sessions.delete(c.session);
                    keysOfSessions.delete(c.session);
                    sessionUsable.delete(c.session);
                    event("closed", { reason });
                });
                return;
            }
            case "certificate": return lookup(keys, c.keys).setServerCertificate(bytes(c.data));
            case "policy": return lookup(keys, c.keys).getStatusForPolicy(c.policy);
            case "generate": {
                const session = lookup(sessions, c.session);
                await session.generateRequest(c.type, bytes(c.data));
                return session.sessionId;
            }
            case "update": {
                const session = lookup(sessions, c.session);
                const data = bytes(c.data);
                const value = await session.update(data);
                // A Clear Key license's keys, now in the open: given to the
                // element's stream's capture as its CDM says them usable
                // (its keystatuseschange, next, tells again).
                clearKey(keysOfSessions.get(c.session), data);
                noteKeys(keysOfSessions.get(c.session));
                return value;
            }
            case "close": return lookup(sessions, c.session).close();
            case "remove": return lookup(sessions, c.session).remove();
            default: throw unsupported();
        }
    }
    return {
        player, opened, closed,
        receive(commands) {
            if (!Array.isArray(commands)) return;
            for (const c of commands.slice(0, 4)) {
                if (!Number.isSafeInteger(c?.request) || c.request <= 0) continue;
                if (pending >= 32) { send({ request: c.request, name: "QuotaExceededError", error: "EME request limit" }); continue; }
                pending++;
                tail = tail.then(async () => {
                    try { send({ request: c.request, value: await run(c) }); }
                    catch (e) { send({ request: c.request, name: e.name, error: e.message || "EME request failed" }); }
                    finally { pending--; }
                });
            }
        },
        stop() {
            stopped = true;
            for (const session of sessions.values()) session.close().catch(() => {});
            sessions.clear();
            elements.clear();
            active.clear();
            accesses.clear();
            keys.clear();
            keysAttached.clear();
            keysOfSessions.clear();
            accessSystems.clear();
            keySystems.clear();
            keyData.clear();
            sessionUsable.clear();
        },
    };
}
