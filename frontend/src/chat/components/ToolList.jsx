const TOOL_ICON = { running: "⚙", done: "✓", error: "✗" };

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
	if (!tools?.length) return null;
	return (
		<div className="chat-tools">
			{tools.map((t) => {
				// Prefer a resolved entity name (note/task title) over raw UUID args.
				const summary = t.label || toolArgsSummary(t.args);
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
