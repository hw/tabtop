// A bounded WebGL1/WebGL2 command mirror for /go. The page keeps its context in Moli;
// missing engine methods get compatibility shims and calls replay in the viewer.
// The calls and extensions it records are gogl-surface.js's (made from
// gogl-surface.json, which the server and viewer read too), its constants
// are in gogl-enums.js and its reading of shaders' source in goglsl.js:
// gobrowser.go puts the four in one function (goGLPageJS).
(() => {
    const Canvas = globalThis.HTMLCanvasElement;
    const GL = globalThis.WebGLRenderingContext;
    const GL2 = globalThis.WebGL2RenderingContext;
    if (!Canvas || !GL) return;

    const apply = Reflect.apply;
    const contexts = new WeakMap();
    const contextByCanvas = new WeakMap();
    const originalGetContext = Canvas.prototype.getContext;
    const originalDispatch = EventTarget.prototype.dispatchEvent;
    const EventCtor = Event;
    const CustomEventCtor = CustomEvent;
    const maxCommands = glSurface.limits.commands;
    const maxData = glSurface.limits.dataBytes;
    const maxJSON = glSurface.limits.logBytes;
    // The constants Moli's contexts lack (gogl-enums.js), on their
    // constructors and prototypes.
    for (const [target, tables] of [[GL, [standardEnums1]], ...(GL2 ? [[GL2, [standardEnums1, standardEnums2]]] : [])]) {
        for (const table of tables) {
            for (const item of table.trim().split(" ")) {
                const at = item.indexOf(":"), name = item.slice(0, at), value = Number.parseInt(item.slice(at + 1), 16);
                for (const where of [target, target.prototype]) {
                    if (typeof where[name] === "number") continue;
                    try { Object.defineProperty(where, name, { value, enumerable: true }); } catch { /* sealed */ }
                }
            }
        }
    }

    for (const proto of [GL.prototype, GL2?.prototype]) {
        if (!proto) continue;
        for (const [name, side] of [["drawingBufferWidth", "width"], ["drawingBufferHeight", "height"]]) {
            if (name in proto) continue;
            try { Object.defineProperty(proto, name, { configurable: true, enumerable: true, get() { return this.canvas?.[side] ?? 0; } }); } catch { /* sealed */ }
        }
    }

    // An attribute's location comes from the program's reflection (below),
    // once linked: Moli doesn't find attributes declared "in" (GLSL ES 3).
    // Installed under the recorder, so the location it records maps to the
    // attribute's name, which the viewer looks up in its own program.
    for (const proto of [GL.prototype, GL2?.prototype]) {
        if (!proto || typeof proto.getActiveAttrib === "function") continue;
        const native = typeof proto.getAttribLocation === "function" ? proto.getAttribLocation : null;
        try {
            Object.defineProperty(proto, "getAttribLocation", { configurable: true, writable: true, value: function (program, name) {
                const locations = programInfo.get(program)?.locations;
                if (locations) return locations.get(String(name)) ?? -1;
                return native ? apply(native, this, [program, name]) : -1;
            } });
        } catch { /* sealed */ }
    }

    const allowed = new Set(glSurface.methods);
    const objectTypes = { createBuffer: "buffer", createFramebuffer: "framebuffer", createProgram: "program", createQuery: "query", createRenderbuffer: "renderbuffer", createSampler: "sampler", createShader: "shader", createTexture: "texture", createTransformFeedback: "transformfeedback", createVertexArray: "vertexarray" };
    const gl2OnlyMethods = new Set(glSurface.webgl2Methods);
    const localQueryMethods = new Set(["beginQuery", "createQuery", "deleteQuery", "endQuery", "getQuery", "getQueryParameter", "queryCounter"]);
    const supportedExtensions = new Set(glSurface.extensions);
    function extensionSupported(name, state) { return supportedExtensions.has(name) && (!glSurface.webgl2Extensions.includes(name) || state.version === 2); }
    // An extension's calls, by extension: each recorded as the call it is
    // (WebGL2's, or the extension's own). WEBGL_multi_draw's are taken
    // apart, draw by draw, where its object is made.
    const extensionAliases = {};
    for (const [method, aliases] of Object.entries(glSurface.webgl1Aliases)) for (const [extension, alias] of aliases) if (extension !== "WEBGL_multi_draw") (extensionAliases[extension] ||= {})[alias] = method;
    for (const [method, extension] of Object.entries(glSurface.extensionCommands)) (extensionAliases[extension] ||= {})[method] = method;
    const skipQueries = new Set(["checkFramebufferStatus", "finish", "flush", "getContextAttributes", "getParameter", "getError", "getShaderParameter", "getProgramParameter", "getShaderInfoLog", "getProgramInfoLog", "getShaderSource", "getShaderPrecisionFormat", "getActiveAttrib", "getActiveUniform", "getActiveUniformBlockName", "getActiveUniformBlockParameter", "getActiveUniforms", "getAttachedShaders", "getBufferParameter", "getBufferSubData", "getFragDataLocation", "getFramebufferAttachmentParameter", "getIndexedParameter", "getInternalformatParameter", "getQueryParameter", "getRenderbufferParameter", "getSamplerParameter", "getSyncParameter", "getTexParameter", "getTransformFeedbackVarying", "getUniform", "getUniformBlockIndex", "getUniformIndices", "getSupportedExtensions", "getVertexAttrib", "getVertexAttribOffset", "isBuffer", "isContextLost", "isEnabled", "isFramebuffer", "isProgram", "isQuery", "isRenderbuffer", "isSampler", "isShader", "isSync", "isTexture", "isTransformFeedback", "isVertexArray", "readPixels"]);
    const locationMethods = new Set(["enableVertexAttribArray", "disableVertexAttribArray", "vertexAttribDivisor", "vertexAttribPointer", "vertexAttribIPointer", "vertexAttribI4i", "vertexAttribI4iv", "vertexAttribI4ui", "vertexAttribI4uiv", "vertexAttrib1f", "vertexAttrib1fv", "vertexAttrib2f", "vertexAttrib2fv", "vertexAttrib3f", "vertexAttrib3fv", "vertexAttrib4f", "vertexAttrib4fv"]);
    const drawMethods = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
    const frameWrites = new Set(["clear", "clearBufferfi", "clearBufferfv", "clearBufferiv", "clearBufferuiv", ...drawMethods]);
    const compactStateMethods = new Set(["clearColor", "clearDepth", "clearStencil", "colorMask", "depthMask", "depthFunc", "depthRange", "blendColor", "blendEquation", "blendEquationSeparate", "blendFunc", "blendFuncSeparate", "cullFace", "frontFace", "lineWidth", "polygonOffset", "polygonModeWEBGL", "sampleCoverage", "scissor", "viewport", "stencilFunc", "stencilFuncSeparate", "stencilMask", "stencilMaskSeparate", "stencilOp", "stencilOpSeparate", "drawBuffers", "enable", "disable", ...locationMethods]);

    function signal(canvas, name) {
        try { apply(originalDispatch, canvas, [new EventCtor(name, { bubbles: true, composed: true })]); } catch { /* detached canvas */ }
        // In a same-origin frame, told on its iframe too, where the page's
        // agent hears it (it doesn't hear the frame's own events in Moli).
        try {
            const owner = globalThis.frameElement;
            if (owner && canvas.ownerDocument === document) {
                const index = Array.prototype.indexOf.call(document.querySelectorAll("canvas"), canvas);
                if (index >= 0) apply(originalDispatch, owner, [new CustomEventCtor("__tabtop_frame_canvas_dirty", { bubbles: true, detail: JSON.stringify({ index }) })]);
            }
        } catch { /* another origin's frame, or gone */ }
    }
    function unsupported(state, reason = "unsupported") {
        if (state.bad) return;
        state.bad = true;
        signal(state.canvas, "__tabtop_webgl_dirty");
    }
    function encode(state, value, bytes) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "object") {
            const objectID = state.objects.get(value);
            if (objectID) return { ref: objectID };
            if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
                const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                bytes.n += view.byteLength;
                if (bytes.n > maxData) throw new Error("data limit");
                let binary = "";
                for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
                return { typed: value.constructor.name, data: btoa(binary) };
            }
            if (value instanceof ArrayBuffer) {
                const view = new Uint8Array(value);
                bytes.n += view.byteLength;
                if (bytes.n > maxData) throw new Error("data limit");
                let binary = "";
                for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
                return { typed: "Uint8Array", data: btoa(binary) };
            }
            if (Array.isArray(value) && value.length <= 64) return value.map((v) => encode(state, v, bytes));
        }
        throw new Error("unsupported argument");
    }
    function encodeTextureSource(state, source, bytes) {
        let width = 0, height = 0, pixels;
        if (typeof ImageData !== "undefined" && source instanceof ImageData) {
            width = source.width;
            height = source.height;
            pixels = source.data;
        } else {
            width = source.naturalWidth || source.videoWidth || source.width || 0;
            height = source.naturalHeight || source.videoHeight || source.height || 0;
            if (!width || !height || width > 4096 || height > 4096 || width * height > (16 << 20) || width * height * 4 > maxData) throw new Error("texture dimensions");
            const scratch = document.createElement("canvas");
            scratch.width = width;
            scratch.height = height;
            const ctx = scratch.getContext("2d");
            if (!ctx) throw new Error("texture readback unavailable");
            ctx.drawImage(source, 0, 0, width, height);
            pixels = ctx.getImageData(0, 0, width, height).data;
        }
        if (!width || !height || width > 4096 || height > 4096 || width * height > (16 << 20) || pixels.byteLength !== width * height * 4) throw new Error("texture dimensions");
        return { pixels: encode(state, pixels, bytes), width, height };
    }
    function record(state, method, args, result, bytes) {
        if (state.bad) return;
        if (localQueryMethods.has(method)) {
            if (method === "createQuery" && result && typeof result === "object") state.objectKinds.set(result, "query");
            else if (method === "deleteQuery" && args[0] && typeof args[0] === "object") state.objectKinds.delete(args[0]);
            return;
        }
        if (!allowed.has(method)) return unsupported(state, `method:${method}`);
        if (method === "useProgram") return;
        if (method === "getExtension" && args[0] === "WEBGL_multi_draw") {
            state.multiDrawRequested = true;
            if (state.drawIDShaders.size) return unsupported(state, "gl_DrawID multi-draw semantics");
        }
        if (method === "shaderSource" && typeof args[1] === "string" && /\bgl_DrawID\b/.test(args[1])) {
            const shader = state.objects.get(args[0]);
            if (shader) state.drawIDShaders.add(shader);
            if (state.multiDrawRequested) return unsupported(state, "gl_DrawID multi-draw semantics");
        } else if (method === "shaderSource") {
            const shader = state.objects.get(args[0]);
            if (shader) state.drawIDShaders.delete(shader);
        }
        const framebuffer = state.objects.get(drawFramebuffer(state)) || 0;
        const clearMask = method === "clear" ? Number(args[0]) : 0;
        if (method === "clear" && checkpointableClear(state, framebuffer, clearMask) && (state.commands.length >= maxCommands * 0.75 || state.bytes >= maxJSON * 0.75)) compactFramebufferFrames(state, framebuffer);
        if (state.commands.length >= maxCommands) return unsupported(state, `limit:${method}`);
        try {
            const a = Array.from(args, (v, i) => {
                if ((method === "texImage2D" || method === "texSubImage2D" || method === "texImage3D" || method === "texSubImage3D") && i === args.length - 1 && v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer)) {
                    return encodeTextureSource(state, v, bytes);
                }
                if (method === "getUniformLocation" && i === 0) return encode(state, v, bytes);
                if (method === "getAttribLocation" && i === 0) return encode(state, v, bytes);
                if (locationMethods.has(method) && i === 0 && Number.isInteger(v)) {
                    const location = state.locations.get(`${state.currentProgram || 0}:${v}`);
                    return location ? { location: location.name, program: location.program } : v;
                }
                return encode(state, v, bytes);
            });
            const command = { m: method, a };
            if (drawMethods.has(method) || method === "clear" || method.startsWith("clearBuffer")) {
                const framebuffer = state.objects.get(drawFramebuffer(state)) || 0;
                command.fb = framebuffer;
                if (drawMethods.has(method)) {
                    const program = state.currentProgram || 0;
                    command.pr = program;
                }
            } else if (method.startsWith("uniform") && state.locationPrograms.has(args[0])) {
                command.up = state.locationPrograms.get(args[0]);
            } else if (method.startsWith("copyTex")) {
                // The framebuffer it reads (compactFramebufferFrames); not
                // in the log (its fields are checked: goCanvasGLKeys).
                copyReads.set(command, state.objects.get(readFramebuffer(state)) || 0);
            }
            if (result && typeof result === "object") {
                const id = ++state.nextObject;
                state.objects.set(result, id);
                state.objectKinds.set(result, method === "getUniformLocation" ? "uniform" : objectTypes[method] || "object");
                if (method === "getUniformLocation") {
                    const program = state.objects.get(args[0]);
                    if (program) state.locationPrograms.set(result, program);
                }
                command.r = id;
                command.rt = method === "getUniformLocation" ? "uniform" : objectTypes[method];
            } else if (method === "getAttribLocation" && Number.isInteger(result) && result >= 0 && typeof args[1] === "string") {
                const program = state.objects.get(args[0]);
                if (program) {
                    command.q = result;
                    command.program = program;
                    command.name = args[1];
                    state.locations.set(`${program}:${result}`, { program, name: args[1] });
                }
            }
            const commandBytes = JSON.stringify(command).length;
            if (state.bytes + commandBytes > maxJSON) return unsupported(state, `bytes:${method}`);
            state.commands.push(command);
            if (method.startsWith("delete") && args[0] && typeof args[0] === "object") {
                state.objects.delete(args[0]);
                state.objectKinds.delete(args[0]);
            }
            state.bytes += commandBytes;
            if (drawMethods.has(method)) {
                const dirty = state.framebufferDirty.get(framebuffer) || { depth: false, stencil: false };
                if (state.shadow.enabled.has(0x0B71) && state.shadow.depthMask) dirty.depth = true;
                if (state.shadow.enabled.has(0x0B90)) dirty.stencil = true;
                state.framebufferDirty.set(framebuffer, dirty);
            } else if (method === "clear") {
                const dirty = state.framebufferDirty.get(framebuffer) || { depth: false, stencil: false };
                if ((clearMask & 0x0100) !== 0 && state.shadow.depthMask) dirty.depth = false;
                if ((clearMask & 0x0400) !== 0 && stencilMaskFull(state.shadow)) dirty.stencil = false;
                state.framebufferDirty.set(framebuffer, dirty);
            }
            // A full replay log is sent only when dirty. This makes every
            // update self-contained and lets the viewer reset after gaps.
            if (drawMethods.has(method) || method === "blitFramebuffer" || method.startsWith("clearBuffer") || method === "clear" || method === "bufferData" || method === "bufferSubData" || method.startsWith("texImage") || method.startsWith("texSubImage") || method.startsWith("texStorage")) {
                signal(state.canvas, "__tabtop_webgl_dirty");
            }
        } catch (err) { unsupported(state, `${method}:${err?.message}`); }
    }
    function stencilMaskFull(shadow) {
        return ((shadow.stencilMasks?.front ?? 0xFFFFFFFF) & 0xFF) === 0xFF && ((shadow.stencilMasks?.back ?? 0xFFFFFFFF) & 0xFF) === 0xFF;
    }
    function checkpointableClear(state, framebuffer, mask) {
        if ((mask & 0x4000) === 0 || state.shadow.enabled.has(0x0C11) || !state.shadow.colorMask.every(Boolean)) return false;
        const dirty = state.framebufferDirty.get(framebuffer);
        if (dirty?.depth && ((mask & 0x0100) === 0 || !state.shadow.depthMask)) return false;
        if (dirty?.stencil && ((mask & 0x0400) === 0 || !stencilMaskFull(state.shadow))) return false;
        return true;
    }
    function compactFramebufferFrames(state, framebuffer) {
        if (state.commands.some((command) => command.m === "blitFramebuffer" || command.m === "drawBuffers" || command.m.endsWith("iOES"))) return;
        // A copy of this framebuffer into a texture (a feedback effect, a
        // trail) is of the draws that would go: not compacted (given up at
        // the log's limit, shown as unsupported, rather than wrong).
        if (state.commands.some((command) => command.m.startsWith("copyTex") && copyReads.get(command) === framebuffer)) return;
        const compactIndependentState = !state.commands.some((command) => frameWrites.has(command.m) && (command.fb || 0) !== framebuffer);
        const latest = new Map();
        const skip = new Set();
        const boundBuffers = new Map();
        const latestBufferData = new Map();
        const latestSubData = new Map();
        const bufferAt = new Map();
        const subDataKey = (command, buffer) => {
            const data = command.a?.[2];
            if (!data || typeof data !== "object" || typeof data.data !== "string" || typeof data.typed !== "string") return "";
            return `${buffer}:${command.a[1]}:${data.typed}:${data.data.length}:${command.a[3] ?? ""}:${command.a[4] ?? ""}`;
        };
        for (let i = 0; compactIndependentState && i < state.commands.length; i++) {
            const command = state.commands[i], target = command.a?.[0];
            if (command.m === "bindBuffer" && (target === 0x8892 || target === 0x8F37)) boundBuffers.set(target, command.a[1]?.ref || 0);
            if ((command.m === "bufferData" || command.m === "bufferSubData") && (target === 0x8892 || target === 0x8F37)) bufferAt.set(i, boundBuffers.get(target) || 0);
            const buffer = bufferAt.get(i);
            if (!buffer) continue;
            if (command.m === "bufferData") latestBufferData.set(buffer, i);
            if (command.m === "bufferSubData") {
                const key = subDataKey(command, buffer);
                if (key) latestSubData.set(key, i);
            }
        }
        for (const [i, buffer] of bufferAt) {
            const command = state.commands[i];
            if (command.m === "bufferData" && latestBufferData.get(buffer) !== i) skip.add(i);
            if (command.m === "bufferSubData") {
                const latestData = latestBufferData.get(buffer);
                if (latestData !== undefined && i < latestData) { skip.add(i); continue; }
                const key = subDataKey(command, buffer);
                if (key && latestSubData.get(key) !== i) skip.add(i);
            }
        }
        // A uniform's location by its name (a page may ask for it again each
        // frame, a new object each time: the same uniform).
        const locationNames = new Map();
        for (const command of state.commands) if (command.m === "getUniformLocation" && command.r && typeof command.a?.[1] === "string") locationNames.set(command.r, command.a[1]);
        const keyOf = (command, vertexArray) => {
            const method = command.m, first = command.a?.[0];
            if (method === "enable" || method === "disable") return `cap:${JSON.stringify(first)}`;
            if (method === "stencilFuncSeparate" || method === "stencilMaskSeparate" || method === "stencilOpSeparate") return `state:${method}:${JSON.stringify(first)}`;
            if (method.startsWith("uniform") && command.up > 0) return `uniform:${command.up}:${locationNames.has(first?.ref) ? "name:" + locationNames.get(first.ref) : JSON.stringify(first)}`;
            if (locationMethods.has(method)) return `attrib:${vertexArray}:${method}:${JSON.stringify(first)}`;
            return compactStateMethods.has(method) ? `state:${method}` : "";
        };
        const kept = [];
        let vertexArray = 0;
        for (let i = 0; i < state.commands.length; i++) {
            const command = state.commands[i];
            if (skip.has(i)) continue;
            if (command.m === "bindVertexArray") vertexArray = command.a?.[0]?.ref || 0;
            if (frameWrites.has(command.m) && (command.fb || 0) === framebuffer) continue;
            const key = compactIndependentState ? keyOf(command, vertexArray) : "";
            if (key) {
                const old = latest.get(key);
                if (old !== undefined) kept[old] = null;
                latest.set(key, kept.length);
            }
            kept.push(command);
        }
        state.commands = kept.filter(Boolean);
        if (compactIndependentState) state.commands = compactBinds(state.commands);
        state.bytes = state.commands.reduce((sum, command) => sum + JSON.stringify(command).length, 0);
        state.sent = 0;
        state.wholeNext = true;
    }
    // compactBinds drops the binds nothing kept after them may use: each
    // kind's last is kept (the state the log leaves), and one before
    // anything that may use what's bound (an upload, a create, a draw of
    // another target's: any call but another bind). A location asked for
    // again, nothing kept naming the one before, goes too.
    function compactBinds(commands) {
        const keys = new Array(commands.length).fill("");
        let unit = 0x84C0, vertexArray = 0;
        for (let i = 0; i < commands.length; i++) {
            const c = commands[i], target = c.a?.[0];
            switch (c.m) {
                case "activeTexture": keys[i] = "active"; unit = target; break;
                case "bindTexture": keys[i] = `texture:${unit}:${target}`; break;
                case "bindBuffer": keys[i] = target === 0x8893 ? `buffer:${vertexArray}:${target}` : `buffer:${target}`; break;
                case "bindVertexArray": case "bindVertexArrayOES": keys[i] = "vertexArray"; vertexArray = target?.ref || 0; break;
                case "bindRenderbuffer": keys[i] = `renderbuffer:${target}`; break;
                case "bindSampler": keys[i] = `sampler:${target}`; break;
                case "pixelStorei": keys[i] = `pixel:${target}`; break;
            }
        }
        const all = new Set(keys.filter(Boolean));
        const needed = new Set(all);
        const keep = new Array(commands.length).fill(true);
        for (let i = commands.length - 1; i >= 0; i--) {
            const key = keys[i];
            if (!key) {
                for (const k of all) needed.add(k);
                continue;
            }
            if (!needed.has(key)) { keep[i] = false; continue; }
            needed.delete(key);
            if (key.startsWith("texture:")) needed.add("active");
            if (key.startsWith("buffer:") && key.split(":").length === 3) needed.add("vertexArray");
        }
        let out = commands.filter((_, i) => keep[i]);
        // Locations asked for again: the earlier, named by nothing kept, go.
        const named = new Set();
        const refs = (v) => {
            if (Array.isArray(v)) v.forEach(refs);
            else if (v && typeof v === "object") {
                if (Number.isInteger(v.ref)) named.add(v.ref);
                else for (const x of Object.values(v)) refs(x);
            }
        };
        for (const c of out) if (c.m !== "getUniformLocation") refs(c.a);
        const lastAsked = new Map();
        out.forEach((c, i) => { if (c.m === "getUniformLocation") lastAsked.set(JSON.stringify(c.a), i); });
        out = out.filter((c, i) => c.m !== "getUniformLocation" || named.has(c.r) || lastAsked.get(JSON.stringify(c.a)) === i);
        return out;
    }
    function contextAttributeMask(gl) {
        let attributes = null;
        try { attributes = gl.getContextAttributes(); } catch { /* use WebGL defaults */ }
        attributes ||= { alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
        return (attributes.alpha ? 1 : 0) | (attributes.depth ? 2 : 0) | (attributes.stencil ? 4 : 0) | (attributes.antialias ? 8 : 0) | (attributes.premultipliedAlpha ? 16 : 0) | (attributes.preserveDrawingBuffer ? 32 : 0);
    }
    function stateFor(canvas, gl, version = 1) {
        let state = contexts.get(gl);
        if (!state) {
            state = { canvas, gl, version, attributes: contextAttributeMask(gl), objects: new WeakMap(), objectKinds: new WeakMap(), locationPrograms: new WeakMap(), framebufferDirty: new Map(), drawIDShaders: new Set(), nextObject: 0, locations: new Map(), currentProgram: 0, commands: [], sent: 0, bytes: 0, bad: false, wholeNext: true,
                shadow: { activeTexture: gl.TEXTURE0, buffers: new Map(), textures: new Map(), samplers: new Map(), pixelStore: new Map(), vertexArrayElementBuffers: new Map(), framebuffer: null, drawFramebuffer: null, readFramebuffer: null, renderbuffer: null, program: null, enabled: new Set(), viewport: [0, 0, canvas.width, canvas.height], clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0, colorMask: [true, true, true, true], depthMask: true, stencilMasks: { front: 0xFFFFFFFF, back: 0xFFFFFFFF } } };
            contexts.set(gl, state);
            contextByCanvas.set(canvas, state);
            canvas.addEventListener("webglcontextlost", (event) => {
                event.preventDefault();
                state.bad = true;
                signal(canvas, "__tabtop_webgl_dirty");
            });
            canvas.addEventListener("webglcontextrestored", () => {
                state.objects = new WeakMap();
                state.objectKinds = new WeakMap();
                state.locationPrograms = new WeakMap();
                state.nextObject = 0;
                state.locations.clear();
                state.currentProgram = 0;
                state.framebufferDirty = new Map();
                state.drawIDShaders = new Set();
                state.commands = [];
                state.sent = 0;
                state.bytes = 0;
                state.wholeNext = true;
                state.bad = false;
                state.shadow = { activeTexture: gl.TEXTURE0, buffers: new Map(), textures: new Map(), samplers: new Map(), pixelStore: new Map(), vertexArrayElementBuffers: new Map(), framebuffer: null, drawFramebuffer: null, readFramebuffer: null, renderbuffer: null, program: null, enabled: new Set(), viewport: [0, 0, canvas.width, canvas.height], clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0, colorMask: [true, true, true, true], depthMask: true, stencilMasks: { front: 0xFFFFFFFF, back: 0xFFFFFFFF } };
                signal(canvas, "__tabtop_webgl_dirty");
            });
        }
        return state;
    }

    function fillEnums(gl, version = 1) {
        for (const [name, value] of Object.entries(version === 2 ? { ...enums, ...gl2Enums } : enums)) {
            if (typeof gl[name] === "number") continue;
            try { Object.defineProperty(gl, name, { value, configurable: true }); }
            catch { try { gl[name] = value; } catch { /* an engine may seal its context */ } }
        }
    }

    function missingResult(name, gl, args) {
        if (name.startsWith("create") && objectTypes[name]) return Object.create(null);
        if (name === "getError") return gl.NO_ERROR;
        if (name === "getParameter") {
            const version = contexts.get(gl)?.version ?? 1;
            switch (args[0]) {
                case gl.MAX_TEXTURE_SIZE: return 4096;
                case gl.MAX_CUBE_MAP_TEXTURE_SIZE: return 2048;
                case gl.MAX_RENDERBUFFER_SIZE: return 4096;
                case gl.MAX_VIEWPORT_DIMS: return new Int32Array([4096, 4096]);
                case gl.MAX_VERTEX_ATTRIBS: return version === 2 ? 16 : 8;
                case gl.MAX_VERTEX_UNIFORM_VECTORS: return version === 2 ? 256 : 128;
                case gl.MAX_FRAGMENT_UNIFORM_VECTORS: return version === 2 ? 224 : 16;
                case gl.MAX_VARYING_VECTORS: return version === 2 ? 15 : 8;
                case gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return version === 2 ? 32 : 8;
                case gl.MAX_TEXTURE_IMAGE_UNITS: return version === 2 ? 16 : 8;
                case gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return version === 2 ? 16 : 0;
                case gl.MAX_3D_TEXTURE_SIZE: return 256;
                case gl.MAX_ARRAY_TEXTURE_LAYERS: return 256;
                case gl.MAX_DRAW_BUFFERS: return 4;
                case gl.MAX_COLOR_ATTACHMENTS: return 4;
                case gl.MAX_SAMPLES: return 4;
                case gl.MAX_VERTEX_UNIFORM_BLOCKS: case gl.MAX_FRAGMENT_UNIFORM_BLOCKS: return 12;
                case gl.MAX_COMBINED_UNIFORM_BLOCKS: return 24;
                case gl.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
                case gl.MAX_UNIFORM_BLOCK_SIZE: return 16384;
                case gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT: return 256;
                case gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: return 4;
                case gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: return 64;
                case gl.MAX_VERTEX_UNIFORM_BLOCKS: case gl.MAX_FRAGMENT_UNIFORM_BLOCKS: return 12;
                case gl.MAX_COMBINED_UNIFORM_BLOCKS: return 24;
                case gl.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
                case gl.MAX_UNIFORM_BLOCK_SIZE: return 16384;
                case gl.MAX_DRAW_BUFFERS: case gl.MAX_COLOR_ATTACHMENTS: return 4;
                case gl.MAX_VERTEX_OUTPUT_COMPONENTS: return 64;
                case gl.MAX_FRAGMENT_INPUT_COMPONENTS: return 60;
                case gl.MAX_VARYING_COMPONENTS: return 60;
                case gl.MAX_TEXTURE_MAX_ANISOTROPY_EXT: return 4;
                default: return null;
            }
        }
        return undefined;
    }
    function addExtensionConstants(extension, name, version = 1, state = null) {
        if (!extension) extension = Object.create(null);
        const values = name === "OES_texture_half_float" ? { HALF_FLOAT_OES: version === 2 ? 0x140B : 0x8D61 } :
            name === "EXT_color_buffer_half_float" ? { RGBA16F_EXT: 0x881A, RGB16F_EXT: 0x881B, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 } :
            name === "WEBGL_depth_texture" ? { UNSIGNED_INT_24_8_WEBGL: 0x84FA } :
                name === "EXT_texture_filter_anisotropic" ? { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF } :
                    name === "OES_vertex_array_object" ? { VERTEX_ARRAY_BINDING_OES: 0x85B5 } :
            name === "WEBGL_draw_buffers" ? { DRAW_BUFFER0_WEBGL: 0x8825, MAX_DRAW_BUFFERS_WEBGL: 0x8824, MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF } :
                name === "WEBGL_polygon_mode" ? { POLYGON_MODE_WEBGL: 0x0B40, POLYGON_OFFSET_LINE_WEBGL: 0x2A02, LINE_WEBGL: 0x1B01, FILL_WEBGL: 0x1B02 } :
                            name.startsWith("EXT_disjoint_timer_query") ? { TIME_ELAPSED_EXT: 0x88BF, TIMESTAMP_EXT: 0x8E28, GPU_DISJOINT_EXT: 0x8FBB, QUERY_COUNTER_BITS_EXT: 0x8864, CURRENT_QUERY_EXT: 0x8865, QUERY_RESULT_EXT: 0x8866, QUERY_RESULT_AVAILABLE_EXT: 0x8867 } :
                                name === "WEBGL_compressed_texture_s3tc" ? { COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83F0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83F1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83F2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83F3 } :
                                    name === "WEBGL_compressed_texture_s3tc_srgb" ? { COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8C4C, COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8C4D, COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8C4E, COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8C4F } :
                                        name === "WEBGL_compressed_texture_etc1" ? { COMPRESSED_RGB_ETC1_WEBGL: 0x8D64 } :
                                            name === "WEBGL_compressed_texture_etc" ? { COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271, COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273, COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275, COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276, COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277, COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279 } :
                                                name === "WEBGL_compressed_texture_pvrtc" ? { COMPRESSED_RGB_PVRTC_4BPPV1_IMG: 0x8C00, COMPRESSED_RGB_PVRTC_2BPPV1_IMG: 0x8C01, COMPRESSED_RGBA_PVRTC_4BPPV1_IMG: 0x8C02, COMPRESSED_RGBA_PVRTC_2BPPV1_IMG: 0x8C03 } :
                                                    name === "WEBGL_compressed_texture_atc" ? { COMPRESSED_RGB_ATC_WEBGL: 0x8C92, COMPRESSED_RGBA_ATC_EXPLICIT_ALPHA_WEBGL: 0x8C93, COMPRESSED_RGBA_ATC_INTERPOLATED_ALPHA_WEBGL: 0x87EE } :
                                                        name === "EXT_texture_compression_bptc" ? { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8E8C, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8E8D, COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8E8E, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8E8F } :
                                                            name === "EXT_texture_compression_rgtc" ? { COMPRESSED_RED_RGTC1_EXT: 0x8DBB, COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8DBC, COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8DBD, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8DBE } : {};
        if (name === "WEBGL_compressed_texture_astc") {
            const blocks = ["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"];
            for (let i = 0; i < blocks.length; i++) { values[`COMPRESSED_RGBA_ASTC_${blocks[i]}_KHR`] = 0x93B0 + i; values[`COMPRESSED_SRGB8_ALPHA8_ASTC_${blocks[i]}_KHR`] = 0x93D0 + i; }
        }
        if (name === "WEBGL_draw_buffers") for (let i = 0; i < 16; i++) { values[`COLOR_ATTACHMENT${i}_WEBGL`] = 0x8CE0 + i; values[`DRAW_BUFFER${i}_WEBGL`] = 0x8825 + i; }
        for (const [key, value] of Object.entries(values)) {
            if (typeof extension[key] === "number") continue;
            try { Object.defineProperty(extension, key, { value, configurable: true }); } catch { /* native extension objects may be sealed */ }
        }
        const aliases = extensionAliases[name] || {};
        return new Proxy(extension, { get(target, property) {
            const multiMethod = name === "WEBGL_multi_draw" && typeof property === "string" ? property : "";
            if (["multiDrawArraysWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"].includes(multiMethod)) {
                const original = Reflect.get(target, property, target);
                return (...args) => {
                    const result = typeof original === "function" ? apply(original, target, args) : undefined;
                    if (!state) return result;
                    const drawCount = args[args.length - 1];
                    if (!Number.isInteger(drawCount) || drawCount < 0 || drawCount > maxCommands || state.commands.length + drawCount > maxCommands) { unsupported(state, "multi-draw count"); return result; }
                    const at = (list, offset, index) => {
                        if (!(Array.isArray(list) || ArrayBuffer.isView(list) && !(list instanceof DataView)) || !Number.isSafeInteger(offset) || offset < 0 || offset + drawCount > list.length) throw new Error("invalid multi-draw list");
                        const value = list?.[offset + index];
                        if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid multi-draw value");
                        return value;
                    };
                    try {
                        for (let i = 0; i < drawCount; i++) {
                            let method, values;
                            if (multiMethod === "multiDrawArraysWEBGL") {
                                method = "drawArrays";
                                values = [args[0], at(args[1], args[2], i), at(args[3], args[4], i)];
                            } else if (multiMethod === "multiDrawElementsWEBGL") {
                                method = "drawElements";
                                values = [args[0], at(args[1], args[2], i), args[3], at(args[4], args[5], i)];
                            } else if (multiMethod === "multiDrawArraysInstancedWEBGL") {
                                method = "drawArraysInstanced";
                                values = [args[0], at(args[1], args[2], i), at(args[3], args[4], i), at(args[5], args[6], i)];
                            } else {
                                method = "drawElementsInstanced";
                                values = [args[0], at(args[1], args[2], i), args[3], at(args[4], args[5], i), at(args[6], args[7], i)];
                            }
                            record(state, method, values, undefined, { n: 0 });
                        }
                    } catch { unsupported(state, "multi-draw arguments"); }
                    return result;
                };
            }
            const method = typeof property === "string" ? aliases[property] : undefined;
            if (!method) {
                const value = Reflect.get(target, property, target);
                if (name.startsWith("EXT_disjoint_timer_query") && typeof property === "string" && property.endsWith("EXT")) {
                    if (typeof value === "function") return value.bind(target);
                    if (["createQueryEXT", "deleteQueryEXT", "beginQueryEXT", "endQueryEXT", "queryCounterEXT", "getQueryEXT", "getQueryObjectEXT"].includes(property)) return (...args) => {
                        if (property === "createQueryEXT") return Object.create(null);
                        if (property === "getQueryEXT") return null;
                        if (property === "getQueryObjectEXT") return args[1] === 0x8867 ? true : 0;
                    };
                }
                return typeof value === "function" ? value.bind(target) : value;
            }
            const original = Reflect.get(target, property, target);
            return (...args) => {
                const result = typeof original === "function" ? apply(original, target, args) : missingResult(method, state?.gl, args);
                reflectTrack(method, args, result);
                if (state) { trackState(state, method, args); record(state, method, args, result, { n: 0 }); }
                return result;
            };
        } });
    }

    function trackState(state, method, args) {
        const s = state.shadow;
        switch (method) {
            case "activeTexture": s.activeTexture = args[0]; break;
            case "pixelStorei": s.pixelStore.set(args[0], args[1]); break;
            case "bindBuffer":
                s.buffers.set(args[0], args[1] ?? null);
                if (args[0] === 0x8893) s.vertexArrayElementBuffers.set(state.objects.get(s.vertexArray) || 0, args[1] ?? null);
                break;
            case "bindBufferBase": case "bindBufferRange": s.buffers.set(args[0], args[2] ?? null); break;
            case "bindTexture": s.textures.set(`${s.activeTexture}:${args[0]}`, args[1] ?? null); break;
            case "bindSampler": s.samplers.set(args[0], args[1] ?? null); break;
            case "bindFramebuffer":
                if (args[0] === 0x8CA8) s.readFramebuffer = args[1] ?? null;
                else {
                    s.framebuffer = args[1] ?? null;
                    s.drawFramebuffer = args[1] ?? null;
                    if (args[0] === 0x8D40) s.readFramebuffer = args[1] ?? null;
                }
                break;
            case "bindVertexArray":
                s.vertexArray = args[0] ?? null;
                s.buffers.set(0x8893, s.vertexArrayElementBuffers.get(state.objects.get(s.vertexArray) || 0) ?? null);
                break;
            case "deleteVertexArray": {
                const id = state.objects.get(args[0]) || 0;
                s.vertexArrayElementBuffers.delete(id);
                if (s.vertexArray === args[0]) {
                    s.vertexArray = null;
                    s.buffers.set(0x8893, s.vertexArrayElementBuffers.get(0) ?? null);
                }
                break;
            }
            case "bindRenderbuffer": s.renderbuffer = args[1] ?? null; break;
            case "useProgram": s.program = args[0] ?? null; state.currentProgram = state.objects.get(args[0]) || 0; break;
            case "viewport": s.viewport = args.slice(0, 4); break;
            case "scissor": s.scissor = args.slice(0, 4); break;
            case "clearColor": s.clearColor = args.slice(0, 4); break;
            case "clearDepth": s.clearDepth = args[0]; break;
            case "clearStencil": s.clearStencil = args[0]; break;
            case "colorMask": s.colorMask = args.slice(0, 4); break;
            case "depthMask": s.depthMask = args[0]; break;
            case "depthFunc": s.depthFunc = args[0]; break;
            case "stencilMask": s.stencilMasks = { front: args[0] >>> 0, back: args[0] >>> 0 }; break;
            case "stencilMaskSeparate":
                if (!s.stencilMasks) s.stencilMasks = { front: 0xFFFFFFFF, back: 0xFFFFFFFF };
                if (args[0] === 0x0404 || args[0] === 0x0408) s.stencilMasks.front = args[1] >>> 0;
                if (args[0] === 0x0405 || args[0] === 0x0408) s.stencilMasks.back = args[1] >>> 0;
                break;
            case "blendColor": s.blendColor = args.slice(0, 4); break;
            case "cullFace": s.cullFace = args[0]; break;
            case "frontFace": s.frontFace = args[0]; break;
            case "lineWidth": s.lineWidth = args[0]; break;
            case "enable": s.enabled.add(args[0]); break;
            case "disable": s.enabled.delete(args[0]); break;
        }
    }

    function drawFramebuffer(state) {
        return state.version === 2 ? state.shadow.drawFramebuffer ?? null : state.shadow.framebuffer;
    }
    const copyReads = new WeakMap();  // a copyTex* command -> the framebuffer it read
    function readFramebuffer(state) {
        return state.version === 2 ? state.shadow.readFramebuffer ?? null : state.shadow.framebuffer;
    }

    function shadowParameter(state, gl, parameter) {
        const s = state?.shadow;
        if (!s) return undefined;
        switch (parameter) {
            case gl.ACTIVE_TEXTURE: return s.activeTexture;
            case gl.ARRAY_BUFFER_BINDING: return s.buffers.get(gl.ARRAY_BUFFER) ?? null;
            case gl.ELEMENT_ARRAY_BUFFER_BINDING: return s.buffers.get(gl.ELEMENT_ARRAY_BUFFER) ?? null;
            case gl.CURRENT_PROGRAM: return s.program;
            case gl.VERTEX_ARRAY_BINDING: return s.vertexArray ?? null;
            case gl.TEXTURE_BINDING_2D: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_2D}`) ?? null;
            case gl.TEXTURE_BINDING_CUBE_MAP: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_CUBE_MAP}`) ?? null;
            case gl.TEXTURE_BINDING_3D: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_3D}`) ?? null;
            case gl.TEXTURE_BINDING_2D_ARRAY: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_2D_ARRAY}`) ?? null;
            case gl.SAMPLER_BINDING: return s.samplers.get(s.activeTexture - gl.TEXTURE0) ?? null;
            case gl.UNIFORM_BUFFER_BINDING: return s.buffers.get(gl.UNIFORM_BUFFER) ?? null;
            case gl.FRAMEBUFFER_BINDING: return s.framebuffer;
            case gl.DRAW_FRAMEBUFFER_BINDING: return s.drawFramebuffer ?? s.framebuffer;
            case gl.READ_FRAMEBUFFER_BINDING: return s.readFramebuffer ?? s.framebuffer;
            case gl.RENDERBUFFER_BINDING: return s.renderbuffer;
            case gl.VIEWPORT: return new Int32Array(s.viewport);
            case gl.SCISSOR_BOX: return new Int32Array(s.scissor ?? [0, 0, state.canvas.width, state.canvas.height]);
            case gl.COLOR_CLEAR_VALUE: return new Float32Array(s.clearColor);
            case gl.DEPTH_CLEAR_VALUE: return s.clearDepth;
            case gl.STENCIL_CLEAR_VALUE: return s.clearStencil;
            case gl.COLOR_WRITEMASK: return s.colorMask;
            case gl.DEPTH_WRITEMASK: return s.depthMask;
            case gl.BLEND_COLOR: return new Float32Array(s.blendColor ?? [0, 0, 0, 0]);
            case gl.CULL_FACE_MODE: return s.cullFace ?? gl.BACK;
            case gl.FRONT_FACE: return s.frontFace ?? gl.CCW;
            case gl.LINE_WIDTH: return s.lineWidth ?? 1;
            case gl.DEPTH_FUNC: return s.depthFunc ?? gl.LESS;
            case gl.PACK_ALIGNMENT: case gl.UNPACK_ALIGNMENT: return s.pixelStore.get(parameter) ?? 4;
            case gl.UNPACK_FLIP_Y_WEBGL: case gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return s.pixelStore.get(parameter) ?? false;
            case gl.UNPACK_COLORSPACE_CONVERSION_WEBGL: return s.pixelStore.get(parameter) ?? gl.BROWSER_DEFAULT_WEBGL;
            case 0x0D02: case 0x0D03: case 0x0D04: case 0x0CF2: case 0x0CF3: case 0x0CF4: case 0x806D: case 0x806E:
                return state.version === 2 ? s.pixelStore.get(parameter) ?? 0 : undefined;
            default: return undefined;
        }
    }

    Canvas.prototype.getContext = function (type, ...args) {
        const result = apply(originalGetContext, this, [type, ...args]);
        const kind = String(type).toLowerCase();
        if (result && (kind === "webgl" || kind === "experimental-webgl") && result instanceof GL) {
            fillEnums(result, 1);
            stateFor(this, result, 1);
        }
        else if (result && kind === "webgl2" && GL2 && result instanceof GL2) {
            fillEnums(result, 2);
            stateFor(this, result, 2);
        }
        return result;
    };

    for (const name of allowed) {
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        if (typeof descriptor?.value !== "function") {
            if (gl2OnlyMethods.has(name)) continue;
            Object.defineProperty(GL.prototype, name, { configurable: true, writable: true, value: function (...args) {
                const state = contexts.get(this);
                let result = missingResult(name, this, args);
                if (name === "getExtension" && state) {
                    if (!extensionSupported(args[0], state)) return null;
                    result = addExtensionConstants(null, args[0], state.version, state);
                }
                reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                return result;
            } });
            continue;
        }
        const original = descriptor.value;
        Object.defineProperty(GL.prototype, name, { ...descriptor, value: function (...args) {
            let result = apply(original, this, args);
            const state = contexts.get(this);
            if (name === "getExtension" && state) {
                if (!extensionSupported(args[0], state)) return null;
                result = addExtensionConstants(result, args[0], state.version, state);
            }
            reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
            return result;
        } });
    }
    for (const [name, fallback] of [
        ["getParameter", function (args) { return missingResult("getParameter", this, args); }],
        ["getError", function () { return this.NO_ERROR; }],
        ["checkFramebufferStatus", function () { return this.FRAMEBUFFER_COMPLETE; }],
        ["getShaderParameter", function (args) { return args[1] === this.COMPILE_STATUS ? true : null; }],
        ["getProgramParameter", function (args) { return args[1] === this.LINK_STATUS ? true : null; }],
        ["getShaderPrecisionFormat", function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; }],
        ["getContextAttributes", function () { return { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false }; }],
        ["getShaderInfoLog", function () { return ""; }],
        ["getProgramInfoLog", function () { return ""; }],
        ["getSupportedExtensions", function () { return []; }],
        ["getQuery", function () { return null; }],
        ["getQueryParameter", function (args) { return args[1] === this.QUERY_RESULT_AVAILABLE ? true : 0; }],
        ["isBuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "buffer"; }],
        ["isContextLost", function () { return false; }],
        ["isEnabled", function (args) { return contexts.get(this)?.shadow.enabled.has(args[0]) ?? false; }],
        ["isTexture", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "texture"; }],
        ["isFramebuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "framebuffer"; }],
        ["isRenderbuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "renderbuffer"; }],
        ["isSampler", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "sampler"; }],
        ["isProgram", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "program"; }],
        ["isShader", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "shader"; }],
    ]) {
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        const original = typeof descriptor?.value === "function" ? descriptor.value : null;
        Object.defineProperty(GL.prototype, name, { ...(descriptor ?? {}), configurable: true, writable: true, value: function (...args) {
            const state = contexts.get(this);
            const kind = name.slice(2).toLowerCase();
            if (name.startsWith("is") && state?.objectKinds.get(args[0]) === kind) return true;
            if (name === "isEnabled" && state) return state.shadow.enabled.has(args[0]);
            if (name === "getParameter") {
                // Fixed strings so detectors see a stable WebKit-like GPU identity
                // (Moli often returns nothing → "Unknown").
                if (args[0] === this.VENDOR) return "WebKit";
                if (args[0] === this.RENDERER) return "WebKit WebGL";
            }
            let result = original ? apply(original, this, args) : null;
            if (name === "getSupportedExtensions") return [...supportedExtensions].filter((extension) => extensionSupported(extension, state));
            if (name === "getParameter" && result == null) result = shadowParameter(state, this, args[0]);
            return result == null ? fallback.call(this, args) : result;
        } });
    }
    // Unknown WebGL calls make the mirror visibly incomplete. Read-only
    // queries stay local to Moli; they do not affect viewer replay state.
    for (const name of Object.getOwnPropertyNames(GL.prototype)) {
        if (name === "constructor" || allowed.has(name) || skipQueries.has(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        if (typeof descriptor?.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(GL.prototype, name, { ...descriptor, value: function (...args) {
            const result = apply(original, this, args);
            const state = contexts.get(this);
            if (state) unsupported(state, `method:${name}`);
            return result;
        } });
    }

    // Moli models WebGL2 with a separate prototype rather than inheriting
    // WebGLRenderingContext, so install the same bounded recorder there and
    // fill missing core calls with compatibility shims.
    if (GL2 && GL2.prototype !== GL.prototype) {
        const proto = GL2.prototype;
        for (const name of allowed) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function") {
                if (name in proto) continue;
                Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...args) {
                    const state = contexts.get(this);
                    let result = missingResult(name, this, args);
                    if (name === "getExtension" && state) {
                        if (!extensionSupported(args[0], state)) return null;
                        result = addExtensionConstants(null, args[0], state.version, state);
                    }
                    reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                    return result;
                } });
                continue;
            }
            const original = descriptor.value;
            Object.defineProperty(proto, name, { ...descriptor, value: function (...args) {
                let result = apply(original, this, args);
                const state = contexts.get(this);
                if (name === "getExtension" && state) {
                    if (!extensionSupported(args[0], state)) return null;
                    result = addExtensionConstants(result, args[0], state.version, state);
                }
                reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                return result;
            } });
        }
        for (const [name, fallback] of [
            ["getParameter", function (args) { return missingResult("getParameter", this, args); }],
            ["getError", function () { return this.NO_ERROR; }],
            ["checkFramebufferStatus", function () { return this.FRAMEBUFFER_COMPLETE; }],
            ["getShaderParameter", function (args) { return args[1] === this.COMPILE_STATUS ? true : null; }],
            ["getProgramParameter", function (args) { return args[1] === this.LINK_STATUS ? true : null; }],
            ["getShaderPrecisionFormat", function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; }],
            ["getContextAttributes", function () { return { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false }; }],
            ["getShaderInfoLog", function () { return ""; }], ["getProgramInfoLog", function () { return ""; }],
            ["getSupportedExtensions", function () { return []; }],
            ["getQuery", function () { return null; }],
            ["getQueryParameter", function (args) { return args[1] === this.QUERY_RESULT_AVAILABLE ? true : 0; }],
            ["isContextLost", function () { return false; }],
            ["isBuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "buffer"; }],
            ["isTexture", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "texture"; }],
            ["isFramebuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "framebuffer"; }],
            ["isRenderbuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "renderbuffer"; }],
            ["isSampler", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "sampler"; }],
            ["isProgram", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "program"; }],
            ["isShader", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "shader"; }],
            ["isQuery", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "query"; }],
            ["isSync", function () { return false; }],
            ["isTransformFeedback", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "transformfeedback"; }],
            ["isVertexArray", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "vertexarray"; }],
            ["isEnabled", function (args) { return contexts.get(this)?.shadow.enabled.has(args[0]) ?? false; }],
        ]) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function" && name in proto) continue;
            const original = typeof descriptor?.value === "function" ? descriptor.value : null;
            Object.defineProperty(proto, name, { ...(descriptor ?? {}), configurable: true, writable: true, value: function (...args) {
                const state = contexts.get(this);
                const kind = name.slice(2).toLowerCase();
                if (name.startsWith("is") && state?.objectKinds.get(args[0]) === kind) return true;
                if (name === "isEnabled" && state) return state.shadow.enabled.has(args[0]);
                if (name === "getParameter") {
                    if (args[0] === this.VENDOR) return "WebKit";
                    if (args[0] === this.RENDERER) return "WebKit WebGL";
                }
                let result = original ? apply(original, this, args) : null;
                if (name === "getSupportedExtensions") return [...supportedExtensions].filter((extension) => extensionSupported(extension, state));
                if (name === "getParameter" && result == null) result = shadowParameter(state, this, args[0]);
                return result == null ? fallback.call(this, args) : result;
            } });
        }
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === "constructor" || allowed.has(name) || skipQueries.has(name)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function") continue;
            const original = descriptor.value;
            Object.defineProperty(proto, name, { ...descriptor, value: function (...args) {
                const result = apply(original, this, args);
                const state = contexts.get(this);
                if (state) unsupported(state, `method:${name}`);
                return result;
            } });
        }
    }

    // Moli links programs without reflecting them: it has no
    // getActiveUniform or getActiveAttrib, which libraries such as three.js
    // use to find a program's uniforms and attributes. They're read from the
    // shaders' source instead: what's declared, after the preprocessor's
    // conditionals, is reported active. (A browser leaves out what a shader
    // doesn't use; the viewer replays calls on those as doing nothing.)
    const shaderInfo = new WeakMap();    // shader -> { type, source }
    const programShaders = new WeakMap(); // program -> Set of shaders
    const programInfo = new WeakMap();   // program -> { uniforms, attributes, locations }, as linked
    const programBindings = new WeakMap(); // program -> Map of attribute name -> location bound
    function reflectTrack(method, args, result) {
        try {
            switch (method) {
                case "createShader": if (result && typeof result === "object") shaderInfo.set(result, { type: args[0], source: "" }); break;
                case "shaderSource": { const info = shaderInfo.get(args[0]); if (info) info.source = String(args[1] ?? ""); break; }
                case "attachShader": {
                    if (!args[0] || typeof args[0] !== "object") break;
                    if (!programShaders.has(args[0])) programShaders.set(args[0], new Set());
                    programShaders.get(args[0]).add(args[1]);
                    break;
                }
                case "detachShader": programShaders.get(args[0])?.delete(args[1]); break;
                case "bindAttribLocation": {
                    if (!args[0] || typeof args[0] !== "object" || !Number.isInteger(args[1])) break;
                    if (!programBindings.has(args[0])) programBindings.set(args[0], new Map());
                    programBindings.get(args[0]).set(String(args[2]), args[1]);
                    break;
                }
                case "linkProgram": {
                    const uniforms = [], attributes = [], seen = new Set();
                    for (const shader of programShaders.get(args[0]) ?? []) {
                        const info = shaderInfo.get(shader);
                        if (!info) continue;
                        const declared = glslDeclared(info.source, info.type === 0x8B31);
                        for (const u of declared.uniforms) if (!seen.has(u.name)) { seen.add(u.name); uniforms.push(u); }
                        attributes.push(...declared.attributes);
                    }
                    // Where each attribute is: bound before linking, or as its
                    // layout says, or else the first free locations (a matrix
                    // takes one a column).
                    const bound = programBindings.get(args[0]) ?? new Map(), used = new Set();
                    const columns = { 0x8B5A: 2, 0x8B5B: 3, 0x8B5C: 4, 0x8B65: 2, 0x8B66: 2, 0x8B67: 3, 0x8B68: 3, 0x8B69: 4, 0x8B6A: 4 };
                    const take = (a, at) => { a.location = at; for (let i = 0; i < (columns[a.type] ?? 1) * a.size; i++) used.add(at + i); };
                    for (const a of attributes) if (bound.has(a.name)) take(a, bound.get(a.name)); else if (a.layout >= 0) take(a, a.layout);
                    for (const a of attributes) {
                        if (a.location !== undefined) continue;
                        const span = (columns[a.type] ?? 1) * a.size;
                        let at = 0;
                        while ([...Array(span).keys()].some((i) => used.has(at + i))) at++;
                        take(a, at);
                    }
                    programInfo.set(args[0], { uniforms, attributes: attributes.map(({ name, type, size }) => ({ name, type, size })), locations: new Map(attributes.map((a) => [a.name, a.location])) });
                    break;
                }
            }
        } catch { /* reflection is best effort; the program still links */ }
    }
    function activeInfo(entry) {
        if (!entry) return null;
        const Info = globalThis.WebGLActiveInfo;
        const info = Info ? Object.create(Info.prototype) : {};
        for (const [key, value] of Object.entries(entry)) Object.defineProperty(info, key, { value, enumerable: true });
        return info;
    }
    const reflectionShims = {
        getActiveUniform(program, index) { return activeInfo(programInfo.get(program)?.uniforms[index]); },
        getActiveAttrib(program, index) { return activeInfo(programInfo.get(program)?.attributes[index]); },
        getAttachedShaders(program) { return [...(programShaders.get(program) ?? [])]; },
        getShaderSource(shader) { return shaderInfo.get(shader)?.source ?? null; },
        disableVertexAttribArray() {},
        finish() {}, flush() {},
        getBufferParameter(target, pname) { return pname === 0x8765 ? 0x88E4 : 0; },
        getTexParameter() { return null; }, getUniform() { return null; }, getVertexAttrib() { return null; }, getVertexAttribOffset() { return 0; },
        getFramebufferAttachmentParameter() { return null; }, getRenderbufferParameter() { return null; },
        makeXRCompatible() { return Promise.resolve(); },
    };
    const reflectionShims2 = {
        getUniformBlockIndex() { return 0xFFFFFFFF; },
        getUniformIndices(program, names) { return Array.from(names ?? [], (name) => { const i = programInfo.get(program)?.uniforms.findIndex((u) => u.name === name || u.name === `${name}[0]`); return i >= 0 ? i : 0xFFFFFFFF; }); },
        getActiveUniforms(program, indices, pname) { return Array.from(indices ?? [], (i) => { const u = programInfo.get(program)?.uniforms[i]; return pname === 0x8A37 ? u?.type ?? 0 : pname === 0x8A38 ? u?.size ?? 0 : pname === 0x8A3A ? -1 : pname === 0x8A3E ? false : pname === 0x8A3B || pname === 0x8A3C || pname === 0x8A3D ? -1 : 0; }); },
        getActiveUniformBlockName() { return null; }, getActiveUniformBlockParameter() { return null; },
        getIndexedParameter() { return null; }, getSamplerParameter() { return null; }, getTransformFeedbackVarying() { return null; },
        getBufferSubData() {},
        fenceSync() { return Object.create(null); }, clientWaitSync() { return 0x911A; }, waitSync() {}, deleteSync() {},
        getSyncParameter(sync, pname) { return pname === 0x9114 ? 0x9119 : pname === 0x9112 ? 0x9116 : pname === 0x9113 ? 0x9117 : 0; },
    };
    for (const [proto, shims] of [[GL.prototype, reflectionShims], ...(GL2 ? [[GL2.prototype, { ...reflectionShims, ...reflectionShims2 }]] : [])]) {
        const reflected = typeof proto.getActiveUniform !== "function";
        for (const [name, fn] of Object.entries(shims)) {
            if (typeof proto[name] === "function") continue;
            try { Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn }); } catch { /* sealed */ }
        }
        if (!reflected) continue;
        // The counts libraries loop to come from the same reflection.
        const program = proto.getProgramParameter, shader = proto.getShaderParameter;
        Object.defineProperty(proto, "getProgramParameter", { configurable: true, writable: true, value: function (p, pname) {
            if (pname === 0x8B86) return programInfo.get(p)?.uniforms.length ?? 0;
            if (pname === 0x8B89) return programInfo.get(p)?.attributes.length ?? 0;
            if (pname === 0x8B85) return programShaders.get(p)?.size ?? 0;
            if (pname === 0x8A36) return 0;
            const result = typeof program === "function" ? apply(program, this, [p, pname]) : null;
            if (result != null) return result;
            return pname === 0x8B80 ? false : pname === 0x8B83 ? true : result;
        } });
        Object.defineProperty(proto, "getShaderParameter", { configurable: true, writable: true, value: function (s, pname) {
            if (pname === 0x8B4F) return shaderInfo.get(s)?.type ?? null;
            const result = typeof shader === "function" ? apply(shader, this, [s, pname]) : null;
            return result == null && pname === 0x8B80 ? false : result;
        } });
    }

    // The agent's reads of a same-origin frame's canvases, done here for it
    // (Moli doesn't take the agent's events to a frame's page): asked on the
    // iframe, the frame's canvas by its place among the frame's canvases;
    // the reply sent back on the iframe. (That it's drawn on, the frame's
    // own gogl.js tells on its iframe: signal.)
    globalThis.addEventListener("__tabtop_frame_canvas", (event) => {
        const frame = (event.composedPath?.()[0] ?? event.target);  // (in a shadow root too)
        if (!(frame instanceof HTMLIFrameElement) || typeof event.detail !== "string" || event.detail.length > 256) return;
        let request, doc;
        try { request = JSON.parse(event.detail); doc = frame.contentDocument; } catch { return; }
        if (!doc || !Number.isInteger(request?.index) || !["__tabtop_webgl_capture", "__tabtop_webgl_undo", "__tabtop_canvas_capture"].includes(request.type)) return;
        const tellFrame = (type, detail) => { try { apply(originalDispatch, frame, [new CustomEventCtor(type, { bubbles: true, detail })]); } catch { /* gone */ } };
        const canvas = doc.querySelectorAll("canvas")[request.index];
        if (!canvas) return;
        let reply = null;
        const heard = (e) => { reply = e.detail; };
        canvas.addEventListener("__tabtop_canvas_pixels", heard);
        try { apply(originalDispatch, canvas, [new CustomEventCtor(request.type, { bubbles: true, detail: typeof request.detail === "string" ? request.detail : null })]); } catch { /* gone */ }
        canvas.removeEventListener("__tabtop_canvas_pixels", heard);
        if (typeof reply === "string") tellFrame("__tabtop_frame_canvas_reply", JSON.stringify({ index: request.index, reply }));
    }, true);

    // The capture protocol, with the agent (goagent.js's canvasPixels), on a
    // canvas's events:
    //   __tabtop_webgl_capture, "full" or "delta": the agent takes the log,
    //     whole or the calls since it last took it (from state.sent), in
    //     __tabtop_canvas_pixels's reply: {gl: {v, w, h, r, version,
    //     attributes}}, as it goes on to the server and the viewer (r: whole),
    //     or {e} if it can't be had. Whole, too, if the log was replaced
    //     since (compacted, the context lost and back: state.wholeNext).
    //   __tabtop_webgl_undo, "full" or "delta": the agent gives back what it
    //     just took (its batch had no room): state.lastTake puts sent and
    //     wholeNext back as they were, so it's taken again next time.
    //   __tabtop_webgl_dirty, from here: the canvas was drawn on.
    // On the window, not the document: a frame navigated from its first
    // (about:blank) document keeps its window, and this script isn't run again.
    globalThis.addEventListener("__tabtop_webgl_undo", (event) => {
        const at = (event.composedPath?.()[0] ?? event.target);  // (in a shadow root too)
        const state = at instanceof Canvas ? contextByCanvas.get(at) : null;
        if (!state?.lastTake) return;
        state.sent = Math.min(state.lastTake.sent, state.commands.length);
        state.wholeNext = state.lastTake.wholeNext || event.detail === "full";
        state.lastTake = null;
    }, true);
    globalThis.addEventListener("__tabtop_webgl_capture", (event) => {
        const canvas = (event.composedPath?.()[0] ?? event.target);  // (in a shadow root too)
        if (!(canvas instanceof Canvas)) return;
        const state = contextByCanvas.get(canvas);
        if (!state) return;
        let result = { e: "unsupported" };
        if (state && canvas.width > 0 && canvas.height > 0 && canvas.width <= 4096 && canvas.height <= 4096 && canvas.width * canvas.height <= 16 * 1024 * 1024) {
            if (state.bad) result = { e: "unsupported" };
            else {
                try {
                    const full = event.detail === "full" || state.wholeNext === true;
                    const v = JSON.stringify(full ? state.commands : state.commands.slice(state.sent));
                    result = v.length <= maxJSON ? { gl: { v, w: canvas.width, h: canvas.height, r: full, version: state.version, attributes: state.attributes } } : { e: "large" };
                    if (v.length <= maxJSON) {
                        state.lastTake = { sent: state.sent, wholeNext: state.wholeNext === true };
                        state.sent = state.commands.length;
                        state.wholeNext = false;
                    }
                } catch { result = { e: "unsupported" }; }
            }
        } else if (state) result = { e: "large" };
        try { apply(originalDispatch, canvas, [new CustomEventCtor("__tabtop_canvas_pixels", { bubbles: true, detail: JSON.stringify(result) })]); } catch { /* detached canvas */ }
    }, true);
})();
