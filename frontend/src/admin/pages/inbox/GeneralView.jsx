import { ArrowLeftOutlined } from "@ant-design/icons";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { PvEmpty, PvIconButton, PvSpin } from "@/ui";
import { usePigeonGeneral } from "../../../queries";
import { formatDate, formatTime } from "../../../utils/dateTime";
import { errorText } from "./inboxText";
import PigeonCards from "./PigeonCards";

// Pigeon's own chat: everything that waits for a decision (every chat's cards,
// a new email Piuma drafted, a change that waits for a yes) and Pigeon's news,
// on one line of time, latest at the bottom; each with who it's about, a link
// to that chat.
export default function GeneralView() {
	const { data, isLoading, error } = usePigeonGeneral();
	const scrollRef = useRef(null);
	const timeline = useMemo(
		() =>
			[
				...(data?.news ?? []).map((n) => ({ at: n.at, news: n })),
				...(data?.cards ?? []).map((k) => ({ at: k.created_at, card: k })),
			].sort((a, b) => new Date(a.at) - new Date(b.at)),
		[data],
	);

	// at the bottom, where the newest is
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && timeline.length) el.scrollTop = el.scrollHeight;
	}, [timeline]);

	if (isLoading) return <PvSpin block label="loading…" />;

	return (
		<section className="inbox-chat">
			<header className="inbox-chat-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<div className="inbox-chat-who">
					<div className="inbox-chat-name">🕊 Pigeon</div>
					<div className="inbox-chat-sub">
						What waits for you, and Pigeon's news
					</div>
				</div>
			</header>
			<div className="inbox-msgs" ref={scrollRef}>
				{error ? <PvEmpty description={errorText(error)} /> : null}
				{timeline.map((x) =>
					x.news ? (
						<div key={`n-${x.news.id}`} className="inbox-news">
							<span className="inbox-news-when">
								{formatDate(x.news.at)} {formatTime(x.news.at)}
							</span>{" "}
							{x.news.about ? (
								<>
									<Link to={`/inbox/${x.news.conversation_id}`}>
										{x.news.about}
									</Link>{" "}
									·{" "}
								</>
							) : null}
							{x.news.url ? (
								<a href={x.news.url} target="_blank" rel="noreferrer">
									{x.news.text}
								</a>
							) : (
								x.news.text
							)}
						</div>
					) : (
						<PigeonCards
							key={`c-${x.card.kind}-${x.card.id}`}
							cards={[x.card]}
						/>
					),
				)}
				{!error && !timeline.length ? (
					<PvEmpty description="Nothing here: all quiet." />
				) : null}
			</div>
		</section>
	);
}
