import { ExportOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { usePigeonItemHtml } from "../../../queries";

// How tall an email shows before "Show all".
const FOLD = 420;

// Whether an element is on screen (or about to be): an email is fetched when it is.
function useSeen(ref) {
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el || seen) return;
		const io = new IntersectionObserver(
			(es) => es.some((e) => e.isIntersecting) && setSeen(true),
			{ rootMargin: "400px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, seen]);
	return seen;
}

// An email in its bubble, as it was sent: its page (made safe by the vault) in a
// frame where nothing runs, as tall as it is, folded past FOLD. Until it's
// fetched, or when it has no HTML, its text (`fallback`).
export default function EmailFrame({ id, fallback }) {
	const box = useRef(null);
	const frame = useRef(null);
	const seen = useSeen(box);
	const { data, isLoading } = usePigeonItemHtml(seen ? id : null);
	const [height, setHeight] = useState(0);
	const [open, setOpen] = useState(false);

	// the frame's own height: once loaded, and again as its images come in
	const measure = () => {
		const doc = frame.current?.contentDocument;
		if (!doc?.body) return;
		const fit = () => setHeight(doc.documentElement.scrollHeight);
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(doc.body);
		frame.current.addEventListener("load", () => ro.disconnect(), {
			once: true,
		});
	};

	const page = data?.html;
	if (!page)
		return (
			<div ref={box}>
				{fallback}
				{seen && isLoading ? (
					<div className="inbox-email-loading">Loading the email…</div>
				) : null}
			</div>
		);
	const folded = !open && height > FOLD;
	return (
		<div ref={box} className="inbox-email">
			<div
				className={`inbox-email-view${folded ? " is-folded" : ""}`}
				style={{ maxHeight: folded ? FOLD : undefined }}
			>
				<iframe
					ref={frame}
					title="The email"
					// no scripts; same origin only so its height can be read; links open apart
					sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
					srcDoc={page}
					onLoad={measure}
					style={{ height: height || 200 }}
				/>
			</div>
			{height > FOLD ? (
				<button
					type="button"
					className="inbox-msg-open"
					onClick={() => setOpen((o) => !o)}
				>
					{open ? "Show less" : "Show all"}
				</button>
			) : null}
		</div>
	);
}

// The link that opens an email where it lives (its mailbox, on the web).
export function OpenEmail({ url }) {
	if (!url) return null;
	return (
		<a className="inbox-msg-open" href={url} target="_blank" rel="noreferrer">
			Open email <ExportOutlined />
		</a>
	);
}
