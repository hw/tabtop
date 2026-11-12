import { test } from "node:test";
import assert from "node:assert/strict";
import { newMaskMark, extendMaskMark, maskBounds, floodSpans, imageMaskPoint } from "../tabtopd/image-mask.js";

test("circles drag from centre to edge, rectangles work in reverse, and bounds include their extent", () => {
    const circle = newMaskMark("circle", [20,30], 5);
    extendMaskMark(circle, [20,30], [23,34]);
    assert.deepEqual(circle.circle, {cx:20,cy:30,r:5});
    assert.deepEqual(maskBounds([circle],100,100), {left:15,top:25,right:25,bottom:35});
    const rect = newMaskMark("rectangle",[40,50],5,true);
    extendMaskMark(rect,[40,50],[10,20]);
    assert.deepEqual(rect.rect,{x:10,y:20,width:30,height:30});
    assert.equal(rect.erase,true);
});

test("flood fill stays inside an outline, rejects open regions, and leaves input untouched", () => {
    const w=9,h=9, rgba=new Uint8ClampedArray(w*h*4);
    for(let y=1;y<=7;y++)for(let x=1;x<=7;x++)if(x===1||x===7||y===1||y===7)rgba[(y*w+x)*4+3]=255;
    const before=rgba.slice();
    const spans=floodSpans(rgba,w,h,4,4);
    assert.equal(spans.reduce((n,[y,a,z])=>n+z-a+1,0),25);
    assert.ok(spans.every(([y,a,z])=>y>=2&&y<=6&&a===2&&z===6));
    assert.deepEqual(rgba,before);
    assert.deepEqual(floodSpans(rgba,w,h,1,1),[]);
    assert.throws(()=>floodSpans(rgba,w,h,0,0),/outline is open/);
    rgba[(1*w+4)*4+3]=0;
    assert.throws(()=>floodSpans(rgba,w,h,4,4),/outline is open/);
});

test("flood fill keeps separate enclosed regions separate and respects subpixel stroke barriers", () => {
    const w=9,h=9, rgba=new Uint8ClampedArray(w*h*4);
    for(let y=1;y<=7;y++)for(let x=1;x<=7;x++)if(x===1||x===4||x===7||y===1||y===7)rgba[(y*w+x)*4+3]=1;
    const spans=floodSpans(rgba,w,h,2,3);
    assert.equal(spans.reduce((n,[y,a,z])=>n+z-a+1,0),10);
    assert.ok(spans.every(([y,a,z])=>a===2&&z===3));
});

test("rectangle endpoints snap to fitted image edges while brushes keep pixel precision", () => {
    const g={x:25,y:30,scale:.25,width:2400,height:1600};
    assert.deepEqual(imageMaskPoint(624,429,g,6),[2400,1600]);
    assert.deepEqual(imageMaskPoint(624,429,g),[2396,1596]);
    assert.deepEqual(imageMaskPoint(26,31,g,6),[0,0]);
    assert.deepEqual(imageMaskPoint(100,100,g,6),[300,280]);
    assert.deepEqual(imageMaskPoint(800,600,g,6),[2400,1600]);
});


test("inverting an inpainting mask expands its repair bounds to the image, including scaled batch marks", () => {
    const rect = { rect: { x: 20, y: 30, width: 10, height: 10 } };
    assert.deepEqual(maskBounds([rect, { invert: true, width: 100, height: 200 }], 100, 200), { left: 0, top: 0, right: 100, bottom: 200 });
    assert.deepEqual(maskBounds([{ invert: true, width: 100, height: 200, scale: [2, 3] }], 200, 600), { left: 0, top: 0, right: 200, bottom: 600 });
});
