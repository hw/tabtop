// The EXIF editor's own reading and asking (tabtopd/image-exif-form.js),
// without its page: held to what image-exif.js then saves and reads back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readExif, editExif } from "../tabtopd/image-exif.js";
import { dateToInput, inputToDate, shiftDate, parseShift, friendlyDate, locationOf, locationText, parseLocation, locationEdits, friendlyValue, exifSummary,
    identityRows, sensitive, fieldKind, fieldError, pendingEdits, fieldId } from "../tabtopd/image-exif-form.js";

// A photo's EXIF, made as the editor would make it.
const photo = () => editExif(null, { make: "Canon", model: "Canon EOS R6", taken: "2026:03:12 14:32:05", modified: "2026:03:13 09:00:00", artist: "A. Photographer", lensModel: "RF 50mm F1.8" }, { edits: [
    { group: "Image", tag: 0x0112, type: 3, value: "6" }, { group: "EXIF", tag: 0x829a, type: 5, value: "1/125" }, { group: "EXIF", tag: 0x829d, type: 5, value: "2.8" },
    { group: "EXIF", tag: 0x8827, type: 3, value: "200" }, { group: "EXIF", tag: 0x920a, type: 5, value: "50" }, { group: "EXIF", tag: 0x9209, type: 3, value: "16" },
    { group: "EXIF", tag: 0xa431, type: 2, value: "SERIAL123" }, { group: "EXIF", tag: 0xa430, type: 2, value: "Owner Name" }, { group: "EXIF", tag: 0x927c, type: 7, value: "01 02 03", format: "hex" },
    { group: "GPS", tag: 1, type: 2, value: "N" }, { group: "GPS", tag: 2, type: 5, value: "1/1, 21/1, 756/100" }, { group: "GPS", tag: 3, type: 2, value: "E" }, { group: "GPS", tag: 4, type: 5, value: "103/1, 49/1, 1128/100" },
    { group: "GPS", tag: 7, type: 5, value: "6/1, 32/1, 5/1" } ] });

test("dates: as a date box has them and back, shifted, and read; never through a time zone", () => {
    assert.equal(dateToInput("2026:03:12 14:32:05"), "2026-03-12T14:32:05");
    assert.equal(inputToDate("2026-03-12T14:32:05"), "2026:03:12 14:32:05");
    // (A box that leaves the seconds out, as some do at :00.)
    assert.equal(inputToDate("2026-03-12T14:32"), "2026:03:12 14:32:00");
    // What isn't a date (blank, zeros, the 30th of February) has no box: it's edited as text.
    for (const bad of ["", "    :  :     :  :  ", "0000:00:00 00:00:00", "2026:02:30 10:00:00", "2026-03-12 14:32:05", undefined]) assert.equal(dateToInput(bad), null, String(bad));
    assert.equal(inputToDate("nonsense"), null);
    assert.equal(friendlyDate("2026:03:12 14:32:05"), "12 Mar 2026, 14:32:05");
    assert.equal(friendlyDate("0000:00:00 00:00:00"), "0000:00:00 00:00:00");
    // Over midnight, a month's end, a leap day, and a year's.
    assert.equal(shiftDate("2026:03:12 23:30:00", 3600), "2026:03:13 00:30:00");
    assert.equal(shiftDate("2024:02:28 23:59:59", 1), "2024:02:29 00:00:00");
    assert.equal(shiftDate("2026:01:01 00:00:00", -1), "2025:12:31 23:59:59");
    assert.equal(shiftDate("2026:03:12 14:32:05", 0), "2026:03:12 14:32:05");
    assert.equal(shiftDate("not a date", 60), null);
    assert.deepEqual(["2h 30m", "-1d", "+45s", "90", "-1.5", "1h30m", "", "soon", "2x"].map(parseShift), [9000, -86400, 45, 5400, -90, 5400, null, null, null]);
});

