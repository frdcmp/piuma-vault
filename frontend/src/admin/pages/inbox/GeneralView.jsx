import { ArrowLeftOutlined } from "@ant-design/icons";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { PvAvatar, PvEmpty, PvIconButton, PvSpin } from "@/ui";
import { usePigeonGeneral } from "../../../queries";
import { formatDate, formatTime } from "../../../utils/dateTime";
import { errorText } from "./inboxText";
import PigeonCards from "./PigeonCards";
import { PigeonMark } from "./SentBy";

// Pigeon's own chat: everything that waits for a decision (every chat's cards,
// a new email Piuma drafted, a change that waits for a yes) and Pigeon's news,
// written to you as its messages, a day line where the day changes, latest at
// the bottom; each says who it's about, a link to that chat.
export default function GeneralView() {
	const { data, isLoading, error } = usePigeonGeneral();
	const scrollRef = useRef(null);
	const rows = useMemo(() => {
		const all = [
			...(data?.news ?? []).map((n) => ({ at: n.at, news: n })),
			...(data?.cards ?? []).map((k) => ({ at: k.created_at, card: k })),
		].sort((a, b) => new Date(a.at) - new Date(b.at));
		const out = [];
		let day = null;
		let prev = null;
		for (const r of all) {
			const d = formatDate(r.at);
			if (d !== day) {
				out.push({ day: d, key: `day-${d}` });
				day = d;
				prev = null;
			}
			out.push({
				...r,
				tail: !prev?.news,
				key: r.news ? `n-${r.news.id}` : `c-${r.card.kind}-${r.card.id}`,
			});
			prev = r;
		}
		return out;
	}, [data]);

	// at the bottom, where the newest is
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && rows.length) el.scrollTop = el.scrollHeight;
	}, [rows]);

	if (isLoading) return <PvSpin block label="loading…" />;

	return (
		<section className="inbox-chat inbox-pigeon">
			<header className="inbox-chat-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<PvAvatar size={36} tone="accent">
					<PigeonMark />
				</PvAvatar>
				<div className="inbox-chat-who">
					<div className="inbox-chat-name">Pigeon</div>
					<div className="inbox-chat-sub">
						What waits for you, and Pigeon's news
					</div>
				</div>
			</header>
			<div className="inbox-msgs" ref={scrollRef}>
				{error ? <PvEmpty description={errorText(error)} /> : null}
				{rows.map((r) =>
					r.day ? (
						<div key={r.key} className="inbox-day">
							<span>{r.day}</span>
						</div>
					) : r.news ? (
						<div
							key={r.key}
							className={`inbox-msg is-in${r.tail ? " has-tail" : ""}`}
						>
							<div className="inbox-bubble">
								{r.news.about ? (
									<Link
										to={`/inbox/${r.news.conversation_id}`}
										className="inbox-msg-sender"
									>
										{r.news.about}
									</Link>
								) : null}
								<div className="inbox-msg-body">
									{r.news.url ? (
										<a href={r.news.url} target="_blank" rel="noreferrer">
											{r.news.text}
										</a>
									) : (
										r.news.text
									)}
								</div>
								<div className="inbox-msg-meta">{formatTime(r.news.at)}</div>
							</div>
						</div>
					) : (
						<PigeonCards key={r.key} cards={[r.card]} />
					),
				)}
				{!error && !rows.length ? (
					<PvEmpty description="Nothing here: all quiet." />
				) : null}
			</div>
		</section>
	);
}
