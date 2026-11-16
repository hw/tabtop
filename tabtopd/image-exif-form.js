// What the EXIF editor (image-exif-view.js) shows and asks for, apart from
// its page: a field's value as a person reads it, the few things most
// people open it for (when, with what, where), the kind of control each
// field is changed with, and what's then given to editExif. No page here,
// so that it can be tried by itself.
import { encodeExifValue, validDate, managedExifTags } from "./image-exif.js";

export const ORIENTATIONS = { 1: "Upright", 2: "Mirrored horizontally", 3: "Rotated 180°", 4: "Mirrored vertically", 5: "Transposed",
    6: "Rotated 90° clockwise", 7: "Transverse", 8: "Rotated 90° counterclockwise" };
const METERING = { 0: "Unknown", 1: "Average", 2: "Centre-weighted", 3: "Spot", 4: "Multi-spot", 5: "Pattern", 6: "Partial" };
const PROGRAMS = { 0: "Not defined", 1: "Manual", 2: "Program", 3: "Aperture priority", 4: "Shutter priority", 5: "Creative", 6: "Action", 7: "Portrait", 8: "Landscape" };

export const fieldId = (row) => `${row.group}:${row.tag}`;
const find = (rows, group, tag) => rows.find((r) => r.group === group && r.tag === tag);
const ratio = (text) => { const [n, d] = String(text).split("/").map(Number); return d === undefined ? n : d ? n / d : NaN; };
const rounded = (value, digits = 6) => String(Number(value.toFixed(digits)));

// A date as EXIF has it (2026:03:12 14:32:05, with no time zone: the
// camera's clock) and as a date-and-time box has it (2026-03-12T14:32:05):
// text to text, never through the browser's own time zone. null: not one.
export function dateToInput(text) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text ?? "");
    return m && validDate(text) && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}
export function inputToDate(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text ?? "");
    return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}` : null;
}
// The date so many seconds on (or back): for a camera whose clock was wrong.
export function shiftDate(text, seconds) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text ?? "");
    if (!m || !validDate(text) || !Number.isFinite(seconds)) return null;
    const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Math.round(seconds) * 1000);
    if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) return null;
    const two = (n) => String(n).padStart(2, "0");
    return `${String(at.getUTCFullYear()).padStart(4, "0")}:${two(at.getUTCMonth() + 1)}:${two(at.getUTCDate())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())}`;
}
// "2h 30m", "-1d", "+45s", "90" (minutes): seconds, or null.
export function parseShift(text) {
    const trimmed = String(text ?? "").trim().toLowerCase();
    if (!trimmed) return null;
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 60;
    const sign = trimmed.startsWith("-") ? -1 : 1;
    let total = 0, rest = trimmed.replace(/^[+-]/, "").replace(/\s+/g, "");
    const units = { d: 86400, h: 3600, m: 60, s: 1 };
    while (rest) {
        const m = /^(\d+(?:\.\d+)?)([dhms])/.exec(rest);
        if (!m) return null;
        total += Number(m[1]) * units[m[2]];
        rest = rest.slice(m[0].length);
    }
    return sign * total;
}
// A date as it's read: 12 Mar 2026, 14:32:05.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
export function friendlyDate(text) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text ?? "");
    return m && validDate(text) && m[1] !== "0000" ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}:${m[6]}` : text ?? "";
}