test("a place: read from the four GPS fields, typed or pasted, and written so that it reads back the same", () => {
    const rows = readExif(photo()).rows, place = locationOf(rows);
    assert.ok(Math.abs(place.latitude - 1.3521) < 1e-6 && Math.abs(place.longitude - 103.8198) < 1e-6, JSON.stringify(place));
    assert.equal(locationText(place), "1.3521° N, 103.8198° E");
    assert.deepEqual(parseLocation("1.3521, 103.8198"), { latitude: 1.3521, longitude: 103.8198 });
    assert.deepEqual(parseLocation(" 33.8688° S 151.2093° E "), { latitude: -33.8688, longitude: 151.2093 });
    assert.deepEqual(parseLocation("-33.8688;151.2093"), { latitude: -33.8688, longitude: 151.2093 });
    assert.deepEqual(parseLocation("40.7128 N, 74.0060 W"), { latitude: 40.7128, longitude: -74.006 });
    for (const bad of ["", "1.3521", "91, 0", "0, 181", "north, east", "1,2,3"]) assert.equal(parseLocation(bad), null, bad);
    // Written, saved and read: the same place, to a ten-thousandth of a second of arc; either side of each line.
    for (const want of [{ latitude: 1.3521, longitude: 103.8198 }, { latitude: -33.8688, longitude: 151.2093 }, { latitude: 40.7128, longitude: -74.006 }, { latitude: 0, longitude: 0 },
        { latitude: -89.999999, longitude: -179.999999 }, { latitude: 59.9999999, longitude: 0.0166666 }]) {
        const before = readExif(photo()).rows, saved = readExif(editExif(photo(), {}, { edits: locationEdits(want, before) })), got = locationOf(saved.rows);
        assert.ok(Math.abs(got.latitude - want.latitude) < 1e-6 && Math.abs(got.longitude - want.longitude) < 1e-6, `${JSON.stringify(want)} read back as ${JSON.stringify(got)}`);
        // (Seconds are never 60.)
        for (const tag of [2, 4]) assert.ok(Number(saved.rows.find((r) => r.group === "GPS" && r.tag === tag).value.split(", ")[2].split("/")[0]) < 600000);
    }
    // A photo with no GPS group gets one, with its version; one with a version keeps it.
    const none = editExif(null, { make: "Canon" }), rowsNone = readExif(none).rows;
    assert.equal(locationOf(rowsNone), null);
    const edits = locationEdits({ latitude: 1.5, longitude: -2.25 }, rowsNone);
    assert.deepEqual(edits.map((e) => e.tag), [0, 1, 2, 3, 4]);
    const placed = readExif(editExif(none, {}, { edits }));
    assert.equal(locationText(locationOf(placed.rows)), "1.5° N, 2.25° W");
    assert.deepEqual(locationEdits({ latitude: 1, longitude: 1 }, placed.rows).map((e) => e.tag), [1, 2, 3, 4]);
});

test("what's read: each value as a person says it, and the few things most people look for", () => {
    const rows = readExif(photo()).rows, value = (group, tag) => friendlyValue(rows.find((r) => r.group === group && r.tag === tag), rows);
    assert.deepEqual([value("Image", 0x0112), value("EXIF", 0x829d), value("EXIF", 0x829a), value("EXIF", 0x8827), value("EXIF", 0x920a), value("EXIF", 0x9209), value("EXIF", 0x9003), value("GPS", 2), value("GPS", 4), value("Image", 0x010f)],
        ["Rotated 90° clockwise", "f/2.8", "1/125 s", "ISO 200", "50 mm", "Did not fire", "12 Mar 2026, 14:32:05", "1.3521° N", "103.8198° E", "Canon"]);
    const summary = exifSummary(rows);
    // (The maker's name isn't said twice.)
    assert.deepEqual({ ...summary, takenRow: fieldId(summary.takenRow), location: locationText(summary.location) }, { taken: "12 Mar 2026, 14:32:05", takenRow: "EXIF:36867",
        camera: "Canon EOS R6 · RF 50mm F1.8", exposure: "f/2.8 · 1/125 s · ISO 200 · 50 mm", location: "1.3521° N, 103.8198° E", rotation: "Rotated 90° clockwise" });
    assert.deepEqual(exifSummary(readExif(editExif(null, { make: "Nikon", model: "Z6" })).rows), { taken: null, takenRow: null, camera: "Nikon Z6", exposure: null, location: null, rotation: null });
    assert.deepEqual(exifSummary([]), { taken: null, takenRow: null, camera: null, exposure: null, location: null, rotation: null });
    // What says where, and who or which camera.
    assert.deepEqual(sensitive(rows), { location: true, identity: true });
    assert.deepEqual(identityRows(rows).map((r) => r.name).sort(), ["Camera serial number", "Maker note", "Tag 0xa430"]);
    assert.deepEqual(sensitive(readExif(editExif(null, { make: "Nikon" })).rows), { location: false, identity: false });
});

