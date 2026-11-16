import { test } from "node:test";
import assert from "node:assert/strict";
import { compareText, lineText, textDocument } from "../tabtopd/text-diff.js";

function reconstruct(result) {
    assert.equal(result.rows.filter(r => r.a >= 0).map(r => result.left.lines[r.a]).join(""), result.left.lines.join(""));
    assert.equal(result.rows.filter(r => r.b >= 0).map(r => result.right.lines[r.b]).join(""), result.right.lines.join(""));
    for (const r of result.rows) if (r.change < 0) assert.equal(result.left.lines[r.a], result.right.lines[r.b]);
}
test("identical, empty, inserted, removed and replaced files align without losing lines", () => {
    for (const [a,b] of [["",""],["a\n","a\n"],["","a\nb\n"],["a\nb\n",""],["a\nb\nc\n","a\nx\ny\nc\n"],["a\nb\nc\nd\n","a\nx\nc\ny\nd\n"]]) {
        const result = compareText(a,b); reconstruct(result);
        assert.equal(result.identical, a === b);
    }
    const d=compareText("a\nb\nc\n","a\nx\ny\nc\n");
    assert.deepEqual(d.rows, [{a:0,b:0,change:-1},{a:1,b:1,change:0},{a:-1,b:2,change:0},{a:2,b:3,change:-1}]);
    assert.equal(d.removed,1);assert.equal(d.added,2);
    assert.equal(compareText("a\nb\nc\nd\n","a\nx\nc\ny\nd\n").changes.length,2);
});
test("whitespace, BOM, line endings and missing final newlines remain distinguishable", () => {
    for (const [a,b] of [["x","x\n"],["a \n","a\n"],["a\r\nb\r\n","a\nb\n"],["a\rb\r","a\nb\n"],["\ufeffa\n","a\n"]]) {
        const result=compareText(a,b);reconstruct(result);assert.equal(result.identical,false);
    }
    assert.equal(textDocument("\ufeffa\r\n").bom,true);
    assert.equal(textDocument("a\r\n").endings,"CRLF");
    assert.equal(textDocument("a").finalNewline,false);
    assert.equal(lineText("a \r\n"),"a ");
});
test("control characters other than NUL are text", () => {
    assert.equal(textDocument("\x1b[31mred\x1b[0m\n").lines.length,1);
    assert.throws(() => textDocument("a\0b"),/binary data/);
});
test("budget fallback preserves shared edges and every changed line", () => {
    const result=compareText("start\na\nb\nend\n","start\nx\ny\nend\n",{maxWork:0});
    reconstruct(result);assert.equal(result.approximate,true);
    assert.equal(result.rows[0].change,-1);assert.equal(result.rows.at(-1).change,-1);
});
test("arbitrary small diffs reconstruct both inputs and have minimal insertion/removal count", () => {
    let seed=123;
    const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
    for(let run=0;run<500;run++) {
        const a=Array.from({length:random(12)},()=>String(random(4))+"\n");
        const b=Array.from({length:random(12)},()=>String(random(4))+"\n");
        const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
        for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);
        const result=compareText(a.join(""),b.join(""));reconstruct(result);
        assert.equal(result.removed+result.added,a.length+b.length-2*dp[a.length][b.length]);
    }
});
test("binary, oversized and excessively long documents are refused", () => {
    assert.throws(()=>compareText("abc\0def","text"),/binary/);
    assert.throws(()=>compareText("é".repeat(1_000_001),""),/2 MB/);
    assert.throws(()=>compareText("\n".repeat(50_001),""),/50,000/);
});
