// The events the page-world stand-ins, the agent and the frames tell each
// other by (__tabtop_…, CustomEvents on a document or an element): written
// as literals in two places or more, so a name mistyped in one would do
// nothing, quietly. Each listened for is said somewhere, and each said is
// listened for somewhere.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../tabtopd/", import.meta.url);
const sources = readdirSync(dir).filter((f) => /\.(js|go)$/.test(f) && !/_test\.go$/.test(f)).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");

test("every __tabtop_ event said is listened for, and every one listened for is said", () => {
    // Listened for as a literal, by a constant that names it (goobserve.js's
    // ENTRY), or by the prelude's answers (tabtopAsker's answerType).
    const named = new Map([...sources.matchAll(/\b([A-Z][A-Z_]*) = ["'](__tabtop_[a-z_]+)["']/g)].map((m) => [m[1], m[2]]));
    const listened = new Set([
        ...[...sources.matchAll(/addEventListener\(\s*["'](__tabtop_[a-z_]+)["']/g)].map((m) => m[1]),
        ...[...sources.matchAll(/addEventListener\(\s*([A-Z][A-Z_]*)\b/g)].map((m) => named.get(m[1])).filter(Boolean),
        ...[...sources.matchAll(/tabtopAsker\(\s*["'](__tabtop_[a-z_]+)["']/g)].map((m) => m[1]),
    ]);
    const all = new Set([...sources.matchAll(/["'](__tabtop_[a-z_]*[a-z])["']/g)].map((m) => m[1]));
    // Said where it's a literal outside a listener: an event made, a tell,
    // a constant it's sent by.
    const said = new Set([...all].filter((name) => {
        const uses = sources.split(`"${name}"`).length - 1 + sources.split(`'${name}'`).length - 1;
        const asListener = [...sources.matchAll(new RegExp(`(addEventListener|tabtopAsker)\\(\\s*["']${name}["']`, "g"))].length;
        return uses > asListener;
    }));
    const unheard = [...said].filter((n) => !listened.has(n));
    const unsaid = [...listened].filter((n) => !said.has(n));
    assert.deepEqual(unheard, [], `said, never listened for: ${unheard.join(", ")}`);
    assert.deepEqual(unsaid, [], `listened for, never said: ${unsaid.join(", ")}`);
});