// Where it was taken, from the four GPS fields that say (two of degrees,
// minutes and seconds, and which side of the equator and of Greenwich):
// {latitude, longitude} in degrees, south and west negative; or null.
export function locationOf(rows) {
    const side = (tag, negative) => {
        const values = find(rows, "GPS", tag)?.value.split(", ").map(ratio), ref = (find(rows, "GPS", tag - 1)?.value ?? "").trim().toUpperCase();
        if (!values || values.length !== 3 || !values.every(Number.isFinite)) return null;
        return (ref === negative ? -1 : 1) * (values[0] + values[1] / 60 + values[2] / 3600);
    };
    const latitude = side(2, "S"), longitude = side(4, "W");
    return latitude == null || longitude == null ? null : { latitude, longitude };
}
export const locationText = ({ latitude, longitude }) => `${rounded(Math.abs(latitude), 5)}° ${latitude < 0 ? "S" : "N"}, ${rounded(Math.abs(longitude), 5)}° ${longitude < 0 ? "W" : "E"}`;
// "1.3521, 103.8198", "1.3521 N 103.8198 E", "-33.86 151.21": as pasted
// from a map. {latitude, longitude}, or null if it isn't a place on Earth.
export function parseLocation(text) {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([ns])?\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([ew])?\s*$/i.exec(String(text ?? ""));
    if (!m) return null;
    const latitude = Number(m[1]) * (m[2]?.toLowerCase() === "s" ? -1 : 1), longitude = Number(m[3]) * (m[4]?.toLowerCase() === "w" ? -1 : 1);
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}
// The edits that put it there: the four fields, and the GPS group's
// version where it has none yet (a new group's first field).
export function locationEdits({ latitude, longitude }, rows) {
    const triple = (degrees) => {
        const whole = Math.floor(Math.abs(degrees)), minutes = (Math.abs(degrees) - whole) * 60, minute = Math.floor(minutes + 1e-9);
        const seconds = Math.max(0, Math.round((minutes - minute) * 60 * 10000));
        // (60 seconds, from rounding, is the next minute's.)
        return seconds >= 600000 ? `${whole}/1, ${minute + 1}/1, 0/10000` : `${whole}/1, ${minute}/1, ${seconds}/10000`;
    };
    return [
        ...(find(rows, "GPS", 0) ? [] : [{ group: "GPS", tag: 0, type: 1, value: "2, 3, 0, 0" }]),
        { group: "GPS", tag: 1, type: 2, value: latitude < 0 ? "S" : "N" }, { group: "GPS", tag: 2, type: 5, value: triple(latitude) },
        { group: "GPS", tag: 3, type: 2, value: longitude < 0 ? "W" : "E" }, { group: "GPS", tag: 4, type: 5, value: triple(longitude) },
    ];
}

// A field's value as a person reads it: f/2.8, 1/125 s, Rotated 90°
// clockwise; the value as it is, where there's no better way to say it.
export function friendlyValue(row, rows) {
    const number = ratio(row.value.split(", ")[0]);
    if (row.group === "Image" && row.tag === 0x0112) return ORIENTATIONS[row.value] ?? `${row.value} (unknown)`;
    if (row.group === "Image" && [0x0132].includes(row.tag) || row.group === "EXIF" && [0x9003, 0x9004].includes(row.tag)) return friendlyDate(row.value);
    if (row.group === "EXIF") {
        if (row.tag === 0x829d && Number.isFinite(number)) return `f/${rounded(number, 2)}`;
        if (row.tag === 0x920a && Number.isFinite(number)) return `${rounded(number, 2)} mm`;
        if (row.tag === 0xa405 && Number.isFinite(number)) return `${rounded(number, 2)} mm (35 mm equivalent)`;
        if (row.tag === 0x829a && Number.isFinite(number)) return `${number >= 1 ? rounded(number, 2) : row.value.replace(/^(\d+)\/(\d+)$/, (_, n, d) => (Number(n) === 1 ? `1/${d}` : `1/${rounded(Number(d) / Number(n), 1)}`))} s`;
        if (row.tag === 0x8827) return `ISO ${row.value}`;
        if (row.tag === 0x9207) return METERING[row.value] ?? row.value;
        if (row.tag === 0x8822) return PROGRAMS[row.value] ?? row.value;
        if (row.tag === 0x9209 && /^\d+$/.test(row.value)) return Number(row.value) & 1 ? "Fired" : "Did not fire";
    }
    if (row.group === "GPS" && [2, 4].includes(row.tag)) {
        const values = row.value.split(", ").map(ratio);
        if (values.length === 3 && values.every(Number.isFinite)) return `${rounded(values[0] + values[1] / 60 + values[2] / 3600, 5)}° ${find(rows, "GPS", row.tag - 1)?.value ?? ""}`.trim();
    }
    return row.value;
}

