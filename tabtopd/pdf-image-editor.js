// A local working copy of PDF pages. The PDF stays in its opaque sandbox;
// only requested raster pages cross the bridge. Nothing writes to the source.
import { el } from "./preview-dom.js";
import { glyphs } from "./glyphs.js";
import { saveBlob } from "./requests.js";
import { askYes } from "./ui.js";
import { imageView } from "./image-view.js";
import { pageRange, batchProcessor, describeStep, stepsFor, pageList, MAX_BATCH_PAGES, MAX_BATCH_BYTES } from "./image-batch.js";
import { stored, store } from "./stored.js";
import { encodePage, imageZIP, rasterPDF } from "./image-export.js";

const PDF_PAGE_DRAG = "application/x-tabtop-pdf-page";

// Decode image imports and edited-page thumbnails through the same PNG path.
async function rasterImage(blob, maxSide = Infinity) {
    const bitmap = await createImageBitmap(blob);
    try {
        if (bitmap.width * bitmap.height > 16e6 || Math.max(bitmap.width, bitmap.height) > 8192)
            throw new Error("This image exceeds 16 megapixels or 8192 pixels per side.");
        const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        const canvas = Object.assign(document.createElement("canvas"), { width, height });
        canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
        const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!png) throw new Error("The image could not be decoded.");
        return { blob: png, width, height };
    } finally {
        bitmap.close();
    }
}

async function localPDF(file, host, signal) {
    const { pdfFrame } = await import("./preview-frames.js");
    signal.throwIfAborted();
    const bytes = await file.arrayBuffer();
    signal.throwIfAborted();
    let frame, timer, abort;
    const stop = () => { frame?.stop(); frame?.remove(); };
    try {
        const pages = await new Promise((resolve, reject) => {
            abort = () => reject(new DOMException("Import cancelled.", "AbortError"));
            signal.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => reject(new Error("Opening the PDF timed out.")), 120000);
            frame = pdfFrame(file.name, { size: file.size, start: bytes, local: true }, {
                rendered: report => {
                    if (report.errors?.length) reject(new Error(report.errors[0]));
                    else if (Number.isSafeInteger(report.pages) && report.pages > 0) resolve(report.pages);
                },
            });
            frame.hidden = true;
            host.append(frame);
        });
        return { pages, bytes: file.size, renderPage: frame.renderPage, stop };
    } catch (err) {
        stop();
        throw err;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}

