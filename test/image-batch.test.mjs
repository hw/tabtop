import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRange, scaleRecipe, describeStep, stepsFor, pageList } from "../tabtopd/image-batch.js";
import { maskBounds, maskSVGShape } from "../tabtopd/image-mask.js";
import { imageZIP, rasterPDF } from "../tabtopd/image-export.js";

test("page ranges deduplicate, sort, and reject invalid or excessive selections",()=>{
    assert.deepEqual(pageRange("5, 1-3,2, 8-9",10),[1,2,3,5,8,9]);
    for(const value of ["","0","1-1001","4-2","1.5","1,","a","1-201","9999999999999999999999"])assert.throws(()=>pageRange(value,1000));
    assert.equal(pageRange("1-200",1000).length,200);
});
test("batch masks scale complete vector and flood-fill geometry without mutating templates",()=>{
    const recipe={kind:"inpaint",width:100,height:100,marks:[{circle:{cx:50,cy:50,r:10}},{rect:{x:90,y:90,width:10,height:10}}]};
    const scaled=scaleRecipe(recipe,200,300);
    assert.deepEqual(maskBounds(scaled.marks,200,300),{left:80,top:120,right:200,bottom:300});
    assert.deepEqual(recipe.marks[0],{circle:{cx:50,cy:50,r:10}});
    assert.equal(maskSVGShape(scaled.marks[0])[1].transform,"scale(2 3)");
    const fill=scaleRecipe({kind:"inpaint",width:100,height:100,marks:[{fill:{x:10,y:20,spans:[[0,0,9]],bounds:{x:10,y:20,width:10,height:1}}}]},200,300);
    assert.deepEqual(maskBounds(fill.marks,200,300),{left:20,top:60,right:40,bottom:63});
    const bg=scaleRecipe({kind:"background",width:100,height:100,selection:{shape:"circle",x:10,y:20,width:30,height:30},strokes:[{points:[[5,6]],radius:4,mode:"erase"}]},200,300);
    assert.deepEqual(bg.selection,{shape:"circle",x:20,y:60,width:60,height:90});
    assert.deepEqual(bg.strokes[0].scale,[2,3]);
    assert.equal(bg.strokes[0].mode,"erase");
});
test("stored image ZIP has valid CRC, UTF-8 names, directory offsets, and intact data",async()=>{
    const blob=await imageZIP([{name:"page-001.png",blob:new Blob(["123456789"])},{name:"图.png",blob:new Blob([])}]);
    const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer),decode=(at,size)=>new TextDecoder().decode(bytes.slice(at,at+size));
    assert.equal(view.getUint32(0,true),0x04034b50);
    assert.equal(view.getUint32(14,true),0xcbf43926);
    assert.equal(view.getUint16(6,true),0x800);
    assert.equal(decode(30,12),"page-001.png");assert.equal(decode(42,9),"123456789");
    const end=bytes.length-22,dir=view.getUint32(end+16,true);
    assert.equal(view.getUint32(end,true),0x06054b50);assert.equal(view.getUint16(end+10,true),2);
    assert.equal(view.getUint32(dir,true),0x02014b50);assert.equal(view.getUint32(dir+42,true),0);
    await assert.rejects(imageZIP([]),/Choose/);
    const abort=new AbortController();abort.abort();await assert.rejects(imageZIP([{name:"x",blob:new Blob(["x"])}],abort.signal));
});
test("raster PDF uses binary byte offsets, correct stream lengths and page dimensions",async()=>{
    const pdf=rasterPDF([{blob:new Blob([Uint8Array.of(0xff,0xd8,0,0xff,0xd9)],{type:"image/jpeg"}),width:200,height:300,widthPt:100,heightPt:150}]);
    const bytes=new Uint8Array(await pdf.arrayBuffer()),text=new TextDecoder("latin1").decode(bytes);
    assert.equal(pdf.type,"application/pdf");assert.ok(text.startsWith("%PDF-1.7"));
    assert.match(text,/\/Count 1/);assert.match(text,/\/MediaBox \[0 0 100.0000 150.0000\]/);assert.match(text,/\/Length 5 >>\nstream\n/);
    const xref=Number(text.match(/startxref\n(\d+)/)[1]);assert.equal(text.slice(xref,xref+4),"xref");
    const entries=text.slice(xref).split("\n").slice(3,8);
    for(let i=0;i<entries.length;i++){const offset=Number(entries[i].slice(0,10));assert.equal(text.slice(offset,offset+7),`${i+1} 0 obj`);}
    assert.throws(()=>rasterPDF([]),/Choose/);
    assert.throws(()=>rasterPDF([{blob:new Blob([],{type:"image/png"}),width:1,height:1,widthPt:1,heightPt:1}]),/Invalid/);
});

