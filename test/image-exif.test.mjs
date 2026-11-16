import { test } from "node:test";
import assert from "node:assert/strict";
import { readExif, editExif, exifEditValue, encodeExifValue } from "../tabtopd/image-exif.js";
import { exifOf, replaceExif, crc32, metadataOf } from "../tabtopd/image-meta.js";
const text = s => new TextEncoder().encode(s);
const concat = (...parts) => Uint8Array.from(parts.flatMap(p => [...p]));
function camera(little = true) {
    const bytes = new Uint8Array(320), v = new DataView(bytes.buffer);
    bytes.set(little ? [73,73] : [77,77]);
    const u16 = (at,n) => v.setUint16(at,n,little), u32 = (at,n) => v.setUint32(at,n,little);
    u16(2,42); u32(4,8); u16(8,5);
    const entry = (at,tag,type,count,value) => { u16(at,tag); u16(at+2,type); u32(at+4,count); if(type===3)u16(at+8,value);else u32(at+8,value); };
    entry(10,0x0112,3,1,6); entry(22,0x010f,2,12,270); entry(34,0x8769,4,1,80); entry(46,0x8825,4,1,200); entry(58,65000,4,1,7); u32(70,300);
    u16(80,2); entry(82,0x927c,7,8,140); entry(94,0x9003,2,20,160);
    bytes.set(text('MAKERRAW'),140);bytes.set(text('2020:03:04 12:30:00\0'),160);
    u16(200,2);entry(202,1,2,2,0);bytes[210]=78;entry(214,2,5,3,240);
    for(let k=0;k<3;k++){u32(240+k*8,10+k);u32(244+k*8,1);}
    bytes.set(text('CameraMaker\0'),270);u16(300,0);
    return bytes;
}
for (const little of [true,false]) test(`EXIF edits preserve orientation, maker notes, unknown tags and thumbnail offsets (${little?'LE':'BE'})`, () => {
    const source=camera(little), before=source.slice();
    const parsed=readExif(source);
    assert.equal(parsed.fields.make,'CameraMaker'); assert.equal(parsed.fields.taken,'2020:03:04 12:30:00');
    const output=editExif(source,{description:'A photo',artist:'Artist',taken:'2024:02:29 10:11:12'});
    const after=readExif(output);
    assert.equal(after.fields.description,'A photo'); assert.equal(after.fields.artist,'Artist');assert.equal(after.fields.taken,'2024:02:29 10:11:12');
    assert.equal(after.rows.find(r=>r.tag===0x0112).value,'6');assert.equal(after.rows.find(r=>r.tag===65000).value,'7');
    assert.deepEqual(output.slice(140,148),text('MAKERRAW'));assert.equal(after.directories.find(d=>d.group==='Image').next,300);
    assert.deepEqual(source,before);assert.ok(!new TextDecoder().decode(output).includes('2020:03:04'));
    const removed=editExif(output,{description:''},{removeGPS:true}), result=readExif(removed);
    assert.equal(result.fields.description,undefined);assert.ok(!result.directories.some(d=>d.group==='GPS'));
    assert.ok(removed.slice(200,230).every(x=>x===0));assert.ok(removed.slice(240,264).every(x=>x===0));
});
test('EXIF can be added; dates and ASCII fields are validated',()=>{
    const bytes=editExif(null,{artist:'Ada',taken:'2026:11:16 09:00:00'});
    assert.equal(readExif(bytes).fields.artist,'Ada');
    for(const taken of ['2025:02:29 12:00:00','2024:13:01 00:00:00','2024:01:01 24:00:00','2024-01-01']) assert.throws(()=>editExif(bytes,{taken}),/valid date/);
    assert.throws(()=>editExif(bytes,{artist:'A\0B'}),/ASCII/);assert.throws(()=>editExif(bytes,{artist:'é'}),/ASCII/);
    assert.throws(()=>editExif(bytes,{artist:'x'.repeat(1025)}),/1,024/);
});
test('malformed and overlapping EXIF cannot cause unbounded reads or unsafe edits',()=>{
    assert.throws(()=>readExif(new Uint8Array(7)),/incomplete/);
    const cycle=camera();new DataView(cycle.buffer).setUint32(42,8,true);assert.throws(()=>readExif(cycle),/repeated/);
    const outside=camera();new DataView(outside.buffer).setUint32(30,999999,true);assert.throws(()=>readExif(outside),/outside/);
    const overlap=camera();new DataView(overlap.buffer).setUint32(30,140,true);assert.throws(()=>editExif(overlap,{make:'New'}),/Overlapping/);
    assert.throws(()=>readExif(new Uint8Array(1024*1024+1)),/exceeds/);
});
const segment=(marker,data)=>concat([255,marker,(data.length+2)>>8,(data.length+2)&255],data);
const jpeg=tiff=>concat([255,216],segment(224,text('JFIF\0')),segment(225,concat(text('Exif\0\0'),tiff)),segment(226,text('ICC_PROFILE\0keep')),segment(225,text('http://ns.adobe.com/xap/1.0/\0keep')), [255,218,0,2,1,2,3,255,217]);
test('JPEG metadata edits preserve encoded image bytes and other metadata',()=>{
    const source=jpeg(camera()), tiff=editExif(exifOf(source,'image/jpeg'),{artist:'New Artist'}), output=replaceExif(source,'image/jpeg',tiff);
    assert.equal(readExif(exifOf(output,'image/jpeg')).fields.artist,'New Artist');
    assert.equal(metadataOf(output,'image/jpeg').orientation,6);
    assert.deepEqual(output.slice(-9),source.slice(-9));assert.ok(new TextDecoder().decode(output).includes('ICC_PROFILE\0keep'));
    assert.ok(new TextDecoder().decode(output).includes('xap/1.0/\0keep'));
    assert.throws(()=>replaceExif(source,'image/jpeg',new Uint8Array(65528)),/size limit/);
});
function pngChunk(kind,data){const body=concat(text(kind),data),out=concat(new Uint8Array(4),body,new Uint8Array(4)),v=new DataView(out.buffer);v.setUint32(0,data.length);v.setUint32(out.length-4,crc32(body));return out;}
test('PNG EXIF insertion preserves IDAT bytes and writes valid chunk CRCs',()=>{
    const source=concat([137,80,78,71,13,10,26,10],pngChunk('IHDR',new Uint8Array(13)),pngChunk('IDAT',[1,2,3]),pngChunk('tEXt',text('note\0keep')),pngChunk('IEND',[]));
    const out=replaceExif(source,'image/png',editExif(null,{description:'PNG'}));assert.equal(readExif(exifOf(out,'image/png')).fields.description,'PNG');
    let at=8;while(at<out.length){const v=new DataView(out.buffer),len=v.getUint32(at);assert.equal(v.getUint32(at+8+len),crc32(out.subarray(at+4,at+8+len)));if(new TextDecoder().decode(out.subarray(at+4,at+8))==='IDAT')assert.deepEqual([...out.slice(at+8,at+8+len)],[1,2,3]);at+=12+len;}
    assert.ok(new TextDecoder().decode(out).includes('note\0keep'));
});
function riff(chunks){const body=concat(...chunks.map(([kind,data])=>{const out=concat(text(kind),new Uint8Array(4),data,new Uint8Array(data.length%2));new DataView(out.buffer).setUint32(4,data.length,true);return out;}));const out=concat(text('RIFF'),new Uint8Array(4),text('WEBP'),body);new DataView(out.buffer).setUint32(4,out.length-8,true);return out;}
test('WebP EXIF insertion upgrades simple headers and retains image bytes',()=>{
    for(const [kind,data] of [['VP8L',Uint8Array.of(47,1,0,0,0)],['VP8 ',Uint8Array.of(0,0,0,157,1,42,10,0,20,0)]]){
        const source=riff([[kind,data]]),out=replaceExif(source,'image/webp',editExif(null,{artist:'WebP'}));
        assert.equal(new DataView(out.buffer).getUint32(4,true),out.length-8);assert.equal(new TextDecoder().decode(out.slice(12,16)),'VP8X');assert.equal(out[20]&8,8);
        assert.equal(readExif(exifOf(out,'image/webp')).fields.artist,'WebP');
        assert.deepEqual(out.slice(38,38+data.length),data);
    }
});
test('thumbnail image bytes are preserved and cannot alias values being cleared',()=>{
    const source=new Uint8Array(420);source.set(camera());const v=new DataView(source.buffer);
    v.setUint16(300,2,true);
    for(const [at,tag,value] of [[302,0x0201,350],[314,0x0202,24]]){v.setUint16(at,tag,true);v.setUint16(at+2,4,true);v.setUint32(at+4,1,true);v.setUint32(at+8,value,true);}
    source.set(text('thumbnail-image-contents!'),350);
    const result=editExif(source,{make:'New camera'});
    assert.deepEqual(result.slice(350,374),source.slice(350,374));
    v.setUint32(222,350,true);
    assert.throws(()=>editExif(source,{}, {removeGPS:true}),/Overlapping/);
});
test('extended WebP retains ICC, alpha, XMP and the image payload when EXIF changes',()=>{
    const header=Uint8Array.of(0x34,0,0,0,1,0,0,1,0,0),image=Uint8Array.of(47,1,0,0,16);
    const source=riff([['VP8X',header],['ICCP',text('color')],['VP8L',image],['EXIF',concat(text('Exif\0\0'),camera())],['XMP ',text('<x>keep</x>')]]);
    const out=replaceExif(source,'image/webp',editExif(exifOf(source,'image/webp'),{artist:'New artist'}));
    assert.equal(out[20],0x3c);assert.ok(new TextDecoder().decode(out).includes('<x>keep</x>'));assert.ok(new TextDecoder().decode(out).includes('color'));
    assert.equal(metadataOf(out,'image/webp').orientation,6);assert.equal(readExif(exifOf(out,'image/webp')).fields.artist,'New artist');
});

