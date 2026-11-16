// G-code, as 3D printers' slicers write it, read for the 3D preview
// (model-view.js, in gcode-worker.js): the moves that extrude, and those
// that don't (travel), as line segments, layer by layer in the order
// they're printed, each extruding one of the kind the slicer said it is
// (outer wall, infill, support…); and what the slicer noted of it (its
// name, the time it estimated).
//
// Moves: G0/G1, and arcs (G2/G3, by I and J or R), in millimetres or
// inches (G21/G20), absolute or relative (G90/G91); E absolute or
// relative (M82/M83; G91 makes it relative too, as Marlin and Klipper
// do); G92 sets where it is, G28 homes. A move extrudes if E goes forward
// as it moves across; one that only primes, or retracts, draws nothing.
//
// Layers are where the slicer's comments say (";LAYER:", ";LAYER_CHANGE"
// and the like); without those, where an extruding move is at another
// height, so lifting the nozzle to travel (Z-hop) isn't one. They're in
// the order printed, which isn't always upward (objects printed one after
// another).
//
// It's read as bytes, a line at a time: a file of hundreds of megabytes
// isn't made a string. A move whose position isn't a number, or is
// absurdly far (MAX_COORD), is skipped; past maxSegments, the rest isn't
// read (truncated).

const MAX_COORD = 1e5;           // mm: no printer's that big
const MAX_TYPES = 255;           // kinds named; any more are "Other"
const ARC_STEP = 0.5;            // mm along an arc, at most, per segment
const ARC_MAX = 720;             // segments per arc, at most
const LAYER_DZ = 0.01;           // mm: a layer, found by height, is at least this above or below the last
const MAX_COMMENT = 240;         // a comment's characters looked at

// featureCategory is the kind of thing a slicer's feature name says it
// is, as the preview colours it: "outer-wall", "inner-wall", "infill",
// "solid-infill", "top-bottom", "bridge", "support", "skirt", or "other".
export function featureCategory(name) {
    const n = String(name).toLowerCase();
    if (/support/.test(n)) return "support";
    if (/skirt|brim|prime|purge|wipe|tower/.test(n)) return "skirt";
    if (/bridge|overhang/.test(n)) return "bridge";
    if (/outer|external|wall-outer/.test(n)) return "outer-wall";
    if (/\btop\b|bottom|skin|ironing/.test(n)) return "top-bottom";
    if (/solid/.test(n)) return "solid-infill";
    if (/fill|gap/.test(n)) return "infill";
    if (/wall|perimeter|inner|shell/.test(n)) return "inner-wall";
    return "other";
}

// A growable array of floats or of small numbers.
class Grow {
    constructor(Type, n = 1 << 16) { this.Type = Type; this.a = new Type(n); this.n = 0; }
    push(v) {
        if (this.n === this.a.length) {
            const b = new this.Type(this.a.length * 2);
            b.set(this.a);
            this.a = b;
        }
        this.a[this.n++] = v;
    }
    done() { return this.a.slice(0, this.n); }
}

// duration is seconds, from "1d 2h 3m 4s", "1:02:03", or a number of seconds.
export function duration(text) {
    const t = String(text).trim();
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const clock = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(t);
    if (clock) return clock[1] * 3600 + clock[2] * 60 + Number(clock[3]);
    let s = 0, any = false;
    for (const [, v, u] of t.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
        s += Number(v) * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()];
        any = true;
    }
    return any ? s : null;
}

