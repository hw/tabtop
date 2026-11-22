// Settings' checks of what's typed, as the server makes them (gohosts.go,
// gosites.go), to say what's wrong by the field before it's sent; and
// hosts-file lines, read and written. (The server checks again.)

// hostNameProblem is why name isn't a record's name ("" if it is one).
export function hostNameProblem(raw) {
    const name = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!name) return "Give a name.";
    if (name.length > 253) return "That name is too long.";
    if (addrProblem(name) === "") return "That’s an address, not a name.";
    for (const label of name.split(".")) {
        if (!label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9_-]+$/.test(label)) {
            return "Letters, digits, - and _ only, in parts between dots.";
        }
    }
    return "";
}

// addrProblem is why raw isn't an IPv4 or IPv6 address ("" if it is one).
export function addrProblem(raw) {
    const a = String(raw ?? "").trim().replace(/^\[(.*)\]$/, "$1");
    if (!a) return "Give an address.";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) {
        const parts = a.split(".").map(Number);
        if (parts.some((p, i) => p > 255 || String(p) !== a.split(".")[i])) return "Not an IPv4 address.";
        if (parts.every((p) => p === 0)) return "An address of all zeros can’t be reached.";
        return "";
    }
    if (a.includes(":")) {
        if (a.includes("%")) return "No zone (%…): an address of all interfaces.";
        try {
            const host = new URL(`http://[${a}]/`).hostname;
            if (host === "[::]") return "An address of all zeros can’t be reached.";
            return "";
        } catch { return "Not an IPv6 address."; }
    }
    return "Not an IPv4 or IPv6 address.";
}

// kindOf is a record's type by its address.
export const kindOf = (addr) => (String(addr).includes(":") ? "AAAA" : "A");

// parseHosts reads hosts-file lines: an address, then its names; # a
// note. Records, and the lines that couldn't be (by number).
export function parseHosts(text) {
    const records = [], problems = [];
    String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*/, "").trim();
        if (!line) return;
        const [addr, ...names] = line.split(/\s+/);
        if (!names.length) return problems.push({ line: i + 1, text: raw.trim(), why: "an address with no name" });
        const bad = addrProblem(addr);
        if (bad) return problems.push({ line: i + 1, text: raw.trim(), why: bad.replace(/\.$/, "").toLowerCase() });
        for (const name of names) {
            const why = hostNameProblem(name);
            if (why) problems.push({ line: i + 1, text: name, why: why.replace(/\.$/, "").toLowerCase() });
            else records.push({ name: name.toLowerCase().replace(/\.$/, ""), addr });
        }
    });
    return { records, problems };
}

// hostsText is records as hosts-file lines: each address with its names.
export function hostsText(records) {
    const byAddr = new Map();
    for (const r of records ?? []) byAddr.set(r.addr, [...(byAddr.get(r.addr) ?? []), r.name]);
    return [...byAddr].map(([addr, names]) => `${addr}\t${names.join(" ")}`).join("\n") + (byAddr.size ? "\n" : "");
}

// byName is records grouped by name, in order: [{name, addrs: [addr]}].
export function byName(records) {
    const groups = new Map();
    for (const r of records ?? []) {
        if (!groups.has(r.name)) groups.set(r.name, []);
        groups.get(r.name).push(r.addr);
    }
    return [...groups].map(([name, addrs]) => ({ name, addrs }));
}

// searchTemplateProblem is why raw isn't a search address (an http or
// https address with one %s, a query parameter's whole value): "" if it is.
export function searchTemplateProblem(raw) {
    const t = String(raw ?? "").trim();
    if (!t) return "Give the search address.";
    if (t.split("%s").length !== 2) return "Put %s once, where the words go.";
    let u;
    try { u = new URL(t.replace("%s", "TABTOPWORDS")); } catch { return "Not an address."; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "An http or https address.";
    if (u.username || u.password) return "No user name or password in it.";
    const param = [...u.searchParams].find(([, v]) => v === "TABTOPWORDS");
    if (!param) return "%s must be a query parameter’s whole value (…?q=%s).";
    return "";
}
