// A shader's source read as a browser's compiler would report it
// (tabtopd/goglsl.js, for gogl.js's reflection): its preprocessor, then
// what it declares.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../tabtopd/goglsl.js", import.meta.url), "utf8");
const { glslValue, glslActive, glslDeclared, glslTypes } = new Function(`${source}; return { glslValue, glslActive, glslDeclared, glslTypes };`)();

test("the preprocessor's expressions: integers, C's operators, defined() and macros", () => {
    const macros = new Map([["N", "4"], ["M", "N * 2"]]);
    for (const [text, want] of [
        ["1 + 2 * 3", 7], ["(1 + 2) * 3", 9], ["7 % 4 << 1", 6], ["0x10 | 1", 17], ["!0 && 2 > 1", 1],
        ["defined(N) ? M : 0", 8], ["defined UNKNOWN", 0], ["UNKNOWN + 1", 1], ["N == 4 || 0", 1], ["-3 + ~0", -4],
    ]) assert.equal(glslValue(text, macros), want, text);
    // A macro defined by itself is followed 8 deep, not for good.
    assert.equal(glslValue("LOOP", new Map([["LOOP", "LOOP + 1"]])), 8);
});

test("conditionals are taken, comments and the branches not taken left out", () => {
    const { text, macros, es3 } = glslActive(`#version 300 es
// uniform float commented;
/* uniform float blocked; */
#define SIZE 3
#ifdef GL_ES
uniform float es;
#else
uniform float desktop;
#endif
#if SIZE > 4
uniform float big;
#elif SIZE == 3
uniform float three;
#else
uniform float other;
#endif
#ifndef SIZE
uniform float none;
#endif
#undef SIZE
#ifdef SIZE
uniform float after;
#endif`);
    assert.ok(es3);
    assert.deepEqual(text.match(/uniform float \w+/g), ["uniform float es", "uniform float three"]);
    assert.equal(macros.has("SIZE"), false);
});

test("uniforms are named as a browser reports them: arrays as name[0], structs field by field", () => {
    const { uniforms, attributes } = glslDeclared(`precision mediump float;
#define LIGHTS 2
struct Light { vec3 color; float power; };
uniform Light lights[LIGHTS];
uniform mediump mat4 view, model;
uniform sampler2D map[3];
void main() { vec4 local = vec4(0.0); }`, false);
    assert.deepEqual(uniforms.map((u) => [u.name, u.type, u.size]), [
        ["lights[0].color", glslTypes.vec3, 1], ["lights[0].power", glslTypes.float, 1],
        ["lights[1].color", glslTypes.vec3, 1], ["lights[1].power", glslTypes.float, 1],
        ["view", glslTypes.mat4, 1], ["model", glslTypes.mat4, 1],
        ["map[0]", glslTypes.sampler2D, 3],
    ]);
    assert.deepEqual(attributes, [], "a fragment shader has no attributes");
});

test("a vertex shader's attributes: attribute, or GLSL ES 3's in, with a layout's location", () => {
    assert.deepEqual(glslDeclared(`attribute vec3 position; attribute vec2 uv;
void main() { gl_Position = vec4(position, 1.0); }`, true).attributes.map((a) => [a.name, a.type, a.layout]),
    [["position", glslTypes.vec3, -1], ["uv", glslTypes.vec2, -1]]);
    assert.deepEqual(glslDeclared(`#version 300 es
layout(location = 2) in vec4 color;
in highp vec3 normal;
void main() {}`, true).attributes.map((a) => [a.name, a.layout]), [["color", 2], ["normal", -1]]);
    // GLSL ES 1's "in" isn't an attribute.
    assert.deepEqual(glslDeclared("in vec3 nothing; void main() {}", true).attributes, []);
});
