import { useEffect, useState } from "react";
import usePigeonWorkingStore from "../../../store/pigeonWorkingStore";
import { PigeonMark } from "./SentBy";

// A line at the bottom of a chat while Pigeon works on its newest messages:
// the step it's at, the dots moving, and a countdown where the vault knows
// when the step ends (reading, waiting for the user, typing). Done with
// nothing to show, a word for a few seconds. As the phone's.
// `threads`: the chat's thread ids (a person's chat has one per channel);
// `seed`: the chat payload's `working` (by thread), for a chat opened mid-way;
// `on`: auto replies answer the chat (without them no reply is coming).

// A step left behind (the worker died mid-way): not shown past this.
const STALE_MS = 3 * 60 * 1000;
// A step with an end shown past it: not longer than this.
const LATE_MS = 30 * 1000;
// How long a closing word stays.
const WORD_MS = 6000;

const STEPS = {
	listening: "Pigeon is listening to the voice note",
	reading: "Pigeon is reading",
	analysing: "Pigeon is analysing",
	deciding: "Pigeon is deciding",
	typing: "Pigeon is typing",
	waiting: "You're writing here: Pigeon answers in",
};
const WORDS = {
	nothing: "Pigeon read it: nothing to answer",
	paused: "You're writing here: Pigeon stays out",
	failed: "Pigeon hit a problem reading it",
};

// 42s · 9:05
const clock = (secs) => {
	const s = Math.max(0, secs);
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function Working({ threads, seed, on }) {
	const by = usePigeonWorkingStore((s) => s.by);
	const note = usePigeonWorkingStore((s) => s.note);
	useEffect(() => {
		for (const [id, data] of Object.entries(seed ?? {})) note(id, data);
	}, [seed, note]);
	const latest = threads
		.map((t) => by[t])
		.filter(Boolean)
		.sort((a, b) => b.at - a.at)[0];
	const [now, setNow] = useState(Date.now());
	// a second's tick while something shows
	useEffect(() => {
		if (!on || !latest) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [on, latest]);
	if (!on || !latest) return null;
	// from the vault's time when it's older (a chat reopened): an old step
	// isn't shown afresh
	const age = now - Math.min(latest.seen, latest.at);
	let text = null;
	if (latest.stage === "done") {
		if (WORDS[latest.outcome] && age <= WORD_MS) text = WORDS[latest.outcome];
	} else if (STEPS[latest.stage]) {
		const end = latest.until ? new Date(latest.until).getTime() : null;
		if (end ? now - end <= LATE_MS : age <= STALE_MS) {
			const left = end ? Math.ceil((end - now) / 1000) : 0;
			const dots = ".".repeat(1 + (Math.floor(now / 500) % 3));
			// listening's end is how long it waits at most, not when it's done
			const when =
				left > 0 && latest.stage !== "listening" ? ` ${clock(left)}` : "";
			text =
				latest.stage === "waiting"
					? `${STEPS.waiting} ${clock(left)}`
					: `${STEPS[latest.stage]}${dots}${when}`;
		}
	}
	if (!text) return null;
	return (
		<div className="inbox-working" aria-live="polite">
			<PigeonMark />
			<span>{text}</span>
		</div>
	);
}
