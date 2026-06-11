import { useNavigate } from "react-router-dom";
import { useDeleteRecording, useRecordings } from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";
import Starfield from "../../components/notes/Starfield";
import { PvButton } from "../../components/ui";
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
												onClick={() => navigate(`/recorder/${r.id}`)}
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
