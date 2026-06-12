import { useNavigate, useParams } from "react-router-dom";
import {
	useRecording,
	useRecordingTranscript,
	useSummariseRecording,
} from "../../../queries";
import { formatDateTime } from "../../../utils/dateTime";
import Starfield from "../../components/notes/Starfield";
import { PvButton, PvPanel, pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import { colorForSpeaker } from "./speakerColors";
import "./recorder.css";

const STATUS_TAG = {
	recording: "vp-tag--red",
	ready: "vp-tag--accent",
	summarising: "vp-tag--accent",
	done: "vp-tag--green",
	failed: "vp-tag--red",
};

// Seconds → m:ss for segment timestamps.
const fmtClock = (s) => {
	const total = Math.max(0, Math.floor(s || 0));
	const m = Math.floor(total / 60);
	const sec = total % 60;
	return `${m}:${String(sec).padStart(2, "0")}`;
};

// Providers emit transcripts word-by-word. Coalesce consecutive segments into
// readable chunks: same speaker, ≤ MAX_GAP_S seconds between them, up to
// MAX_WORDS words per chunk.
const MAX_WORDS = 40;
const MAX_GAP_S = 3;

const tidy = (t) =>
	t
		.replace(/\s+([,.!?;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();

const mergeSegments = (segs) => {
	const out = [];
	let cur = null;
	for (const s of segs) {
		const text = (s.text || "").trim();
		if (!text) continue;
		const speaker = s.speaker ?? null;
		const gap = cur ? s.t - cur.end : 0;
		const words = cur ? cur.text.split(/\s+/).length : 0;
		if (
			cur &&
			speaker === cur.speaker &&
			gap <= MAX_GAP_S &&
			words < MAX_WORDS
		) {
			cur.text += ` ${text}`;
			cur.end = s.end;
		} else {
			if (cur) out.push(cur);
			cur = { t: s.t, end: s.end, speaker, text };
		}
	}
	if (cur) out.push(cur);
	return out.map((g) => ({ ...g, text: tidy(g.text) }));
};

export default function RecordingDetailPage() {
	const { id } = useParams();
	const navigate = useNavigate();
	const { data: rec, isLoading } = useRecording(id);
	const { data: transcript, isLoading: trLoading } = useRecordingTranscript(id);
	const summarise = useSummariseRecording();

	const segments = mergeSegments(
		(transcript?.segments || []).filter((s) => s.is_final),
	);

	// 'ready' = transcript saved but never summarised (user chose "keep" after
	// stopping). Offer to summarise it now.
	const canSummarise = rec?.status === "ready" || rec?.status === "failed";
	const runSummarise = () => {
		summarise.mutate(id, {
			onSuccess: () => pvMessage.success("Summary saved to your vault"),
			onError: () => pvMessage.error("Couldn't summarise the recording"),
		});
	};

	return (
		<div className="recorder-scene recorder-scene--page">
			<Starfield />
			<div className="recorder-page recorder-page--over">
				<div className="vp-page-head">
					<div>
						<PvButton
							size="sm"
							variant="ghost"
							onClick={() => navigate("/recorder/sessions")}
						>
							← Sessions
						</PvButton>
						<h1 className="vp-page-title" style={{ marginTop: 10 }}>
							{rec?.title || (isLoading ? "Loading…" : "Untitled recording")}
						</h1>
						{rec && (
							<div className="recorder-item-meta" style={{ marginTop: 8 }}>
								<span className={`vp-tag ${STATUS_TAG[rec.status] || ""}`}>
									{rec.status}
								</span>
								<span>{formatDateTime(rec.created_at).date}</span>
								{rec.duration_secs > 0 && (
									<span>{Math.round(rec.duration_secs / 60)} min</span>
								)}
								{rec.word_count > 0 && <span>{rec.word_count} words</span>}
								{rec.provider && <span>{rec.provider}</span>}
							</div>
						)}
					</div>
					{canSummarise ? (
						<PvButton
							variant="primary"
							loading={summarise.isPending}
							disabled={summarise.isPending}
							onClick={runSummarise}
						>
							{rec?.status === "failed" ? "Retry summary" : "Summarize now"}
						</PvButton>
					) : rec?.final_note_id ? (
						<PvButton
							onClick={() => navigate(`/notes/${rec.final_note_id}`)}
						>
							Open summary note
						</PvButton>
					) : null}
				</div>

				{rec?.status === "failed" && rec.error && (
					<PvPanel title="error">
						<p className="recorder-item-error" style={{ margin: 0 }}>
							{rec.error}
						</p>
					</PvPanel>
				)}

				{rec?.running_summary && (
					<PvPanel title="summary">
						<p className="recorder-detail-summary">{rec.running_summary}</p>
					</PvPanel>
				)}

				<PvPanel title="transcript">
					{trLoading ? (
						<p className="vp-muted vp-text">Loading transcript…</p>
					) : segments.length === 0 ? (
						<p className="vp-muted vp-text">
							{transcript?.ready === false
								? "Transcript not available yet — it's saved when the recording finishes."
								: "No transcript text."}
						</p>
					) : (
						<div className="recorder-transcript">
							{segments.map((seg) => (
								<div
									key={`${seg.t}-${seg.end}-${seg.text}`}
									className="recorder-seg"
								>
									<span className="recorder-seg-time">{fmtClock(seg.t)}</span>
									{seg.speaker && (
										<span
											className="recorder-seg-speaker"
											style={{ color: colorForSpeaker(seg.speaker) }}
										>
											{seg.speaker}
										</span>
									)}
									<span className="recorder-seg-text">{seg.text}</span>
								</div>
							))}
						</div>
					)}
				</PvPanel>
			</div>
		</div>
	);
}