// parseGCode reads the G-code in bytes (a Uint8Array). It's:
//   extrude: {positions (x, y, z of each segment's two ends), types (each
//     segment's, an index into types)}; travel: {positions};
//   layers: {extrudeEnd, travelEnd (how many of each there are by the end
//     of each layer), z (where each starts)};
//   types: the feature names, [0] being "" (none said);
//   bounds: {min, max} of what's extruded ([x, y, z]), or null if nothing is;
//   filament: mm of filament pushed, extruding; lines; skipped (moves left
//   out, as said above); truncated; slicer; time (seconds, as the slicer
//   estimated it), or null.
export function parseGCode(bytes, { maxSegments = 10e6 } = {}) {
    // (At most 16 segments a byte past the first 2 million, too: a small
    // file of arcs, each drawn in hundreds, can't make 10 million; one of
    // arcs a slicer fitted, with as many as it has, is read whole.)
    maxSegments = Math.min(maxSegments, Math.max(2e6, bytes.length * 16));
    const ext = new Grow(Float32Array), extType = new Grow(Uint8Array), trav = new Grow(Float32Array);
    // Of each segment extruded: its speed (mm/s), filament pushed for each
    // mm it goes, the width and height the slicer said of it (or NaN), the
    // nozzle's temperature, and the fan's speed (0 to 255).
    const extSpeed = new Grow(Float32Array), extFeed = new Grow(Float32Array), extWidth = new Grow(Float32Array), extHeight = new Grow(Float32Array);
    const extTemp = new Grow(Uint16Array), extFan = new Grow(Uint8Array);
    let feed = NaN, ePerMM = 0, width = NaN, height = NaN, temp = 0, fan = 0, diameter = NaN;
    const layerExt = [], layerTrav = [], layerZ = [];
    const types = [""], typeIndex = new Map([["", 0]]);
    let type = 0;
    let x = 0, y = 0, z = 0, e = 0;          // where it is, in mm
    let absolute = true, absoluteE = true, scale = 1;
    let byComments = false;                  // layers are where comments say
    let filament = 0, lines = 0, skipped = 0, truncated = false, slicer = "", time = null;
    // Cura's time so far, at each layer: the last is the whole print's (its
    // header's ";TIME:" is a placeholder, 6666, until Cura fills it in).
    let elapsed = null;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let segments = 0;

    const layer = () => layerZ.length - 1;
    // newLayer starts one, unless the one there is has nothing extruded yet.
    const newLayer = () => {
        const i = layer();
        if (i >= 0 && layerExt[i] === (i > 0 ? layerExt[i - 1] : 0)) {
            layerZ[i] = NaN;
            return;
        }
        layerExt.push(ext.n / 6);
        layerTrav.push(trav.n / 6);
        layerZ.push(NaN);
    };
    const segment = (into, x0, y0, z0, x1, y1, z1) => {
        if (segments >= maxSegments) {
            truncated = true;
            return false;
        }
        segments++;
        into.push(x0); into.push(y0); into.push(z0); into.push(x1); into.push(y1); into.push(z1);
        return true;
    };
    const extrudeTo = (x0, y0, z0, x1, y1, z1) => {
        if (layer() < 0) newLayer();
        const i = layer();
        if (!byComments && !Number.isNaN(layerZ[i]) && Math.abs(z1 - layerZ[i]) >= LAYER_DZ) newLayer();
        if (!segment(ext, x0, y0, z0, x1, y1, z1)) return;
        extType.push(type);
        extSpeed.push(feed / 60); extFeed.push(ePerMM); extWidth.push(width); extHeight.push(height);
        extTemp.push(temp); extFan.push(fan);
        const j = layer();
        if (Number.isNaN(layerZ[j])) layerZ[j] = z1;
        layerExt[j] = ext.n / 6;
        layerTrav[j] = trav.n / 6;
        if (x0 < minX) minX = x0; if (x0 > maxX) maxX = x0; if (x1 < minX) minX = x1; if (x1 > maxX) maxX = x1;
        if (y0 < minY) minY = y0; if (y0 > maxY) maxY = y0; if (y1 < minY) minY = y1; if (y1 > maxY) maxY = y1;
        if (z0 < minZ) minZ = z0; if (z0 > maxZ) maxZ = z0; if (z1 < minZ) minZ = z1; if (z1 > maxZ) maxZ = z1;
    };
    const travelTo = (x0, y0, z0, x1, y1, z1) => {
        if (layer() < 0) newLayer();
        if (!segment(trav, x0, y0, z0, x1, y1, z1)) return;
        layerTrav[layer()] = trav.n / 6;
    };
    const setType = (name) => {
        const key = name.trim();
        let i = typeIndex.get(key);
        if (i === undefined) {
            if (types.length < MAX_TYPES) {
                i = types.length;
                types.push(key);
            } else {
                i = typeIndex.get("Other") ?? MAX_TYPES - 1;
                types[i] = "Other";
            }
            typeIndex.set(key, i);
        }
        type = i;
    };
    const comment = (c) => {
        let m;
        if (/^LAYER(?::|_CHANGE\b)/i.test(c) || /^\s*layer\s+-?\d+\s*,\s*z\s*=/i.test(c) || /^\s*CHANGE_LAYER\b/.test(c)) {
            // (What start G-code extruded before the first, a line to prime
            // the nozzle, say, is the first's.)
            if (byComments || layer() > 0) newLayer();
            byComments = true;
        } else if ((m = /^\s*(?:TYPE|FEATURE)\s*:\s*(.+)$/i.exec(c)) || (m = /^\s*feature\s+(.+)$/i.exec(c))) {
            setType(m[1]);
        } else if (!slicer && (m = /generated (?:by|with)\s+(.+)$/i.exec(c))) {
            slicer = m[1].trim().replace(/\s+on\s+\d{4}-.*$/, "");
        } else if (!slicer && /^\s*(BambuStudio|OrcaSlicer|Cura_SteamEngine|PrusaSlicer|SuperSlicer|Simplify3D|ideaMaker)\b/i.test(c)) {
            slicer = c.trim();
        } else if ((m = /^TIME_ELAPSED:(\d+(?:\.\d+)?)\s*$/.exec(c))) {
            elapsed = Number(m[1]);
        } else if ((m = /^\s*(?:WIDTH|LINE_WIDTH)\s*:\s*([\d.]+)/i.exec(c))) {
            width = Number(m[1]);
        } else if ((m = /^\s*(?:HEIGHT|LAYER_HEIGHT)\s*:\s*([\d.]+)/i.exec(c))) {
            height = Number(m[1]);
        } else if ((m = /^\s*filament_?diameters?\s*[=:,]\s*([\d.]+)/i.exec(c)) || (m = /^\s*material_diameter\s*[=:]\s*([\d.]+)/i.exec(c))) {
            diameter = Number(m[1]);
        } else if (time === null && (m = /^TIME:(\d+(?:\.\d+)?)\s*$/.exec(c))) {
            time = Number(m[1]);
        } else if (time === null && (m = /estimated printing time(?: \(normal mode\))?\s*[=:]\s*(.+)$/i.exec(c))) {
            time = duration(m[1]);
        } else if (time === null && (m = /total estimated time\s*[=:]\s*([^;]+)/i.exec(c))) {
            time = duration(m[1]);
        }
    };

    // Each line: its words (a letter, then a number), up to a comment.
    const n = bytes.length;
    const words = new Float64Array(26), has = new Uint8Array(26), seen = [];
    let i = 0;
    while (i < n && !truncated) {
        lines++;
        for (const k of seen) has[k] = 0;
        seen.length = 0;
        let end = i;
        while (end < n && bytes[end] !== 10) end++;
        let j = i;
        let commentAt = -1;
        while (j < end) {
            const ch = bytes[j];
            if (ch === 59) { commentAt = j + 1; break; }                 // ;
            if (ch === 40) {                                               // ( to )
                while (j < end && bytes[j] !== 41) j++;
                j++;
                continue;
            }
            if (ch === 42) break;                                          // *checksum
            const up = ch & 0xdf;
            if (up >= 65 && up <= 90) {
                // A number: sign, digits, a point, digits.
                let k = j + 1;
                while (k < end && (bytes[k] === 32 || bytes[k] === 9)) k++;
                let sign = 1;
                if (bytes[k] === 45) { sign = -1; k++; } else if (bytes[k] === 43) k++;
                let v = 0, digits = 0;
                while (k < end && bytes[k] >= 48 && bytes[k] <= 57) { v = v * 10 + bytes[k] - 48; k++; digits++; }
                if (bytes[k] === 46) {
                    k++;
                    let f = 0.1;
                    while (k < end && bytes[k] >= 48 && bytes[k] <= 57) { v += (bytes[k] - 48) * f; f /= 10; k++; digits++; }
                }
                const w = up - 65;
                if (digits) {
                    if (!has[w]) seen.push(w);
                    has[w] = 1;
                    words[w] = sign * v;
                } else if (!has[w]) {
                    // A letter alone (G28 X): there, as 0.
                    seen.push(w);
                    has[w] = 2;
                    words[w] = 0;
                }
                j = k;
                continue;
            }
            j++;
        }
        if (commentAt >= 0) {
            const len = Math.min(end - commentAt, MAX_COMMENT);
            let c = "";
            for (let k = commentAt; k < commentAt + len; k++) c += String.fromCharCode(bytes[k]);
            comment(c.replace(/\r$/, ""));
        }
        i = end + 1;
        const G = 6, M = 12, X = 23, Y = 24, Z = 25, E = 4, F = 5, I = 8, J = 9, P = 15, R = 17, S = 18, T = 19;
        if (has[G] === 1) {
            const g = words[G];
            if (g === 0 || g === 1 || g === 2 || g === 3) {
                const at = (w, from) => (has[w] === 1 ? (absolute ? words[w] * scale : from + words[w] * scale) : from);
                const nx = at(X, x), ny = at(Y, y), nz = at(Z, z);
                const ne = has[E] === 1 ? (absolute && absoluteE ? words[E] * scale : e + words[E] * scale) : e;
                if (![nx, ny, nz, ne].every(Number.isFinite) || Math.abs(nx) > MAX_COORD || Math.abs(ny) > MAX_COORD || Math.abs(nz) > MAX_COORD) {
                    skipped++;
                    continue;
                }
                const de = ne - e;
                if (has[F] === 1 && words[F] > 0) feed = words[F] * scale;
                // (An arc by I and J back to where it began: a whole circle.)
                const arc = g >= 2 && (nx !== x || ny !== y || has[I] === 1 || has[J] === 1);
                const across = nx !== x || ny !== y || arc;
                const extruding = de > 0 && across;
                if (extruding) filament += de;
                if (arc) {
                    // An arc, from here to there, about a centre: I and J
                    // from here, or a radius R (negative: the longer way).
                    let cx, cy;
                    const clockwise = g === 2;
                    if (has[I] === 1 || has[J] === 1) {
                        cx = x + (has[I] === 1 ? words[I] * scale : 0);
                        cy = y + (has[J] === 1 ? words[J] * scale : 0);
                    } else if (has[R] === 1) {
                        const r = words[R] * scale, dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
                        const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
                        const side = (clockwise ? -1 : 1) * (r < 0 ? -1 : 1);
                        cx = x + dx / 2 - side * h * dy / d;
                        cy = y + dy / 2 + side * h * dx / d;
                    }
                    if (!(Math.abs(cx) <= MAX_COORD && Math.abs(cy) <= MAX_COORD)) {
                        // A centre absurdly far (or none): skipped, as a place would be.
                        skipped++;
                        x = nx; y = ny; z = nz; e = ne;
                        continue;
                    }
                    {
                        const r = Math.hypot(x - cx, y - cy);
                        const a0 = Math.atan2(y - cy, x - cx);
                        let sweep = Math.atan2(ny - cy, nx - cx) - a0;
                        if (clockwise && sweep >= -1e-9) sweep -= 2 * Math.PI;
                        if (!clockwise && sweep <= 1e-9) sweep += 2 * Math.PI;
                        if (extruding) ePerMM = de / (Math.hypot(Math.abs(sweep) * r, nz - z) || 1);
                        const steps = Math.max(1, Math.min(ARC_MAX, Math.ceil(Math.abs(sweep) * r / ARC_STEP)));
                        let px = x, py = y, pz = z;
                        for (let s = 1; s <= steps; s++) {
                            const t = s / steps;
                            const qx = s === steps ? nx : cx + r * Math.cos(a0 + sweep * t);
                            const qy = s === steps ? ny : cy + r * Math.sin(a0 + sweep * t);
                            const qz = z + (nz - z) * t;
                            if (extruding) extrudeTo(px, py, pz, qx, qy, qz); else travelTo(px, py, pz, qx, qy, qz);
                            px = qx; py = qy; pz = qz;
                        }
                        x = nx; y = ny; z = nz; e = ne;
                        continue;
                    }
                }
                if (extruding) {
                    ePerMM = de / (Math.hypot(nx - x, ny - y, nz - z) || 1);
                    extrudeTo(x, y, z, nx, ny, nz);
                } else if (across || nz !== z) travelTo(x, y, z, nx, ny, nz);
                x = nx; y = ny; z = nz; e = ne;
            } else if (g === 90) absolute = true;
            else if (g === 91) absolute = false;
            else if (g === 20) scale = 25.4;
            else if (g === 21) scale = 1;
            else if (g === 92) {
                if (has[X] === 1) x = words[X] * scale;
                if (has[Y] === 1) y = words[Y] * scale;
                if (has[Z] === 1) z = words[Z] * scale;
                if (has[E] === 1) e = words[E] * scale;
                if (!has[X] && !has[Y] && !has[Z] && !has[E]) x = y = z = e = 0;
            } else if (g === 28) {
                const all = !has[X] && !has[Y] && !has[Z];
                if (all || has[X]) x = 0;
                if (all || has[Y]) y = 0;
                if (all || has[Z]) z = 0;
            }
        } else if (has[M] === 1) {
            const mc = words[M];
            if (mc === 82) absoluteE = true;
            else if (mc === 83) absoluteE = false;
            // The nozzle's temperature set (not its bed's: M140, M190).
            else if ((mc === 104 || mc === 109) && has[S] === 1 && !(has[T] === 1 && words[T] > 0)) temp = Math.max(0, Math.min(65535, Math.round(words[S])));
            // The part's fan: not another (Bambu's and Orca's P2, P3: the
            // auxiliary and chamber fans).
            else if ((mc === 106 || mc === 107) && has[P] === 1 && words[P] > 1) { /* another fan */ }
            else if (mc === 106) fan = has[S] === 1 ? Math.max(0, Math.min(255, Math.round(words[S]))) : 255;
            else if (mc === 107) fan = 0;
        }
    }
    // A last layer with nothing extruded (lifting away at the end) is the one before's.
    const last = layer();
    if (last > 0 && layerExt[last] === layerExt[last - 1]) {
        layerTrav[last - 1] = layerTrav[last];
        layerExt.pop(); layerTrav.pop(); layerZ.pop();
    }
    const extrudeCount = ext.n / 6;
    // Each segment's height: as the slicer said, else its layer's (how far
    // above the one before it is); and its width: as said, else what the
    // filament pushed makes of that height (a slicer's line, its sides
    // rounded: area = (w - h)·h + π(h/2)², as PrusaSlicer has it).
    const heights = extHeight.done(), widths = extWidth.done(), feeds = extFeed.done();
    const layerHeight = layerZ.map((zl, k) => {
        const below = k > 0 ? layerZ[k - 1] : 0;
        const h = zl - below;
        return h > 0.01 && h < 5 ? h : NaN;
    });
    for (let k = 0, s = 0; k < layerZ.length; k++) {
        for (; s < layerExt[k]; s++) if (!(heights[s] > 0)) heights[s] = layerHeight[k];
    }
    let guessed = false;
    if (!(diameter > 0)) {
        // Not said: 1.75 mm or 2.85 mm, whichever makes its lines nearer
        // the width lines are (0.45 mm, or so: thicker filament, less of
        // it pushed for a line as wide).
        const sample = [];
        const step = Math.max(1, Math.floor(feeds.length / 4000));
        for (let s = 0; s < feeds.length; s += step) if (feeds[s] > 0 && heights[s] > 0) sample.push(feeds[s] / heights[s]);
        sample.sort((a, b) => a - b);
        const median = sample[sample.length >> 1] ?? 0;
        const off = (d) => Math.abs(Math.log((median * Math.PI * (d / 2) ** 2 || 1e-9) / 0.45));
        diameter = off(2.85) < off(1.75) ? 2.85 : 1.75;
        guessed = true;
    }
    const filamentArea = Math.PI * (diameter / 2) ** 2;
    for (let s = 0; s < widths.length; s++) {
        if (widths[s] > 0) continue;
        const h = heights[s], area = feeds[s] * filamentArea;
        widths[s] = h > 0 && area > 0 ? Math.max(0.01, Math.min(10, area / h + h * (1 - Math.PI / 4))) : NaN;
    }
    // Flow, mm³ a second: what the nozzle pushes out.
    const speeds = extSpeed.done(), flows = new Float32Array(speeds.length);
    for (let s = 0; s < flows.length; s++) flows[s] = feeds[s] * filamentArea * speeds[s];
    return {
        extrude: { positions: ext.done(), types: extType.done(), speed: speeds, flow: flows, width: widths, height: heights, temp: extTemp.done(), fan: extFan.done() },
        filamentDiameter: diameter, diameterGuessed: guessed,
        travel: { positions: trav.done() },
        layers: { extrudeEnd: Uint32Array.from(layerExt), travelEnd: Uint32Array.from(layerTrav), z: Float32Array.from(layerZ) },
        types,
        bounds: extrudeCount ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : null,
        filament, lines, skipped, truncated, slicer, time: elapsed ?? time,
    };
}
