// The browser acting as the viewer owns every CDM object. Handles are local
// to one remote document. Only transient, non-identifying sessions can use
// this shared viewer origin.
export function encryptedMedia(reply, allowed) {
    const accesses = new Map(), keys = new Map(), sessions = new Map(), elements = new Map();
    const active = new Map();
    let stopped = false, tail = Promise.resolve(), pending = 0;
    const invalid = () => new DOMException("Invalid media key handle", "InvalidStateError");
    const unsupported = () => new DOMException("This key system configuration is unavailable", "NotSupportedError");
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
    function lookup(map, id) {
        if (!map.has(id)) throw invalid();
        return map.get(id);
    }
    function reserve(map, id) {
        if (map.size >= 32 || !Number.isSafeInteger(id) || id <= 0 || map.has(id)) throw invalid();
    }
    // admit makes room in a map of handles for id: its oldest that may go
    // (keep says which mustn't) goes, if it's full. A page probing formats
    // (decodingInfo, each answer an access) and making keys episode after
    // episode would otherwise run out, its later requests all refused.
    function admit(map, id, keep = () => false) {
        if (!Number.isSafeInteger(id) || id <= 0 || map.has(id)) throw invalid();
        if (map.size < 32) return;
        for (const old of map.keys()) {
            if (!keep(old)) {
                map.delete(old);
                return;
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
        admit(accesses, id);
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
                admit(keys, id, keysInUse);
                const value = await lookup(accesses, c.access).createMediaKeys();
                if (stopped) throw invalid();
                keys.set(id, value);
                return id;
            }
            case "attach": {
                if (!Number.isSafeInteger(c.node) || c.node <= 0 || !["audio", "video"].includes(c.kind)) throw invalid();
                const el = active.get(c.node) || player(c.node, c.kind);
                if (!elements.has(c.node)) reserve(elements, c.node);
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
                session.addEventListener("keystatuseschange", () => event("keystatuseschange", {
                    statuses: Array.from(session.keyStatuses, ([key, status]) => [encode(key), status]),
                }));
                session.closed?.then(reason => {
                    sessions.delete(c.session);
                    keysOfSessions.delete(c.session);
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
            case "update": return lookup(sessions, c.session).update(bytes(c.data));
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
        },
    };
}
