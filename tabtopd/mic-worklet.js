// Captures the microphone for audio.js: posts its first channel to the
// page in 20 ms blocks of Float32 samples, to encode and send. Its output is
// silence.

class MicCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.size = Math.round(sampleRate / 50);
        this.block = new Float32Array(this.size);
        this.n = 0;
    }

    process(inputs) {
        const samples = inputs[0]?.[0];
        if (samples) {
            for (let i = 0; i < samples.length; i++) {
                this.block[this.n++] = samples[i];
                if (this.n === this.size) {
                    this.port.postMessage(this.block, [this.block.buffer]);
                    this.block = new Float32Array(this.size);
                    this.n = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor("tabtop-mic", MicCapture);
