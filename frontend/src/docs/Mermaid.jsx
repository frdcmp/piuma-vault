/* biome-ignore-all lint/security/noDangerouslySetInnerHtml: chart source is
   author-controlled (lives in versioned .md files), not user input. */
import { useEffect, useId, useRef, useState } from "react";
import { renderMermaid } from "../utils/mermaid";

/**
 * Render a Mermaid diagram from a fenced ```mermaid code block in a doc.
 *
 * Mermaid is heavy (~600 KB) and bootstraps from the global document; the shared
 * `renderMermaid` util lazy-loads and initialises it once with the vault-pixel
 * theme. We inject the returned SVG with dangerouslySetInnerHTML — the chart
 * source is author-controlled (lives in versioned .md files), so this is safe.
 *
 * If parsing fails (typo in the diagram), we show the error inline so the doc
 * author can fix it without opening devtools.
 */
export default function Mermaid({ chart }) {
	const id = useId();
	const containerRef = useRef(null);
	const [svg, setSvg] = useState("");
	const [error, setError] = useState(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const rendered = await renderMermaid(id, chart);
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
