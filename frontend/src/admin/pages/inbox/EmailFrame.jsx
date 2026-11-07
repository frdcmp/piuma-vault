import { DownOutlined, UpOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { PvSpin } from "@/ui";
import { usePigeonItemHtml } from "../../../queries";

// How tall an email shows before "Show all".
const FOLD = 420;
// How long a page may take to load before its text shows instead.
const LOAD_MS = 15 * 1000;

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
// frame where nothing runs, as tall as it is, folded past FOLD. It shows once,
// whole: a spinner holds its place until the page and its images have loaded
// and it's measured (no text first, no growing as images come in). With no
// HTML, or a page that never loads, its text (`fallback`).
export default function EmailFrame({ id, fallback }) {
	const box = useRef(null);
	const frame = useRef(null);
	const seen = useSeen(box);
	const { data, isLoading, isError } = usePigeonItemHtml(seen ? id : null);
	const [height, setHeight] = useState(0);
	const [ready, setReady] = useState(false);
	const [late, setLate] = useState(false);
	const [open, setOpen] = useState(false);
	const page = data?.html;

	// a page that doesn't finish loading: its text after a while
	useEffect(() => {
		if (!page || ready) return;
		const t = setTimeout(() => setLate(true), LOAD_MS);
		return () => clearTimeout(t);
	}, [page, ready]);

	// loaded (the frame's load waits for its images): measured, then shown; its
	// height follows it after that (a late image, a font)
	const watch = useRef(null);
	const onLoad = () => {
		const doc = frame.current?.contentDocument;
		if (!doc?.body) return;
		const fit = () => setHeight(doc.documentElement.scrollHeight);
		fit();
		setReady(true);
		watch.current?.disconnect();
		watch.current = new ResizeObserver(fit);
		watch.current.observe(doc.body);
	};
	useEffect(() => () => watch.current?.disconnect(), []);

	if (!seen || isLoading)
		return (
			<div ref={box} className="inbox-email-wait">
				<PvSpin label="Loading the email…" />
			</div>
		);
	if (!page || isError || (late && !ready))
		return <div ref={box}>{fallback}</div>;
	const folded = ready && !open && height > FOLD;
	return (
		<div ref={box} className="inbox-email">
			{ready ? null : (
				<div className="inbox-email-wait">
					<PvSpin label="Loading the email…" />
				</div>
			)}
			<div
				className={`inbox-email-view${folded ? " is-folded" : ""}${ready ? "" : " is-loading"}`}
				style={{ maxHeight: folded ? FOLD : undefined }}
			>
				<iframe
					ref={frame}
					title="The email"
					// no scripts; same origin only so its height can be read; links open apart
					sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
					srcDoc={page}
					onLoad={onLoad}
					style={{ height: height || 200 }}
				/>
			</div>
			{ready && height > FOLD ? (
				<button
					type="button"
					className="inbox-email-more"
					onClick={() => setOpen((o) => !o)}
				>
					{open ? <UpOutlined /> : <DownOutlined />}
					{open ? "Show less" : "Show all"}
				</button>
			) : null}
		</div>
	);
}
