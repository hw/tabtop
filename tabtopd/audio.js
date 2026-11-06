// Desktop audio for noVNC, served by tabtopd (see audio.go and mic.go).
//
// Adds a speaker button to noVNC's control bar while connected. It fetches
// the Opus packets through the encrypted tunnel, with the desktop's
// session, decodes them with WebCodecs and schedules them back to back
// through a small adaptive buffer, for a delay of roughly 100-200 ms.
// WebCodecs needs HTTPS (or localhost).
//
// And a microphone button, which records this device's microphone, encodes
// it as Opus with WebCodecs and sends it through the tunnel, for the
// desktop's applications to record. It's never on until pressed in this
// page: a permission the browser remembers mustn't turn it on by itself.

import { TunnelSocket } from "./tunnel.js";
import { iconDataURL } from "./glyphs.js";

const PREF_KEY = "tabtop_audio";
const supported = window.isSecureContext && "AudioDecoder" in window;

const states = ["off", "connecting", "on", "error"];
const ICONS = Object.fromEntries(states.map((state) => [state, iconDataURL(`audio-${state}`)]));
const MIC_ICONS = Object.fromEntries(states.map((state) => [state, iconDataURL(`mic-${state}`)]));

function savedPref() {
    try {
        return localStorage.getItem(PREF_KEY) === "on";
    } catch {
        return false;
    }
}

function savePref(on) {
    try {
        localStorage.setItem(PREF_KEY, on ? "on" : "off");
    } catch {
        // Not remembered: fine.
    }
}

// Browsers only start audio after the user has interacted with the page.
function notAllowed() {
    const e = new Error("audio needs a click first");
    e.name = "NotAllowedError";
    return e;
}

// StreamPlayer plays the audio tunnel through WebCodecs and
// AudioBufferSourceNodes.
class StreamPlayer {
    constructor(onEnd) {
        this.onEnd = onEnd;
        this.target = 0.04;  // seconds of audio to keep scheduled ahead
        this.next = 0;       // when the next packet starts, in context time
        this.calm = 0;       // context time since the last change to target
    }

    async start() {
        this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
        if (this.ctx.state !== "running") {
            if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
                throw notAllowed();
            }
            await this.ctx.resume();
        }
        this.ws = new TunnelSocket({ type: "audio" });
        this.ws.binaryType = "arraybuffer";
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = () => reject(new Error("audio connection failed"));
        });
        this.ws.onerror = null;
        this.ws.onclose = () => this.onEnd();
        this.ws.onmessage = (e) => {
            if (typeof e.data === "string") {
                this.configure(JSON.parse(e.data));
            } else {
                this.decode(e.data);
            }
        };
    }

    configure(cfg) {
        this.frameUs = cfg.frameMs * 1000;
        this.timestamp = 0;
        this.decoder = new AudioDecoder({
            output: (data) => this.play(data),
            error: () => this.ws.close(),
        });
        this.decoder.configure({ codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.channels });
    }

    decode(data) {
        if (this.decoder?.state !== "configured") {
            return;
        }
        this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, data }));
        this.timestamp += this.frameUs;
    }

    play(data) {
        const buf = this.ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let ch = 0; ch < data.numberOfChannels; ch++) {
            data.copyTo(buf.getChannelData(ch), { planeIndex: ch, format: "f32-planar" });
        }
        data.close();

        const now = this.ctx.currentTime;
        const ahead = this.next - now;
        if (ahead < 0.002) {
            // Ran dry (network hiccup or the first packet): restart the
            // schedule, and keep more in hand if it keeps happening.
            if (this.next > 0) {
                this.target = Math.min(this.target + 0.02, 0.4);
            }
            this.next = now + this.target;
            this.calm = now;
        } else if (ahead > this.target + 0.06) {
            // Too far ahead (a burst after a stall, or clock drift between
            // the desktop and this device): drop the packet to catch up.
            return;
        } else if (now - this.calm > 10 && this.target > 0.03) {
            // Steady for a while: try a little less buffering.
            this.target = Math.max(this.target - 0.005, 0.03);
            this.calm = now;
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(this.next);
        this.next += buf.duration;
    }

    // delay is the scheduled audio plus the output's own latency, in ms.
    // Capture, encoding and the network add a little more.
    delay() {
        const out = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        return Math.round((Math.max(this.next - this.ctx.currentTime, 0) + out) * 1000);
    }

    stop() {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        if (this.decoder && this.decoder.state !== "closed") {
            this.decoder.close();
        }
        this.ctx?.close();
    }
}

