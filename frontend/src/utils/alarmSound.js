// Synthesized alarm tone via the Web Audio API — no audio asset to ship.
// Loops a two-tone beep pattern until stopped. Autoplay policy may keep the
// AudioContext suspended until a user gesture; we resume() best-effort, and the
// visual must-dismiss overlay still works even if the browser blocks audio.

let ctx = null;
let intervalId = null;

function getCtx() {
	if (!ctx) {
		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtx) return null;
		ctx = new AudioCtx();
	}
	return ctx;
}

// One short beep at `freq` Hz with a quick attack/decay so it doesn't click.
function beep(freq, when, duration = 0.18) {
	const ac = getCtx();
	if (!ac) return;
	const osc = ac.createOscillator();
	const gain = ac.createGain();
	osc.type = "square";
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.0001, when);
	gain.gain.exponentialRampToValueAtTime(0.25, when + 0.01);
	gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
	osc.connect(gain);
	gain.connect(ac.destination);
	osc.start(when);
	osc.stop(when + duration + 0.02);
}

// Fire the two-tone pattern once, anchored at the context's current time.
function pattern() {
	const ac = getCtx();
	if (!ac) return;
	const t = ac.currentTime;
	beep(880, t);
	beep(660, t + 0.22);
}

export function startAlarm() {
	const ac = getCtx();
	if (!ac) return;
	if (ac.state === "suspended") ac.resume().catch(() => {});
	if (intervalId) return; // already ringing
	pattern();
	intervalId = setInterval(pattern, 1200);
}

export function stopAlarm() {
	if (intervalId) {
		clearInterval(intervalId);
		intervalId = null;
	}
}
