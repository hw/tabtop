// Desktop audio for noVNC, served by tabtopd (see audio.go).
//
// Adds a speaker button to noVNC's control bar while connected. Where
// WebCodecs is available (HTTPS or localhost), it decodes the Opus packets
// from audio/ws itself and schedules them back to back through a small
// adaptive buffer, for a delay of roughly 100-200 ms. On plain HTTP it falls
// back to an <audio> element playing audio/stream.ogg, which the browser
// buffers for about 2 s.

const PREF_KEY = "tabtop_audio";
const lowLatency = window.isSecureContext && "AudioDecoder" in window;

const icon = (extra) => "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 25 25" fill="none" ' +
    'stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3.5 9.5h3.5l4.5-4v14l-4.5-4h-3.5z" fill="#fff"/>' + extra + "</svg>");
const ICONS = {
    off: icon('<path d="M15.5 10l5 5m0-5l-5 5"/>'),
    connecting: icon('<path d="M15 12.5h.01m3 0h.01m3 0h.01"/>'),
    on: icon('<path d="M15 9.5a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"/>'),
    error: icon('<path d="M18 8.5v5m0 3.5h.01"/>'),
};

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

// StreamPlayer plays audio/ws through WebCodecs and AudioBufferSourceNodes.
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
        const url = new URL("audio/ws", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        this.ws = new WebSocket(url);
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

// ElementPlayer plays audio/stream.ogg in an <audio> element, for pages
// without WebCodecs. The browser decides how much to buffer (about 2 s in
// Chromium). It fetches in bursts, so speeding up playback to catch up only
// runs the buffer dry and makes it stall.
class ElementPlayer {
    constructor(onEnd) {
        this.onEnd = onEnd;
    }

    async start() {
        this.audio = new Audio();
        this.audio.src = "audio/stream.ogg?" + Date.now();
        await this.audio.play();
        this.audio.onerror = this.audio.onended = () => this.onEnd();
    }

    delay() {
        return null;
    }

    stop() {
        if (this.audio) {
            this.audio.onerror = this.audio.onended = null;
            this.audio.pause();
            this.audio.removeAttribute("src");
            this.audio.load();
        }
    }
}

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
    if (state === "on" && player?.delay() !== null) {
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
    const p = new (lowLatency ? StreamPlayer : ElementPlayer)(() => {
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
    if (!connected()) {
        stopPlayer();
        setState("off", "Start audio");
    } else if (wanted && !player && !retryTimer) {
        start();
    }
}

const settings = document.getElementById("noVNC_settings_button");
if (settings) {
    settings.before(button);
    setState("off", "Start audio");
    new MutationObserver(update).observe(document.documentElement, { attributeFilter: ["class"] });
    update();
} else {
    console.warn("tabtop audio: noVNC's control bar wasn't found; no audio button");
}
