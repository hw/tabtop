// WebGL in the page's copy (go-frame.html, after go-frame.js's own
// comment): a canvas's WebGL command log, recorded in the engine's page
// (gogl.js) and checked by the server (gocanvasgl.go), replayed on a context
// of the viewer's own, within what's checked here of what it may ask of
// this browser's GPU (glCheck); kept to be replayed again if the viewer
// loses the context and gets it back; and given up, the canvas greyed and
// labelled, when it can't be.
//
// go-frame.js makes it with what it needs of the copy (host): the
// generation shown, or being built (current), whether a 2D picture's been
// drawn on a canvas (drawn2D), and a new canvas put in one's place
// (replaceCanvas, for a full log replayed from a context's first state).
"use strict";

globalThis.goFrameGL = (host) => {
    const glCanvases = new WeakMap();
    const glContextListeners = new WeakSet();
    const glGrayed = new WeakSet();  // canvases given a grey background by a failed replay
    const glMethods = new Set(("activeTexture attachShader disableVertexAttribArray validateProgram bindAttribLocation bindBuffer bindFramebuffer bindRenderbuffer bindTexture blendColor blendEquation blendEquationSeparate blendFunc blendFuncSeparate bufferData bufferSubData clear clearColor clearDepth clearStencil colorMask compileShader copyTexImage2D copyTexSubImage2D cullFace deleteBuffer deleteFramebuffer deleteProgram deleteRenderbuffer deleteShader deleteTexture depthFunc depthMask depthRange detachShader disable enable enableVertexAttribArray framebufferRenderbuffer framebufferTexture2D frontFace generateMipmap getAttribLocation getExtension getUniformLocation hint lineWidth linkProgram pixelStorei polygonOffset renderbufferStorage sampleCoverage scissor shaderSource stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate stencilOp stencilOpSeparate texImage2D texParameterf texParameteri texSubImage2D uniform1f uniform1fv uniform1i uniform1iv uniform2f uniform2fv uniform2i uniform2iv uniform3f uniform3fv uniform3i uniform3iv uniform4f uniform4fv uniform4i uniform4iv uniformMatrix2fv uniformMatrix3fv uniformMatrix4fv useProgram vertexAttrib1f vertexAttrib1fv vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv vertexAttribPointer viewport drawArrays drawElements createBuffer createFramebuffer createProgram createRenderbuffer createShader createTexture bindBufferBase bindBufferRange bindVertexArray blitFramebuffer clearBufferfi clearBufferfv clearBufferiv clearBufferuiv copyTexSubImage3D createVertexArray deleteVertexArray drawArraysInstanced drawElementsInstanced drawRangeElements framebufferTextureLayer readBuffer renderbufferStorageMultisample texImage3D texStorage2D texStorage3D texSubImage3D vertexAttribDivisor drawBuffers samplerParameterf samplerParameteri bindSampler createSampler deleteSampler bindTransformFeedback beginTransformFeedback endTransformFeedback createTransformFeedback deleteTransformFeedback pauseTransformFeedback resumeTransformFeedback createQuery deleteQuery beginQuery endQuery queryCounter getQuery getQueryParameter getFragDataLocation enableiOES disableiOES blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES polygonModeWEBGL copyBufferSubData invalidateFramebuffer invalidateSubFramebuffer compressedTexImage2D compressedTexSubImage2D compressedTexImage3D compressedTexSubImage3D uniform1ui uniform1uiv uniform2ui uniform2uiv uniform3ui uniform3uiv uniform4ui uniform4uiv uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4x2fv uniformMatrix4x3fv uniformBlockBinding transformFeedbackVaryings vertexAttribIPointer vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv").split(/\s+/));
    const gl2OnlyMethods = new Set(("bindBufferBase bindBufferRange bindSampler bindTransformFeedback beginQuery beginTransformFeedback bindVertexArray blitFramebuffer clearBufferfi clearBufferfv clearBufferiv clearBufferuiv compressedTexImage3D compressedTexSubImage3D copyBufferSubData copyTexSubImage3D createQuery createSampler createTransformFeedback createVertexArray deleteQuery deleteSampler deleteTransformFeedback deleteVertexArray drawArraysInstanced drawBuffers drawElementsInstanced drawRangeElements endQuery endTransformFeedback framebufferTextureLayer getFragDataLocation getQuery getQueryParameter enableiOES disableiOES blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES invalidateFramebuffer invalidateSubFramebuffer pauseTransformFeedback queryCounter readBuffer renderbufferStorageMultisample resumeTransformFeedback samplerParameterf samplerParameteri texImage3D texStorage2D texStorage3D texSubImage3D transformFeedbackVaryings uniform1ui uniform1uiv uniform2ui uniform2uiv uniform3ui uniform3uiv uniform4ui uniform4uiv uniformBlockBinding uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4x2fv uniformMatrix4x3fv vertexAttribDivisor vertexAttribIPointer vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv").split(/\s+/));
    const extensionMethods = { createVertexArray: ["OES_vertex_array_object", "createVertexArrayOES"], bindVertexArray: ["OES_vertex_array_object", "bindVertexArrayOES"], deleteVertexArray: ["OES_vertex_array_object", "deleteVertexArrayOES"], drawArraysInstanced: ["ANGLE_instanced_arrays", "drawArraysInstancedANGLE", "WEBGL_multi_draw", "multiDrawArraysInstancedWEBGL"], drawElementsInstanced: ["ANGLE_instanced_arrays", "drawElementsInstancedANGLE", "WEBGL_multi_draw", "multiDrawElementsInstancedWEBGL"], vertexAttribDivisor: ["ANGLE_instanced_arrays", "vertexAttribDivisorANGLE"], drawBuffers: ["WEBGL_draw_buffers", "drawBuffersWEBGL"] };
    const extensionCommandMethods = Object.fromEntries(["enableiOES", "disableiOES", "blendEquationiOES", "blendEquationSeparateiOES", "blendFunciOES", "blendFuncSeparateiOES", "colorMaskiOES"].map((name) => [name, ["OES_draw_buffers_indexed", name]]));
    extensionCommandMethods.polygonModeWEBGL = ["WEBGL_polygon_mode", "polygonModeWEBGL"];
    const requiredRenderingExtensions = new Set(["OES_element_index_uint", "OES_standard_derivatives", "WEBGL_depth_texture", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_float_blend", "OES_draw_buffers_indexed", "WEBGL_polygon_mode", "EXT_texture_filter_anisotropic"]);
    const webgl2CoreExtensions = new Set(["OES_element_index_uint", "OES_standard_derivatives", "WEBGL_depth_texture", "OES_texture_float", "OES_texture_half_float", "OES_texture_half_float_linear", "OES_vertex_array_object", "ANGLE_instanced_arrays", "WEBGL_draw_buffers", "WEBGL_compressed_texture_etc"]);
    const glTyped = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ...(typeof Float16Array === "function" ? { Float16Array } : {}) };
    // What replay may ask of the viewer's GPU, whatever the page asked of
    // Moli: each allocation and draw is bounded, and so is what a context
    // holds at once (its objects' storage, by what's bound when it's given).
    const glExtensionList = ["OES_element_index_uint", "OES_standard_derivatives", "WEBGL_depth_texture", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_float_blend", "OES_draw_buffers_indexed", "WEBGL_polygon_mode", "EXT_texture_filter_anisotropic", "EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2", "OES_vertex_array_object", "ANGLE_instanced_arrays", "WEBGL_draw_buffers", "WEBGL_multi_draw", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_pvrtc", "WEBGL_compressed_texture_atc", "WEBGL_compressed_texture_astc", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc"];
    const glExtensionNames = new Set(glExtensionList);
    const glLimits = { size: 4096, depth: 256, texels: 64 << 20, levels: 13, samples: 8, buffer: 64 << 20, draw: 16 << 20, instances: 1 << 20, context: 256 << 20, mirrors: 16, commands: 4096, log: 4 << 20 };
    const glLive = new Map();  // canvases with a replay context -> their document's generation
    const glAttached = new WeakSet();  // of those, the ones seen in the page
    // When the viewer's contexts were lost (GPU resets), in the last minute:
    // a reset loses them all at once, and counts once (losses within a
    // second of its first). After 3, no more WebGL here for a minute, and
    // each time again after for twice as long as the last (a page that
    // keeps resetting the GPU, with new canvases, isn't let go on).
    let glResets = [], glOffUntil = 0, glOffTimes = 0;
    const glOff = (now = performance.now()) => now < glOffUntil;
    // glReset counts a context lost, and is whether WebGL's off now.
    function glReset() {
        const now = performance.now();
        glResets = glResets.filter((t) => now - t < 60000);
        if (!glResets.length || now - glResets.at(-1) >= 1000) glResets.push(now);
        if (glResets.length >= 3 && !glOff(now)) {
            glOffUntil = now + 60000 * 2 ** Math.min(glOffTimes++, 10);
            glResets = [];
        }
        return glOff(now);
    }
    // Calls a string may be passed to, and those a sequence may (uniform*v
    // and the like): WebGL would turn any other string or array into a
    // number, past the bounds checked here.
    const glAllocations = new Set(["bufferData", "texImage2D", "texImage3D", "copyTexImage2D", "compressedTexImage2D", "compressedTexImage3D", "texStorage2D", "texStorage3D", "renderbufferStorage", "renderbufferStorageMultisample"]);
    const glStringMethods = new Set(["shaderSource", "getExtension", "bindAttribLocation", "getUniformLocation", "getAttribLocation", "getFragDataLocation", "transformFeedbackVaryings"]);
    const glSequenceMethod = (m) => m.endsWith("v") || m === "drawBuffers" || m.startsWith("invalidate") || m === "transformFeedbackVaryings";
    function glCheck(mirror, command) {
        const a = command.a, n = (i) => (typeof a[i] === "number" ? a[i] : 0);
        for (const arg of a) {
            if (typeof arg === "string" && !glStringMethods.has(command.m)) throw new Error("WebGL string argument");
            if (Array.isArray(arg) && !glSequenceMethod(command.m)) throw new Error("WebGL array argument");
        }
        const ref = (v) => (v && typeof v === "object" && Number.isInteger(v.ref) ? v.ref : 0);
        const b = mirror.budget ||= { bound: new Map(), bytes: new Map(), total: 0, unit: 0, vao: 0, vaoElements: new Map(), draw: 0, read: 0, tf: 0, holders: new Map(), zombies: new Set() };
        const dims = (w, h, d = 1, samples = 1) => {
            if (w < 0 || h < 0 || d < 0 || w > glLimits.size || h > glLimits.size || d > glLimits.depth || w * h * d > glLimits.texels || samples > glLimits.samples) throw new Error("WebGL allocation too large");
            return w * h * d * 4 * Math.max(1, samples);
        };
        // (Storage given where nothing's bound would be a GL error; refused
        // here too, so nothing can be counted to no object.)
        const store = (key, slot, bytes) => {
            if (!key) throw new Error("WebGL storage for nothing bound");
            const per = b.bytes.get(key) ?? new Map();
            b.total += bytes - (per.get(slot) ?? 0);
            per.set(slot, bytes);
            b.bytes.set(key, per);
            if (b.total > glLimits.context) throw new Error("WebGL memory budget");
        };
        const texture = (target) => b.bound.get(`t${b.unit}:${target >= 0x8515 && target <= 0x851A ? 0x8513 : target}`);
        // An object deleted while a framebuffer, vertex array or transform
        // feedback not bound still holds it keeps its storage (GL): counted
        // till the last lets go of it (a zombie till then).
        const held = (id) => {
            for (const v of b.vaoElements.values()) if (v === id) return true;
            for (const m of b.holders.values()) for (const v of m.values()) if (v === id) return true;
            return false;
        };
        const free = (id) => {
            const per = b.bytes.get(id);
            if (per) for (const v of per.values()) b.total -= v;
            b.bytes.delete(id);
        };
        const letGo = (id) => {
            if (id && b.zombies.has(id) && !held(id)) {
                b.zombies.delete(id);
                free(id);
            }
        };
        const hold = (holder, slots, id) => {
            const m = b.holders.get(holder) ?? new Map();
            b.holders.set(holder, m);
            for (const slot of slots) {
                const old = m.get(slot);
                if (id) m.set(slot, id); else m.delete(slot);
                if (old && old !== id) letGo(old);
            }
        };
        const dropHolder = (holder) => {
            const m = b.holders.get(holder);
            b.holders.delete(holder);
            if (m) for (const id of new Set(m.values())) letGo(id);
        };
        // (DEPTH_STENCIL_ATTACHMENT is both.)
        const attachment = (point) => (point === 0x821A ? [0x8D00, 0x8D20] : [point]);
        const framebuffer = (target) => (target === 0x8CA8 ? b.read : b.draw);
        // Deleted: detached from what's bound (WebGL does), else kept.
        const deleted = (id, holders) => {
            for (const holder of holders) {
                const m = b.holders.get(holder);
                if (m) for (const [slot, v] of m) if (v === id) m.delete(slot);
            }
            if (!id) return;
            if (held(id)) b.zombies.add(id);
            else free(id);
        };
        switch (command.m) {
            case "activeTexture": b.unit = n(0); break;
            case "bindBuffer":
                b.bound.set(`b${n(0)}`, ref(a[1]));
                if (n(0) === 0x8893) {
                    const old = b.vaoElements.get(b.vao);
                    b.vaoElements.set(b.vao, ref(a[1]));  // the vertex array's own
                    letGo(old);
                }
                break;
            case "bindBufferBase": case "bindBufferRange":
                b.bound.set(`b${n(0)}`, ref(a[2]));
                if (n(0) === 0x8C8E) hold(`x${b.tf}`, [n(1)], ref(a[2]));  // the transform feedback's own
                break;
            case "vertexAttribPointer": case "vertexAttribIPointer": hold(`v${b.vao}`, [n(0)], b.bound.get("b34962") ?? 0); break;
            case "bindFramebuffer":
                if (n(0) !== 0x8CA8) b.draw = ref(a[1]);
                if (n(0) !== 0x8CA9) b.read = ref(a[1]);
                break;
            case "framebufferTexture2D": case "framebufferRenderbuffer":
                if (framebuffer(n(0))) hold(`f${framebuffer(n(0))}`, attachment(n(1)), ref(a[3]));
                break;
            case "framebufferTextureLayer":
                if (framebuffer(n(0))) hold(`f${framebuffer(n(0))}`, attachment(n(1)), ref(a[2]));
                break;
            case "deleteFramebuffer": {
                const gone = ref(a[0]);
                if (gone && gone === b.draw) b.draw = 0;
                if (gone && gone === b.read) b.read = 0;
                dropHolder(`f${gone}`);
                break;
            }
            case "deleteTransformFeedback": {
                const gone = ref(a[0]);
                if (gone && gone === b.tf) b.tf = 0;
                dropHolder(`x${gone}`);
                break;
            }
            case "bindVertexArray":
                b.vao = ref(a[0]);
                b.bound.set("b34963", b.vaoElements.get(b.vao) ?? 0);
                break;
            // A transform feedback object brings buffers of its own: what's
            // bound to its target is unknown till bound again.
            case "bindTransformFeedback":
                b.bound.set("b35982", 0);
                b.tf = ref(a[1]);
                break;
            case "deleteVertexArray": {
                // The bound one deleted: GL goes back to the default one.
                const gone = ref(a[0]);
                const elements = b.vaoElements.get(gone);
                b.vaoElements.delete(gone);
                if (gone && gone === b.vao) {
                    b.vao = 0;
                    b.bound.set("b34963", b.vaoElements.get(0) ?? 0);
                }
                if (gone) {
                    dropHolder(`v${gone}`);
                    letGo(elements);
                }
                break;
            }
            case "bindTexture": b.bound.set(`t${b.unit}:${n(0)}`, ref(a[1])); break;
            case "bindRenderbuffer": b.bound.set("r", ref(a[1])); break;
            case "deleteTexture": case "deleteRenderbuffer": deleted(ref(a[0]), [`f${b.draw}`, `f${b.read}`]); break;
            case "deleteBuffer": {
                const gone = ref(a[0]);
                if (gone && b.vaoElements.get(b.vao) === gone) b.vaoElements.set(b.vao, 0);
                deleted(gone, [`v${b.vao}`, `x${b.tf}`]);
                break;
            }
            case "bufferData": {
                const bytes = typeof a[1] === "number" ? a[1] : 0;
                if (bytes < 0 || bytes > glLimits.buffer) throw new Error("WebGL buffer too large");
                store(b.bound.get(`b${n(0)}`), 0, bytes || (a[1]?.data?.length ?? 0) * 0.75);
                break;
            }
            case "texImage2D": case "copyTexImage2D": case "compressedTexImage2D": {
                // (compressedTexImage2D's width and height are always its 4th
                // and 5th: WebGL1's 7 arguments too.)
                const [w, h] = command.m === "copyTexImage2D" ? [n(5), n(6)] : a.length >= 8 || command.m === "compressedTexImage2D" ? [n(3), n(4)] : [a[5]?.width ?? 0, a[5]?.height ?? 0];
                store(texture(n(0)), `${n(0)}:${n(1)}`, dims(w, h));
                if (command.m === "compressedTexImage2D" && typeof a[6] === "number" && a[6] > glLimits.buffer) throw new Error("WebGL upload too large");
                break;
            }
            case "texImage3D": case "compressedTexImage3D":
                store(texture(n(0)), `${n(0)}:${n(1)}`, dims(n(3), n(4), n(5)));
                if (command.m === "compressedTexImage3D" && typeof a[7] === "number" && a[7] > glLimits.buffer) throw new Error("WebGL upload too large");
                break;
            case "texStorage2D": case "texStorage3D": {
                if (n(1) < 1 || n(1) > glLimits.levels) throw new Error("WebGL texture levels");
                const bytes = command.m === "texStorage2D" ? dims(n(3), n(4)) : dims(n(3), n(4), n(5));
                store(texture(n(0)), "storage", Math.ceil(bytes * (n(1) > 1 ? 4 / 3 : 1)) * (n(0) === 0x8513 ? 6 : 1));
                break;
            }
            case "renderbufferStorage": store(b.bound.get("r"), 0, dims(n(2), n(3))); break;
            case "renderbufferStorageMultisample": store(b.bound.get("r"), 0, dims(n(3), n(4), 1, n(1))); break;
            case "drawArrays": if (n(2) > glLimits.draw) throw new Error("WebGL draw too large"); break;
            case "drawElements": if (n(1) > glLimits.draw) throw new Error("WebGL draw too large"); break;
            case "drawRangeElements": if (n(3) > glLimits.draw) throw new Error("WebGL draw too large"); break;
            case "drawArraysInstanced": if (n(2) > glLimits.draw || n(3) > glLimits.instances || n(2) * n(3) > glLimits.draw * 4) throw new Error("WebGL draw too large"); break;
            case "drawElementsInstanced": if (n(1) > glLimits.draw || n(4) > glLimits.instances || n(1) * n(4) > glLimits.draw * 4) throw new Error("WebGL draw too large"); break;
            case "getExtension": if (!glExtensionNames.has(a[0])) throw new Error("WebGL extension not mirrored"); break;
        }
    }
    // glDrop gives up a canvas's replay context, freeing what it holds on
    // the GPU; its last frame goes with it.
    function glDrop(el) {
        const mirror = glCanvases.get(el);
        glLive.delete(el);
        if (!mirror?.gl) return;
        mirror.history = null;  // not replayed again
        try { if (!mirror.gl.isContextLost()) mirror.gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* lost already */ }
    }
    // An attribute the viewer's shader compiler left out (its location -1):
    // calls setting it up are skipped, as they'd do nothing here.
    const glSkip = Symbol("inactive attribute");
    function webglFrame(el, encoded, width, height, version = 1, attributes = 27, reset = true, d = null) {
        if (reset && (glCanvases.has(el) || host.drawn2D(el))) el = host.replaceCanvas(d, el);
        try {
            if (typeof encoded !== "string" || encoded.length > glLimits.log || !Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(attributes) || attributes < 0 || attributes > 63 || !Number.isInteger(version) || ![1, 2].includes(version) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > (16 << 20)) throw new Error("limits");
            const commands = JSON.parse(encoded);
            if (!Array.isArray(commands) || commands.length > glLimits.commands) throw new Error("commands");
            let mirror = !reset ? glCanvases.get(el) : null;
            if (mirror?.failed) throw new Error("WebGL mirror requires a full snapshot");
            if (!reset && !mirror) throw new Error("WebGL calls without their log");
            if (!mirror) {
                if (glOff()) throw new Error("WebGL off after repeated GPU resets");
                // Those gone from the copy give theirs up: of a document since
                // replaced (still shown while the next is made), or seen in it
                // and not now. (One being made, in a snapshot not yet shown,
                // isn't in it yet.)
                for (const [live, gen] of glLive) {
                    if (gen !== host.current()) glDrop(live);
                    else if (live.isConnected) glAttached.add(live);
                    else if (glAttached.has(live)) glDrop(live);
                }
                if (glLive.size >= glLimits.mirrors) throw new Error("too many WebGL canvases");
                el.width = width;
                el.height = height;
                const gl = el.getContext(version === 2 ? "webgl2" : "webgl", { alpha: (attributes & 1) !== 0, depth: (attributes & 2) !== 0, stencil: (attributes & 4) !== 0, antialias: (attributes & 8) !== 0, premultipliedAlpha: (attributes & 16) !== 0, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false });
                if (!gl) throw new Error("WebGL unavailable");
                const actual = gl.getContextAttributes();
                if (!actual || actual.alpha !== ((attributes & 1) !== 0) || actual.depth !== ((attributes & 2) !== 0) || actual.stencil !== ((attributes & 4) !== 0) || actual.antialias !== ((attributes & 8) !== 0) || actual.premultipliedAlpha !== ((attributes & 16) !== 0)) throw new Error("WebGL context attributes differ");
                mirror = { gl, objects: new Map(), extensions: new Map(), version, attributes, history: [], historyBytes: 2 };
                glLive.set(el, d?.gen ?? host.current());
                glCanvases.set(el, mirror);
                if (!glContextListeners.has(el)) {
                    glContextListeners.add(el);
                    el.addEventListener("webglcontextlost", (event) => {
                        const current = glCanvases.get(el);
                        // Given back at most once, and not a context we gave up
                        // or one whose replay failed: a log that resets the GPU
                        // isn't replayed again and again.
                        if (current?.history && !current.failed && !current.restored && !glReset()) event.preventDefault();
                        else glLive.delete(el);
                        if (current) current.failed = true;
                        el.title = "WebGL content is unavailable in the remote view";
                        el.setAttribute("aria-label", el.title);
                    });
                    el.addEventListener("webglcontextrestored", () => {
                        const current = glCanvases.get(el);
                        if (!current || !current.history || current.restored) return;
                        glCanvases.delete(el);
                        glLive.delete(el);
                        webglFrame(el, JSON.stringify(current.history), el.width, el.height, current.version, current.attributes, true);
                        const again = glCanvases.get(el);
                        if (again) again.restored = true;
                    });
                }
            } else if (mirror.version !== version) {
                throw new Error("WebGL version changed");
            } else if (mirror.attributes !== attributes) {
                throw new Error("WebGL context attributes changed");
            } else if (el.width !== width || el.height !== height) {
                el.width = width;
                el.height = height;
            }
            const { gl, objects } = mirror;
            if (gl.isContextLost()) throw new Error("WebGL context lost");
            const restore = (value) => {
                if (value === null || typeof value !== "object") return value;
                if (Array.isArray(value)) return value.map(restore);
                if (Number.isInteger(value.ref)) {
                    if (!objects.has(value.ref)) throw new Error("unknown object");
                    return objects.get(value.ref);
                }
                if (typeof value.typed === "string" && typeof value.data === "string" && Object.hasOwn(glTyped, value.typed)) {
                    if (value.data.length > (3 << 20) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new Error("typed data");
                    const binary = atob(value.data), bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const Ctor = glTyped[value.typed];
                    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT) throw new Error("typed alignment");
                    return new Ctor(bytes.buffer);
                }
                if (Number.isInteger(value.width) && Number.isInteger(value.height) && value.width > 0 && value.height > 0 && value.width <= 4096 && value.height <= 4096 && value.width * value.height <= (16 << 20) && value.pixels) {
                    const pixels = restore(value.pixels);
                    if (!(pixels instanceof Uint8ClampedArray) || pixels.byteLength !== value.width * value.height * 4) throw new Error("texture pixels");
                    const source = document.createElement("canvas");
                    source.width = value.width;
                    source.height = value.height;
                    source.getContext("2d").putImageData(new ImageData(pixels, value.width, value.height), 0, 0);
                    return source;
                }
                if (typeof value.location === "string" && Number.isInteger(value.program)) {
                    const program = objects.get(value.program);
                    if (!program) throw new Error("unknown program");
                    const location = gl.getAttribLocation(program, value.location);
                    return location < 0 ? glSkip : location;
                }
                throw new Error("invalid argument");
            };
            for (const command of commands) {
                if (!command || !glMethods.has(command.m) || !Array.isArray(command.a) || command.a.length > 16) throw new Error("invalid command");
                glCheck(mirror, command);
                if (version === 1 && gl2OnlyMethods.has(command.m)) {
                    const requirements = extensionMethods[command.m];
                    if (!requirements || !requirements.some((_, i) => i % 2 === 0 && typeof requirements[i] === "string" && mirror.extensions.has(requirements[i]))) throw new Error("WebGL2 command in WebGL1 stream");
                }
                const args = command.a.map(restore);
                if (args.includes(glSkip)) continue;
                if (command.up !== undefined) {
                    if (!Number.isInteger(command.up) || command.up < 1 || !objects.has(command.up)) throw new Error("unknown uniform program");
                    gl.useProgram(objects.get(command.up));
                }
                if (command.pr !== undefined) {
                    if (!Number.isInteger(command.pr) || command.pr < 0 || command.pr > 0 && !objects.has(command.pr)) throw new Error("unknown draw program");
                    gl.useProgram(command.pr ? objects.get(command.pr) : null);
                }
                const supportedExtensions = glExtensionList;
                const compatExtension = command.m === "getExtension" && supportedExtensions.includes(args[0]);
                let result;
                if (compatExtension) {
                    result = gl.getExtension(args[0]);
                    const needsExtension = requiredRenderingExtensions.has(args[0]) || args[0].startsWith("WEBGL_compressed_texture_") || args[0].startsWith("EXT_texture_compression_");
                    const providedByCore = version === 2 && webgl2CoreExtensions.has(args[0]);
                    if (!result && needsExtension && !providedByCore) throw new Error("required rendering extension unavailable");
                    if (!result) result = Object.create(null);
                }
                else if (extensionCommandMethods[command.m]) {
                    const [name, method] = extensionCommandMethods[command.m];
                    const extension = mirror.extensions.get(name);
                    const fn = extension?.[method];
                    if (typeof fn !== "function") throw new Error("indexed draw buffer extension method unavailable");
                    result = fn.apply(extension, args);
                }
                else if (extensionMethods[command.m] && version === 1) {
                    const mapping = extensionMethods[command.m];
                    let extension, fn;
                    for (let i = 0; i + 1 < mapping.length; i += 2) {
                        extension = mirror.extensions.get(mapping[i]);
                        fn = extension?.[mapping[i + 1]];
                        if (typeof fn === "function") break;
                    }
                    if (typeof fn !== "function") throw new Error("WebGL extension method unavailable");
                    if (command.m === "drawArraysInstanced" && mapping.length > 2 && extension === mirror.extensions.get("WEBGL_multi_draw")) result = fn.call(extension, args[0], new Int32Array([args[1]]), 0, new Int32Array([args[2]]), 0, new Int32Array([args[3]]), 0, 1);
                    else if (command.m === "drawElementsInstanced" && mapping.length > 2 && extension === mirror.extensions.get("WEBGL_multi_draw")) result = fn.call(extension, args[0], new Int32Array([args[1]]), 0, args[2], new Int32Array([args[3]]), 0, new Int32Array([args[4]]), 0, 1);
                    else result = fn.apply(extension, args);
                } else {
                    const fn = gl[command.m];
                    if (typeof fn !== "function") throw new Error("WebGL method unavailable");
                    result = fn.apply(gl, args);
                }
                // GL keeps the first error till it's asked: asked after each
                // allocation, a call it refused before (a binding the budget
                // took as made) ends the replay there, so the budget can't
                // count storage to one object while GL gives it to another.
                if (glAllocations.has(command.m) && gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error before an allocation");
                if (command.m === "getExtension" && typeof args[0] === "string" && result) mirror.extensions.set(args[0], result);
                if (command.m === "compileShader" && !gl.getShaderParameter(args[0], gl.COMPILE_STATUS)) throw new Error("shader compile failed");
                if (command.m === "linkProgram" && !gl.getProgramParameter(args[0], gl.LINK_STATUS)) throw new Error("program link failed");
                if (Number.isInteger(command.q)) {
                    if (!Number.isInteger(command.program) || typeof command.name !== "string") throw new Error("invalid attribute query");
                    if (!objects.get(command.program)) throw new Error("unknown program");
                }
                if (Number.isInteger(command.r) && command.r > 0) {
                    // A uniform the viewer's compiler left out has no location:
                    // setting it does nothing, as in a browser.
                    if (result == null && command.m !== "getUniformLocation") throw new Error("object creation failed");
                    objects.set(command.r, result);
                }
            }
            const replayError = gl.getError();
            if (replayError !== gl.NO_ERROR) throw new Error(`WebGL replay generated error 0x${replayError.toString(16)}`);
            // What's been replayed, kept for a context the viewer loses and
            // gets back (webglcontextrestored): the page's log, bounded as it is.
            if (reset) {
                mirror.history = commands;
                mirror.historyBytes = encoded.length;
            } else {
                for (const command of commands) mirror.history.push(command);
                mirror.historyBytes += encoded.length;
            }
            if (mirror.history.length > glLimits.commands || mirror.historyBytes > glLimits.log) throw new Error("history limits");
            el.removeAttribute("aria-label");
            el.title = "WebGL rendering mirrored from the remote page";
        } catch {
            // A canvas that owns a WebGL context cannot draw a 2D fallback.
            const mirror = glCanvases.get(el);
            if (mirror) mirror.failed = true;
            else glCanvases.set(el, { failed: true });
            glDrop(el);
            el.title = "WebGL content is unavailable in the remote view";
            el.setAttribute("aria-label", el.title);
            if (!el.style.backgroundColor) {
                el.style.backgroundColor = "#ddd";
                glGrayed.add(el);
            }
        }
        return el;
    }
    // forget gives up el's replay context, for a new canvas put in its
    // place (go-frame.js's freshCanvas): whether a failed replay greyed it.
    function forget(el) {
        try { glCanvases.get(el)?.gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* already lost */ }
        glCanvases.delete(el);
        glLive.delete(el);
        return glGrayed.has(el);
    }
    // giveUp, for a WebGL canvas the page's hook gave up on (a 2D fallback
    // shown instead: go-frame.js's canvasFrame), gives up its replay
    // context and its last frame, greying it; whether it has a WebGL
    // context (and so can't draw the note in 2D).
    function giveUp(el) {
        if (glCanvases.get(el)?.gl) {
            glCanvases.get(el).failed = true;
            glDrop(el);
            if (!el.style.backgroundColor) {
                el.style.backgroundColor = "#ddd";
                glGrayed.add(el);
            }
        }
        return !!glCanvases.get(el)?.gl;
    }
    return { webglFrame, glDrop, forget, giveUp, glCheck, glLimits };
};
