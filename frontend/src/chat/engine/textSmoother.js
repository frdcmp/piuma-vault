// Typewriter smoothing for streamed assistant text.
//
// LLM providers don't stream one token at a time — they emit multi-token deltas
// (often 5–20 tokens at once), so painting each delta the instant it arrives
// looks chunky. This buffers incoming text and drains it on a rAF loop at a
// "balanced" cadence: a few characters per frame, accelerating when the backlog
// grows so the typewriter never trails the live stream by more than ~6 frames
// (~100ms). The result reads as fluid character-by-character typing while still
// keeping up with a fast response.
//
// `emit(chunk)` commits a slice of text (the caller appends it to the message).
// One smoother per turn; `cancel()` it on abort and `finish()` it on stream end.
export function createTextSmoother(emit) {
	let buf = "";
	let raf = null;
	let cancelled = false;
	let finishing = false;
	let settle = null;
	const drained = new Promise((res) => {
		settle = res;
	});
	const resolveDrained = () => {
		if (settle) {
			settle();
			settle = null;
		}
	};

	const tick = () => {
		raf = null;
		if (cancelled) {
			resolveDrained();
			return;
		}
		if (buf.length) {
			// Drain proportionally: small backlog → ~2 chars/frame (gentle typing),
			// large backlog → faster, so a bursty provider can't make us lag.
			const n = Math.max(2, Math.ceil(buf.length / 6));
			emit(buf.slice(0, n));
			buf = buf.slice(n);
		}
		if (buf.length) raf = requestAnimationFrame(tick);
		else if (finishing) resolveDrained();
	};

	const schedule = () => {
		if (raf == null && !cancelled && buf.length)
			raf = requestAnimationFrame(tick);
	};

	return {
		// Queue a streamed text delta for smooth playback.
		push(delta) {
			if (cancelled || finishing || !delta) return;
			buf += delta;
			schedule();
		},
		// Commit everything buffered right now (preserves ordering when a non-text
		// part — a tool run, an error line — must be appended after the text so far).
		flush() {
			if (cancelled) return;
			if (raf != null) {
				cancelAnimationFrame(raf);
				raf = null;
			}
			if (buf.length) {
				emit(buf);
				buf = "";
			}
		},
		// Stream ended: keep typing out the remaining buffer; the returned promise
		// resolves once it's all painted (or immediately if already empty/cancelled).
		finish() {
			finishing = true;
			if (cancelled || !buf.length) resolveDrained();
			else schedule();
			return drained;
		},
		// Abort: stop typing immediately and drop anything un-painted (server truth
		// reconciles the message afterwards).
		cancel() {
			cancelled = true;
			if (raf != null) {
				cancelAnimationFrame(raf);
				raf = null;
			}
			buf = "";
			resolveDrained();
		},
		get drained() {
			return drained;
		},
	};
}
