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
        await ev(`(s=>{s.value='jpeg';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-format'))`);
        const heights=await ev(`['.pdf-batch-range','.pdf-batch-dpi','.pdf-batch-format','.pdf-batch-quality'].map(s=>Math.round(${d}.querySelector(s).getBoundingClientRect().height))`);
        if(new Set(heights).size!==1)throw new Error(`the page range, resolution, format and quality differ in height: ${JSON.stringify(heights)}`);
        await ev(`(s=>{s.value='png';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-format'))`);
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
    await checkPDFAssembly(checks);
}


export async function checkPDFAssembly(checks){
    const{ev,step,work,container,open,listed,waitFor,inFrame,downloads,waitForFile}=checks;
    await step("files: merge PDFs, insert image pages, reorder thumbnails, undo and export",async()=>{
        const base64=await ev(`(async()=>{
            const{rasterPDF}=await import('/tabtop/image-export.js');
            const c=Object.assign(document.createElement('canvas'),{width:200,height:300}),x=c.getContext('2d');
            x.fillStyle='rgb(140,160,180)';x.fillRect(0,0,200,300);
            const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));
            const bytes=new Uint8Array(await rasterPDF([{blob,width:200,height:300,widthPt:100,heightPt:150},{blob,width:200,height:300,widthPt:100,heightPt:150}]).arrayBuffer());
            let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text);
        })()`);
        const fixture=Buffer.from(base64,"base64");writeFileSync(`${work}/assembly.pdf`,fixture);
        execFileSync("docker",["cp","-q",`${work}/assembly.pdf`,`${container}:/home/user/Downloads/media/assembly.pdf`]);
        execFileSync("docker",["exec",container,"chown","user","/home/user/Downloads/media/assembly.pdf"]);
        await open("fs/#/media/",`${listed}.includes("assembly.pdf")`,"assembly PDF listed");
        await ev(`[...document.querySelectorAll('td.name a')].find(a=>a.textContent==='assembly.pdf').click()`);
        await waitFor(`JSON.parse(document.querySelector('iframe.pdf')?.dataset.rendered??'null')?.pages===2`,"assembly source shown");
        const d=`document.querySelector('dialog.pdf-image-editor')`,v=`${d}.querySelector('.image-view')`;
        const click=async selector=>{
            await ev(`${d}.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
            await checks.click(`${d}.querySelector(${JSON.stringify(selector)})`);
        };
        const canvas=`${v}?.querySelector('canvas.image-content')`,note=`${d}.querySelector('.pdf-batch-note').textContent`;
        const ready=`!!${canvas}&&!${d}.querySelector('.pdf-batch-keep').disabled`;
        // Add image pages and another PDF, retain edits by identity, reorder,
        // undo page changes, and export in the sidebar's displayed order.
        await inFrame("pdf-frame.html",`document.querySelector('.edit-images').click()`);
        await waitFor(`${d}&&${ready}`,"assembly editor ready");
        await ev(`(async()=>{
            const {rasterPDF}=await import('/tabtop/image-export.js');
            const c=Object.assign(document.createElement('canvas'),{width:120,height:80}),x=c.getContext('2d');
            x.fillStyle='rgb(20,210,40)';x.fillRect(0,0,120,80);
            window.pdfAssemblyImage=new File([await new Promise(r=>c.toBlob(r,'image/png'))],'insert.png',{type:'image/png'});
            c.width=100;c.height=160;x.fillStyle='rgb(30,50,220)';x.fillRect(0,0,100,160);
            const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));
            window.pdfAssemblyPDF=new File([rasterPDF([{blob,width:100,height:160,widthPt:50,heightPt:80}])],'merge.pdf',{type:'application/pdf'});
        })()`);
        const importFile=async(selector,expression)=>{
            await ev(`(()=>{const dt=new DataTransfer();dt.items.add(${expression});const input=${d}.querySelector(${JSON.stringify(selector)});input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
        };
        const dragPage=async(from,to)=>ev(`(()=>{
            const source=${d}.querySelector('.pdf-batch-card[data-page="${from}"]');
            const target=${d}.querySelector('.pdf-batch-card[data-page="${to}"]');
            const dataTransfer=new DataTransfer(),clientY=target.getBoundingClientRect().top+1;
            source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
            for(const type of ['dragover','drop'])target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer,clientY}));
        })()`);
        const cardOrder=`[...${d}.querySelectorAll('.pdf-batch-card')].map(c=>Number(c.dataset.page))`;
        await importFile('.pdf-batch-pdf-input','window.pdfAssemblyPDF');
        await waitFor(`${note}.startsWith('Added 1 page')&&${ready}&&${cardOrder}.length===3`,"PDF appended",120000);
        await click('.pdf-batch-card[data-page="3"] .pdf-batch-open-page');
        await waitFor(`${ready}&&${canvas}.width===100&&${canvas}.height===160`,"merged PDF page rendered through its sandbox");
        await ev(`(s=>{s.value='72';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-dpi'))`);
        await waitFor(`${ready}&&${canvas}.width===50&&${canvas}.height===80`,"merged PDF resolution changed");
        await ev(`(s=>{s.value='144';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-dpi'))`);
        await waitFor(`${ready}&&${canvas}.width===100&&${canvas}.height===160`,"merged PDF resolution restored");
        // PDF source points remain 50x80 even though the current render is 144 DPI.
        await importFile('.pdf-batch-image-input','window.pdfAssemblyImage');
        await waitFor(`${note}.startsWith('Added 1 page')&&${ready}&&${cardOrder}.length===4`,"image appended");
        await click('.pdf-batch-card[data-page="4"] .pdf-batch-open-page');
        await waitFor(`${ready}&&${canvas}.width===120&&${canvas}.height===80`,"image opened");
        await click('.pdf-batch-undo-pages');
        await waitFor(`${ready}&&${cardOrder}.length===3&&${note}==='Last page change undone.'`,"image insertion undone while that page was open");
        await importFile('.pdf-batch-image-input','window.pdfAssemblyImage');
        await waitFor(`${note}.startsWith('Added 1 page')&&${ready}&&${cardOrder}.length===4`,"image reinserted");
        const imageID=await ev(`${cardOrder}.at(-1)`);
        await click(`.pdf-batch-card[data-page="${imageID}"] .pdf-batch-open-page`);
        await waitFor(`${ready}&&${canvas}.width===120`,"reinserted image opened");
        await click('.image-rotate-right');
        await waitFor(`${canvas}.width===80&&${canvas}.height===120`,"image-page edit");
        await dragPage(imageID,3);
        await waitFor(`JSON.stringify(${cardOrder})===${JSON.stringify(JSON.stringify([1,2,imageID,3]))}`,"drag reorders pages");
        await click('.pdf-batch-undo-pages');
        await waitFor(`JSON.stringify(${cardOrder})===${JSON.stringify(JSON.stringify([1,2,3,imageID]))}&&${ready}`,"page reorder undone");
        await dragPage(imageID,1);
        await waitFor(`JSON.stringify(${cardOrder})===${JSON.stringify(JSON.stringify([imageID,1,2,3]))}&&${d}.querySelector('.pdf-batch-page-title').textContent==='Page 1'`,"thumbnail drag reorders while retaining the active image-page edit");
        if(!(await ev(`${canvas}.width===80&&${canvas}.height===120`)))throw new Error('reordering lost the active image edit');
        // A malformed second image rolls the entire import back.
        await ev(`(()=>{const dt=new DataTransfer();dt.items.add(window.pdfAssemblyImage);dt.items.add(new File(['invalid'],'bad.png',{type:'image/png'}));const input=${d}.querySelector('.pdf-batch-image-input');input.files=dt.files;input.dispatchEvent(new Event('change'));})()`);
        await waitFor(`${d}.querySelector('.pdf-batch-note').classList.contains('error')&&${ready}`,"failed image import reported");
        if(await ev(`${cardOrder}.length`)!==4)throw new Error('failed import left partial image pages');
        await ev(`(s=>{s.value='pdf';s.dispatchEvent(new Event('change'));})(${d}.querySelector('.pdf-batch-format'))`);
        await click('.pdf-batch-export');await waitForFile(`${downloads}/assembly-edited.pdf`,"assembled PDF exported");
        await waitFor(`${note}.startsWith('Exported 4 pages')&&${ready}`,"assembled PDF export completed");
        const assembled=readFileSync(`${downloads}/assembly-edited.pdf`);
        const boxes=[...assembled.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m=>m.slice(1).map(Number));
        if(!assembled.includes(Buffer.from('/Count 4'))||boxes.length!==4||boxes[0][0]!==60||boxes[0][1]!==90||boxes[3][0]!==50||boxes[3][1]!==80)throw new Error(`assembled PDF lost page order, dimensions or image edit: ${JSON.stringify(boxes)}`);
        await click('.pdf-batch-close');
        await waitFor(`!!document.querySelector('dialog:not(.preview):not(.pdf-image-editor)')`,"assembly discard prompt");
        await ev(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Leave').click()`);
        await waitFor(`!${d}`,"assembly editor closed");
        await ev(`delete window.pdfAssemblyImage;delete window.pdfAssemblyPDF;document.querySelector('dialog.preview button.close').click()`);
        await waitFor(`!document.querySelector('dialog.preview')`,"rebuilt preview closed");
        rmSync(`${downloads}/assembly-edited.pdf`);

        if(!fixture.equals(execFileSync("docker",["exec",container,"cat","/home/user/Downloads/media/assembly.pdf"])))throw new Error("assembly modified the source PDF");
        execFileSync("docker",["exec",container,"rm","/home/user/Downloads/media/assembly.pdf"]);
        await open('fs/#/',`document.title==='Downloads /'&&!!document.querySelector('table')`,"assembly listing restored");
    });
}
