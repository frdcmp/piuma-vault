import { useEffect, useState } from "react";
import Starfield from "../admin/components/notes/Starfield";
import { legFrameAt, Sprite, useSprite } from "../sprites";
import voiceEngine from "./voiceEngine";
import useVoiceStore from "./voiceStore";
import "./VoicePage.css";

const STATUS_LABEL = {
	idle: "tap to talk",
	connecting: "waking up…",
	listening: "listening",
	thinking: "thinking…",
	speaking: "speaking",
	error: "something went wrong",
};

// The Piuma mascot, driven by the voice state: bounces with its own voice while
// speaking, trots in place while thinking, and floats while listening.
function TalkingPiuma({ status, outLevel }) {
	const { body, idleLegs, walkLegs, walkFrameMs } = useSprite();
	const [legFrame, setLegFrame] = useState(-1);

	useEffect(() => {
		if (status !== "thinking") {
			setLegFrame(-1);
			return;
		}
		const start = performance.now();
		const id = setInterval(() => {
			setLegFrame(
				legFrameAt(performance.now() - start, walkLegs.length, walkFrameMs),
			);
		}, walkFrameMs / 2);
		return () => clearInterval(id);
	}, [status, walkLegs.length, walkFrameMs]);

	const speaking = status === "speaking";
	const lift = speaking ? Math.min(1, outLevel * 4) : 0;
	return (
		<div
			className={`voice-piuma is-${status}`}
			style={{
				transform: `translateY(${-lift * 18}px) scale(${1 + lift * 0.06}, ${1 - lift * 0.04})`,
			}}
		>
			<Sprite
				rows={[...body, ...(legFrame >= 0 ? walkLegs[legFrame] : idleLegs)]}
				pixelSize={10}
			/>
		</div>
	);
}

const EQ_COLS = 15;
const EQ_ROWS = 6;

// A row of chunky pixel columns under the mascot — fixed size, so it never
// pushes or overlaps the subtitles. Columns rise with the voice level (taller
// in the middle, with a little per-column jitter); while thinking a single
// pixel sweeps back and forth instead.
function PixelEqualizer({ status, level }) {
	const amp = Math.min(1, level * 5);
	const mid = (EQ_COLS - 1) / 2;
	return (
		<div className={`voice-eq is-${status}`} aria-hidden="true">
			{Array.from({ length: EQ_COLS }, (_, i) => {
				const envelope = 1 - (Math.abs(i - mid) / mid) * 0.6;
				const jitter =
					0.55 + 0.45 * Math.abs(Math.sin(i * 12.9898 + amp * 437.58));
				const lit =
					status === "thinking"
						? 0
						: Math.max(1, Math.round(amp * envelope * jitter * EQ_ROWS));
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed, positional columns
						key={i}
						className="voice-eq-col"
						style={{ "--eq-delay": `${i * 70}ms` }}
					>
						{Array.from({ length: EQ_ROWS }, (_, r) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed, positional cells
								key={r}
								className={`voice-eq-cell${EQ_ROWS - r <= lit ? " is-lit" : ""}`}
							/>
						))}
					</div>
				);
			})}
		</div>
	);
}

export default function VoicePage() {
	const { name } = useSprite();
	const status = useVoiceStore((s) => s.status);
	const error = useVoiceStore((s) => s.error);
	const muted = useVoiceStore((s) => s.muted);
	const wakePhrase = useVoiceStore((s) => s.wakePhrase);
	const micLevel = useVoiceStore((s) => s.micLevel);
	const outLevel = useVoiceStore((s) => s.outLevel);
	const userText = useVoiceStore((s) => s.userText);
	const piumaText = useVoiceStore((s) => s.piumaText);
	const tools = useVoiceStore((s) => s.tools);

	const active = status !== "idle" && status !== "error";
	// The equalizer bounces with whoever is talking.
	const level =
		status === "speaking" ? outLevel : status === "listening" ? micLevel : 0;

	return (
		<div className="voice-page">
			<Starfield />

			<div className={`voice-stage is-${status}`}>
				<TalkingPiuma status={status} outLevel={outLevel} />
				<PixelEqualizer status={status} level={level} />
			</div>

			<div className={`voice-status is-${status}`}>
				<span className="voice-status-dot" aria-hidden="true" />
				{muted && active
					? "muted"
					: status === "listening" && wakePhrase
						? `listening · say “${wakePhrase}”`
						: STATUS_LABEL[status]}
			</div>

			<div className="voice-subtitles" aria-live="polite">
				{userText && <p className="voice-line voice-line--user">{userText}</p>}
				{piumaText && (
					<p className="voice-line voice-line--piuma">
						<span className="voice-who">{name}</span> {piumaText}
					</p>
				)}
				{status === "error" && error && (
					<p className="voice-line voice-line--error">{error}</p>
				)}
			</div>

			{tools.length > 0 && (
				<div className="voice-tools">
					{tools.map((t) => (
						<span
							key={t.id}
							className={`voice-tool ${t.done ? (t.ok ? "is-ok" : "is-err") : "is-running"}`}
						>
							{t.done ? (t.ok ? "✓" : "✕") : "…"} {t.label || t.name}
						</span>
					))}
				</div>
			)}

			<div className="voice-controls">
				{active ? (
					<>
						<button
							type="button"
							className="voice-btn"
							onClick={() => voiceEngine.setMuted(!muted)}
						>
							{muted ? "UNMUTE" : "MUTE"}
						</button>
						<button
							type="button"
							className="voice-btn voice-btn--end"
							onClick={() => voiceEngine.stop()}
						>
							END
						</button>
					</>
				) : (
					<button
						type="button"
						className="voice-btn voice-btn--start"
						onClick={() => voiceEngine.start()}
					>
						TALK TO {name.toUpperCase()}
					</button>
				)}
			</div>
			<p className="voice-hint">Ctrl + Space — start or end from anywhere</p>
		</div>
	);
}
