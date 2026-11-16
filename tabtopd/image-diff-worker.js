import { imageDiffGeometry, imageDelta, imageDeltaOverlay } from "./image-diff.js";

self.onmessage = ({ data: { a, b } }) => {
    const outputs = [];
    try {
        const aWidth = a.width, aHeight = a.height, bWidth = b.width, bHeight = b.height;
        const geometry = imageDiffGeometry(aWidth, aHeight, bWidth, bHeight);
        const { width, height } = geometry;
        const ca = new OffscreenCanvas(width, height), cb = new OffscreenCanvas(width, height), cd = new OffscreenCanvas(width, height), co = new OffscreenCanvas(width, height);
        const options = { colorSpace: "srgb", willReadFrequently: true };
        const ac = ca.getContext("2d", options), bc = cb.getContext("2d", options), dc = cd.getContext("2d"), oc = co.getContext("2d");
        if (!ac || !bc || !dc || !oc) throw new Error("This browser can't create image comparison canvases.");
        ac.drawImage(a, 0, 0); bc.drawImage(b, 0, 0);
        a.close(); b.close();
        let changed = 0, maxDelta = 0;
        // Bound readback buffers independently of total image size.
        for (let y = 0; y < height; y += 128) {
            const rows = Math.min(128, height - y);
            const result = imageDelta(ac.getImageData(0, y, width, rows).data, bc.getImageData(0, y, width, rows).data,
                { aWidth, aHeight, bWidth, bHeight, startY: y });
            dc.putImageData(new ImageData(result.data, width, rows), 0, y);
            oc.putImageData(new ImageData(imageDeltaOverlay(result.data), width, rows), 0, y);
            changed += result.changed; maxDelta = Math.max(maxDelta, result.maxDelta);
        }
        outputs.push(ca.transferToImageBitmap(), cb.transferToImageBitmap(), cd.transferToImageBitmap(), co.transferToImageBitmap());
        self.postMessage({ result: { ...geometry, aWidth, aHeight, bWidth, bHeight, changed, maxDelta, bitmaps: outputs } }, outputs);
    } catch (err) {
        outputs.forEach(bitmap => bitmap.close());
        self.postMessage({ error: err.message });
    } finally { a.close(); b.close(); }
};
