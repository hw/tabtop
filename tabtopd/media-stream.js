// Browser integration for the shared, independently testable media source.
import { call, collect } from "./requests.js";
import { mediaWorker } from "./stream-worker.js";
import { createMediaSource } from "./media-source.js";

export const mediaStream = createMediaSource({ call, collect, getWorker: mediaWorker });
