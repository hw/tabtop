export async function checkRoots({ev,waitFor,open,listed,row,click,press,answer,status,inContainer,step}) {
    const request = req => ev(`import('/tabtop/requests.js').then(async m=>{try{const t=await m.call(${JSON.stringify(req)});const result=t.reply;t.close();return result;}catch(err){return {error:err.message,code:err.code};}})`);
    const choose = async id => {
        await ev(`window.rootNavigation=true;(()=>{const s=document.querySelector('select.root-select');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change'));})()`);
        await waitFor(`!window.rootNavigation && new URLSearchParams(location.search).get('root')===${JSON.stringify(id)} && document.querySelector('.root-select')?.value===${JSON.stringify(id)} && !!document.querySelector('input.filter')`,"root "+id);
        if(await ev(`!!document.querySelector('#tabtop_login')`))throw new Error("root switch asked for another login");
    };
    await step("roots: chooser, independent URLs, read-only browsing and previews",async()=>{
        await waitFor(`document.querySelector('select.root-select')?.options.length===3`,"three exposed roots");
        await choose("documents");
        if(!await ev(`document.querySelector('.root-read-only')?.textContent==='Read-only' && document.querySelector('.crumbs').textContent==='~/Documents' && !document.querySelector('p.upload')`))throw new Error("wrong root heading or writable controls on read-only root");
        await ev(`${row('readonly.txt')}.querySelector('input[type=checkbox]').click()`);
        if(await ev(`!!document.querySelector('.selection button.delete, .selection button.move')`))throw new Error("read-only selection offered mutation");
        await click(`${row('readonly.txt')}.querySelector('td.name a')`);
        await waitFor(`document.querySelector('dialog.preview .body')?.textContent.includes('Read-only document')`,"read-only preview");
        if(!await ev(`document.querySelector('dialog.preview button.edit').hidden`))throw new Error("read-only preview offered editing");
        await press("Escape");await waitFor(`!document.querySelector('dialog.preview')`,"preview closes");
        for(const type of ["create","mkdir","delete","rename","upload","zip-extract","file-patch","epub-edit","trash-empty","fetch","share"]) {
            const reply=await request({type,path:"readonly.txt",name:type==="fetch"?"":"new.txt",upload:type==="share",expires:3600,max_bytes:type==="share"?1000:0});
            if(reply.code!=="read-only")throw new Error(`${type} bypassed read-only policy: ${JSON.stringify(reply)}`);
        }
        if(inContainer("cat","/home/user/Documents/readonly.txt").trim()!=="Read-only document")throw new Error("read-only file changed");
    });
    await step("roots: read-only download shares and global root-labelled activity",async()=>{
        const made=await request({type:"share",path:"readonly.txt",expires:3600});
        if(!made.token)throw new Error(JSON.stringify(made));
        const content=await ev(`fetch(''+new URL('fs/${made.token}/readonly.txt',new URL('../',location.href))).then(r=>r.text())`);
        if(content.trim()!=="Read-only document")throw new Error("share read from the wrong root");
        const activity=await request({type:"activity",max:0});
        if(!activity.entries.some(entry=>entry.root==="documents"&&entry.path==="readonly.txt"))throw new Error("activity omitted root/path");
        await ev(`location.hash='#shares'`);
        await waitFor(`document.querySelector('.shares-table')?.textContent.includes('Documents/readonly.txt')`,"root-labelled shares");
        await ev(`location.hash='#/reports/'`);await waitFor(`${listed}.includes('note.txt')`,"Documents/reports");
        await choose("data");
        if(!await ev(`!document.querySelector('.root-read-only') && !!document.querySelector('p.upload') && document.querySelector('.crumbs').textContent==='/data'`))throw new Error("data root isn't writable");
    });
    await step("roots: writes, cross-root move denial, isolated Trash and folder memory",async()=>{
        const made=await request({type:"create",name:"created.txt"});if(made.ok!==true)throw new Error(JSON.stringify(made));
        await waitFor(`${listed}.includes('created.txt')`,"new file in data");
        if(inContainer("sh","-c","test -f /data/created.txt && test ! -e ~/Downloads/created.txt && echo ok")!=="ok")throw new Error("write escaped data root");
        const stale=await request({type:"list",root_version:"stale-directory"});
        if(stale.code!=="root-changed")throw new Error("stale root identity was accepted");
        const moved=await request({type:"move",path:"same.txt",to:"",to_root:"downloads"});
        if(!moved.error?.includes("between"))throw new Error("cross-root move wasn't refused");
        const folder=await request({type:"mkdir",name:"target"});if(folder.ok!==true)throw new Error(JSON.stringify(folder));
        await waitFor(`${listed}.includes('target/')`,"target folder");
        await ev(`(()=>{const dt=new DataTransfer();dt.setData('application/x-tabtop-move',JSON.stringify({root:'downloads',dir:'',names:['same.txt']}));${row('target/')}.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
        if(inContainer("sh","-c","test -f /data/same.txt && test ! -e /data/target/same.txt && echo ok")!=="ok")throw new Error("cross-root drag moved a same-named file");
        await ev(`${row('same.txt')}.querySelector('button.delete').click()`);await answer();
        await waitFor(`!${listed}.includes('same.txt')`,"data file moved to Trash");
        await ev(`document.querySelector('button.trash').click()`);
        await waitFor(`location.hash==='#trash' && document.querySelector('tbody')?.textContent.includes('same.txt')`,"data Trash");
        if(!await ev(`document.querySelector('thead').textContent.includes('Folder') && [...document.querySelectorAll('tbody tr')].some(r=>r.textContent.includes('same.txt')&&r.firstElementChild.textContent==='data')`))throw new Error("Trash across roots didn't say whose");
        const other=await request({type:"trash-list",root:"downloads"});if(other.entries.length)throw new Error("data deletion appeared in Downloads Trash");
        await ev(`document.querySelector('tbody button').click()`);
        await waitFor(`document.querySelector('main').textContent.includes('Trash is empty.')`,"data restore");
        if(inContainer("cat","/data/same.txt").trim()!=="data original")throw new Error("restored to the wrong root");
        await ev(`document.querySelector('button.trash').click()`);await waitFor(`${listed}.includes('target/')`,"data listing");
        await click(`${row('target/')}.querySelector('td.name a')`);await waitFor(`location.hash==='#/target/' && /target\\/?$/.test(document.querySelector('.crumbs')?.textContent)`,"data/target");
        await choose("documents");
        await waitFor(`location.hash==='#/reports/' && ${listed}.includes('note.txt')`,"Documents folder memory");
        await choose("data");await waitFor(`location.hash==='#/target/'`,"data folder memory");
    });
    await step("roots: copy and move between roots",async()=>{
        await ev(`location.hash='#/'`);await waitFor(`${listed}.includes('created.txt')`,"data top");
        // Copy to…: the one other writable root is Downloads, so no root is asked for.
        await ev(`${row('created.txt')}.querySelector('button.copy-to').click()`);
        await answer("");
        await waitFor(`/created\\.txt: copied to Downloads/.test(${status})`,"the copy");
        if(inContainer("sh","-c","test -f ~/Downloads/created.txt && test -f /data/created.txt && echo ok")!=="ok")throw new Error("copy didn't leave both");
        // Move to…: here or Downloads; the name's taken there, so it's numbered.
        await ev(`${row('created.txt')}.querySelector('button.move').click()`);
        await waitFor(`!![...document.querySelectorAll('dialog[open] button')].find(b=>b.value==='downloads')`,"the root choice");
        await ev(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.value==='downloads').click()`);
        await answer("");
        await waitFor(`/created\\.txt: moved to Downloads as created \\(1\\)\\.txt/.test(${status})`,"the move");
        await waitFor(`!${listed}.includes('created.txt')`,"the moved file to leave data");
        if(inContainer("sh","-c","test -f ~/Downloads/'created (1).txt' && test ! -e /data/created.txt && echo ok")!=="ok")throw new Error("move didn't land, or left the original");
    });
    await step("roots: unavailable root cannot silently fall back",async()=>{
        await open("fs/?root=missing#/",`document.querySelector('main .error')?.textContent.includes('unavailable')`,"unknown root error");
        await choose("data");
    });
}
