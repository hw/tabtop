import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { filesystemRoot, filesystemRoots, ensureFilesystemRoots, setFilesystemRoot, rootStorageScope, rootPath, readOnlyRoot, assertWritableRoot } from "../tabtopd/fs-context.js";
import { bookPlace, setBookPlace } from "../tabtopd/preview-settings.js";
const docs={id:"documents",version:"docs-v",label:"Documents",shell_path:"~/Documents",path:"/home/user/Documents",read_only:true};
const data={id:"data",version:"data-v",label:"data",shell_path:"/data",path:"/data",read_only:false};
const target=new URL("../tabtopd/requests.js",import.meta.url).href;
const hooks=registerHooks({resolve(specifier,context,next){
 if(context.parentURL===target&&specifier==="./tunnel.js")return {shortCircuit:true,url:"data:text/javascript,"+encodeURIComponent(`export const session=async()=>await globalThis.rootSession,forgetSession=()=>{};export class Tunnel {static open(req){return globalThis.rootOpen(req)}}`)};
 return next(specifier,context);
}});
let call,shellPath,uploadFile;
try{({call,shellPath,uploadFile}=await import(target));}finally{hooks.deregister();}

test("root discovery selects the first exposed root when Downloads is absent",async()=>{
 const roots=await ensureFilesystemRoots(async()=>({reply:{roots:[docs,data]},close(){}}));
 assert.deepEqual(roots,[docs,data]);assert.equal(filesystemRoot(),docs);assert.equal(filesystemRoots().length,2);
 assert.equal(rootPath(),"~/Documents");assert.equal(readOnlyRoot(),true);assert.throws(assertWritableRoot,/read-only/);
});
test("requests capture their root before asynchronous authentication",async()=>{
 const pending=Promise.withResolvers();globalThis.rootSession=pending.promise;globalThis.rootOpen=req=>({reply:req});
 setFilesystemRoot(docs);const promise=call({type:"list",path:"same"});setFilesystemRoot(data);pending.resolve({id:"s"});
 const captured=(await promise).reply;assert.equal(captured.root,"documents");assert.equal(captured.root_version,"docs-v");
 assert.equal((await call({type:"list",root:"documents"})).reply.root,"documents");
});
test("book positions and shell paths use the selected root",()=>{
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
 setFilesystemRoot(docs);const docScope=rootStorageScope();setBookPlace("same.epub",100,{chapter:1});
 setFilesystemRoot(data);assert.notEqual(rootStorageScope(),docScope);assert.equal(bookPlace("same.epub",100),null);setBookPlace("same.epub",100,{chapter:2});
 assert.equal(shellPath("file name"),"'/data/file name'");
 setFilesystemRoot(docs);assert.deepEqual(bookPlace("same.epub",100),{chapter:1});assert.equal(shellPath("same.txt"),"~/Documents/same.txt");
 setFilesystemRoot({...data,shell_path:"/data/o'neil"});assert.equal(shellPath("file"),"'/data/o'\\''neil/file'");
 setFilesystemRoot({...data,shell_path:"~/."});assert.equal(shellPath("file"),"~/file");assert.equal(shellPath(""),"~");
 setFilesystemRoot({...data,shell_path:"~/Downloads"});assert.equal(shellPath(""),"~/Downloads");
 setFilesystemRoot({...data,shell_path:"/"});assert.equal(shellPath("etc"),"/etc");assert.equal(shellPath(""),"/");
});
test("upload helpers refuse read-only roots before sending file bytes",async()=>{
 setFilesystemRoot(docs);let sent=0;globalThis.rootOpen=()=>{sent++;throw Error("unexpected upload")};
 await assert.rejects(()=>uploadFile(new File(["x"],"x.txt"),()=>{},"",new AbortController().signal),/read-only/);assert.equal(sent,0);
});
test("an explicit unavailable root is never silently redirected",async()=>{
 globalThis.location={search:"?root=missing"};
 try{const context=await import("../tabtopd/fs-context.js?unavailable");await assert.rejects(()=>context.ensureFilesystemRoots(async()=>({reply:{roots:[data]},close(){}})),/unavailable/);assert.equal(context.filesystemRoot().id,"missing");}
 finally{delete globalThis.location;setFilesystemRoot(data);}
});
test("with no root named, the page shows the one the server has as the default",async()=>{
 globalThis.location={search:""};
 try{const context=await import("../tabtopd/fs-context.js?default");
  await context.ensureFilesystemRoots(async()=>({reply:{roots:[docs,{...data,id:"files",default:true}]},close(){}}));
  assert.equal(context.filesystemRoot().id,"files");}
 finally{delete globalThis.location;}
});
test("away from the files page, requests name no root unless they say one",async()=>{
 globalThis.location={pathname:"/desktop/",search:""};globalThis.rootSession=Promise.resolve({id:"s"});globalThis.rootOpen=req=>({reply:req});
 try{
  setFilesystemRoot(data);const plain=(await call({type:"watch"})).reply;assert.equal(plain.root,"");assert.equal(plain.root_version,undefined);
  const named=(await call({type:"upload",root:"data"})).reply;assert.equal(named.root,"data");assert.equal(named.root_version,"data-v");
  assert.equal(filesystemRoot(),data);
 }finally{delete globalThis.location;}
});
