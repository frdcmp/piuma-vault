// AudioWorklet processor for the recorder. Browsers capture audio at the
// AudioContext's native rate (often 48 kHz) as Float32; streaming ASR providers
// (Speechmatics) want raw little-endian PCM16 at 16 kHz. This worklet downsamples
// and converts in the audio thread, posting small Int16 buffers to the main
// thread, which forwards them over the WebSocket. (MediaRecorder is deliberately
// avoided — it emits WebM/Opus container fragments an ASR can't stream.)

class PCM16Downsampler extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const opts = (options && options.processorOptions) || {};
		this.targetRate = opts.targetRate || 16000;
		this.inputRate = sampleRate; // global in AudioWorkletGlobalScope
		this.ratio = this.inputRate / this.targetRate;
		this._frac = 0;
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel || channel.length === 0) return true;

		// Linear-decimation downsample from inputRate → targetRate.
		const out = [];
		let i = this._frac;
		while (i < channel.length) {
			const idx = Math.floor(i);
			let s = channel[idx];
			// Clamp and convert Float32 [-1,1] → Int16.
			s = Math.max(-1, Math.min(1, s));
			out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
			i += this.ratio;
		}
		this._frac = i - channel.length;

		if (out.length > 0) {
			const buf = new Int16Array(out);
			// Transfer the underlying buffer to avoid a copy.
			this.port.postMessage(buf.buffer, [buf.buffer]);
		}
		return true;
	}
}

registerProcessor("pcm16-downsampler", PCM16Downsampler);
