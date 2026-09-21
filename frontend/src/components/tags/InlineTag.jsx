import { tagColor, tagTint } from "../../utils/tagColor";
import "./InlineTag.css";

// An inline tag typed in a note body (`#k8s` or `[k8s]`) rendered as a rounded,
// colour-coded pill. Shape lives in CSS; the colour is applied inline from the
// deterministic tag hash so the same tag always looks the same (web, mobile,
// chat).
export default function InlineTag({ name, className = "" }) {
	const color = tagColor(name);
	return (
		<span
			className={`inline-tag ${className}`.trim()}
			style={{ color, borderColor: color, background: tagTint(name) }}
			data-tag={name}
		>
			<span className="inline-tag-hash" aria-hidden="true">
				#
			</span>
			{name}
		</span>
	);
}

// react-markdown `span` renderer. The remark plugin marks tag spans with a
// `data-tag` attribute; everything else falls through to a normal span.
export function InlineTagSpan({ node, className, children, ...props }) {
	if (props["data-tag"]) return <InlineTag name={props["data-tag"]} />;
	return (
		<span className={className} {...props}>
			{children}
		</span>
	);
}
