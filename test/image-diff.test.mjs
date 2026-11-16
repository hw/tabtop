import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDelta, imageDiffGeometry, imageDeltaOverlay } from "../tabtopd/image-diff.js";
const rgba = (...values) => new Uint8ClampedArray(values.flat());
const geometry = { aWidth: 1, aHeight: 1, bWidth: 1, bHeight: 1 };

test("identical pixels produce opaque black; RGB differences retain their colour", () => {
    let result = imageDelta(rgba(1,2,3,255), rgba(1,2,3,255), geometry);
    assert.deepEqual([...result.data], [0,0,0,255]); assert.equal(result.changed,0);
    result = imageDelta(rgba(20,40,60,255),rgba(50,30,61,255),geometry);
    assert.deepEqual([...result.data],[30,10,1,255]);assert.equal(result.changed,1);assert.equal(result.maxDelta,30);
});
test("transparency ignores hidden RGB, but differences in coverage remain visible", () => {
    assert.equal(imageDelta(rgba(255,20,30,0),rgba(0,80,200,0),geometry).changed,0);
    const result=imageDelta(rgba(0,0,0,0),rgba(0,0,0,128),geometry);
    assert.deepEqual([...result.data],[128,128,128,255]);assert.equal(result.changed,1);
    const subtle=imageDelta(rgba(0,0,0,1),rgba(1,0,0,1),geometry);
    assert.equal(subtle.changed,1);assert.equal(subtle.data[0],1);
});
test("different dimensions mark only singly covered pixels magenta and never rescale", () => {
    const bounds={aWidth:2,aHeight:1,bWidth:1,bHeight:2};
    assert.deepEqual(imageDiffGeometry(2,1,1,2),{width:2,height:2,pixels:3});
    const a=rgba([0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]);
    const b=rgba(...a);
    const result=imageDelta(a,b,bounds);
    assert.deepEqual([...result.data],[0,0,0,255,255,0,255,255,255,0,255,255,0,0,0,255]);
    assert.equal(result.changed,2);
    const bottom=imageDelta(a.slice(8),b.slice(8),{...bounds,startY:1});
    assert.deepEqual([...bottom.data],[...result.data.slice(8)]);
});
test("strip processing reconstructs the full delta and counts exactly", () => {
    const bounds={aWidth:3,aHeight:4,bWidth:2,bHeight:3};
    const a=rgba(...Array.from({length:48},(_,i)=>(i*73)%256));
    const b=rgba(...Array.from({length:48},(_,i)=>(i*17)%256));
    const full=imageDelta(a,b,bounds), strips=[];let changed=0;
    for(let y=0;y<4;y++) { const part=imageDelta(a.slice(y*12,y*12+12),b.slice(y*12,y*12+12),{...bounds,startY:y});strips.push(...part.data);changed+=part.changed; }
    assert.deepEqual(strips,[...full.data]);assert.equal(changed,full.changed);
});
test("dimension and buffer limits reject oversized, fractional and malformed inputs", () => {
    for(const args of [[0,1,1,1],[8193,1,1,1],[1.5,2,1,1],[5000,5000,1,1],[8000,1000,1000,8000]]) assert.throws(()=>imageDiffGeometry(...args));
    assert.throws(()=>imageDelta(rgba(1,2),rgba(1,2),geometry),/Invalid/);
    assert.throws(()=>imageDelta(rgba(1,2,3,4),rgba(1,2,3,4),{...geometry,startY:1}),/Invalid/);
});

test("difference overlay leaves matching pixels clear and marks changed and missing pixels", () => {
    const delta = rgba([0,0,0,255], [1,0,0,255], [255,0,255,255], [0,0,0,255]);
    assert.deepEqual([...imageDeltaOverlay(delta)], [0,0,0,0, 255,80,0,255, 255,0,255,255, 0,0,0,0]);
    assert.deepEqual([...delta], [0,0,0,255, 1,0,0,255, 255,0,255,255, 0,0,0,255]);
});
