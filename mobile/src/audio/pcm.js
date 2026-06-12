// PCM helpers for the native recorder.
//
// The audio source emits each chunk as a base64 string of raw little-endian
// PCM16 (mono, 16 kHz — the exact bytes the backend relay forwards to
// Speechmatics). We decode to bytes for the WebSocket and compute an RMS level
// (0..1) so the black hole + waveform can react, the way the web client reads
// its AnalyserNode.

const B64 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
	return t;
})();

// Decode a base64 string → Uint8Array. Self-contained (no atob/Buffer needed,
// which keeps it identical across Hermes versions).
export function base64ToBytes(b64) {
	const len = b64.length;
	if (len === 0) return new Uint8Array(0);
	let pad = 0;
	if (b64[len - 1] === "=") pad++;
	if (b64[len - 2] === "=") pad++;
	const out = new Uint8Array(((len * 3) >> 2) - pad);
	let p = 0;
	for (let i = 0; i < len; i += 4) {
		const a = LOOKUP[b64.charCodeAt(i)];
		const b = LOOKUP[b64.charCodeAt(i + 1)];
		const c = LOOKUP[b64.charCodeAt(i + 2)];
		const d = LOOKUP[b64.charCodeAt(i + 3)];
		out[p++] = (a << 2) | (b >> 4);
		if (p < out.length) out[p++] = ((b & 15) << 4) | (c >> 2);
		if (p < out.length) out[p++] = ((c & 3) << 6) | d;
	}
	return out;
}

// RMS level (0..1) of a little-endian PCM16 byte buffer. Same ×3 gain the web
// waveform applies so the visuals feel identical.
export function rmsFromPcm16(bytes) {
	const n = bytes.length >> 1; // 2 bytes per sample
	if (n === 0) return 0;
	let sumSq = 0;
	for (let i = 0; i < n; i++) {
		// Little-endian int16 → signed.
		let s = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
		if (s >= 0x8000) s -= 0x10000;
		const v = s / 32768;
		sumSq += v * v;
	}
	return Math.min(1, Math.sqrt(sumSq / n) * 3);
}

// Per-bar peak amplitudes (0..1) across a PCM16 chunk — the data behind the
// mirrored "specular" waveform. Mirrors the web PixelWaveform: split the frame
// into `bars` slices and take the peak deviation in each, so each bar maps to a
// slice of the current audio frame (not a moment in time). ×2 gain ≈ the web's.
export function barsFromPcm16(bytes, bars = 28) {
	const n = bytes.length >> 1; // sample count
	const out = new Array(bars).fill(0);
	if (n === 0) return out;
	const slice = Math.max(1, Math.floor(n / bars));
	for (let b = 0; b < bars; b++) {
		let peak = 0;
		const start = b * slice;
		const end = Math.min(n, start + slice);
		for (let i = start; i < end; i++) {
			let s = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
			if (s >= 0x8000) s -= 0x10000;
			const v = Math.abs(s) / 32768;
			if (v > peak) peak = v;
		}
		out[b] = Math.min(1, peak * 2);
	}
	return out;
}
