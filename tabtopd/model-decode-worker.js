// Decodes what a compressed glTF has, for the 3D preview (see
// model-decode.js, which asks): Draco's meshes (KHR_draco_mesh_compression),
// meshopt's buffers (EXT_meshopt_compression), and KTX2 (Basis) textures
// (KHR_texture_basisu), transcoded to plain RGBA. Each decoder is
// WebAssembly, which this worker, served with its own policy, may run and
// the page may not. They're three.js's (examples/jsm/libs: Draco's and Basis
// Universal's, Apache-2.0; meshoptimizer's, MIT), loaded the first time
// they're needed. A message is {id, kind, ...}; the answer {id, result}, or
// {id, error}.
"use strict";

// The most any one answer may be: a mesh's attributes, a buffer, a
// texture's pixels (a texture with more is given at a smaller mip level).
const MAX_BYTES = 256 << 20;
const MAX_PIXELS = 4096 * 4096;

// The offline client (scripts/bootstrap/file-launcher.mjs) runs this from
// a blob: URL, which no path can be resolved against, and fetches its files
// through the tunnel: script loads a script as importScripts does, when
// it's done; at is a file's address, as fetch() is to be given it.
const offline = !!self.tabtopImportScripts;
const script = (url) => (offline ? self.tabtopImportScripts(url) : importScripts(url));
const at = (url) => (offline ? url : new URL(url, self.location.href).href);

const wasm = async (url) => {
    const response = await fetch(at(url));
    if (!response.ok) throw new Error(`its decoder isn't on this server (${response.status})`);
    return response.arrayBuffer();
};

let draco, basis, meshopt;
const decoders = {
    draco: () => (draco ??= wasm("./three/draco_decoder.wasm").then(async (wasmBinary) => {
        await script("./three/draco_wasm_wrapper.js");
        return wasmBinary;
    }).then((wasmBinary) => new Promise((resolve) => {
        // (Its module is "then"-able: wrapped, not resolved with.)
        self.DracoDecoderModule({ wasmBinary, onModuleLoaded: (module) => resolve({ module }) });
    })).then(({ module }) => module)),
    basis: () => (basis ??= wasm("./three/basis_transcoder.wasm").then(async (wasmBinary) => {
        await script("./three/basis_transcoder.js");
        return wasmBinary;
    }).then((wasmBinary) => new Promise((resolve) => {
        const module = { wasmBinary, onRuntimeInitialized: () => resolve({ module }) };
        self.BASIS(module);
    })).then(({ module }) => {
        module.initializeBasis();
        return module;
    })),
    meshopt: () => (meshopt ??= Promise.resolve().then(async () => {
        await script("./three/meshopt_decoder.js");
        return self.MeshoptDecoder.ready.then(() => self.MeshoptDecoder);
    })),
};

