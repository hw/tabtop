// The remote browser's fetch, patched for data: URLs: tabtopd has the engine
// run this before any of a document's scripts, with its IntersectionObserver
// (see gobrowser.go). Engines fetch data: URLs themselves (XHR always has),
// but a page's CSP forbidding them — connect-src without data:, typical of
// sites that never fetch data: — refuses the fetch before the engine's is
// asked, and pages that do (inline datasets, self-contained exports) break.
// A data: fetch is answered here instead: the URL's own bytes, decoded the
// way data: URLs are (the fetch standard's data: URL processor), as a
// Response. No request is made, so there's nothing for the page's CSP or
// the engine's proxy to refuse, and a data: fetch sends nothing anywhere;
// every other URL goes to the engine's fetch as before.
//
// It's the page's to see and change, like anything in its world: what it
// does with that only touches its own copy.
(() => {
    const NATIVE = window.fetch;
    const UTF8 = new TextEncoder();
    const refused = () => Promise.reject(new TypeError("Failed to fetch"));

    // Percent-decodes a serialized URL path to bytes (its escapes were
    // percent-encoded on the way in; what's left becomes UTF-8).
    function decoded(s) {
        const out = [];
        for (let i = 0; i < s.length; i++) {
            if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
                out.push(parseInt(s.slice(i + 1, i + 3), 16));
                i += 2;
            } else {
                for (const b of UTF8.encode(s[i])) out.push(b);
            }
        }
        return Uint8Array.from(out);
    }

    // The bytes as a string of their values, for base64's alphabet.
    function latin1(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x1000) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x1000));
        }
        return s;
    }

    // Forgiving-base64 decode, as the fetch standard has it: whitespace
    // dropped, padding optional, anything else a refusal.
    function base64(s) {
        s = s.replace(/[\t\n\f\r ]/g, "");
        if (s.length % 4 === 1 || !/^[a-z\d+/]*={0,2}$/i.test(s)) return null;
        const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    window.fetch = (input, init) => {
        try {
            const href = input instanceof Request ? input.url
                : input instanceof URL ? new URL(input.href, document.baseURI).href
                : typeof input === "string" ? new URL(input, document.baseURI).href
                : null;
            if (href === null || !href.startsWith("data:")) return NATIVE.call(window, input, init);
            // What follows the first "#" is the fragment, not the data:
            // anything meant for the body was percent-escaped on the way in.
            let data = href;
            const cut = data.indexOf("#");
            if (cut >= 0) data = data.slice(0, cut);
            const at = data.indexOf(",", 5);
            if (at < 0) return refused();
            let mime = data.slice(5, at).replace(/^ +| +$/g, "");
            let body = decoded(data.slice(at + 1));
            const b64 = /; *base64$/i.exec(mime);
            if (b64) {
                body = base64(latin1(body));
                if (body === null) return refused();
                mime = mime.slice(0, b64.index);
            }
            if (mime.startsWith(";")) mime = "text/plain" + mime;
            if (mime === "") mime = "text/plain;charset=US-ASCII";
            const res = new Response(body, { headers: { "content-type": mime } });
            Object.defineProperty(res, "url", { value: href });
            return Promise.resolve(res);
        } catch {
            return refused();
        }
    };
})();