test("a field's control and what's wrong with a value are by the rules saving has", () => {
    const rows = readExif(photo()).rows, row = (group, tag) => rows.find((r) => r.group === group && r.tag === tag);
    assert.deepEqual([fieldKind(row("Image", 0x0112)), fieldKind(row("EXIF", 0x9003)), fieldKind(row("Image", 0x010f)), fieldKind(row("EXIF", 0x829a)), fieldKind(row("EXIF", 0x927c), "hex"),
        fieldKind({ group: "EXIF", tag: 0x9286, type: 7 }, "comment"), fieldKind({ group: "Image", tag: 0x8769, type: 4 })], ["orientation", "date", "text", "numbers", "bytes", "comment", "managed"]);
    const error = (group, tag, type, value, format) => fieldError({ group, tag, type, format }, value);
    assert.deepEqual([error("EXIF", 0x9003, 2, "2026:03:12 14:32:05"), error("Image", 0x0112, 3, "8"), error("Image", 0x010f, 2, "Canon"), error("EXIF", 0x829a, 5, "1/125"), error("EXIF", 0x829a, 5, "0.008"),
        error("EXIF", 0x927c, 7, "01 ff", "hex"), error("EXIF", 0x9286, 7, "こんにちは", "comment")], [null, null, null, null, null, null, null]);
    assert.match(error("EXIF", 0x9003, 2, "2026:02:30 10:00:00"), /valid date/);
    assert.match(error("Image", 0x0112, 3, "9"), /from 1 to 8/);
    assert.match(error("Image", 0x010f, 2, "Café"), /ASCII/);
    assert.match(error("EXIF", 0x829a, 5, "1/0"), /denominator/);
    assert.match(error("EXIF", 0x8827, 3, "70000"), /0 to 65535/);
    assert.match(error("EXIF", 0x927c, 7, "0g", "hex"), /hexadecimal/);
    assert.match(error("Image", NaN, 2, "x"), /tag ID/);
    assert.match(error("Image", 0x8769, 4, "8"), /automatically/);
    // Whatever it says is wrong, saving refuses; whatever it passes, saving takes.
    for (const [group, tag, type, value] of [["EXIF", 0x9003, 2, "2026:02:30 10:00:00"], ["Image", 0x0112, 3, "9"], ["EXIF", 0x829a, 5, "1/0"], ["EXIF", 0x8827, 3, "70000"], ["EXIF", 0x9003, 2, "2027:01:01 00:00:00"], ["EXIF", 0x8827, 3, "400"]]) {
        const said = fieldError({ group, tag, type }, value);
        const saves = (() => { try { editExif(photo(), {}, { edits: [{ group, tag, type, value }] }); return true; } catch { return false; } })();
        assert.equal(said === null, saves, `${group} 0x${tag.toString(16)} = ${value}: ${said}`);
    }
});

test("what's changed, as saving is given it; with the place removed, its fields aren't changed as well", () => {
    const pending = new Map([
        ["Image:271", { group: "Image", tag: 271, type: 2, value: "Nikon" }], ["EXIF:33434", { group: "EXIF", tag: 33434, type: 5, value: "", remove: true }],
        ["Image:65000", { group: "Image", tag: 65000, type: 7, value: "01 02", format: "hex", isNew: true }], ["Image:65001", { group: "Image", tag: 65001, type: 2, value: "x", isNew: true, remove: true }],
        ["GPS:2", { group: "GPS", tag: 2, type: 5, value: "2/1, 0/1, 0/1" }],
    ]);
    const { edits, removeGPS } = pendingEdits(pending);
    assert.equal(removeGPS, false);
    assert.deepEqual(edits, [{ group: "Image", tag: 271, type: 2, value: "Nikon", remove: false, format: "value" }, { group: "EXIF", tag: 33434, type: 5, value: "", remove: true, format: "value" },
        { group: "Image", tag: 65000, type: 7, value: "01 02", remove: false, format: "hex" }, { group: "GPS", tag: 2, type: 5, value: "2/1, 0/1, 0/1", remove: false, format: "value" }]);
    const saved = readExif(editExif(photo(), {}, { removeGPS, edits }));
    assert.deepEqual([saved.fields.make, saved.rows.some((r) => r.tag === 33434), saved.rows.find((r) => r.tag === 65000).value, saved.rows.some((r) => r.tag === 65001)], ["Nikon", false, "2 bytes", false]);
    const gone = pendingEdits(pending, { removeLocation: true });
    assert.deepEqual([gone.removeGPS, gone.edits.some((e) => e.group === "GPS")], [true, false]);
    assert.equal(readExif(editExif(photo(), {}, gone)).rows.some((r) => r.group === "GPS"), false);
    assert.deepEqual(pendingEdits(new Map()), { removeGPS: false, edits: [] });
});

test("everything but the way up: a new block, with nothing of the old in it", () => {
    // As the editor makes it: from nothing, the orientation alone.
    const old = photo(), orientation = readExif(old).rows.find((r) => r.group === "Image" && r.tag === 0x0112);
    const fresh = editExif(null, {}, { edits: [{ group: "Image", tag: 0x0112, type: orientation.type, value: orientation.value }] }), text = new TextDecoder("latin1").decode(fresh);
    assert.deepEqual(readExif(fresh).rows.map((r) => [fieldId(r), r.value]), [["Image:274", "6"]]);
    for (const secret of ["Canon", "SERIAL123", "Owner Name", "A. Photographer", "2026:03:12"]) assert.ok(!text.includes(secret), secret);
    assert.ok(fresh.length < 64, `${fresh.length} bytes`);
});