// What the gateway says when it has no microphone (noMicMsg in e2e.go):
// the button goes for good.
const NO_MIC = "There's no microphone here.";
// The gateway serves this as false when it has no microphone (see scripts
// in e2e.go), so the button never shows.
const micOffered = true;
const micSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
    && "AudioEncoder" in window && "AudioWorkletNode" in window;

// MicSender records the microphone and sends it through the tunnel as
// Opus packets, one per message.
class MicSender {
    constructor(onEnd) {
        this.onEnd = onEnd;
    }

    async start() {
        // The tunnel first, so a gateway without a microphone never has
        // the browser ask for one.
        this.ws = new TunnelSocket({ type: "mic" });
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onclose = (e) => reject(Object.assign(new Error(e.reason || "microphone connection failed"),
                { noMic: e.reason === NO_MIC }));
        });
        if (this.stopped) {
            return;
        }
        this.ws.onclose = () => this.onEnd();
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (this.stopped) {
            this.stop();
            return;
        }
        // The device's own rate: Firefox won't connect a microphone to a
        // context at another. The gateway decodes Opus at 48 kHz whatever
        // it was encoded from.
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        const rate = this.ctx.sampleRate;
        const config = { codec: "opus", sampleRate: rate, numberOfChannels: 1, bitrate: 32000 };
        if (!(await AudioEncoder.isConfigSupported(config)).supported) {
            throw new Error(`this browser can't encode the microphone at ${rate} Hz`);
        }
        this.encoder = new AudioEncoder({
            output: (chunk) => {
                const packet = new Uint8Array(chunk.byteLength);
                chunk.copyTo(packet);
                this.ws.send(packet);
            },
            error: () => this.ws.close(),
        });
        this.encoder.configure(config);
        await this.ctx.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
        if (this.stopped) {
            return;
        }
        this.node = new AudioWorkletNode(this.ctx, "tabtop-mic");
        let timestamp = 0;
        this.node.port.onmessage = (e) => {
            if (this.encoder.state !== "configured") {
                return;
            }
            const data = new AudioData({ format: "f32", sampleRate: rate, numberOfFrames: e.data.length,
                numberOfChannels: 1, timestamp, data: e.data });
            this.encoder.encode(data);
            data.close();
            timestamp += e.data.length * 1e6 / rate;
        };
        this.ctx.createMediaStreamSource(this.stream).connect(this.node);
        this.node.connect(this.ctx.destination);  // silence, but keeps it running
        if (this.ctx.state !== "running") {
            await this.ctx.resume();
        }
    }

    // stop releases the microphone at once, so the browser stops showing
    // it in use.
    stop() {
        this.stopped = true;
        this.stream?.getTracks().forEach((t) => t.stop());
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        if (this.encoder && this.encoder.state !== "closed") {
            this.encoder.close();
        }
        this.ctx?.close();
    }
}

const micButton = document.createElement("input");
micButton.type = "image";
micButton.id = "tabtop_mic_button";
micButton.className = "noVNC_button noVNC_hidden";
micButton.alt = "Microphone";

let micWanted = false;  // in this page only: see the top
let micGone = !micOffered;  // the gateway has none
let mic = null;
let micRetryTimer = null;
let micRetryDelay = 1000;

function setMicState(state, title) {
    micButton.src = MIC_ICONS[state];
    micButton.title = title;
    micButton.classList.toggle("noVNC_selected", state === "on");
}

function stopMic() {
    clearTimeout(micRetryTimer);
    micRetryTimer = null;
    if (mic) {
        mic.stop();
        mic = null;
    }
}

function retryMic(message) {
    stopMic();
    setMicState("error", `${message}. Retrying… (click to stop)`);
    micRetryTimer = setTimeout(startMic, micRetryDelay);
    micRetryDelay = Math.min(micRetryDelay * 2, 10000);
}