// What most people open it for, each as a line to read (null: it doesn't say).
export function exifSummary(rows) {
    const value = (group, tag) => find(rows, group, tag)?.value?.trim() || null;
    const friendly = (group, tag) => { const row = find(rows, group, tag); return row ? friendlyValue(row, rows) : null; };
    const make = value("Image", 0x010f), model = value("Image", 0x0110), lens = value("EXIF", 0xa434);
    // (A model that begins with its maker's name, as Canon's do, isn't said twice.)
    const camera = [model && make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model ?? make, lens].filter(Boolean).join(" · ") || null;
    const exposure = [friendly("EXIF", 0x829d), friendly("EXIF", 0x829a), friendly("EXIF", 0x8827), friendly("EXIF", 0x920a)].filter(Boolean).join(" · ") || null;
    const place = locationOf(rows), takenRow = find(rows, "EXIF", 0x9003) ?? find(rows, "EXIF", 0x9004) ?? find(rows, "Image", 0x0132);
    return { taken: takenRow ? friendlyDate(takenRow.value) : null, takenRow: takenRow ?? null, camera, exposure, location: place, rotation: friendly("Image", 0x0112) };
}

// What says who took it or with exactly which camera: the owner's name,
// the camera's and the lens's serial numbers, and the maker's own notes,
// which often repeat them.
const IDENTITY = new Set(["EXIF:42032", "EXIF:42033", "EXIF:42037", "EXIF:37500", "Image:50735", "Image:42032", "Image:42033"]);
export const identityRows = (rows) => rows.filter((r) => IDENTITY.has(fieldId(r)));
export const sensitive = (rows) => ({ location: rows.some((r) => r.group === "GPS"), identity: identityRows(rows).length > 0 });

// The control a field is changed with: "managed" (not at all: it's kept
// right by the saving), "orientation", "date", "comment", "text", "bytes"
// (hexadecimal) or "numbers".
export function fieldKind(row, format = "value") {
    if (managedExifTags.has(row.tag)) return "managed";
    if (row.group === "Image" && row.tag === 0x0112) return "orientation";
    if (row.type === 2 && (row.group === "Image" && row.tag === 0x0132 || row.group === "EXIF" && [0x9003, 0x9004].includes(row.tag))) return "date";
    if (row.type === 7) return format === "comment" ? "comment" : "bytes";
    return row.type === 2 ? "text" : "numbers";
}
export const HINTS = { date: "YYYY:MM:DD HH:MM:SS", text: "Printable ASCII text", comment: "Text, in any script", bytes: "Hexadecimal bytes, such as 01 ff 20",
    numbers: "Numbers, with commas between; fractions as 1/125 or decimals", orientation: "A number from 1 to 8" };

// What's wrong with a value for a field, by the rules saving has; null if
// nothing is. field is {group, tag, type, format}.
export function fieldError(field, value) {
    const kind = fieldKind(field, field.format);
    if (kind === "managed") return "Maintained automatically.";
    if (!Number.isInteger(field.tag) || field.tag < 0 || field.tag > 65535) return "Enter a tag ID such as 0x010e.";
    if (kind === "date" && !validDate(value)) return "Use YYYY:MM:DD HH:MM:SS, with a valid date.";
    if (kind === "orientation" && !/^[1-8]$/.test(value.trim())) return "Orientation must be from 1 to 8.";
    try {
        encodeExifValue(field.type, value, true, field.type === 7 ? field.format ?? "value" : "value");
        return null;
    } catch (err) {
        return err.message;
    }
}

// What saving is given, from what's been changed: pending is a Map of a
// field's id to {group, tag, type, value, format, remove, isNew}, for each
// field changed, removed or added; removeLocation, the whole GPS group
// goes. (A new field that was then removed is nothing; with the GPS group
// going, its fields aren't changed as well, which saving refuses.)
export function pendingEdits(pending, { removeLocation = false } = {}) {
    const edits = [];
    for (const change of pending.values()) {
        if (change.isNew && change.remove || removeLocation && change.group === "GPS") continue;
        edits.push({ group: change.group, tag: change.tag, type: change.type, value: change.value, remove: !!change.remove, format: change.type === 7 ? change.format ?? "value" : "value" });
    }
    return { removeGPS: removeLocation, edits };
}
