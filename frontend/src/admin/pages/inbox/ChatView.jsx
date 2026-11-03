import {
	ArrowLeftOutlined,
	CheckOutlined,
	ControlOutlined,
	EditOutlined,
	FileTextOutlined,
	MessageOutlined,
	SendOutlined,
} from "@ant-design/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	PvAlert,
	PvAvatar,
	PvButton,
	PvEmpty,
	PvField,
	PvIconButton,
	PvPopover,
	PvSegmented,
	PvSpin,
	PvTag,
	PvTextarea,
	pvMessage,
} from "@/ui";
import {
	useDraftPigeonReply,
	useMarkPigeonHandled,
	useMarkPigeonRead,
	usePigeonConversation,
	usePigeonItems,
	usePigeonSummary,
	useSendPigeonMessage,
	useSetPigeonConversationSwitches,
} from "../../../queries";
import useChatDockStore from "../../../store/chatDockStore";
import { formatDate, formatTime } from "../../../utils/dateTime";
import {
	ALERT_HINT,
	ALERT_OPTIONS,
	bodyText,
	channelLabel,
	channelTone,
	errorText,
	initials,
	mediaLabels,
	POLICY_OPTIONS,
	senderLabel,
	withInherit,
} from "./inboxText";
import PigeonCards from "./PigeonCards";

// A chat's messages and Pigeon's news, oldest first, with a day line whenever
// the day changes.
function useTimeline(data) {
	return useMemo(() => {
		const rows = [
			...(data?.items ?? []).map((i) => ({ type: "item", at: i.at, item: i })),
			...(data?.news ?? []).map((n) => ({ type: "news", at: n.at, news: n })),
		].sort((a, b) => new Date(a.at) - new Date(b.at));
		const out = [];
		let day = null;
		for (const r of rows) {
			const d = formatDate(r.at);
			if (d !== day) {
				out.push({ type: "day", key: `day-${d}`, label: d });
				day = d;
			}
			out.push({
				...r,
				key: r.type === "item" ? r.item.id : `news-${r.news.id}`,
			});
		}
		return out;
	}, [data]);
}

// `group`: more than one person writes here, so each message says who
function Message({ item, group, senders }) {
	const out = item.direction === "out";
	const media = mediaLabels(item.media);
	const body = bodyText(item.body, item.media);
	const sender = group && !out ? senderLabel(item, senders) : null;
	return (
		<div
			className={`inbox-msg ${out ? "is-out" : "is-in"}${item.author === "pigeon" ? " is-pigeon" : ""}`}
		>
			<div className="inbox-bubble">
				{sender ? <div className="inbox-msg-sender">{sender}</div> : null}
				{item.subject ? (
					<div className="inbox-msg-subject">{item.subject}</div>
				) : null}
				{media.length ? (
					<div className="inbox-msg-media">
						{media.map((m, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a message's attachments never reorder
							<PvTag key={i}>{m}</PvTag>
						))}
					</div>
				) : null}
				{body ? <div className="inbox-msg-body">{body}</div> : null}
				<div className="inbox-msg-meta">
					{item.author === "pigeon" ? <span>🕊 Pigeon · </span> : null}
					{formatTime(item.at)}
				</div>
			</div>
		</div>
	);
}

// The chat's own switches: may Pigeon reply here, and how it rings.
function Switches({ id, switches }) {
	const set = useSetPigeonConversationSwitches();
	const save = (patch) =>
		set.mutate(
			{ id, ...patch },
			{ onError: (e) => pvMessage.error(errorText(e)) },
		);
	const reply = switches.reply_own ?? "inherit";
	const alerts = switches.alerts_own ?? "inherit";
	return (
		<div className="inbox-switches">
			<PvField
				label="Pigeon's replies here"
				as="div"
				hint={
					reply === "auto" && !switches.auto_enabled
						? "Auto is switched off in the Inbox's settings: it asks instead."
						: undefined
				}
			>
				<PvSegmented
					size="sm"
					options={withInherit(POLICY_OPTIONS, switches.reply)}
					value={reply}
					onChange={(v) => save({ reply: v })}
				/>
			</PvField>
			<PvField
				label="Alerts"
				as="div"
				hint={ALERT_HINT[alerts === "inherit" ? switches.alerts : alerts]}
			>
				<PvSegmented
					size="sm"
					options={withInherit(ALERT_OPTIONS, switches.alerts)}
					value={alerts}
					onChange={(v) => save({ alerts: v })}
				/>
			</PvField>
		</div>
	);
}

