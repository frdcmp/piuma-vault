/* biome-ignore-all lint/security/noDangerouslySetInnerHtml: chart source is
   author-controlled (lives in versioned .md files), not user input. */
import mermaid from "mermaid";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Render a Mermaid diagram from a fenced ```mermaid code block in a doc.
 *
 * Mermaid is a heavy library (~600 KB) and bootstraps from the global document,
 * so we initialise it once per mount. We render into a detached SVG string and
 * inject it with dangerouslySetInnerHTML — the chart source is author-controlled
 * (lives in versioned .md files), so this is safe.
 *
 * If parsing fails (typo in the diagram), we show the error inline so the doc
 * author can fix it without opening devtools.
 */
let mermaidInitialised = false;
let mermaidInitKey = 0;
const initMermaid = () => {
	mermaidInitKey += 1;
	mermaid.initialize({
		startOnLoad: false,
		// Match the vault-pixel docs theme.
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
			/* Pixel design system: no rounded corners, solid thick borders, retro fonts */
			.node rect, .node circle, .node polygon, .node path {
				stroke: #3a4150 !important;
				stroke-width: 2px !important;
				fill: #1b1e25 !important;
				rx: 0px !important;
				ry: 0px !important;
			}
			.cluster rect {
				stroke: #3a4150 !important;
				stroke-dasharray: 4px !important; /* retro dashed borders for subgraphs */
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
				fill: #f7c948 !important; /* Accent gold for subgraphs */
			}
			.edgePath .path {
				stroke: #8a93a3 !important;
				stroke-width: 2px !important;
			}
			.edgeLabel rect {
				fill: #14171c !important;
				rx: 0px !important;
				ry: 0px !important;
			}
			.edgeLabel {
				font-size: 11px !important;
				fill: #8a93a3 !important;
			}
			.node .label {
				font-size: 12px !important;
				fill: #d6dbe5 !important;
			}
			.node .label b, .node .label strong {
				color: #f7c948 !important; /* Gold text highlight for bold text in nodes */
			}
			.arrowheadPath {
				fill: #8a93a3 !important;
				stroke: none !important;
			}
		`,
		// Better defaults for documentation diagrams.
		flowchart: { curve: "basis", htmlLabels: true },
		stateDiagram: { htmlLabels: true },
		securityLevel: "loose",
	});
	mermaidInitialised = true;
};

export default function Mermaid({ chart }) {
	const id = useId();
	const containerRef = useRef(null);
	const [svg, setSvg] = useState("");
	const [error, setError] = useState(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!mermaidInitialised) initMermaid();
			try {
				const { svg: rendered } = await mermaid.render(
					`mermaid-${id.replace(/:/g, "")}-${mermaidInitKey}`,
					chart,
				);
				if (!cancelled) {
					setSvg(rendered);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err?.message || String(err));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [chart, id]);

	if (error) {
		return (
			<div className="vp-docs-mermaid vp-docs-mermaid--error">
				<strong>Mermaid diagram error:</strong>
				<pre>{error}</pre>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="vp-docs-mermaid"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

// The chart source is author-controlled (lives in versioned .md files), not
// user input — so injecting the rendered SVG string is safe.
