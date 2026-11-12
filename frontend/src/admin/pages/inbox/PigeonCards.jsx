import { SendOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
	PvButton,
	PvField,
	PvIconButton,
	PvInput,
	PvModal,
	PvSegmented,
	PvSpin,
	PvTextarea,
	pvMessage,
} from "@/ui";
import { usePigeonAccess, usePressPigeonCard } from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import { errorText, usesLine } from "./inboxText";

const MODES = [
	{ value: "ask", label: "Ask me" },
	{ value: "auto", label: "Auto" },
];

// "Allow…" on a 🔑 card (they asked for something they hold no permission
// for): how much of it, and whether Pigeon asks first or tells on its own. The
// levels come from the vault's catalogue; `onAllow(permission)` with its name,
// `tool.level.mode`.
function AllowDialog({ card, open, busy, onClose, onAllow }) {
	const { data, isLoading } = usePigeonAccess(open);
	const tool = data?.catalogue?.find((t) => t.tool === card.data?.tool);
	const [level, setLevel] = useState(null);
	const [mode, setMode] = useState("ask");
	const chosen = level ?? tool?.levels?.[0]?.name;
	const example = tool?.levels?.find((l) => l.name === chosen)?.example;
	const who = card.data?.holder?.name;
	const go = () => {
		if (tool && chosen && !busy) onAllow(`${tool.tool}.${chosen}.${mode}`);
	};
	return (
		<PvModal
			open={open}
			title={`Allow${who ? ` ${who}` : ""}`}
			onCancel={onClose}
			onConfirm={tool ? go : undefined}
			confirmText="Allow"
			width="440px"
		>
			{tool ? (
				<div className="pigeon-allow">
					<p className="pigeon-allow-help">
						Pigeon may tell them {tool.gives}, from now on.
					</p>
					{tool.has_levels ? (
						<PvField label="How much" as="div" hint={example || undefined}>
							<PvSegmented
								size="sm"
								options={tool.levels.map((l) => ({
									value: l.name,
									label: l.label,
								}))}
								value={chosen}
								onChange={setLevel}
							/>
						</PvField>
					) : null}
					{tool.ask_only ? null : (
						<PvField
							label="How"
							as="div"
							hint={
								mode === "auto"
									? "Pigeon tells them on its own when it's sure that's what they ask, and says so after."
									: "Pigeon writes the reply; it goes when you send it."
							}
						>
							<PvSegmented
								size="sm"
								options={MODES}
								value={mode}
								onChange={setMode}
							/>
						</PvField>
					)}
				</div>
			) : isLoading ? (
				<PvSpin block label="loading…" />
			) : (
				<p className="pigeon-allow-help">
					This can't be allowed from here: set it on their page.
				</p>
			)}
		</PvModal>
	);
}

// One card: what Pigeon proposes or asks, with its buttons. A draft's words can
// be changed before Send; a question or a "needs you" card takes an answer in
// the user's own words; a 🔑 card's "Allow…" asks how much first.
function PigeonCard({ card, conversationId }) {
	const press = usePressPigeonCard();
	const [draft, setDraft] = useState(card.draft ?? "");
	const [answer, setAnswer] = useState("");
	const [allowing, setAllowing] = useState(false);
	const uses = card.kind === "draft" ? usesLine(card.data?.used) : "";

	const send = (button, text) =>
		press.mutate(
			{ conversationId, kind: card.kind, id: card.id, button, text },
			{
				onSuccess: (r) => r?.result && pvMessage.success(r.result),
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);

	const onButton = (value) => {
		if (card.kind === "uncovered" && value === "allow") {
			setAllowing(true);
			return;
		}
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
					{uses ? (
						<div className="pigeon-card-label">🔑 Uses {uses}</div>
					) : null}
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
			{card.kind === "uncovered" ? (
				<AllowDialog
					card={card}
					open={allowing}
					busy={press.isPending}
					onClose={() => setAllowing(false)}
					onAllow={(permission) => {
						setAllowing(false);
						send("allow", permission);
					}}
				/>
			) : null}
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