export default function ChatView({ id }) {
	const { data, isLoading, error } = usePigeonConversation(id);
	const items = usePigeonItems(id);
	const timeline = useTimeline(items.data);
	const senders = items.data?.senders;
	const group = useMemo(
		() =>
			new Set(
				(items.data?.items ?? [])
					.filter((i) => i.direction === "in" && i.sender)
					.map((i) => i.sender),
			).size > 1,
		[items.data],
	);
	const markRead = useMarkPigeonRead();
	const handled = useMarkPigeonHandled();
	const send = useSendPigeonMessage();
	const draft = useDraftPigeonReply();
	const askPiuma = useChatDockStore((s) => s.askPiuma);

	const [text, setText] = useState("");
	const [showSummary, setShowSummary] = useState(false);
	const [switchesOpen, setSwitchesOpen] = useState(false);
	const switchesRef = useRef(null);
	const scrollRef = useRef(null);
	const stickRef = useRef(true);
	const summary = usePigeonSummary(id, showSummary);

	const conv = data?.conversation;
	const unread =
		conv?.last_in_at &&
		(!conv.read_at || new Date(conv.last_in_at) > new Date(conv.read_at));

	// Opening the chat reads what came in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per new message in, not per mutation object
	useEffect(() => {
		if (id && unread) markRead.mutate(id);
	}, [id, unread]);

	// A new chat starts with an empty composer, at the bottom.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chat changes
	useEffect(() => {
		setText("");
		setShowSummary(false);
		stickRef.current = true;
	}, [id]);

	// Stay at the bottom as messages come in, unless the user scrolled up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when messages or cards change
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) el.scrollTop = el.scrollHeight;
	}, [timeline, data?.cards]);

	const onScroll = (e) => {
		const el = e.currentTarget;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	};

	if (isLoading) return <PvSpin block label="loading…" />;
	if (error || !conv)
		return (
			<div className="inbox-blank">
				<PvEmpty
					description={error ? errorText(error) : "This chat is gone."}
				/>
			</div>
		);

	const onSend = () => {
		const t = text.trim();
		if (!t) return;
		stickRef.current = true;
		send.mutate(
			{ id, text: t },
			{
				onSuccess: () => setText(""),
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);
	};

	const onDraft = () => {
		stickRef.current = true;
		draft.mutate(
			{ id, instructions: text.trim() },
			{
				onSuccess: () => {
					setText("");
					pvMessage.success("Pigeon wrote a draft");
				},
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);
	};

	const needsYou = conv.attention || conv.needs_note;

	return (
		<section className="inbox-chat">
			<header className="inbox-chat-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<PvAvatar size={36} tone={channelTone(conv.connector)}>
					{initials(data.with)}
				</PvAvatar>
				<div className="inbox-chat-who">
					<div className="inbox-chat-name">{data.with}</div>
					<div className="inbox-chat-sub">
						{channelLabel(conv.connector)}
						{data.contact?.slug ? ` · @${data.contact.slug}` : ""}
						{data.contact?.relationship
							? ` · ${data.contact.relationship}`
							: ""}
						{data.contact?.note_id ? (
							<>
								{" · "}
								<Link to={`/notes/${data.contact.note_id}`}>note</Link>
							</>
						) : null}
					</div>
				</div>
				<div className="inbox-chat-tools">
					{needsYou ? (
						<PvIconButton
							icon={<CheckOutlined />}
							label="Handled: nothing more to do"
							onClick={() =>
								handled.mutate(id, {
									onError: (e) => pvMessage.error(errorText(e)),
								})
							}
						/>
					) : null}
					<PvIconButton
						icon={<FileTextOutlined />}
						label="What it's about"
						active={showSummary}
						onClick={() => setShowSummary((s) => !s)}
					/>
					<span ref={switchesRef}>
						<PvIconButton
							icon={<ControlOutlined />}
							label="This chat's switches"
							active={switchesOpen}
							onClick={() => setSwitchesOpen((o) => !o)}
						/>
					</span>
					<PvButton
						size="sm"
						variant="accent"
						icon={<MessageOutlined />}
						onClick={() => askPiuma({ id, title: data.with })}
						title="Open Piuma with this chat attached"
					>
						Ask Piuma
					</PvButton>
				</div>
				<PvPopover
					open={switchesOpen}
					anchorRef={switchesRef}
					onClose={() => setSwitchesOpen(false)}
					align="end"
					width={360}
					title="This chat"
				>
					<Switches id={id} switches={data.switches} />
				</PvPopover>
			</header>

			{showSummary ? (
				<div className="inbox-summary">
					{summary.isLoading ? (
						<PvSpin label="Pigeon is reading the chat…" />
					) : summary.error ? (
						errorText(summary.error)
					) : (
						summary.data?.summary || "Nothing to say yet."
					)}
				</div>
			) : null}

			<div className="inbox-msgs" ref={scrollRef} onScroll={onScroll}>
				{items.hasNextPage ? (
					<div className="inbox-older">
						<PvButton
							size="sm"
							variant="ghost"
							loading={items.isFetchingNextPage}
							onClick={() => {
								stickRef.current = false;
								items.fetchNextPage();
							}}
						>
							Older messages
						</PvButton>
					</div>
				) : null}
				{items.isLoading ? <PvSpin block /> : null}
				{timeline.map((r) =>
					r.type === "day" ? (
						<div key={r.key} className="inbox-day">
							<span>{r.label}</span>
						</div>
					) : r.type === "news" ? (
						<div key={r.key} className="inbox-news">
							{r.news.url ? (
								<a href={r.news.url} target="_blank" rel="noreferrer">
									{r.news.text}
								</a>
							) : (
								r.news.text
							)}
						</div>
					) : (
						<Message
							key={r.key}
							item={r.item}
							group={group}
							senders={senders}
						/>
					),
				)}
				<PigeonCards cards={data.cards} conversationId={id} />
			</div>

			{conv.window_until && new Date(conv.window_until) < new Date() ? (
				<PvAlert type="warning" title="The reply window is closed">
					{channelLabel(conv.connector)} only takes a reply within its window
					after their last message.
				</PvAlert>
			) : null}

			<footer className="inbox-composer">
				<PvTextarea
					autoSize
					maxHeight={200}
					rows={1}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							onSend();
						}
					}}
					placeholder={`Write to ${data.with}… (or tell Pigeon what to say, then ✍)`}
					aria-label="Your message"
				/>
				<PvIconButton
					icon={<EditOutlined />}
					label={
						text.trim()
							? "Pigeon drafts it, following what you wrote"
							: "Pigeon drafts a reply"
					}
					disabled={draft.isPending}
					onClick={onDraft}
				/>
				<PvIconButton
					variant="accent"
					icon={<SendOutlined />}
					label="Send, as you"
					disabled={!text.trim() || send.isPending}
					onClick={onSend}
				/>
			</footer>
			{draft.isPending ? (
				<div className="inbox-writing">🕊 Pigeon is writing…</div>
			) : null}
		</section>
	);
}
