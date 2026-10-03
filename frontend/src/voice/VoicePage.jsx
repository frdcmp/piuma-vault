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

export default function VoicePage() {
	const { name } = useSprite();
	const status = useVoiceStore((s) => s.status);
	const error = useVoiceStore((s) => s.error);
	const muted = useVoiceStore((s) => s.muted);
	const micLevel = useVoiceStore((s) => s.micLevel);
	const outLevel = useVoiceStore((s) => s.outLevel);
	const userText = useVoiceStore((s) => s.userText);
	const piumaText = useVoiceStore((s) => s.piumaText);
	const tools = useVoiceStore((s) => s.tools);

	const active = status !== "idle" && status !== "error";
	// The rings breathe with whoever is talking.
	const level =
		status === "speaking" ? outLevel : status === "listening" ? micLevel : 0;
	const ring = Math.min(1, level * 5);

	return (
		<div className="voice-page">
			<Starfield />

			<div className={`voice-stage is-${status}`}>
				<div
					className="voice-ring voice-ring--outer"
					style={{ transform: `scale(${1 + ring * 0.35})` }}
				/>
				<div
					className="voice-ring voice-ring--inner"
					style={{ transform: `scale(${1 + ring * 0.18})` }}
				/>
				<TalkingPiuma status={status} outLevel={outLevel} />
			</div>

			<div className={`voice-status is-${status}`}>
				<span className="voice-status-dot" aria-hidden="true" />
				{muted && active ? "muted" : STATUS_LABEL[status]}
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
