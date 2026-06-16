// Shared Mermaid renderer. Mermaid is heavy (~600 KB), so it's dynamically
// imported on first use and initialised once with the vault-pixel theme. Used by
// both the docs site and the notes editor's mermaid code-block preview.

let mermaidMod = null;
let initialised = false;
let renderKey = 0;

async function ensureMermaid() {
	if (!mermaidMod) {
		mermaidMod = (await import("mermaid")).default;
	}
	if (!initialised) {
		mermaidMod.initialize({
			startOnLoad: false,
			theme: "base",
			themeVariables: {
				background: "#14171c",
				primaryColor: "#1b1e25",
				primaryTextColor: "#d6dbe5",
				primaryBorderColor: "#3a4150",
				secondaryColor: "#1f232b",
				tertiaryColor: "#15171c",
				lineColor: "#8a93a3",
				fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
			},
			themeCSS: `
				.node rect, .node circle, .node polygon, .node path {
					stroke: #3a4150 !important;
					stroke-width: 2px !important;
					fill: #1b1e25 !important;
					rx: 0px !important;
					ry: 0px !important;
				}
				.cluster rect {
					stroke: #3a4150 !important;
					stroke-dasharray: 4px !important;
					stroke-width: 2px !important;
					fill: #15171c !important;
					rx: 0px !important;
					ry: 0px !important;
				}
				.cluster .label {
					font-size: 11px !important;
					letter-spacing: 1px !important;
					text-transform: uppercase !important;
					font-weight: bold !important;
					fill: #f7c948 !important;
				}
				.edgePath .path { stroke: #8a93a3 !important; stroke-width: 2px !important; }
				.edgeLabel rect { fill: #14171c !important; rx: 0px !important; ry: 0px !important; }
				.edgeLabel { font-size: 11px !important; fill: #8a93a3 !important; }
				.node .label { font-size: 12px !important; fill: #d6dbe5 !important; }
				.node .label b, .node .label strong { color: #f7c948 !important; }
				.arrowheadPath { fill: #8a93a3 !important; stroke: none !important; }
			`,
			flowchart: { curve: "basis", htmlLabels: true },
			stateDiagram: { htmlLabels: true },
			securityLevel: "loose",
		});
		initialised = true;
	}
	return mermaidMod;
}

// Render `chart` to an SVG string. `idHint` keeps render ids stable-ish per
// caller; a monotonic key guarantees uniqueness across re-renders.
export async function renderMermaid(idHint, chart) {
	const mermaid = await ensureMermaid();
	renderKey += 1;
	const id = `mermaid-${String(idHint).replace(/[^a-zA-Z0-9_-]/g, "")}-${renderKey}`;
	const { svg } = await mermaid.render(id, chart);
	return svg;
}
