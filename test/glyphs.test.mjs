import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphs, iconDataURL, iconSVG } from "../tabtopd/glyphs.js";

test("shared SVGs retain navigation and preview sizes without browser dependencies", () => {
    for (const id of ["desktop", "terminal", "files", "logout", "search", "bell", "bell-off", "security", "share",
        "audio-off", "audio-connecting", "audio-on", "audio-error", "mic-off", "mic-connecting", "mic-on", "mic-error"]) {
        const svg = iconSVG(id);
        assert.match(svg, /width="25" height="25" viewBox="0 0 25 25"/);
        assert.match(svg, /aria-hidden="true"/);
        assert.doesNotMatch(svg, /undefined/);
    }
    assert.match(iconSVG("download"), /width="18" height="18"/);
    assert.match(iconSVG("download-direct"), /width="18" height="18"/);
    assert.match(iconSVG("download-direct"), /stroke-width="2.6"/);
    for (const id of ["back", "fold-all", "fit-page", "fit-width"]) {
        assert.match(iconSVG(id), /width="18" height="18" viewBox="0 0 24 24"/);
    }
    assert.match(iconSVG("actual-size"), /width="28" height="28"/);
    assert.match(iconSVG("actual-size"), />100%<\/text>/);
    assert.equal(glyphs.close, "✕");
    assert.equal(glyphs.fontSmaller, "A−");
});

test("desktop data icons include standalone SVG and their requested color", () => {
    for (const id of ["desktop", "audio-on", "mic-on"]) {
        const url = iconDataURL(id);
        assert.ok(url.startsWith("data:image/svg+xml,"));
        const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
        assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
        assert.match(svg, /color="#fff"/);
    }
});

test("SVG rendering rejects inherited icon names and escapes attribute values", () => {
    for (const id of ["constructor", "__proto__", "missing"]) {
        assert.throws(() => iconSVG(id), /Unknown icon/);
    }
    const svg = iconSVG("search", 'red" onload="alert(1)<&');
    assert.doesNotMatch(svg, /" onload="/);
    assert.match(svg, /&quot;/);
    assert.match(svg, /&lt;&amp;/);
});
