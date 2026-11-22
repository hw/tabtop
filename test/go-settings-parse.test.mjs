// Settings' checks of what's typed (tabtopd/go-settings-parse.js), as the
// server makes them (gohosts.go, gosites.go), and hosts-file lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addrProblem, byName, hostNameProblem, hostsText, kindOf, parseHosts, searchTemplateProblem } from "../tabtopd/go-settings-parse.js";

test("a record's name: labels of letters, digits, - and _, not an address", () => {
    for (const ok of ["nas.home.arpa", "NAS.Home.Arpa.", "printer", "_svc.example", "a-b.c"]) assert.equal(hostNameProblem(ok), "", ok);
    for (const bad of ["", "  ", "not a name", "a..b", "-a.b", "a-.b", "a/b", "x".repeat(64) + ".b", "192.168.1.10", "[::1]", "é.example"]) {
        assert.notEqual(hostNameProblem(bad), "", bad);
    }
    assert.match(hostNameProblem("10.0.0.1"), /address, not a name/);
});

test("a record's address: IPv4 or IPv6, not all zeros, no zone", () => {
    for (const ok of ["192.168.1.10", "10.0.0.1", "fd00::10", "[fd00::10]", "::1", "::ffff:1.2.3.4"]) assert.equal(addrProblem(ok), "", ok);
    for (const bad of ["", "256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "nas", "1::2::3", "fe80::1%eth0", "0.0.0.0", "::", "[::]"]) {
        assert.notEqual(addrProblem(bad), "", bad);
    }
    assert.equal(kindOf("10.0.0.1"), "A");
    assert.equal(kindOf("fd00::1"), "AAAA");
});

test("hosts lines read: each name of a line a record; what can't be, by line", () => {
    const { records, problems } = parseHosts([
        "# a note",
        "192.168.1.10   nas.home.arpa nas   # the NAS",
        "",
        "fd00::10\tnas.home.arpa",
        "10.0.0.1",
        "999.1.1.1 bad.example",
        "10.0.0.2 good.example not/one",
    ].join("\r\n"));
    assert.deepEqual(records, [
        { name: "nas.home.arpa", addr: "192.168.1.10" },
        { name: "nas", addr: "192.168.1.10" },
        { name: "nas.home.arpa", addr: "fd00::10" },
        { name: "good.example", addr: "10.0.0.2" },
    ]);
    assert.deepEqual(problems.map((p) => [p.line, p.text]), [[5, "10.0.0.1"], [6, "999.1.1.1 bad.example"], [7, "not/one"]]);
    assert.deepEqual(parseHosts(""), { records: [], problems: [] });
});

test("records written as hosts lines, read back the same", () => {
    const records = [
        { name: "nas.home.arpa", addr: "192.168.1.10" },
        { name: "nas", addr: "192.168.1.10" },
        { name: "nas.home.arpa", addr: "fd00::10" },
    ];
    const text = hostsText(records);
    assert.equal(text, "192.168.1.10\tnas.home.arpa nas\nfd00::10\tnas.home.arpa\n");
    assert.deepEqual(parseHosts(text).records, records);
    assert.equal(hostsText([]), "");
});

test("records grouped by name, in order", () => {
    assert.deepEqual(byName([
        { name: "b", addr: "10.0.0.2" }, { name: "a", addr: "10.0.0.1" }, { name: "b", addr: "fd00::2" },
    ]), [{ name: "b", addrs: ["10.0.0.2", "fd00::2"] }, { name: "a", addrs: ["10.0.0.1"] }]);
});

test("a search address: http or https, %s once, a parameter's whole value", () => {
    for (const ok of ["https://search.example/?q=%s", "http://s.example/find?lang=en&q=%s", " https://s.example/s?q=%s&x=1 "]) {
        assert.equal(searchTemplateProblem(ok), "", ok);
    }
    for (const bad of ["", "https://s.example/?q=", "https://s.example/?q=%s&r=%s", "https://s.example/%s", "https://s.example/?q=x%s",
        "ftp://s.example/?q=%s", "https://user:pw@s.example/?q=%s", "s.example/?q=%s", "https://s.example/#q=%s"]) {
        assert.notEqual(searchTemplateProblem(bad), "", bad);
    }
});
