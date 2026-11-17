#!/bin/sh
# Copies what the files page's 3D preview (tabtopd's model-view.js) uses of
# three.js's npm package, at <package>, into <out>, flat: the core, orbit
# controls, the STL, OBJ, PLY, AMF, glTF, FBX, Collada, VRML (with the
# chevrotain parser it reads with), MTL (OBJ's materials) and TGA
# (textures) loaders, the room environment (glTF's materials reflect
# it), and what those import; fflate too (which tabtopd's model-worker.js
# unzips 3MF with); and the decoders tabtopd's model-decode-worker.js runs
# for compressed glTF: Draco's (glTF's build), Basis Universal's (KTX2) and
# meshoptimizer's, the last made a plain script (not a module), as the
# worker loads all three with importScripts. Their imports are rewritten to point within <out>
# ("three", and "../libs/", "../utils/", "../curves/", "../environments/",
# "../loaders/" and "./collada/" as the package has them), which is served as one
# folder (tabtopd's threeFiles lists the same files). check.mjs checks the
# result loads and parses.
#
# Draco's, Basis Universal's and chevrotain's builds come without their
# licence, which is Apache-2.0: LICENSE.decoders says so, with its text
# (<apache>, TabTop's own LICENSE by default); and chevrotain's build has
# regexp-to-ast in it, whose MIT licence is LICENSE.regexp-to-ast, beside this.
#
# Usage: scripts/three/vendor.sh <package> <out> [<apache>]
set -eu
pkg=${1:?usage: $0 <package> <out> [<apache>]}
out=${2:?usage: $0 <package> <out> [<apache>]}
apache=${3:-$(dirname "$0")/../../LICENSE}
mkdir -p "$out"
for f in build/three.module.js build/three.core.js \
    examples/jsm/controls/OrbitControls.js \
    examples/jsm/loaders/STLLoader.js examples/jsm/loaders/OBJLoader.js \
    examples/jsm/loaders/PLYLoader.js examples/jsm/loaders/AMFLoader.js \
    examples/jsm/loaders/GLTFLoader.js examples/jsm/loaders/FBXLoader.js \
    examples/jsm/loaders/MTLLoader.js examples/jsm/loaders/TGALoader.js \
    examples/jsm/loaders/ColladaLoader.js examples/jsm/loaders/collada/ColladaParser.js \
    examples/jsm/loaders/collada/ColladaComposer.js \
    examples/jsm/loaders/VRMLLoader.js examples/jsm/libs/chevrotain.module.min.js \
    examples/jsm/utils/BufferGeometryUtils.js examples/jsm/utils/SkeletonUtils.js \
    examples/jsm/curves/NURBSCurve.js examples/jsm/curves/NURBSUtils.js \
    examples/jsm/environments/RoomEnvironment.js \
    examples/jsm/libs/fflate.module.js; do
    cp "$pkg/$f" "$out/"
done
cp "$pkg/LICENSE" "$out/LICENSE.three"
for f in examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js examples/jsm/libs/draco/gltf/draco_decoder.wasm \
    examples/jsm/libs/basis/basis_transcoder.js examples/jsm/libs/basis/basis_transcoder.wasm; do
    cp "$pkg/$f" "$out/"
done
grep -q "Apache License" "$apache" && grep -q "Version 2.0" "$apache"
{
    echo "draco_wasm_wrapper.js and draco_decoder.wasm: Draco (https://github.com/google/draco),"
    echo "copyright The Draco Authors. basis_transcoder.js and basis_transcoder.wasm:"
    echo "Basis Universal (https://github.com/BinomialLLC/basis_universal), copyright"
    echo "Binomial LLC. chevrotain.module.min.js: chevrotain 9.0.1"
    echo "(https://github.com/Chevrotain/chevrotain). All as three.js ships them"
    echo "(examples/jsm/libs), under the Apache License, Version 2.0, below; but"
    echo "regexp-to-ast, in chevrotain.module.min.js, under the MIT License, after it."
    echo
    cat "$apache"
    echo
    echo "regexp-to-ast (https://github.com/bd82/regexp-to-ast):"
    echo
    cat "$(dirname "$0")/LICENSE.regexp-to-ast"
} > "$out/LICENSE.decoders"
sed '/^export { MeshoptDecoder };$/d' "$pkg/examples/jsm/libs/meshopt_decoder.module.js" > "$out/meshopt_decoder.js"
if grep -nE "^\s*export\b" "$out/meshopt_decoder.js"; then
    echo "meshopt_decoder.js still exports" >&2
    exit 1
fi
sed -i -E "s#from 'three';#from './three.module.js';#; s#from '\.\./(libs|utils|curves|environments|loaders)/#from './#; s#from '\./collada/#from './#" "$out"/*.js
# Every import now within the folder.
if grep -nE "^\s*(import|export)\b[^;]*from\s*['\"]([^.]|\.\./)" "$out"/*.js; then
    echo "an import still points outside $out" >&2
    exit 1
fi
chmod -R u=rwX,go=rX "$out"
