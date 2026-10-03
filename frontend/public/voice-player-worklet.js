// AudioWorklet processor for the voice agent's speaker side. The speech-to-speech
// model streams its reply as small PCM16 chunks; the main thread converts each to
// Float32 and posts it here, where they queue and play back gaplessly. Runs in
// an AudioContext created at the model's output rate (24 kHz), so no resampling.
//
// Messages in:  Float32Array (enqueue) · { type: "clear" } (barge-in: drop all)
// Messages out: { type: "level", rms } ~every 50 ms while playing (drives the
//               mascot) · { type: "drained" } once the queue runs dry.

class VoicePlayer extends AudioWorkletProcessor {
	constructor() {
		super();
		this.queue = [];
		this.offset = 0; // read position inside queue[0]
		this.playing = false;
		this.sumSq = 0;
		this.count = 0;
		this.port.onmessage = (e) => {
			if (e.data instanceof Float32Array) {
				this.queue.push(e.data);
			} else if (e.data && e.data.type === "clear") {
				this.queue = [];
				this.offset = 0;
			}
		};
	}

	process(_inputs, outputs) {
		const out = outputs[0][0];
		let i = 0;
		while (i < out.length && this.queue.length > 0) {
			const head = this.queue[0];
			const n = Math.min(out.length - i, head.length - this.offset);
			for (let k = 0; k < n; k++) {
				const s = head[this.offset + k];
				out[i + k] = s;
				this.sumSq += s * s;
			}
			i += n;
			this.offset += n;
			this.count += n;
			if (this.offset >= head.length) {
				this.queue.shift();
				this.offset = 0;
			}
		}
		for (; i < out.length; i++) out[i] = 0;

		const hasAudio = this.queue.length > 0;
		if (hasAudio) this.playing = true;
		if (this.count >= sampleRate / 20) {
			this.port.postMessage({
				type: "level",
				rms: Math.sqrt(this.sumSq / this.count),
			});
			this.sumSq = 0;
			this.count = 0;
		}
		if (this.playing && !hasAudio) {
			this.playing = false;
			this.port.postMessage({ type: "drained" });
		}
		return true;
	}
}

registerProcessor("voice-player", VoicePlayer);
