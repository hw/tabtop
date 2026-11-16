#!/bin/sh
# Copies what the files page's 3D preview (tabtopd's model-view.js) uses of
# three.js's npm package, at <package>, into <out>, flat: the core, orbit
# controls, the STL, OBJ, PLY and AMF loaders, and fflate (which AMF's
# loader unzips with, as tabtopd's model-worker.js unzips 3MF). Their
# imports are rewritten to point within <out> ("three" and "../libs/" as
# the package has them), which is served as one
# folder (tabtopd's threeFiles lists the same files). check.mjs checks the
# result loads and parses.
#
# Usage: scripts/three/vendor.sh <package> <out>
set -eu
pkg=${1:?usage: $0 <package> <out>}
out=${2:?usage: $0 <package> <out>}
mkdir -p "$out"
for f in build/three.module.js build/three.core.js \
    examples/jsm/controls/OrbitControls.js \
    examples/jsm/loaders/STLLoader.js examples/jsm/loaders/OBJLoader.js \
    examples/jsm/loaders/PLYLoader.js examples/jsm/loaders/AMFLoader.js \
    examples/jsm/libs/fflate.module.js; do
    cp "$pkg/$f" "$out/"
done
cp "$pkg/LICENSE" "$out/LICENSE.three"
sed -i -E "s#from 'three';#from './three.module.js';#; s#from '\.\./(libs|utils)/#from './#" "$out"/*.js
# Every import now within the folder.
if grep -nE "^\s*(import|export)\b[^;]*from\s*['\"]([^.]|\.\./)" "$out"/*.js; then
    echo "an import still points outside $out" >&2
    exit 1
fi
chmod -R u=rwX,go=rX "$out"
