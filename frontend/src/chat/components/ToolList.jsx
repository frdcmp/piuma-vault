import { useQueryClient } from "@tanstack/react-query";
import { findCachedNoteTitle } from "../../queries";

const TOOL_ICON = { running: "⚙", done: "✓", error: "✗" };

// Note tools that take a note `id` arg — while they run (before the result's
// title arrives) we resolve the id to a name from the cache so the chip shows
// the note title, not a raw UUID.
const NOTE_ID_TOOLS = new Set(["read_note", "update_note", "delete_note"]);

// Compact one-line summary of a tool's arguments for the chip.
const toolArgsSummary = (args) => {
	if (!args || typeof args !== "object") return "";
	return Object.entries(args)
		.filter(([, v]) => v !== null && v !== undefined && v !== "")
		.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
		.join(", ");
};

// Tool activity — which plugins the agent ran this turn (chips wrap to fit). No
// collapse-to-summary on completion; the run stays visible as a record.
export default function ToolList({ tools }) {
	const qc = useQueryClient();
	if (!tools?.length) return null;
	return (
		<div className="chat-tools">
			{tools.map((t) => {
				// Prefer a resolved entity name (note/task title) over raw UUID args:
				// the result's label first, then a cached note title (so a running
				// read_note shows the name), then the raw args as a last resort.
				const cachedTitle =
					NOTE_ID_TOOLS.has(t.name) && t.args?.id
						? findCachedNoteTitle(qc, t.args.id)
						: null;
				const summary = t.label || cachedTitle || toolArgsSummary(t.args);
				return (
					<div key={t.id} className={`chat-tool chat-tool--${t.status}`}>
						<span className="chat-tool-icon" aria-hidden="true">
							{TOOL_ICON[t.status] || "⚙"}
						</span>
						<span className="chat-tool-name">{t.name}</span>
						{summary ? <span className="chat-tool-args">{summary}</span> : null}
					</div>
				);
			})}
		</div>
	);
}
