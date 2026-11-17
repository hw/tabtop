// Collada and VRML files made to blow up when read (each level using the
// one below twice: a few kilobytes making millions of parts) are refused
// before three.js's loaders copy them; real files aren't; and the counting
// itself stays quick on large or junk input.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { colladaMade, checkCollada, vrmlMade } from "../tabtopd/model-limits.js";

const colladaBomb = (levels) => `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<library_geometries><geometry id="g"><mesh/></geometry></library_geometries><library_nodes><node id="n0"><instance_geometry url="#g"/></node>
${Array.from({ length: levels }, (_, i) => `<node id="n${i + 1}"><instance_node url="#n${i}"/><instance_node url="#n${i}"/></node>`).join("")}
</library_nodes><library_visual_scenes><visual_scene id="s"><node><instance_node url="#n${levels}"/></node></visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#s"/></scene></COLLADA>`;
const vrmlBomb = (levels) => `#VRML V2.0 utf8
DEF N0 Shape { geometry IndexedFaceSet { coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1] } }
${Array.from({ length: levels }, (_, i) => `DEF N${i + 1} Group { children [ USE N${i} USE N${i} ] }`).join("\n")}\n`;

test("a Collada file's parts, each shared one counted where it's used", () => {
    assert.deepEqual(colladaMade(colladaBomb(4)), { nodes: 1 + 31, shapes: 16 });
    assert.doesNotThrow(() => checkCollada(colladaBomb(8)));
    for (const levels of [16, 24, 60]) assert.throws(() => checkCollada(colladaBomb(levels)), /too many parts/, `${levels} levels`);
    // One that uses itself: refused, not followed for ever.
    assert.throws(() => colladaMade(`<COLLADA><library_nodes><node id="a"><instance_node url="#b"/></node><node id="b"><instance_node url="#a"/></node></library_nodes>
        <library_visual_scenes><visual_scene><node><instance_node url="#a"/></node></visual_scene></library_visual_scenes></COLLADA>`), /inside itself/);
    // Deep, not wide: counted without recursion (no stack overflow), refused for its nodes.
    const deep = `<COLLADA><library_visual_scenes><visual_scene>${"<node>".repeat(150000)}${"</node>".repeat(150000)}</visual_scene></library_visual_scenes></COLLADA>`;
    assert.throws(() => checkCollada(deep), /too many parts/);
});

test("a VRML file's parts, each USE counted again", () => {
    const board = readFileSync(new URL("data/3d/board.wrl", import.meta.url), "utf8");
    assert.equal(vrmlMade(board).shapes, 4);
    // Every level is in the scene too: 1 + 2 + 4 + 8 + 16 shapes.
    assert.equal(vrmlMade(vrmlBomb(4)).shapes, 31);
    for (const levels of [16, 20, 40]) assert.throws(() => vrmlMade(vrmlBomb(levels)), /too many parts/, `${levels} levels`);
    // "DEF"/"USE" in comments and strings aren't counted.
    assert.equal(vrmlMade('#VRML V2.0 utf8\n# USE N0 USE N0\nWorldInfo { title "USE N0 { }" }\nShape { }\n').shapes, 1);
});

test("counting is quick: a large real-looking VRML file, and junk", () => {
    const shape = "Transform { children [ Shape { appearance Appearance { material Material { diffuseColor 1 0 0 } } geometry IndexedFaceSet { coord Coordinate { point [ 0 0 0, 1 0 0, 0 1 0 ] } coordIndex [ 0 1 2 -1 ] } } ] }\n";
    let t = performance.now();
    assert.equal(vrmlMade("#VRML V2.0 utf8\n" + shape.repeat(40000)).shapes, 40000);
    assert.ok(performance.now() - t < 2000, `${performance.now() - t} ms`);
    t = performance.now();
    vrmlMade('"\\'.repeat(2e6));
    assert.ok(performance.now() - t < 2000, `quotes: ${performance.now() - t} ms`);
});
