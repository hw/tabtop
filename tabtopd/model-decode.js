import { ByID } from "./worker-client.js";
// A compressed glTF's decoders, for three.js's GLTFLoader (see
// model-view.js): Draco's, meshopt's, and KTX2's, standing in for
// three.js's DRACOLoader, MeshoptDecoder and KTX2Loader, which run their
// WebAssembly on the page, or in workers made from blob: URLs, neither of
// which the page allows. Each asks model-decode-worker.js instead, which
// may; one worker, made when first needed, for all the page's models.

// How long one decoding may take; past it, the worker's ended (and made
// again for the next), and what it was doing fails.
const TIMEOUT = 60_000;

const decoder = new ByID(() => new Worker(new URL("./model-decode-worker.js", import.meta.url)), {
    timeout: TIMEOUT, answered: (data) => data.result,
    timedOut: () => new Error("decoding it took too long"), loadFailed: () => new Error("its decoder failed"),
});
// ask is the worker's answer to message, its transfer handed over.
const ask = (message, transfer = []) => decoder.ask(message, transfer);

// gltfDecoders is what GLTFLoader is given (setDRACOLoader,
// setMeshoptDecoder, setKTX2Loader) to read a glTF's compressed parts:
// THREE is three.js; manager, the loading manager whose URL modifier finds
// a texture's file (as for its other pictures).
export function gltfDecoders(THREE, manager) {
    const draco = {
        preload() { return this; },
        // As DRACOLoader's: the geometry, from the attributes (by unique
        // ID) and types asked for. (Vertex colours in a glTF's Draco are
        // already linear: none made so.)
        decodeDracoFile(buffer, onLoad, attributeIDs, attributeTypes, _colorSpace, onError) {
            const bytes = buffer.slice(0);
            ask({ kind: "draco", bytes, attributeIDs, attributeTypes }, [bytes]).then((made) => {
                const geometry = new THREE.BufferGeometry();
                if (made.index) geometry.setIndex(new THREE.BufferAttribute(made.index, 1));
                for (const { name, array, itemSize, stride } of made.attributes) {
                    geometry.setAttribute(name, itemSize === stride ? new THREE.BufferAttribute(array, itemSize)
                        : new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(array, stride), itemSize, 0));
                }
                onLoad(geometry);
            }, onError);
        },
    };
    const meshopt = {
        supported: true,
        ready: Promise.resolve(),
        decodeGltfBufferAsync(count, stride, source, mode, filter) {
            const copy = source.slice();
            return ask({ kind: "meshopt", count, stride, source: copy.buffer, mode, filter }, [copy.buffer]);
        },
    };
    // KTX2: a texture of its pixels, RGBA (its colour space, and how it's
    // sampled, GLTFLoader sets, as for any texture).
    const texture = ({ pixels, width, height }) => {
        const t = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.needsUpdate = true;
        return t;
    };
    const ktx2 = {
        isKTX2Loader: true,
        manager,
        parse(buffer, onLoad, onError) {
            const bytes = buffer.slice(0);
            ask({ kind: "ktx2", bytes }, [bytes]).then((made) => onLoad(texture(made)), onError);
        },
        // (A file beside it, found as its other pictures are; or not there.)
        load(url, onLoad, _onProgress, onError) {
            fetch(manager.resolveURL(url)).then((r) => r.arrayBuffer()).then((bytes) => this.parse(bytes, onLoad, onError), onError);
        },
    };
    return { draco, meshopt, ktx2 };
}
