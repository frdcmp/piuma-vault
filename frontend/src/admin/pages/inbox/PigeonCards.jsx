import { SendOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PvButton, PvIconButton, PvInput, PvTextarea, pvMessage } from "@/ui";
import { usePressPigeonCard } from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import { errorText } from "./inboxText";

// One card: what Pigeon proposes or asks, with its buttons. A draft's words can
// be changed before Send; a question or a "needs you" card takes an answer in
// the user's own words.
function PigeonCard({ card, conversationId }) {
	const press = usePressPigeonCard();
	const [draft, setDraft] = useState(card.draft ?? "");
	const [answer, setAnswer] = useState("");

	const send = (button, text) =>
		press.mutate(
			{ conversationId, kind: card.kind, id: card.id, button, text },
			{
				onSuccess: (r) => r?.result && pvMessage.success(r.result),
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);

	const onButton = (value) => {
		// a draft sent as changed carries its new words
		const edited =
			card.kind === "draft" &&
			value === "y" &&
			draft.trim() !== (card.draft ?? "").trim();
		send(value, edited ? draft.trim() : undefined);
	};

	const onAnswer = () => {
		const t = answer.trim();
		if (!t) return;
		send("y", t);
		setAnswer("");
	};

	return (
		<div className={`pigeon-card pigeon-card--${card.kind}`}>
			{card.about ? (
				<Link
					to={`/inbox/${card.conversation_id}`}
					className="pigeon-card-about"
				>
					{card.about}
				</Link>
			) : null}
			{card.kind === "draft" ? (
				<>
					<div className="pigeon-card-label">✍ Pigeon's draft</div>
					<PvTextarea
						autoSize
						maxHeight={240}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						aria-label="The draft's words"
					/>
				</>
			) : (
				<div className="pigeon-card-text">{card.text}</div>
			)}
			{card.free_text ? (
				<div className="pigeon-card-answer">
					<PvInput
						size="sm"
						value={answer}
						onChange={(e) => setAnswer(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								onAnswer();
							}
						}}
						placeholder={
							card.kind === "needs"
								? "Tell Pigeon what to do…"
								: "Or answer in your words…"
						}
						aria-label="Your answer"
						suffix={null}
					/>
					<PvIconButton
						size="sm"
						variant="accent"
						icon={<SendOutlined />}
						label="Send the answer"
						disabled={!answer.trim() || press.isPending}
						onClick={onAnswer}
					/>
				</div>
			) : null}
			<div className="pigeon-card-foot">
				<div className="pigeon-card-buttons">
					{card.buttons.map((b) => (
						<PvButton
							key={b.value}
							size="sm"
							plain
							variant={b.value === "y" ? "primary" : "default"}
							disabled={press.isPending}
							onClick={() => onButton(b.value)}
						>
							{b.label}
						</PvButton>
					))}
				</div>
				<span className="pigeon-card-time">{timeAgo(card.created_at)}</span>
			</div>
		</div>
	);
}

export default function PigeonCards({ cards, conversationId = null }) {
	if (!cards?.length) return null;
	return (
		<div className="pigeon-cards">
			{cards.map((c) => (
				<PigeonCard
					// a draft re-written by Pigeon is a new card: reset its words
					key={`${c.kind}-${c.id}-${c.draft ?? ""}`}
					card={c}
					conversationId={c.conversation_id ?? conversationId}
				/>
			))}
		</div>
	);
}
