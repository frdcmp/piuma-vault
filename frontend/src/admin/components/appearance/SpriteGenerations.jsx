import { PvIconButton } from "@/ui";
import { timeAgo } from "../../../utils/dateTime";
import { AnimatedPreview } from "./pixelRender";

// AI sprite generations in progress or recently finished. Each job runs in
// rounds server-side (draft, then look at the render and fix); every round
// shows here as it lands, with what the automatic checks found. Clicking a
// round opens it in the editor to name and save; nothing is saved before that.

const statusText = (g) => {
	if (g.status === "running") {
		return `round ${g.rounds.length + 1} of up to ${g.max_rounds}…`;
	}
	if (g.status === "failed") return "failed";
	return `done · ${g.rounds.length} round${g.rounds.length === 1 ? "" : "s"}`;
};

function RoundTile({ round, onPick }) {
	const { definition: d, issues } = round;
	const problems = issues.length;
	return (
		<button
			type="button"
			className="vp-gen-round"
			onClick={() => onPick(round)}
			title={[
				round.notes,
				...issues.map((i) => `• ${i.message}`),
				"Click to open in the editor",
			]
				.filter(Boolean)
				.join("\n")}
		>
			<AnimatedPreview
				body={d.body}
				frames={d.walkLegs}
				frameMs={d.walkFrameMs}
				palette={d.palette}
				pixelSize={4}
			/>
			<span className="vp-gen-round-label">round {round.round}</span>
			<span
				className={`vp-sprite-badge ${problems ? "vp-sprite-badge--warn" : ""}`}
			>
				{problems
					? `${problems} problem${problems === 1 ? "" : "s"}`
					: "checks ok"}
			</span>
		</button>
	);
}

export default function SpriteGenerations({
	generations,
	loader,
	onPick,
	onDismiss,
}) {
	if (!generations.length) return null;
	return (
		<div className="vp-gens">
			{generations.map((g) => (
				<section key={g.id} className={`vp-gen vp-gen--${g.status}`}>
					<div className="vp-gen-head">
						<div className="vp-gen-title">
							<span className="vp-sprite-card-name">
								{g.name || "New sprite"}
							</span>
							<span className="vp-gen-meta">
								{statusText(g)} · {g.model} · {timeAgo(g.started_at)}
							</span>
						</div>
						<PvIconButton
							variant="ghost"
							size="sm"
							icon="✕"
							label={g.status === "running" ? "Stop and dismiss" : "Dismiss"}
							onClick={() => onDismiss(g.id)}
						/>
					</div>
					<p className="vp-gen-prompt">“{g.prompt}”</p>
					<div className="vp-gen-rounds">
						{g.rounds.map((r) => (
							<RoundTile
								key={r.round}
								round={r}
								onPick={(round) => onPick(round, g)}
							/>
						))}
						{g.status === "running" && (
							<div className="vp-gen-round vp-gen-round--pending">
								{loader ? (
									<AnimatedPreview
										body={loader.definition.body}
										frames={loader.definition.gallopLegs}
										frameMs={loader.definition.gallopFrameMs}
										palette={loader.definition.palette}
										pixelSize={4}
									/>
								) : (
									<div className="vp-sprite-spinner" />
								)}
								<span className="vp-gen-round-label">
									{g.rounds.length ? "looking and fixing…" : "drawing…"}
								</span>
							</div>
						)}
					</div>
					{g.error && <p className="vp-text vp-sprite-error">{g.error}</p>}
				</section>
			))}
		</div>
	);
}
