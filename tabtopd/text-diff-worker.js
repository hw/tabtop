import { compareText } from "./text-diff.js";
self.onmessage = ({ data }) => {
    try { self.postMessage({ result: compareText(data.left, data.right) }); }
    catch (err) { self.postMessage({ error: err.message }); }
};
