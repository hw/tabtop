import { execFileSync } from "node:child_process";
import { png } from "./images.mjs";

export async function checkImageDiff({ container, inContainer, open, listed, row, ev, waitFor, press, click, step, cdp }) {
    const root = "/home/user/Downloads/image-diff-check";
    inContainer("mkdir", "-p", root + "/folder");
    const put = (name, data) => execFileSync("docker", ["exec", "-i", "-u", "user", container, "sh", "-c", 'cat > "$1"', "image-diff-fixture", root + "/" + name], { input: data });
    const base = [40,60,80,255];
    put("a.png", png(4,3,()=>base)); put("same.png",png(4,3,()=>base));
    put("b.png", png(4,3,(x,y)=>x===1&&y===1?[60,60,80,255]:base));
    put("alpha-a.png",png(2,1,x=>x?[255,0,0,0]:[0,0,0,0]));
    put("alpha-b.png",png(2,1,x=>x?[0,255,0,0]:[0,0,0,128]));
    put("wide.png",png(2,1,()=>[0,0,0,0])); put("tall.png",png(1,2,()=>[0,0,0,0]));
    put("scroll-a.png",png(1200,1000,(x,y)=>[x%256,y%256,0,255]));
    put("scroll-b.png",png(1200,1000,(x,y)=>[x%256,y%256,1,255]));
    put("source.svg",'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><script>globalThis.imageDiffPwned=true</script><rect width="4" height="3" fill="rgb(40,60,80)"/></svg>');
    put("huge.svg",'<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="1"/>');
    put("bad.png","not a picture");put("text.txt","text");
    inContainer("truncate","-s","50000001",root+"/oversize.png");
    const dialog='document.querySelector("dialog.image-diff[open]")';
    const summary=`${dialog}?.querySelector(".image-diff-summary").textContent`;
    const select=async (...names)=>{
        await open("fs/#/image-diff-check/",`${listed}.includes("a.png")`,"image comparison fixtures");
        for (const name of names) await waitFor(`${listed}.includes(${JSON.stringify(name)})`, "image fixture " + name);
        await ev(`document.querySelector(".selection button:last-child")?.click()`);
        for(const name of names) await ev(`${row(name)}.querySelector('input[type=checkbox]').click()`);
    };
    const compare=async(...names)=>{
        await select(...names);await click('document.querySelector("button.compare-images")');
        await waitFor(`!!${dialog}`,"image comparison opens");
        await waitFor(`${summary}!=="Loading images…" && ${summary}!=="Comparing pixels…"`,"image comparison finishes");
        if(await ev(`${summary}?.startsWith("Can't compare")`)) throw new Error(await ev(summary));
    };
    const close=async()=>{await press("Escape");await waitFor(`!${dialog}`,"image comparison closes");};
    const pixel=async(side,x,y)=>ev(`(()=>{const src=${dialog}.querySelector('[data-side="${side}"] canvas');const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(src,${x},${y},1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];})()`);
    await step("image diff: selection and exact A/B/delta pixels",async()=>{
        for(const names of [["a.png"],["a.png","text.txt"],["a.png","folder/"],["a.png","oversize.png"],["a.png","b.png","same.png"]]) {
            await select(...names);
            if(!await ev('document.querySelector("button.compare-images").hidden'))throw new Error("invalid selection offered image comparison");
        }
        await select("a.png","b.png");
        if(await ev('document.querySelector("button.compare-images").hidden || !document.querySelector("button.compare-files").hidden'))throw new Error("two images weren't offered image comparison alone");
        await compare("a.png","b.png");
        if(!await ev(`${summary}.startsWith("1 of 12 pixels differ") && ${dialog}.querySelectorAll('figure:not([hidden])').length===2`))throw new Error("wrong delta summary or missing side-by-side pane");
        if(JSON.stringify(await pixel("a",1,1))!=="[40,60,80,255]"||JSON.stringify(await pixel("b",1,1))!=="[60,60,80,255]"||JSON.stringify(await pixel("delta",1,1))!=="[20,0,0,255]"||JSON.stringify(await pixel("delta",0,0))!=="[0,0,0,255]")throw new Error("incorrect original or delta pixels");
        await click(`${dialog}.querySelector(".image-diff-maximize")`);
        await waitFor(`${dialog}.classList.contains("wide") && ${dialog}.querySelector(".image-diff-maximize").getAttribute("aria-pressed")==="true" && Math.abs(${dialog}.getBoundingClientRect().width-innerWidth)<2`, "comparison maximized");
        await click(`${dialog}.querySelector(".image-diff-maximize")`);
        await waitFor(`!${dialog}.classList.contains("wide") && ${dialog}.querySelector(".image-diff-maximize").getAttribute("aria-label")==="Maximize"`, "comparison size restored");
        await click(`${dialog}.querySelector('[data-mode="slider"]')`);
        await waitFor(`${dialog}.querySelector('[data-side="slider"]').hidden===false`, "slider view");
        const divider = `${dialog}.querySelector('.image-diff-divider')`;
        await ev(`${divider}.focus()`); await press("ArrowRight");
        await waitFor(`${divider}.getAttribute('aria-valuenow')==='51'`, "keyboard reveal");
        await click(`${dialog}.querySelector('.image-diff-overlay-toggle')`);
        if (!await ev(`!${dialog}.querySelector('.image-diff-overlay').hidden && ${dialog}.querySelector('.image-diff-overlay-toggle').getAttribute('aria-pressed')==='true'`)) throw new Error("overlay not enabled");
        const overlayPixel = await ev(`(()=>{const c=${dialog}.querySelector('.image-diff-overlay');const out=document.createElement('canvas');out.width=out.height=1;const ctx=out.getContext('2d');ctx.drawImage(c,1,1,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];})()`);
        if (overlayPixel[3]!==255) throw new Error("changed pixel not highlighted");
        const unchangedPixel = await ev(`(()=>{const c=${dialog}.querySelector('.image-diff-overlay');const out=document.createElement('canvas');out.width=out.height=1;const ctx=out.getContext('2d');ctx.drawImage(c,0,0,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];})()`);
        if (unchangedPixel[3]!==0) throw new Error("unchanged overlay pixel isn't transparent");
        await click(`${dialog}.querySelector('.image-diff-swap')`);
        if (!await ev(`${divider}.getAttribute('aria-valuetext').includes('51% B')`)) throw new Error("slider sides not swapped");
        await press("d");await waitFor(`${dialog}.querySelector('figure:not([hidden])').dataset.side==='delta'`,"delta-only view");
        await press("a");await waitFor(`${dialog}.querySelector('figure:not([hidden])').dataset.side==='a'`,"A-only view");
        await press("b");await waitFor(`${dialog}.querySelector('figure:not([hidden])').dataset.side==='b'`,"B-only view");
        await ev(`${dialog}.querySelector('[data-mode="all"]').click();(()=>{const gain=${dialog}.querySelector('.image-diff-gain');gain.value='4';gain.dispatchEvent(new Event('input'));})()`);
        if(!await ev(`${dialog}.querySelector('[data-side="delta"] canvas').style.filter==='brightness(4)'`))throw new Error("delta gain didn't update");
        await close();
        if(!await ev('document.activeElement.matches("button.compare-images")'))throw new Error("comparison didn't restore focus");
    });
    await step("image diff: transparency, dimension mismatch, identical images and safe SVG",async()=>{
        await compare("alpha-a.png","alpha-b.png");
        if(!await ev(`${summary}.startsWith("1 of 2 pixels differ")`))throw new Error("hidden transparent RGB counted as different");
        if(JSON.stringify(await pixel("delta",0,0))!=="[128,128,128,255]"||JSON.stringify(await pixel("delta",1,0))!=="[0,0,0,255]")throw new Error("alpha delta incorrect");
        await close();await compare("wide.png","tall.png");
        if(!await ev(`${summary}.startsWith("2 of 3 pixels differ") && ${summary}.includes("Dimensions differ")`))throw new Error("dimension mismatch not reported");
        if(JSON.stringify(await pixel("delta",1,0))!=="[255,0,255,255]"||JSON.stringify(await pixel("delta",0,1))!=="[255,0,255,255]"||JSON.stringify(await pixel("delta",1,1))!=="[0,0,0,255]")throw new Error("missing areas not marked correctly");
        await close();await compare("a.png","same.png");
        if(await ev(summary)!=="Images have identical decoded pixels.")throw new Error("identical images differ");
        await close();await compare("a.png","source.svg");
        if(await ev(summary)!=="Images have identical decoded pixels."||await ev('!!globalThis.imageDiffPwned'))throw new Error("SVG failed to compare safely");
        await close();
    });
    await step("image diff: EXIF orientation and animated first frame",async()=>{
        const encoded=await ev(`(async()=>{
            const c=document.createElement('canvas');c.width=4;c.height=2;const ctx=c.getContext('2d');
            ctx.fillStyle='red';ctx.fillRect(0,0,2,2);ctx.fillStyle='blue';ctx.fillRect(2,0,2,2);
            const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',1));
            const jpeg=btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
            const image=await createImageBitmap(blob);
            const r=document.createElement('canvas');r.width=2;r.height=4;const rc=r.getContext('2d');
            rc.translate(2,0);rc.rotate(Math.PI/2);rc.drawImage(image,0,0);image.close();
            return {jpeg,png:r.toDataURL('image/png').split(',')[1]};
        })()`);
        const jpeg=Buffer.from(encoded.jpeg,"base64");
        const tiff=Buffer.from([0x4d,0x4d,0,42,0,0,0,8,0,1,0x01,0x12,0,3,0,0,0,1,0,6,0,0,0,0,0,0]);
        const exif=Buffer.concat([Buffer.from("Exif\0\0"),tiff]), header=Buffer.from([0xff,0xe1,0,0]);
        header.writeUInt16BE(exif.length+2,2);
        put("oriented.jpg",Buffer.concat([jpeg.subarray(0,2),header,exif,jpeg.subarray(2)]));
        put("upright.png",Buffer.from(encoded.png,"base64"));
        await compare("oriented.jpg","upright.png");
        if(await ev(summary)!=="Images have identical decoded pixels.")throw new Error("EXIF orientation wasn't applied consistently");
        await close();
        const frame=colour=>Buffer.from([0x21,0xf9,4,0,1,0,0,0,0x2c,0,0,0,0,1,0,1,0,0,2,2,colour?0x4c:0x44,1,0]);
        put("animated.gif",Buffer.concat([Buffer.from("GIF89a"),Buffer.from([1,0,1,0,0x80,0,0,0,0,0,255,255,255]),
            Buffer.from([0x21,0xff,0x0b]),Buffer.from("NETSCAPE2.0"),Buffer.from([3,1,0,0,0]),frame(0),frame(1),Buffer.from([0x3b])]));
        put("first.png",png(1,1,()=>[0,0,0,255]));
        await compare("animated.gif","first.png");
        if(await ev(summary)!=="Images have identical decoded pixels.")throw new Error("animated raster didn't use its first frame");
        await close();
    });
    await step("image diff: shared pan and zoom, narrow layout and dark mode",async()=>{
        await compare("scroll-a.png","scroll-b.png");
        await click(`${dialog}.querySelector('.image-diff-actual')`);
        await ev(`(()=>{const v=${dialog}.querySelector('.image-diff-viewport');v.scrollLeft=200;v.scrollTop=150;})()`);
        await waitFor(`[...${dialog}.querySelectorAll('figure:not([hidden]) .image-diff-viewport')].every(v=>Math.abs(v.scrollLeft-200)<2&&Math.abs(v.scrollTop-150)<2)`,"shared scroll position");
        await click(`${dialog}.querySelector('.image-diff-zoom-in')`);
        if(!await ev(`[...${dialog}.querySelectorAll('canvas')].every(c=>c.style.width==='1500px')`))throw new Error("zoom diverged between panes");
        await cdp("Emulation.setDeviceMetricsOverride",{width:375,height:812,deviceScaleFactor:1,mobile:true});
        await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
        await click(`${dialog}.querySelector('.image-diff-fit')`);
        if(!await ev(`(()=>{const d=${dialog},p=[...d.querySelectorAll('figure:not([hidden])')];return d.getBoundingClientRect().width<=innerWidth&&p.every(f=>f.clientHeight>0&&f.getBoundingClientRect().right<=innerWidth)})()`))throw new Error("narrow image comparison overflowed");
        await press("d");
        await waitFor(`${dialog}.querySelectorAll('figure:not([hidden])').length===1`,"single pane on mobile");
        await cdp("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false});
        await cdp("Emulation.setEmulatedMedia",{features:[]});await close();
    });
    await step("image diff: invalid/oversized images fail safely and closing cancels work",async()=>{
        for(const name of ["bad.png","huge.svg"]) {
            await select("a.png",name);await click('document.querySelector("button.compare-images")');
            await waitFor(`${summary}?.startsWith("Can't compare images:")`,"image error");await close();
        }
        await select("scroll-a.png","scroll-b.png");
        await ev('document.querySelector("button.compare-images").click();document.querySelector(".image-diff-close").click()');
        await waitFor(`!${dialog}`,"cancelled image comparison removed");
        if(inContainer("stat","-c","%s",root+"/a.png")!==String(png(4,3,()=>base).length))throw new Error("comparison modified a source file");
    });
    await step("image diff: earlier image version compared with current image", async () => {
        await open("fs/#/image-diff-check/", `${listed}.includes("b.png")`, "image version fixture");
        await click(`${row("b.png")}.querySelector("td.name a")`);
        await waitFor(`!!document.querySelector("dialog.preview button.edit:not([hidden])")`, "image preview");
        await click('document.querySelector("dialog.preview button.edit")');
        await waitFor(`!!document.querySelector(".image-edit:not([hidden]) .image-flip-h")`, "image editor");
        await click('document.querySelector(".image-flip-h")');
        await click('document.querySelector("dialog.preview .compare-saved")');
        await waitFor(`${summary}?.startsWith("2 of 12 pixels differ")`, "image compared with saved before saving");
        if (!await ev(`${dialog}.querySelector('[data-mode="slider"]').getAttribute('aria-pressed')==='true'`)) throw new Error("editor comparison didn't default to slider");
        await close();
        await click('document.querySelector("dialog.preview button.save-edit")');
        await waitFor(`document.querySelector("dialog.preview .edit-status")?.textContent.startsWith("Saved:")`, "image saved");
        await click('document.querySelector("dialog.preview .compare-saved")');
        await waitFor(`${summary}==="Images have identical decoded pixels."`, "image saved baseline advances");
        await close();
        await click('document.querySelector("dialog.preview button.done-edit")');
        await waitFor(`!document.querySelector("dialog.preview button.versions").hidden`, "image versions available");
        await click('document.querySelector("dialog.preview button.versions")');
        await waitFor(`document.querySelectorAll("dialog.versions tbody tr").length===1`, "earlier image version");
        if (!await ev(`[...document.querySelectorAll("dialog.versions td.actions button")].every(b=>b.querySelector("svg") && b.getAttribute("aria-label") && b.title) && !document.querySelector(".version-compare").hidden`)) throw new Error("missing accessible version glyphs");
        await click('document.querySelector("dialog.versions .version-compare")');
        await waitFor(`${summary}?.startsWith("2 of 12 pixels differ")`, "earlier and current images differ");
        if (JSON.stringify(await pixel("a",1,1))!=="[60,60,80,255]" || JSON.stringify(await pixel("b",2,1))!=="[60,60,80,255]") throw new Error("incorrect earlier/current image pixels");
        if (!await ev(`${dialog}.querySelector('[data-side="a"] figcaption').textContent.includes("as it was before") && ${dialog}.querySelector('[data-side="b"] figcaption').textContent.includes("Now")`)) throw new Error("version labels missing");
        await close();
        if (!await ev('document.activeElement.matches(".version-compare")')) throw new Error("version compare focus not restored");
        await click('document.querySelector("dialog.versions .versions-close")');
        await click('document.querySelector("dialog.preview button.close")');
    });

}