for(const little of [true,false]) test(`typed EXIF data fields round-trip in ${little?'little':'big'} endian`,()=>{
    const values={1:'0, 255',2:'Text',3:'0, 65535',4:'0, 4294967295',5:'1/125, 2.8',6:'-128, 127',7:'00 ff 12 ab',8:'-32768, 32767',9:'-2147483648, 2147483647',10:'-1/3, 0.5',11:'1.5, -2.25',12:'1.25, -9.5'};
    const edits=Object.entries(values).map(([type,value])=>({group:'EXIF',tag:60000+Number(type),type:Number(type),value}));
    const output=editExif(camera(little),{}, {edits}), model=readExif(output);
    for(const [type,value]of Object.entries(values)){
        const row=model.rows.find(r=>r.group==='EXIF'&&r.tag===60000+Number(type));
        const edited=exifEditValue(model,row);
        assert.deepEqual(encodeExifValue(Number(type),edited.value,little),encodeExifValue(Number(type),value,little));
    }
});
test('exposure, ISO, orientation, GPS, Interop and arbitrary fields can be added, updated and removed',()=>{
    const output=editExif(camera(),{}, {edits:[
        {group:'EXIF',tag:0x829a,type:5,value:'1/250'}, {group:'EXIF',tag:0x8827,type:3,value:'400'},
        {group:'Image',tag:0x0112,type:3,value:'1'}, {group:'GPS',tag:2,type:5,value:'37, 46, 30'},
        {group:'GPS',tag:3,type:2,value:'W'}, {group:'Interop',tag:1,type:2,value:'R98'},
        {group:'Image',tag:65000,type:4,value:'42'}, {group:'EXIF',tag:0x927c,remove:true},
    ]});
    const model=readExif(output);
    assert.equal(model.rows.find(r=>r.tag===0x829a).value,'1/250');assert.equal(model.rows.find(r=>r.tag===0x8827).value,'400');
    assert.equal(model.rows.find(r=>r.tag===0x0112).value,'1');assert.equal(model.rows.find(r=>r.group==='GPS'&&r.tag===2).value,'37/1, 46/1, 30/1');
    assert.equal(model.rows.find(r=>r.group==='Interop'&&r.tag===1).value,'R98');assert.equal(model.rows.find(r=>r.tag===65000).value,'42');
    assert.ok(!model.rows.some(r=>r.tag===0x927c));assert.ok(output.slice(140,148).every(b=>b===0));
    const removed=readExif(editExif(output,{}, {edits:[{group:'EXIF',tag:0x829a,remove:true},{group:'GPS',tag:3,remove:true}]}));
    assert.ok(!removed.rows.some(r=>r.tag===0x829a || r.group==='GPS'&&r.tag===3));
});
test('new nested groups, long arrays and Unicode comments remain editable without truncation',()=>{
    const values=Array.from({length:80},(_,i)=>i).join(', ');
    const output=editExif(null,{}, {edits:[{group:'Interop',tag:1,type:2,value:'R98'},{group:'GPS',tag:0,type:1,value:'2, 3, 0, 0'},{group:'EXIF',tag:0x9286,type:7,value:'A café ☕',format:'comment'},{group:'Image',tag:60001,type:3,value:values}]});
    const model=readExif(output);
    assert.equal(exifEditValue(model,model.rows.find(r=>r.tag===60001)).value,values);
    const comment=model.rows.find(r=>r.tag===0x9286);assert.equal(exifEditValue(model,comment).value,'A café ☕');
    assert.ok(model.directories.some(d=>d.group==='Interop'));assert.ok(model.directories.some(d=>d.group==='GPS'));
});
test('invalid types, ranges, fractions, duplicate edits and managed links are rejected',()=>{
    for(const [type,value]of [[1,'256'],[3,'-1'],[4,'4294967296'],[5,'1/0'],[5,'-1/2'],[10,'1/0'],[7,'zz'],[11,'1e100'],[12,'Infinity'],[3,'1.5'],[2,'non-ASCII é']])assert.throws(()=>encodeExifValue(type,value));
    assert.throws(()=>encodeExifValue('__proto__','bad'));
    assert.throws(()=>editExif(camera(),{}, {edits:[{group:'Image',tag:0x8769,remove:true}]}),/automatically/);
    assert.throws(()=>editExif(camera(),{}, {edits:[{group:'Image',tag:0x0112,type:3,value:'9'}]}),/Orientation/);
    assert.throws(()=>editExif(camera(),{}, {edits:[{group:'Image',tag:65000,remove:true},{group:'Image',tag:65000,remove:true}]}),/once/);
});

test('decimal fractions retain small exposure values and accept spacing around the slash',()=>{
    for(const [value,n,d] of [['0.000000001',1,1000000000],['2.8',14,5],['1 / 125',1,125]]){
        const bytes=encodeExifValue(5,value), view=new DataView(bytes.buffer);
        assert.equal(view.getUint32(0,true),n);assert.equal(view.getUint32(4,true),d);
    }
    assert.throws(()=>encodeExifValue(5,'1e-20'),/cannot be represented/);
    assert.throws(()=>encodeExifValue(5,'/2'),/numerator/);
});