async function startMic() {
    stopMic();
    if (!connected()) {
        return;
    }
    if (!micSupported) {
        micWanted = false;
        setMicState("error", !window.isSecureContext ? "The microphone needs HTTPS"
            : "This browser can't send the microphone (no WebCodecs)");
        return;
    }
    setMicState("connecting", "Connecting the microphone… (click to stop)");
    const m = new MicSender(() => {
        if (mic === m) {
            retryMic("Microphone disconnected");
        }
    });
    mic = m;
    try {
        await m.start();
    } catch (e) {
        if (mic !== m) {
            return;  // stopped meanwhile
        }
        if (e.noMic) {
            stopMic();
            micGone = true;
            micButton.remove();
        } else if (e.name === "NotAllowedError" || e.name === "NotFoundError" || e.name === "NotReadableError") {
            stopMic();
            micWanted = false;
            setMicState("error", e.name === "NotAllowedError" ? "The microphone isn't allowed for this site"
                : e.name === "NotFoundError" ? "No microphone found" : "The microphone is in use elsewhere");
        } else {
            retryMic("Microphone unavailable");
        }
        return;
    }
    if (mic === m) {
        micRetryDelay = 1000;
        setMicState("on", "Stop the microphone");
    }
}

micButton.addEventListener("click", () => {
    micWanted = !(mic || micRetryTimer);
    if (micWanted) {
        startMic();
    } else {
        stopMic();
        setMicState("off", "Send your microphone to the desktop");
    }
});

const button = document.createElement("input");
button.type = "image";
button.id = "tabtop_audio_button";
button.className = "noVNC_button noVNC_hidden";
button.alt = "Audio";

let wanted = savedPref();
let player = null;
let retryTimer = null;
let retryDelay = 1000;
let titleTimer = null;

function setState(state, title) {
    button.src = ICONS[state];
    button.title = title;
    button.classList.toggle("noVNC_selected", state === "on");
    clearInterval(titleTimer);
    titleTimer = null;
    if (state === "on") {
        titleTimer = setInterval(() => {
            button.title = `Stop audio (about ${player.delay()} ms behind)`;
        }, 1000);
    }
}

function connected() {
    return document.documentElement.classList.contains("noVNC_connected");
}

function stopPlayer() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (player) {
        player.stop();
        player = null;
    }
}

function retry(message) {
    stopPlayer();
    setState("error", `${message}. Retrying… (click to stop)`);
    retryTimer = setTimeout(start, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
}

async function start() {
    stopPlayer();
    if (!connected()) {
        return;
    }
    setState("connecting", "Connecting audio… (click to stop)");
    if (!supported) {
        stopPlayer();
        setState("error", window.isSecureContext ? "This browser can't play the audio (no WebCodecs)" : "Audio needs HTTPS");
        return;
    }
    const p = new StreamPlayer(() => {
        if (player === p) {
            retry("Audio disconnected");
        }
    });
    player = p;
    try {
        await p.start();
    } catch (e) {
        if (player !== p) {
            return;  // stopped meanwhile
        }
        if (e.name === "NotAllowedError") {
            stopPlayer();
            setState("off", "Start audio");
        } else {
            retry("Audio unavailable");
        }
        return;
    }
    if (player === p) {
        retryDelay = 1000;
        setState("on", "Stop audio");
    }
}

button.addEventListener("click", () => {
    wanted = !(player || retryTimer);
    savePref(wanted);
    if (wanted) {
        start();
    } else {
        stopPlayer();
        setState("off", "Start audio");
    }
});

function update() {
    button.classList.toggle("noVNC_hidden", !connected());
    micButton.classList.toggle("noVNC_hidden", !connected() || micGone);
    if (!connected()) {
        stopPlayer();
        setState("off", "Start audio");
        stopMic();
        setMicState("off", "Send your microphone to the desktop");
    } else {
        if (wanted && !player && !retryTimer) {
            start();
        }
        if (micWanted && !mic && !micRetryTimer) {
            startMic();
        }
    }
}

const settings = document.getElementById("noVNC_settings_button");
if (settings) {
    settings.before(button);
    settings.before(micButton);
    setState("off", "Start audio");
    setMicState("off", "Send your microphone to the desktop");
    new MutationObserver(update).observe(document.documentElement, { attributeFilter: ["class"] });
    update();
} else {
    console.warn("tabtop audio: noVNC's control bar wasn't found; no audio button");
}