test("the operations list describes each step relative to its page",()=>{
    assert.equal(describeStep({kind:"transform",operation:"left",width:10,height:20}),"Rotate left");
    assert.equal(describeStep({kind:"transform",operation:"v",width:10,height:20}),"Flip vertically");
    assert.equal(describeStep({kind:"crop",width:200,height:100,rect:{x:0,y:0,width:100,height:25}}),"Crop to 50% × 25%");
    assert.equal(describeStep({kind:"resize",width:200,height:100,size:[100,50]}),"Resize to 50%");
    assert.equal(describeStep({kind:"resize",width:200,height:100,size:[100,100]}),"Resize to 50% × 100%");
    assert.equal(describeStep({kind:"inpaint",width:1,height:1,marks:[{}]}),"Inpaint 1 mark");
    assert.equal(describeStep({kind:"inpaint",width:1,height:1,marks:[{},{}]}),"Inpaint 2 marks");
    assert.equal(describeStep({kind:"background",width:1,height:1}),"Remove background");
});
test("a page is given only the operations it hasn't had, in order",()=>{
    const a={kind:"transform",operation:"left"},b={kind:"transform",operation:"h"},c={kind:"transform",operation:"v"};
    const ops=[{step:a,done:new Set([1,2])},{step:b,done:new Set([2])},{step:c,done:new Set()}];
    assert.deepEqual(stepsFor(ops,1),[b,c]);
    assert.deepEqual(stepsFor(ops,2),[c]);
    assert.deepEqual(stepsFor(ops,3),[a,b,c]);
    assert.deepEqual(stepsFor([],1),[]);
});
test("pages are listed as ranges",()=>{
    assert.equal(pageList(new Set([5,1,2,3,9,10])),"1–3, 5, 9–10");
    assert.equal(pageList([4]),"4");
    assert.equal(pageList([]),"");
});

test("shapes drawn scale with the page, and are described",()=>{
    const step={kind:"draw",width:100,height:50,shape:"circle",mode:"outline",color:"#00ff00",line:4,rect:{x:10,y:5,width:20,height:20}};
    const scaled=scaleRecipe(step,200,200);
    assert.deepEqual(scaled.rect,{x:20,y:20,width:40,height:80});
    assert.equal(scaled.line,4*Math.sqrt(2*4));
    assert.equal(step.rect.x,10,"the step itself isn't changed");
    assert.equal(describeStep(step),"Outline circle #00ff00");
    assert.equal(describeStep({...step,shape:"rect",mode:"fill"}),"Fill rectangle #00ff00");
});

test("pen strokes and placed pictures scale with the page, and are described",()=>{
    const pen={kind:"draw",width:100,height:50,shape:"pen",mode:"highlight",color:"#ffff00",line:10,strokes:[[10,10,20,20]]};
    assert.deepEqual(scaleRecipe(pen,200,100).strokes,[[20,20,40,40]]);
    assert.equal(scaleRecipe(pen,200,100).line,20);
    assert.equal(describeStep(pen),"Highlight 1 stroke #ffff00");
    assert.equal(describeStep({...pen,mode:"outline",strokes:[[0,0],[1,1]]}),"Pen 2 strokes #ffff00");
    assert.equal(describeStep({...pen,shape:"rect",rect:{x:0,y:0,width:1,height:1}}),"Highlight rectangle #ffff00");
    const blob=new Blob(["x"]),paste={kind:"paste",width:100,height:50,rect:{x:10,y:5,width:50,height:25},opacity:1,blob};
    const scaled=scaleRecipe(paste,200,200);
    assert.deepEqual(scaled.rect,{x:20,y:20,width:100,height:100});
    assert.equal(scaled.blob,blob);
    assert.equal(describeStep(paste),"Place a picture over 50% × 50%");
});

test("fills scale with the page, and are described",()=>{
    const fill={kind:"fill",width:100,height:50,points:[[10,10]],color:"#00ff00",tolerance:20,selection:{shape:"circle",x:0,y:0,width:50,height:50}};
    const scaled=scaleRecipe(fill,200,100);
    assert.deepEqual(scaled.points,[[20,20]]);
    assert.deepEqual(scaled.selection,{shape:"circle",x:0,y:0,width:100,height:100});
    assert.equal(describeStep(fill),"Fill 1 area #00ff00 within a circle");
    assert.equal(describeStep({...fill,points:[[1,1],[2,2]],selection:null}),"Fill 2 areas #00ff00");
});
