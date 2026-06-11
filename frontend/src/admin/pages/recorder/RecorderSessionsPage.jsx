import { useNavigate } from "react-router-dom";
import {
	useDeleteRecording,
	useRecorderUsage,
	useRecordings,
} from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";
import Starfield from "../../components/notes/Starfield";
import { PvButton, PvPanel } from "../../components/ui";
import "../../vault-pixel.css";
import "./recorder.css";

// Archive of recorded sessions — the list that used to live on the recorder
// page. Same pixel language: starfield backdrop, bordered cards, vp tags.

const STATUS_TAG = {
	recording: "vp-tag--red",
	summarising: "vp-tag--accent",
	done: "vp-tag--green",
	failed: "vp-tag--red",
};

const fmtDur = (sec) => {
	const m = Math.round(sec / 60);
	const h = Math.floor(m / 60);
	return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
};

// This-month transcription usage per provider, with a gauge against the
// provider's free-tier cap (Speechmatics 40h/mo).
function UsagePanel() {
	const { data } = useRecorderUsage();
	const months = data?.months || [];
	const freeHours = data?.free_hours || {};
	if (months.length === 0) return null;

	// Months come newest-first; show the most recent one present.
	const latest = months[0].month;
	const current = months.filter((m) => m.month === latest);

	return (
		<PvPanel title={`usage · ${latest}`}>
			<div className="recorder-usage">
				{current.map((row) => {
					const hours = row.seconds / 3600;
					const cap = freeHours[row.provider];
					const pct = cap ? Math.min(100, (hours / cap) * 100) : 0;
					const over = cap && hours > cap;
					return (
						<div key={row.provider} className="recorder-usage-row">
							<div className="recorder-usage-head">
								<span className="recorder-usage-name">{row.provider}</span>
								<span className="recorder-usage-val">
									{fmtDur(row.seconds)}
									{cap ? ` / ${cap}h free` : ""} · {row.sessions} rec
								</span>
							</div>
							{cap > 0 && (
								<div className="recorder-usage-bar">
									<div
										className={`recorder-usage-fill${over ? " is-over" : ""}`}
										style={{ width: `${pct}%` }}
									/>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</PvPanel>
	);
}

export default function RecorderSessionsPage() {
	const navigate = useNavigate();
	const { data: recordings = [], isLoading } = useRecordings();
	const deleteRecording = useDeleteRecording();

	return (
		<div className="recorder-scene recorder-scene--page">
			<Starfield />
			<div className="recorder-page recorder-page--over">
				<div className="vp-page-head">
					<div>
						<PvButton
							size="sm"
							variant="ghost"
							onClick={() => navigate("/recorder")}
						>
							← Recorder
						</PvButton>
						<h1 className="vp-page-title" style={{ marginTop: 10 }}>
							Recorded Sessions
						</h1>
						<p className="vp-page-subtitle">
							Every capture — transcript and summary note included.
						</p>
					</div>
				</div>

				<UsagePanel />

				{isLoading ? (
					<p className="vp-muted vp-text">Loading…</p>
				) : recordings.length === 0 ? (
					<p className="vp-muted vp-text">
						Nothing here yet — feed the black hole.
					</p>
				) : (
					<ul className="recorder-list">
						{recordings.map((r) => {
							const { date, time } = formatDateTime(r.created_at);
							return (
								<li key={r.id} className="recorder-item">
									<div className="recorder-item-main">
										<div className="recorder-item-title">
											<button
												type="button"
												className="recorder-item-link"
												onClick={() => navigate(`/recorder/sessions/${r.id}`)}
											>
												{r.title || "Untitled recording"}
											</button>
											<span className={`vp-tag ${STATUS_TAG[r.status] || ""}`}>
												{r.status}
											</span>
										</div>
										<div className="recorder-item-meta">
											<span>
												{date} {time}
											</span>
											{r.duration_secs > 0 && (
												<span>{Math.round(r.duration_secs / 60)} min</span>
											)}
											{r.word_count > 0 && <span>{r.word_count} words</span>}
										</div>
										{r.preview && (
											<p className="recorder-item-preview">{r.preview}</p>
										)}
										{r.status === "failed" && r.error && (
											<p className="recorder-item-error">{r.error}</p>
										)}
									</div>
									<div className="recorder-item-actions">
										{r.final_note_id && (
											<PvButton
												size="sm"
												onClick={() => navigate(`/notes/${r.final_note_id}`)}
											>
												Note
											</PvButton>
										)}
										<PvButton
											size="sm"
											variant="danger"
											onClick={() => deleteRecording.mutate(r.id)}
										>
											Delete
										</PvButton>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}
