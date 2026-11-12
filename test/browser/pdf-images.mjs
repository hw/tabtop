import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

export async function checkPDFImages(checks){
    const{ev,step,work,container,open,listed,waitFor,inFrame,downloads,waitForFile}=checks;
    await step("files: PDF pages share masks, retain per-page edits, cancel, undo, and export as images or PDF",async()=>{
        // Different page sizes exercise relative masks; page three is excluded.
        const base64=await ev(`(async()=>{
            const{rasterPDF}=await import('/tabtop/image-export.js');const pages=[];
            for(const factor of [1,2,1]){
                const c=Object.assign(document.createElement('canvas'),{width:320*factor,height:240*factor}),x=c.getContext('2d');
                x.fillStyle='rgb(140,160,180)';x.fillRect(0,0,c.width,c.height);x.fillStyle='rgb(240,30,30)';x.fillRect(140*factor,100*factor,40*factor,40*factor);
                const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',1));pages.push({blob,width:c.width,height:c.height,widthPt:c.width,heightPt:c.height});
            }
            pages.push({...pages[0],widthPt:10000,heightPt:10000});
            const bytes=new Uint8Array(await rasterPDF(pages).arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text);
        })()`);
        const fixture=Buffer.from(base64,"base64");writeFileSync(`${work}/batch.pdf`,fixture);
        execFileSync("docker",["cp","-q",`${work}/batch.pdf`,`${container}:/home/user/Downloads/media/batch.pdf`]);
        execFileSync("docker",["exec",container,"chown","user","/home/user/Downloads/media/batch.pdf"]);
        await open("fs/#/media/",`${listed}.includes("batch.pdf")`,"batch PDF listed");
        await ev(`[...document.querySelectorAll('td.name a')].find(a=>a.textContent==='batch.pdf').click()`);
        await waitFor(`JSON.parse(document.querySelector('iframe.pdf')?.dataset.rendered??'null')?.pages===4`,"four PDF pages rendered");
        await inFrame("pdf-frame.html",`document.querySelector('.edit-images').click()`);
        const d=`document.querySelector('dialog.pdf-image-editor')`,v=`${d}.querySelector('.image-view')`;
        const click=selector=>checks.click(`${d}.querySelector(${JSON.stringify(selector)})`);
        const canvas=`${v}?.querySelector('canvas.image-content')`,note=`${d}.querySelector('.pdf-batch-note').textContent`;
        const ready=`!!${canvas}&&!${d}.querySelector('.pdf-batch-keep').disabled`;
        await waitFor(`${d}&&${ready}`,"batch page editor ready",120000);
        if(!(await ev(`${d}.querySelector('.pdf-batch-export').closest('.pdf-batch-actions')===${d}.querySelector('.pdf-batch-keep').closest('.pdf-batch-actions') && !${d}.querySelector('footer,.pdf-batch-background')`)))throw new Error("export controls weren't merged or redundant removal button remains");
        const initial=await ev(`(()=>{const r=${d}.getBoundingClientRect();return{width:r.width,height:r.height};})()`);
        await click('.pdf-batch-widen');
        await waitFor(`${d}.classList.contains('wide')&&${d}.querySelector('.pdf-batch-widen').getAttribute('aria-pressed')==='true'`,"PDF image editor maximized");
        if(!(await ev(`(()=>{const r=${d}.getBoundingClientRect();return Math.abs(r.x)<1&&Math.abs(r.y)<1&&Math.abs(r.width-innerWidth)<1&&Math.abs(r.height-innerHeight)<1;})()`)))throw new Error("PDF image editor doesn't fill the window");
        await click('.pdf-batch-widen');
        await waitFor(`!${d}.classList.contains('wide')&&${d}.querySelector('.pdf-batch-widen').getAttribute('aria-pressed')==='false'`,"PDF image editor restored");
        if(!(await ev(`(()=>{const r=${d}.getBoundingClientRect();return Math.abs(r.width-${initial.width})<1&&Math.abs(r.height-${initial.height})<1;})()`)))throw new Error("PDF image editor size wasn't restored");
        await ev(`(s=>{s.value='72';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-dpi'))`);
        await waitFor(`${ready}&&${canvas}.width===320&&${canvas}.height===240`,"72 DPI page");
        await ev(`${d}.querySelector('.pdf-batch-range').value='1-2'`);await click('.pdf-batch-choose');
        const pixel=(x,y)=>ev(`[...${canvas}.getContext('2d').getImageData(${x},${y},1,1).data]`);
        const gray=rgba=>Math.abs(rgba[0]-140)<12&&Math.abs(rgba[1]-160)<12&&Math.abs(rgba[2]-180)<12;
        const outside=await pixel(20,20);
        await click('.image-inpaint-start');await click('.image-inpaint-select');
        const r=await ev(`(()=>{const r=${canvas}.getBoundingClientRect();return{x:r.x,y:r.y,sx:r.width/320,sy:r.height/240};})()`);
        for(const[type,x,y,buttons]of[["mousePressed",130,90,1],["mouseMoved",190,150,1],["mouseReleased",190,150,0]])await checks.cdp("Input.dispatchMouseEvent",{type,x:r.x+x*r.sx,y:r.y+y*r.sy,button:"left",buttons,clickCount:1});
        await waitFor(`!${d}.querySelector('.pdf-batch-apply').disabled`,"mask available for batch");
        // The operations list: shown on asking, the tool in use last.
        const ops=`[...${d}.querySelectorAll('.pdf-batch-ops-list li')]`;
        if(!(await ev(`${d}.querySelector('.pdf-batch-ops').hidden`)))throw new Error("the operations list is shown before it's asked for");
        await click('.pdf-batch-ops-toggle');
        await waitFor(`!${d}.querySelector('.pdf-batch-ops').hidden&&${d}.querySelector('.pdf-batch-ops-toggle').getAttribute('aria-expanded')==='true'`,"operations list shown");
        await waitFor(`${ops}.length===1&&${ops}[0].classList.contains('pending')&&${ops}[0].textContent.startsWith('Inpaint 1 mark')&&${ops}[0].textContent.includes('in progress on page 1')`,"the inpainting in progress listed");
        await click('.pdf-batch-apply');
        await waitFor(`${note}.startsWith('2 pages processed')&&${ready}`,"two pages inpainted",180000);
        await waitFor(`${ops}.length===1&&${ops}[0].textContent.includes('from page 1; done on pages 1–2')&&${d}.querySelector('.pdf-batch-ops-toggle').textContent==='Operations (1)'`,"the inpainting listed as done on both pages");
        if(!(await ev(`${d}.querySelector('.pdf-batch-apply').disabled`)))throw new Error("Batch apply offered with every selected page done");
        if(!gray(await pixel(160,120))||JSON.stringify(await pixel(20,20))!==JSON.stringify(outside))throw new Error("page-one inpainting changed the wrong pixels");
        await click('.pdf-batch-card[data-page="2"] .pdf-batch-open-page');
        await waitFor(`${ready}&&${canvas}.width===640`,"second page opened");
        if(!gray(await pixel(320,240)))throw new Error("mask wasn't scaled to the second page");
        await ev(`${d}.querySelector('.pdf-batch-range').value='1-3'`);await click('.pdf-batch-choose');
        await click('.pdf-batch-card[data-page="3"] .pdf-batch-open-page');await waitFor(`${ready}&&${d}.querySelector('.pdf-batch-page-title').textContent==='Page 3'`,"unselected page shown");
        if((await pixel(160,120))[0]<220)throw new Error("an unselected PDF page was edited");
        await ev(`(c=>{c.checked=false;c.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-card[data-page="3"] input'))`);
        // Real U2NetP runs on each selected image; undo preserves inpainting.
        await click('.image-remove-background');
        await waitFor(`!${d}.querySelector('.image-background-spatial-apply').disabled||${d}.querySelector('.image-background-note.error')`,"background tool configured",120000);
        if(await ev(`${d}.querySelector('.image-background-spatial-apply').disabled`))throw new Error("background tool couldn't start");
        await click('.pdf-batch-apply');await waitFor(`${note}.startsWith('2 pages processed')&&${ready}`,"batch background removal",180000);
        await click('.pdf-batch-card[data-page="1"] .pdf-batch-open-page');await waitFor(`${ready}&&${d}.querySelector('.pdf-batch-page-title').textContent==='Page 1'`,"removed page shown");
        if(!(await ev(`(()=>{const c=${canvas},a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return a.some((v,i)=>i%4===3&&v<200);})()`)))throw new Error("batch background removal didn't alter alpha");
        await click('.pdf-batch-undo');await waitFor(`${note}==='Last batch undone.'&&${ready}`,"last batch undone");
        if(!gray(await pixel(160,120))||JSON.stringify(await pixel(20,20))!==JSON.stringify(outside))throw new Error("Undo batch didn't retain earlier inpainting");
        await click('.pdf-batch-apply');await waitFor(`!${d}.querySelector('.pdf-batch-cancel').hidden`,"batch started");await click('.pdf-batch-cancel');
        await waitFor(`${note}.startsWith('Cancelled.')&&${ready}`,"batch cancelled",120000);
        await click('.pdf-batch-undo');await waitFor(`${note}==='Last batch undone.'&&${ready}`,"cancelled batch undone");
        // An oversized page fails independently; a valid page still completes.
        await ev(`${d}.querySelector('.pdf-batch-range').value='1,4'`);await click('.pdf-batch-choose');
        await click('.pdf-batch-apply');await waitFor(`${note}.startsWith('1 page processed; 1 failed')&&${ready}`,"per-page batch failure reported",180000);
        if(!(await ev(`${d}.querySelector('.pdf-batch-card[data-page="4"] small').textContent.startsWith('Failed:')`)))throw new Error("failed page wasn't marked for review");
        await click('.pdf-batch-undo');await waitFor(`${note}==='Last batch undone.'&&${ready}`,"partly failed batch undone");
        if(!gray(await pixel(160,120)))throw new Error("undo after a page failure lost previous edits");
        await ev(`${d}.querySelector('.pdf-batch-range').value='1-2'`);await click('.pdf-batch-choose');
        // A page can be refined independently after a shared batch.
        if(!(await ev(`${d}.querySelector('.pdf-batch-dpi').disabled`)))throw new Error("resolution can invalidate existing page edits");
        await click('.pdf-batch-card[data-page="2"] .pdf-batch-open-page');await waitFor(`${ready}&&${canvas}.width===640`,"second page for refinement");
        await click('.image-resize-start');
        await ev(`(p=>{p.value='50';p.dispatchEvent(new Event('input'));})(${d}.querySelector('.image-resize-percent'))`);
        await click('.image-resize-apply');await click('.pdf-batch-keep');
        await waitFor(`${note}.startsWith('Page 2 kept')&&${ready}&&${canvas}.width===320`,"individual page refinement kept");
        await waitFor(`${ops}.length===3&&${ops}[1].textContent.startsWith('Remove background')&&${ops}[2].textContent.startsWith('Resize to 50%')&&${ops}[2].textContent.includes('from page 2; done on page 2')`,"background removal and resizing listed");
        if((await ev(`${d}.querySelector('.pdf-batch-apply').disabled`)))throw new Error("Batch apply not offered for page 1's missing resize");
        await click('.pdf-batch-clear');
        await waitFor(`${ops}.length===0&&!${d}.querySelector('.pdf-batch-ops-empty').hidden&&${d}.querySelector('.pdf-batch-ops-toggle').textContent==='Operations (0)'&&${d}.querySelector('.pdf-batch-apply').disabled`,"operations list cleared");
        if(!(await ev(`${d}.querySelector('.pdf-batch-card[data-page="2"] small').textContent==='Edited'`)))throw new Error("clearing the list changed a page");
        await click('.pdf-batch-card[data-page="1"] .pdf-batch-open-page');await waitFor(`${ready}&&${d}.querySelector('.pdf-batch-page-title').textContent==='Page 1'`,"first page restored");
        if(process.env.PDF_BATCH_SCREENSHOT){const shot=await checks.cdp('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.PDF_BATCH_SCREENSHOT,Buffer.from(shot.data,'base64'));}
        // All three encoders produce selected pages in source order.
        for(const format of ['png','jpeg','webp']){
            await ev(`(s=>{s.value=${JSON.stringify(format)};s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-format'))`);
            await click('.pdf-batch-export');await waitForFile(`${downloads}/batch-edited.zip`,`${format} page ZIP`);
            await waitFor(`${note}.startsWith('Exported 2 pages')&&${ready}`,"ZIP export finishes");
            const result=JSON.parse(execFileSync("python3",["-c",`import zipfile,json,sys,base64
with zipfile.ZipFile(sys.argv[1]) as z:
 print(json.dumps({'names':z.namelist(),'first':base64.b64encode(z.read(z.namelist()[0])).decode()}))`,`${downloads}/batch-edited.zip`],{encoding:"utf8"}));
            const ext=format==='jpeg'?'jpg':format;
            if(result.names.join(',')!==`page-001.${ext},page-002.${ext}`)throw new Error("ZIP page selection or order");
            const data=Buffer.from(result.first,'base64');
            if(format==='png'&&data.readUInt32BE(16)!==320)throw new Error("PNG page dimensions");
            if(format==='jpeg'&&data[0]!==255)throw new Error("JPEG page encoding");
            if(format==='webp'&&data.subarray(8,12).toString()!=='WEBP')throw new Error("WebP page encoding");
            rmSync(`${downloads}/batch-edited.zip`);
        }
        await ev(`(s=>{s.value='pdf';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-format'))`);
        await click('.pdf-batch-export');await waitForFile(`${downloads}/batch-edited.pdf`,"raster PDF export");await waitFor(`${note}.startsWith('Exported 2 pages')&&${ready}`,"PDF export finishes");
        const rebuilt=readFileSync(`${downloads}/batch-edited.pdf`);if(!rebuilt.subarray(0,8).toString().startsWith('%PDF-')||!rebuilt.includes(Buffer.from('/Count 2')))throw new Error("rebuilt PDF page count");
        if(!fixture.equals(execFileSync("docker",["exec",container,"cat","/home/user/Downloads/media/batch.pdf"])))throw new Error("batch editing modified the source PDF");
        await click('.pdf-batch-close');await waitFor(`!!document.querySelector('dialog:not(.preview):not(.pdf-image-editor)')`,"discard session prompt");
        await ev(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Leave').click()`);await waitFor(`!${d}`,"batch editor closed");
        await ev(`document.querySelector('dialog.preview button.close').click()`);await waitFor(`!document.querySelector('dialog.preview')`,"PDF preview closed");
        execFileSync("docker",["cp","-q",`${downloads}/batch-edited.pdf`,`${container}:/home/user/Downloads/media/batch-edited.pdf`]);
        execFileSync("docker",["exec",container,"chown","user","/home/user/Downloads/media/batch-edited.pdf"]);
        await open("fs/#/media/",`${listed}.includes('batch-edited.pdf')`,"rebuilt PDF listed");await ev(`[...document.querySelectorAll('td.name a')].find(a=>a.textContent==='batch-edited.pdf').click()`);
        await waitFor(`(()=>{const r=JSON.parse(document.querySelector('iframe.pdf')?.dataset.rendered??'null');return r?.pages===2&&r.drawn.includes(1);})()`,"rebuilt PDF rendered");
        if(!(await inFrame('pdf-frame.html',`document.querySelector('.page canvas').width>0`)))throw new Error("rebuilt PDF didn't draw");
        await ev(`document.querySelector('dialog.preview button.close').click()`);await waitFor(`!document.querySelector('dialog.preview')`,"rebuilt preview closed");
        execFileSync("docker",["exec",container,"rm","/home/user/Downloads/media/batch.pdf","/home/user/Downloads/media/batch-edited.pdf"]);rmSync(`${downloads}/batch-edited.pdf`);
        await open('fs/#/',`document.title==='Downloads /'&&!!document.querySelector('table')`,"listing restored");
    });
}
