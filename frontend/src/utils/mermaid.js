// Shared Mermaid renderer. Mermaid is heavy (~600 KB), so it's dynamically
// imported on first use and initialised once with the vault-pixel theme. Used by
// both the docs site and the notes editor's mermaid code-block preview.

import { currentTokens, staticTokens } from "../theme";

let mermaidMod = null;
let initialised = false;
let renderKey = 0;

async function ensureMermaid() {
	if (!mermaidMod) {
		mermaidMod = (await import("mermaid")).default;
	}
	if (!initialised) {
		const t = currentTokens();
		mermaidMod.initialize({
			startOnLoad: false,
			theme: "base",
			themeVariables: {
				background: t.bg,
				primaryColor: t.panel,
				primaryTextColor: t.text,
				primaryBorderColor: t.border,
				secondaryColor: t.panelAlt,
				tertiaryColor: t.bgSoft,
				lineColor: t.muted,
				fontFamily: staticTokens.font,
			},
			themeCSS: `
				.node rect, .node circle, .node polygon, .node path {
					stroke: ${t.border} !important;
					stroke-width: 2px !important;
					fill: ${t.panel} !important;
					rx: 0px !important;
					ry: 0px !important;
				}
				.cluster rect {
					stroke: ${t.border} !important;
					stroke-dasharray: 4px !important;
					stroke-width: 2px !important;
					fill: ${t.bgSoft} !important;
					rx: 0px !important;
					ry: 0px !important;
				}
				.cluster .label {
					font-size: 11px !important;
					letter-spacing: 1px !important;
					text-transform: uppercase !important;
					font-weight: bold !important;
					fill: ${t.accent} !important;
				}
				.edgePath .path { stroke: ${t.muted} !important; stroke-width: 2px !important; }
				.edgeLabel rect { fill: ${t.bg} !important; rx: 0px !important; ry: 0px !important; }
				.edgeLabel { font-size: 11px !important; fill: ${t.muted} !important; }
				.node .label { font-size: 12px !important; fill: ${t.text} !important; }
				.node .label b, .node .label strong { color: ${t.accent} !important; }
				.arrowheadPath { fill: ${t.muted} !important; stroke: none !important; }
			`,
			flowchart: { curve: "basis", htmlLabels: true },
			stateDiagram: { htmlLabels: true },
			// "strict" (mermaid's own default) encodes HTML in labels and
			// disables `click` bindings. It must stay strict: we inject the
			// rendered SVG with dangerouslySetInnerHTML, and diagram source is
			// not always ours — a ```mermaid block can arrive from an
			// edit-access public share, an agent web_fetch, or a transcript.
			// Under "loose" mermaid skips its DOMPurify pass and honours
			// `click X "javascript:..."`, which is arbitrary JS on our origin.
			// Inline <b>/<strong> in labels no longer renders as markup; use
			// mermaid's markdown strings instead: A["`**bold**`"].
			securityLevel: "strict",
			// On a parse failure mermaid otherwise draws its "bomb" error
			// diagram into a temp div it appends to <body>, and throws before
			// reaching its own cleanup — leaving a giant orphaned SVG floating
			// over the app. Every caller renders the thrown error inline, so
			// suppress mermaid's graphic and let it clean up and rethrow.
			suppressErrorRendering: true,
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