// Draco: as three.js's DRACOLoader's worker decodes a glTF's (its
// decodeGeometry, decodeIndex and decodeAttribute; MIT): the attributes
// asked for, by their unique IDs, as the types asked for, each row padded
// to 4 bytes; and the triangles' indices.
const TYPES = { Float32Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array };
function decodeDraco(d, bytes, attributeIDs, attributeTypes) {
    const decoder = new d.Decoder();
    let mesh = null;
    try {
        const array = new Int8Array(bytes);
        const type = decoder.GetEncodedGeometryType(array);
        let status;
        if (type === d.TRIANGULAR_MESH) {
            mesh = new d.Mesh();
            status = decoder.DecodeArrayToMesh(array, array.byteLength, mesh);
        } else if (type === d.POINT_CLOUD) {
            mesh = new d.PointCloud();
            status = decoder.DecodeArrayToPointCloud(array, array.byteLength, mesh);
        } else {
            throw new Error("it's of a kind Draco doesn't know");
        }
        if (!status.ok() || mesh.ptr === 0) throw new Error(`it couldn't be decoded (${status.error_msg()})`);
        const count = mesh.num_points();
        const geometry = { index: null, attributes: [] };
        let total = 0;
        for (const name of Object.keys(attributeIDs)) {
            const Type = TYPES[attributeTypes[name]];
            if (!Type) throw new Error(`its ${name} is of a type Draco doesn't give`);
            const attribute = decoder.GetAttributeByUniqueId(mesh, attributeIDs[name]);
            if (!attribute || attribute.ptr === 0) continue;
            const itemSize = attribute.num_components();
            const srcStride = itemSize * Type.BYTES_PER_ELEMENT, dstStride = Math.ceil(srcStride / 4) * 4;
            if ((total += count * dstStride) > MAX_BYTES) throw new Error("it's too big to show here");
            const dataType = { Float32Array: d.DT_FLOAT32, Int8Array: d.DT_INT8, Int16Array: d.DT_INT16, Int32Array: d.DT_INT32,
                Uint8Array: d.DT_UINT8, Uint16Array: d.DT_UINT16, Uint32Array: d.DT_UINT32 }[attributeTypes[name]];
            const ptr = d._malloc(count * srcStride);
            try {
                decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, dataType, count * srcStride, ptr);
                const src = new Type(d.HEAPF32.buffer, ptr, count * itemSize);
                const stride = dstStride / Type.BYTES_PER_ELEMENT;
                let out;
                if (stride === itemSize) out = src.slice();
                else {
                    out = new Type(count * stride);
                    for (let i = 0; i < count; i++) for (let j = 0; j < itemSize; j++) out[i * stride + j] = src[i * itemSize + j];
                }
                geometry.attributes.push({ name, array: out, itemSize, stride });
            } finally {
                d._free(ptr);
            }
        }
        if (type === d.TRIANGULAR_MESH) {
            const n = mesh.num_faces() * 3;
            if ((total += n * 4) > MAX_BYTES) throw new Error("it's too big to show here");
            const ptr = d._malloc(n * 4);
            try {
                decoder.GetTrianglesUInt32Array(mesh, n * 4, ptr);
                geometry.index = new Uint32Array(d.HEAPF32.buffer, ptr, n).slice();
            } finally {
                d._free(ptr);
            }
        }
        return geometry;
    } finally {
        if (mesh) d.destroy(mesh);
        d.destroy(decoder);
    }
}

// KTX2: its first image (no cube faces, nor array layers), transcoded to
// RGBA (8 bits a channel), at the first mip level small enough.
const RGBA32 = 13;
function decodeKTX2(b, bytes) {
    const file = new b.KTX2File(new Uint8Array(bytes));
    try {
        if (!file.isValid()) throw new Error("it isn't a KTX2 texture this preview reads");
        if (file.isHDR()) throw new Error("it's an HDR texture, which this preview doesn't show");
        if (!file.startTranscoding()) throw new Error("it couldn't be transcoded");
        const levels = file.getLevels() || 1;
        let level = 0, info = file.getImageLevelInfo(0, 0, 0);
        while (info.origWidth * info.origHeight > MAX_PIXELS && level + 1 < levels) info = file.getImageLevelInfo(++level, 0, 0);
        if (info.origWidth * info.origHeight > MAX_PIXELS) throw new Error("it's too big to show here");
        const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, RGBA32));
        if (!file.transcodeImage(pixels, level, 0, 0, RGBA32, 0, -1, -1)) throw new Error("it couldn't be transcoded");
        // (RGBA is transcoded at the image's own size, not its 4×4 blocks'.)
        return { pixels, width: info.origWidth, height: info.origHeight };
    } finally {
        file.close();
        file.delete();
    }
}

self.onmessage = async ({ data }) => {
    const { id, kind } = data;
    try {
        let result, transfer = [];
        if (kind === "draco") {
            result = decodeDraco(await decoders.draco(), data.bytes, data.attributeIDs, data.attributeTypes);
            transfer = [...result.attributes.map((a) => a.array.buffer), ...(result.index ? [result.index.buffer] : [])];
        } else if (kind === "meshopt") {
            const { count, stride, source, mode, filter } = data;
            if (!(count * stride <= MAX_BYTES)) throw new Error("it's too big to show here");
            const decoder = await decoders.meshopt();
            result = new Uint8Array(count * stride);
            decoder.decodeGltfBuffer(result, count, stride, new Uint8Array(source), mode, filter);
            transfer = [result.buffer];
        } else if (kind === "ktx2") {
            result = decodeKTX2(await decoders.basis(), data.bytes);
            transfer = [result.pixels.buffer];
        } else {
            throw new Error(`there's no decoder for ${kind}`);
        }
        self.postMessage({ id, result }, transfer);
    } catch (err) {
        self.postMessage({ id, error: String(err?.message ?? err) });
    }
};
