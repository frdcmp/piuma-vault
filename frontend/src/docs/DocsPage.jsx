import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Link, Navigate, useParams } from "react-router-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import PvPanel from "../admin/components/ui/PvPanel/PvPanel";
import { DOC_BY_SLUG, FIRST_SLUG } from "./docsManifest";

// Flatten a heading's React children to plain text so we can derive an id.
const toText = (children) => {
	if (children == null) return "";
	if (typeof children === "string" || typeof children === "number") {
		return String(children);
	}
	if (Array.isArray(children)) return children.map(toText).join("");
	if (children.props) return toText(children.props.children);
	return "";
};

// Kebab-case slug for heading anchors (enables /docs/notes#embeddings deep links).
const slugify = (text) =>
	text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-");

const heading = (Tag) => {
	const H = ({ children }) => {
		const id = slugify(toText(children));
		return (
			<Tag id={id} className="vp-docs-h">
				<a
					href={`#${id}`}
					className="vp-docs-anchor"
					aria-label="Link to section"
				>
					{children}
				</a>
			</Tag>
		);
	};
	H.displayName = `DocsHeading(${Tag})`;
	return H;
};

const markdownComponents = {
	h1: heading("h1"),
	h2: heading("h2"),
	h3: heading("h3"),
	h4: heading("h4"),
	a({ href = "", children, ...props }) {
		// In-app navigation stays within the SPA; anchors scroll; the rest opens
		// in a new tab.
		if (href.startsWith("/")) {
			return <Link to={href}>{children}</Link>;
		}
		if (href.startsWith("#")) {
			return <a href={href}>{children}</a>;
		}
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
				{children}
			</a>
		);
	},
};

export default function DocsPage() {
	const { slug } = useParams();
	const doc = useMemo(() => DOC_BY_SLUG[slug], [slug]);
	// The doc title is shown in the page head, so drop the leading "# Title".
	const body = useMemo(
		() => (doc ? doc.body.replace(/^#[^\n]*\n+/, "") : ""),
		[doc],
	);

	if (!doc) return <Navigate to={`/docs/${FIRST_SLUG}`} replace />;

	return (
		<div className="vp-page vp-page--narrow vp-docs-page">
			<div className="vp-page-head">
				<h1 className="vp-page-title">{doc.title}</h1>
			</div>
			<PvPanel title={doc.title}>
				<div className="vp-docs-body">
					<ReactMarkdown
						components={markdownComponents}
						remarkPlugins={[remarkGfm]}
						rehypePlugins={[rehypeHighlight]}
					>
						{body}
					</ReactMarkdown>
				</div>
			</PvPanel>
		</div>
	);
}
