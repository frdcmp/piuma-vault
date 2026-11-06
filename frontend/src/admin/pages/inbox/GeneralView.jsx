import { ArrowLeftOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { PvEmpty, PvIconButton, PvSpin } from "@/ui";
import { usePigeonGeneral } from "../../../queries";
import { formatDate, formatTime } from "../../../utils/dateTime";
import { errorText } from "./inboxText";
import PigeonCards from "./PigeonCards";

// Pigeon's own chat: everything that waits for a decision (every chat's cards,
// a new email Piuma drafted, a change that waits for a yes) and Pigeon's news,
// each with who it's about, a link to that chat.
export default function GeneralView() {
	const { data, isLoading, error } = usePigeonGeneral();
	if (isLoading) return <PvSpin block label="loading…" />;
	const cards = data?.cards ?? [];
	const news = data?.news ?? [];

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
			<div className="inbox-msgs">
				{error ? <PvEmpty description={errorText(error)} /> : null}
				{news.map((n) => (
					<div key={n.id} className="inbox-news">
						<span className="inbox-news-when">
							{formatDate(n.at)} {formatTime(n.at)}
						</span>{" "}
						{n.about ? (
							<>
								<Link to={`/inbox/${n.conversation_id}`}>{n.about}</Link> ·{" "}
							</>
						) : null}
						{n.url ? (
							<a href={n.url} target="_blank" rel="noreferrer">
								{n.text}
							</a>
						) : (
							n.text
						)}
					</div>
				))}
				<PigeonCards cards={cards} />
				{!error && !cards.length && !news.length ? (
					<PvEmpty description="Nothing here: all quiet." />
				) : null}
			</div>
		</section>
	);
}