export function pdfImageEditor({ name, count, current = 1, renderPage, closed }) {
    let stopped = false, busy = false, loading = false, editor = null, image = null, imageURL = null;
    let active = current, original = null, undo = null, operation = null, pageAbort = null;
    // The operations list: each step applied to a page, in order, as
    // {step, page (it was made on), done (a Set of the pages that have
    // it)}; Batch apply gives each selected page the steps it hasn't had.
    // recorded is how many of the open page's steps are in it already.
    let operations = [], recorded = 0, undoDone = null;
    const lifetime = new AbortController(), processor = batchProcessor();
    const edits = new Map(), info = new Map(), failures = new Map(), cards = new Map();
    let working = count <= MAX_BATCH_PAGES ? Array.from({length:count},(_,i)=>i+1) : [current];
    let selected = new Set(working);
    let order = Array.from({length:count},(_,i)=>i+1), nextPage = count + 1, pageUndo = null;
    const added = new Map(), importedDocuments = new Set();
    let importedBytes = 0;
    const position = n => order.indexOf(n) + 1;
    const stem = name.replace(/\.pdf$/i, "") || "pages";
    const pageName = (n, extension = "png") => `page-${String(position(n)).padStart(Math.max(3,String(order.length).length),"0")}.${extension}`;
    const button = (text, cls, action) => {
        const control=el("button",{type:"button",className:cls,textContent:text});
        control.addEventListener("click",()=>Promise.resolve().then(action).catch(error));
        return control;
    };
    const note=el("p",{className:"pdf-batch-note hint",role:"status",textContent:"Select pages, then edit one page and reuse its active mask across the selection."});
    const say=(message,bad=false)=>{if(stopped)return;note.textContent=message;note.classList.toggle("error",bad);};
    const error=err=>{if(!stopped)say(err.message||String(err),true);};
    const range=el("input",{className:"pdf-batch-range",value:count<=MAX_BATCH_PAGES?`1-${count}`:String(current),ariaLabel:"Page numbers or ranges",placeholder:"1-3, 5"});
    const choose=button("Select pages","pdf-batch-choose",()=>{
        if(editor?.pending())throw new Error("Apply or cancel the current tool before changing pages.");
        const numbers=pageRange(range.value,order.length).map(n=>order[n-1]);working=order.filter(n=>numbers.includes(n));selected=new Set(numbers);buildCards();update();
        say(`${numbers.length} pages selected. Masks use relative page coordinates; review pages with different layouts.`);
    });
    const dpi=el("select",{className:"pdf-batch-dpi",ariaLabel:"Render resolution"},...[72,96,144,200,300].map(value=>el("option",{value:String(value),textContent:`${value} DPI`,selected:value===144})));
    dpi.addEventListener("change",()=>{info.clear();original=null;openPage(active,true).catch(error);});
    const output=el("select",{className:"pdf-batch-format",ariaLabel:"Export format"},
        ...[["png","PNG images (ZIP)"],["jpeg","JPEG images (ZIP)"],["webp","WebP images (ZIP)"],["pdf","PDF with image pages"]].map(([value,label])=>el("option",{value,textContent:label})));
    const quality=el("input",{type:"number",min:"1",max:"100",value:"92",className:"pdf-batch-quality",ariaLabel:"Export quality"});
    const qualityLabel=el("label",{className:"pdf-batch-quality-label",hidden:true},"Quality % ",quality);
    output.addEventListener("change",()=>{qualityLabel.hidden=output.value==="png";});
    const pageTitle=el("strong",{className:"pdf-batch-page-title",textContent:`Page ${active}`});
    const all=button("All","pdf-batch-all",()=>{selected=new Set(working);update();});
    const none=button("None","pdf-batch-none",()=>{selected.clear();update();});
    const keep=button("Keep page","pdf-batch-keep",async()=>{await keepPage();say(`Page ${position(active)} kept in this session. Export when ready.`);});
    const apply=button("Batch apply","pdf-batch-apply",()=>runBatch());
    apply.title="Apply the operations list to the selected pages, in order: exact masks, brush strokes, rotation, cropping and resizing, scaled to each page. A page isn't given an operation it already has.";
    const OPS_SHOWN="tabtop.pdf-operations-shown";
    const opsToggle=button("Operations","pdf-batch-ops-toggle",()=>{
        opsPanel.hidden=!opsPanel.hidden;store(OPS_SHOWN,opsPanel.hidden?null:"1");update();
    });
    const clearOps=button("Clear","pdf-batch-clear",()=>{
        operations=[];undoDone=null;
        // The open page's steps so far stay out of it: they're done.
        const live=editor?.batchRecipe();recorded=live?live.committed:0;
        update();say("Operations list cleared. Pages keep their edits.");
    });
    clearOps.title="Empty the operations list; pages keep the edits they have";
    const opsList=el("ol",{className:"pdf-batch-ops-list"});
    const opsEmpty=el("p",{className:"hint pdf-batch-ops-empty",textContent:"No operations yet. Edit a page: each step applied is added here."});
    const opsPanel=el("section",{className:"pdf-batch-ops",ariaLabel:"Operations list",hidden:stored(OPS_SHOWN)!=="1"},opsEmpty,opsList);
    const undoButton=button("Undo batch","pdf-batch-undo",async()=>{
        if(!undo)return;
        const previous=undo;undo=null;edits.clear();for(const [n,blob]of previous)edits.set(n,blob);
        // Which pages had which operations, as before it too.
        for(const[op,had]of undoDone??[])op.done=had;undoDone=null;
        failures.clear();refreshCards();await openPage(active,true);say("Last batch undone.");
    });
    const cancel=button("Cancel processing","pdf-batch-cancel",()=>{operation?.abort();processor.cancel();});
    cancel.hidden=true;
    const exportButton=button("Export selected","pdf-batch-export",()=>exportPages());
    const close=button("Back to PDF","pdf-batch-close",async()=>{
        if((pageUndo||order.some((n,i)=>n!==i+1)||added.size||edits.size||editor?.dirty()||editor?.pending())&&!await askYes("Leave the page editor? Exported copies are kept; changes in this session will be discarded.","Leave"))return;
        stop();
    });
    const widen=button(glyphs.expand,"pdf-batch-widen glyph",()=>{
        const wide=dialog.classList.toggle("wide");
        widen.textContent=wide?glyphs.contract:glyphs.expand;
        widen.title=wide?"Back to a box":"Fill the window";
        widen.setAttribute("aria-label",widen.title);
        widen.setAttribute("aria-pressed",String(wide));
    });
    widen.title="Fill the window";widen.setAttribute("aria-label",widen.title);widen.setAttribute("aria-pressed","false");
    const heading=el("header",{className:"pdf-batch-heading"},el("strong",{textContent:`${name} — pages as images`}),widen,close);
    const pdfInput=el("input",{type:"file",accept:"application/pdf,.pdf",multiple:true,hidden:true,className:"pdf-batch-pdf-input"});
    const imageInput=el("input",{type:"file",accept:"image/*",multiple:true,hidden:true,className:"pdf-batch-image-input"});
    const merge=button("Merge PDF", "pdf-batch-merge",()=>pdfInput.click());
    const addImage=button("Add image", "pdf-batch-add-image",()=>imageInput.click());
    for(const input of [pdfInput,imageInput])input.addEventListener("change",()=>{
        const files=[...input.files];input.value="";
        if(files.length)importFiles(files).catch(error);
    });
    const undoPages=button("Undo page change","pdf-batch-undo-pages",async()=>{
        if(!pageUndo)return;
        if(editor?.pending())throw new Error("Apply or cancel the current tool before changing pages.");
        loading=true;update();
        try{
            await keepPage();if(stopped)return;
            ({order,working,selected}=pageUndo);pageUndo=null;
            const removed=[...added.keys()].filter(n=>!order.includes(n));
            for(const n of removed){
                const page=added.get(n);if(page.blob)importedBytes-=page.blob.size;
                added.delete(n);edits.delete(n);info.delete(n);failures.delete(n);
            }
            for(const document of importedDocuments)if(![...added.values()].some(page=>page.document===document)){
                document.stop();importedDocuments.delete(document);importedBytes-=document.bytes;
            }
            if(removed.length){operations=operations.filter(op=>order.includes(op.page));undo=null;undoDone=null;}
            rebuildPages();
            if(!order.includes(active))await openPage(working[0],true);
            say("Last page change undone.");
        }finally{loading=false;update();}
    });
    const settings=el("div",{className:"pdf-batch-settings"},el("label",{},"Pages ",range),choose,merge,addImage,undoPages,pdfInput,imageInput,el("label",{},"Resolution ",dpi),el("span",{className:"hint",textContent:`Up to ${MAX_BATCH_PAGES} pages and 16 megapixels per page.`}));
    const list=el("div",{className:"pdf-batch-pages",ariaLabel:"PDF pages"});
    const sidebar=el("aside",{className:"pdf-batch-sidebar"},el("div",{className:"pdf-batch-selection"},all,none),el("small",{className:"pdf-batch-order-hint hint",textContent:"Drag pages to reorder."}),list);
    const host=el("div",{className:"pdf-batch-image"});
    const exports=el("span",{className:"pdf-batch-exports"},output,qualityLabel,exportButton);
    const actions=el("div",{className:"pdf-batch-actions"},pageTitle,keep,opsToggle,apply,clearOps,undoButton,cancel,exports);
    const workspace=el("div",{className:"pdf-batch-workspace"},sidebar,el("section",{className:"pdf-batch-editor"},actions,opsPanel,host));
    const exportHint=el("small",{className:"pdf-batch-export-hint hint",textContent:"PDF exports contain image pages; selectable text and links are not retained. Transparent areas are white in JPEG and PDF."});
    const dialog=el("dialog",{className:"pdf-image-editor",ariaLabel:"Edit PDF pages as images"},heading,settings,workspace,note,exportHint);
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener("cancel",event=>{event.preventDefault();if(busy){operation?.abort();processor.cancel();}else close.click();});

    function rebuildPages() {
        range.value=working.map(position).join(", ");
        buildCards();update();
    }
    function rememberPages(){pageUndo={order:[...order],working:[...working],selected:new Set(selected)};}
    async function movePage(n,target,after){
        if(stopped||busy||loading||n===target||!order.includes(target))return;
        if(editor?.pending())throw new Error("Apply or cancel the current tool before changing pages.");
        rememberPages();order=order.filter(id=>id!==n);order.splice(order.indexOf(target)+(after?1:0),0,n);
        working=order.filter(id=>working.includes(id));
        rebuildPages();say(`Page moved to position ${position(n)}. Exports follow the sidebar order.`);
        cards.get(n)?.open.focus();
    }
    async function importFiles(files){
        if(stopped||busy||loading)return;
        if(editor?.pending())throw new Error("Apply or cancel the current tool before adding pages.");
        const bytes=files.reduce((sum,file)=>sum+file.size,0);
        if(bytes+importedBytes>MAX_BATCH_BYTES)throw new Error("Imported files exceed 256 MiB. Start another PDF editing session.");
        busy=true;operation=new AbortController();const signal=operation.signal;update();
        const incoming=[],documents=[];let retainedBytes=0;
        try{
            await keepPage();signal.throwIfAborted();
            for(const file of files){
                say(`Adding ${file.name}…`);
                if(file.type==="application/pdf"||/\.pdf$/i.test(file.name)){
                    const imported=await localPDF(file,dialog,signal);documents.push(imported);retainedBytes+=file.size;
                    if(working.length+incoming.length+imported.pages>MAX_BATCH_PAGES)throw new Error(`Choose at most ${MAX_BATCH_PAGES} pages at a time.`);
                    for(let page=1;page<=imported.pages;page++)incoming.push({document:imported,page});
                }else{
                    const page=await rasterImage(file);
                    incoming.push({...page,widthPt:page.width*.75,heightPt:page.height*.75});
                    retainedBytes+=page.blob.size;
                }
                if(working.length+incoming.length>MAX_BATCH_PAGES)throw new Error(`Choose at most ${MAX_BATCH_PAGES} pages at a time.`);
                if(importedBytes+retainedBytes>MAX_BATCH_BYTES)throw new Error("Imported pages exceed 256 MiB. Choose fewer or smaller images.");
                signal.throwIfAborted();
            }
            signal.throwIfAborted();rememberPages();
            for(const page of incoming){const n=nextPage++;added.set(n,page);order.push(n);working.push(n);selected.add(n);}
            importedBytes+=retainedBytes;
            for(const document of documents)importedDocuments.add(document);
            rebuildPages();say(`Added ${incoming.length} ${incoming.length===1?"page":"pages"}. Drag thumbnails to reorder, then export as PDF.`);
        }catch(err){for(const document of documents)document.stop();if(signal.aborted)say("Import cancelled. No pages added.");else throw err;}
        finally{busy=false;operation=null;if(!stopped)update();}
    }
    function update(){
        if(stopped)return;
        const blocked=busy||loading, pending=!!editor?.pending();
        const currentRecipe=editor?.batchRecipe(),shown=listed(currentRecipe);
        for(const control of [range,choose,output,quality,all,none,exportButton])control.disabled=blocked;
        merge.disabled=addImage.disabled=blocked||pending;
        undoPages.disabled=blocked||pending||!pageUndo;
        range.setAttribute("aria-label",`Page numbers or ranges (1–${order.length})`);
        pageTitle.textContent=`Page ${position(active)}`;
        dpi.disabled=blocked||edits.size>0||!!editor?.dirty()||pending;
        keep.disabled=blocked||!editor||pending;
        exportButton.disabled=blocked||!selected.size||pending;
        // A tool still in use is applied with the rest, once it can be.
        const toDo=[...selected].some(n=>stepsFor(shown,n).length>0);
        apply.disabled=blocked||!toDo||(pending&&!currentRecipe);
        apply.textContent=`Batch apply to ${selected.size} selected`;
        clearOps.disabled=blocked||!operations.length&&!shown.some(op=>!op.pending);
        opsToggle.textContent=`Operations (${shown.length})`;
        opsToggle.setAttribute("aria-expanded",String(!opsPanel.hidden));
        if(!opsPanel.hidden)showOperations(shown);
        undoButton.disabled=blocked||!undo||pending;
        close.disabled=busy;
        cancel.hidden=!busy;
        host.inert=blocked;
        for(const[n,card]of cards){
            card.element.draggable=!blocked&&!pending;
            card.check.checked=selected.has(n);
            card.check.disabled=card.open.disabled=blocked;
            card.open.setAttribute("aria-current",String(n===active));
            card.status.textContent=failures.has(n)?`Failed: ${failures.get(n)}`:edits.has(n)?"Edited":"Original";
        }
        exportButton.textContent=`Export ${selected.size} selected`;
    }
    // listed is the operations list as shown: those recorded, then the
    // open page's steps not yet recorded (from its recipe, live), the last
    // of them pending if it's a tool still in use.
    function listed(live=editor?.batchRecipe()){
        const out=[...operations];
        if(live)live.steps.slice(recorded).forEach((step,i)=>{
            const pending=recorded+i>=live.committed;
            out.push({step,page:active,done:new Set(pending?[]:[active]),pending});
        });
        return out;
    }
    // record adds the open page's applied steps to the list, and with
    // withPending, the tool in use too (not yet done anywhere).
    function record(withPending=false){
        const live=editor?.batchRecipe();if(!live)return;
        const upto=withPending?live.steps.length:live.committed;
        for(const op of listed(live).slice(operations.length)){
            if(op.pending&&!withPending)break;
            operations.push({step:structuredClone(op.step),page:op.page,done:op.done});
        }
        recorded=Math.max(recorded,upto);
    }
    function showOperations(shown){
        opsEmpty.hidden=shown.length>0;
        opsList.replaceChildren(...shown.map(op=>{
            const done=[...op.done].filter(n=>order.includes(n)).map(position).sort((a,b)=>a-b);
            return el("li",{className:op.pending?"pending":""},
                el("span",{className:"pdf-batch-op-name",textContent:describeStep(op.step)}),
                el("small",{className:"hint",textContent:op.pending?`in progress on page ${position(op.page)}`
                    :`from page ${position(op.page)}${done.length?`; done on ${done.length===1?"page":"pages"} ${pageList(done)}`:""}`}));
        }));
    }
    function putEdit(n,blob){
        const total=[...edits].reduce((sum,[page,data])=>sum+(page===n?0:data.size),blob.size);
        if(total>MAX_BATCH_BYTES)throw new Error("Edited pages exceed 256 MiB. Export this batch and start another.");
        edits.set(n,blob);failures.delete(n);queueThumb(n);update();
    }
    function renderPDFPage(n, resolution, signal, thumbnail = false) {
        const extra=added.get(n);
        return extra ? extra.document.renderPage(extra.page,resolution,signal,thumbnail)
            : renderPage(n,resolution,signal,thumbnail);
    }
    async function source(n,signal){
        if(edits.has(n))return edits.get(n);
        if(original?.number===n)return original.blob;
        const extra=added.get(n);
        if(extra?.blob){info.set(n,extra);return extra.blob;}
        const rendered=await renderPDFPage(n,Number(dpi.value),signal);
        info.set(n,{width:rendered.width,height:rendered.height,widthPt:rendered.widthPt,heightPt:rendered.heightPt});
        return rendered.blob;
    }
    async function keepPage(beforeTool=false){
        if(!editor)return;
        if(!beforeTool&&editor.pending())throw new Error("Apply or cancel the current tool first.");
        if(editor.dirty()){
            const n=active,blob=await editor.snapshot({beforeTool});
            if(!stopped)putEdit(n,blob);
        }
        if(!stopped)record();
    }
    function disposeImage(){
        editor?.stop();editor=null;recorded=0;image?.stop();image=null;
        if(imageURL)URL.revokeObjectURL(imageURL);imageURL=null;host.replaceChildren();
    }
    async function openPage(n,discard=false){
        if(stopped)return;
        if(!discard){
            if(busy||loading)return;
            if(editor?.pending())throw new Error("Apply or cancel the current tool before switching pages.");
            loading=true;update();
            try{await keepPage();}catch(err){loading=false;update();throw err;}
            if(stopped)return;
        }
        loading=true;pageAbort?.abort();pageAbort=new AbortController();const signal=pageAbort.signal;
        disposeImage();active=n;pageTitle.textContent=`Page ${n}`;update();
        try{
            const blob=await source(n,signal);signal.throwIfAborted();
            original=edits.has(n)?null:{number:n,blob};imageURL=URL.createObjectURL(blob);
            const next=await imageView({file:{name:pageName(n),size:blob.size,type:"image/png"},blob,url:imageURL});
            if(signal.aborted||stopped){next.stop?.();return;}
            image=next;host.replaceChildren(image);
            editor=await image.startEditing({save:blob=>{putEdit(n,blob);},saveCopy:async blob=>{putEdit(n,blob);return{name:pageName(n)};},changed:update,maxPixels:16e6,toolScope:dialog});
            if(!editor)throw new Error("This page couldn't be edited.");
            // Batch export owns encoding; save settings for a virtual page
            // would otherwise imply that changing them changes the export.
            image.querySelector(".image-save-options-group").hidden=true;
        }finally{if(!signal.aborted){loading=false;update();}}
    }
    async function runBatch(){
        if(busy||loading||stopped)return;
        if(!selected.size)throw new Error("Select at least one page.");
        if(editor?.pending()&&!editor.batchRecipe())throw new Error("Finish marking the current tool or cancel it first.");
        // Checked before anything's kept or reopened: nothing's lost.
        if(!listed().length)throw new Error("Edit a page first: the operations list is empty.");
        busy=true;operation=new AbortController();const signal=operation.signal;update();
        let done=0,failed=0;
        try{
            // The tool in use joins the list, to be applied to this page
            // too: the page is kept as it was before it.
            record(true);
            await keepPage(true);signal.throwIfAborted();
            undo=new Map(edits);undoDone=new Map(operations.map(op=>[op,new Set(op.done)]));
            for(const n of order.filter(n=>selected.has(n))){
                signal.throwIfAborted();say(`Processing page ${position(n)} (${done+failed+1} of ${selected.size})…`);
                try{
                    const todo=operations.filter(op=>!op.done.has(n));
                    if(todo.length){
                        const blob=await processor.apply(await source(n,signal),{kind:"sequence",steps:todo.map(op=>op.step)},signal);signal.throwIfAborted();
                        putEdit(n,blob);for(const op of todo)op.done.add(n);
                    }
                    done++;
                }
                catch(err){if(signal.aborted)throw err;failures.set(n,err.message);failed++;update();}
            }
            say(`${done} ${done===1?"page":"pages"} processed${failed?`; ${failed} failed — review the marked pages`:". Review the results, then export."}`,failed>0);
        }catch(err){if(signal.aborted)say(`Cancelled. ${done} completed pages kept; Undo batch restores the previous results.`);else error(err);}
        finally{processor.cancel();busy=false;operation=null;if(!stopped){await openPage(active,true);update();}}
    }
    async function exportPages(){
        if(busy||loading||stopped)return;
        if(editor?.pending())throw new Error("Apply or cancel the current tool before exporting.");
        if(!selected.size)throw new Error("Select pages to export.");
        const q=Number(quality.value)/100;if(!Number.isFinite(q)||q<.01||q>1)throw new Error("Choose a quality from 1 to 100.");
        busy=true;operation=new AbortController();const signal=operation.signal;update();
        const entries=[],pdfPages=[];let bytes=0;
        try{
            await keepPage();signal.throwIfAborted();
            for(const n of order.filter(n=>selected.has(n))){
                signal.throwIfAborted();say(`Preparing page ${position(n)} for export…`);
                const blob=await source(n,signal),type=output.value==="pdf"?"image/jpeg":`image/${output.value}`;
                const encoded=await encodePage(blob,type,q);signal.throwIfAborted();bytes+=encoded.blob.size;
                if(bytes>MAX_BATCH_BYTES)throw new Error("The export exceeds 256 MiB. Choose fewer pages or a lower resolution.");
                if(output.value==="pdf"){
                    const dimensions=info.get(n);
                    if(!dimensions)throw new Error("Page dimensions are missing. Reopen the page and try again.");
                    pdfPages.push({...encoded,widthPt:dimensions.widthPt*encoded.width/dimensions.width,heightPt:dimensions.heightPt*encoded.height/dimensions.height});
                }else entries.push({name:pageName(n,output.value==="jpeg"?"jpg":output.value),blob:encoded.blob});
            }
            const blob=output.value==="pdf"?rasterPDF(pdfPages):await imageZIP(entries,signal);
            signal.throwIfAborted();saveBlob(blob,`${stem}-edited.${output.value==="pdf"?"pdf":"zip"}`);say(`Exported ${selected.size} pages. The source PDF is unchanged.`);
        }catch(err){if(signal.aborted)say("Export cancelled. Page edits are kept.");else throw err;}
        finally{busy=false;operation=null;update();}
    }

    // Thumbnails are requested only when visible, one at a time. Edited
    // thumbnails use their stored PNG; unedited pages stay in the PDF frame.
    const thumbs=[],observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);queueThumb(Number(entry.target.dataset.page));}},{root:list,rootMargin:"120px"});
    let drawingThumb=false;
    function queueThumb(n){const card=cards.get(n);if(!card)return;card.version++;thumbs.push([n,card.version]);drawThumbs();}
    async function drawThumbs(){
        if(drawingThumb||stopped)return;drawingThumb=true;
        try{while(thumbs.length&&!stopped){
            const[n,version]=thumbs.shift(),card=cards.get(n);if(!card||card.version!==version)continue;
            try{
                let blob=edits.get(n)??added.get(n)?.blob;
                if(blob)blob=(await rasterImage(blob,144)).blob;
                else blob=(await renderPDFPage(n,36,lifetime.signal,true)).blob;
                if(stopped||cards.get(n)!==card||card.version!==version)continue;
                if(card.url)URL.revokeObjectURL(card.url);card.url=URL.createObjectURL(blob);card.img.src=card.url;
            }catch(err){if(!stopped){card.status.textContent=`Preview: ${err.message}`;}}
        }}finally{drawingThumb=false;}
    }
    function bindPageDrag(card,n) {
        const dropAfter=event=>event.clientY>card.getBoundingClientRect().top+card.offsetHeight/2;
        card.addEventListener("dragstart",event=>{
            if(busy||loading||editor?.pending()){event.preventDefault();return;}
            event.dataTransfer.setData(PDF_PAGE_DRAG,String(n));event.dataTransfer.effectAllowed="move";
        });
        card.addEventListener("dragover",event=>{
            if(![...event.dataTransfer.types].includes(PDF_PAGE_DRAG)||busy||loading||editor?.pending())return;
            event.preventDefault();event.dataTransfer.dropEffect="move";
            card.classList.toggle("drop-after",dropAfter(event));
            card.classList.add("drop-target");
        });
        card.addEventListener("dragleave",()=>card.classList.remove("drop-target","drop-after"));
        card.addEventListener("drop",event=>{
            event.preventDefault();
            const from=Number(event.dataTransfer.getData(PDF_PAGE_DRAG));
            const after=dropAfter(event);
            card.classList.remove("drop-target","drop-after");
            if(order.includes(from))movePage(from,n,after).catch(error);
        });
        card.addEventListener("dragend",()=>list.querySelectorAll(".drop-target").forEach(c=>c.classList.remove("drop-target","drop-after")));
    }
    function clearCards() {
        observer.disconnect();
        for(const card of cards.values())if(card.url)URL.revokeObjectURL(card.url);
        cards.clear();list.replaceChildren();
    }
    function buildCards(){
        clearCards();
        for(const n of working){
            const check=el("input",{type:"checkbox",checked:selected.has(n),ariaLabel:`Select page ${position(n)}`});
            check.addEventListener("change",()=>{check.checked?selected.add(n):selected.delete(n);update();});
            const img=el("img",{alt:`Page ${position(n)} preview`,draggable:false}),status=el("small",{className:"hint",textContent:edits.has(n)?"Edited":"Original"});
            const open=button("","pdf-batch-open-page",()=>openPage(n));open.append(img,el("span",{textContent:`Page ${position(n)}`}),status);
            const card=el("div",{className:"pdf-batch-card",draggable:true},check,open);card.dataset.page=String(n);
            bindPageDrag(card,n);
            cards.set(n,{element:card,check,open,img,status,url:null,version:0});list.append(card);observer.observe(card);
        }
    }
    function refreshCards(){for(const n of cards.keys())queueThumb(n);update();}
    function stop(){
        if(stopped)return;
        stopped=true;
        lifetime.abort();pageAbort?.abort();operation?.abort();processor.cancel();
        clearCards();disposeImage();
        for(const imported of importedDocuments)imported.stop();
        importedDocuments.clear();added.clear();edits.clear();undo=null;pageUndo=null;
        dialog.close();dialog.remove();closed?.();
    }
    buildCards();openPage(active,true).catch(error);update();
    return{stop,focus:()=>dialog.focus()};
}
