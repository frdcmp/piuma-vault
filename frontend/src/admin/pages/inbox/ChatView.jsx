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
import { Link, useNavigate } from "react-router-dom";
import {
	PvAlert,
	PvAvatar,
	PvButton,
	PvEmpty,
	PvField,
	PvIconButton,
	PvModal,
	PvPopover,
	PvSegmented,
	PvSpin,
	PvTag,
	PvTextarea,
	pvMessage,
} from "@/ui";
import {
	useComposePigeonReply,
	useMarkPigeonHandled,
	useMarkPigeonPersonHandled,
	useMarkPigeonPersonRead,
	useMarkPigeonRead,
	usePigeonConversation,
	usePigeonItemHtml,
	usePigeonItems,
	usePigeonPersonChat,
	usePigeonPersonItems,
	usePigeonSummary,
	useSendPigeonMessage,
	useSetPigeonContactSwitches,
	useSetPigeonConversationSwitches,
} from "../../../queries";
import useChatDockStore from "../../../store/chatDockStore";
import { formatDate, formatTime } from "../../../utils/dateTime";
import InboxMedia from "./InboxMedia";
import {
	ALERT_HINT,
	ALERT_OPTIONS,
	bodyText,
	channelLabel,
	channelTone,
	errorText,
	initials,
	mediaFiles,
	mediaWords,
	POLICY_OPTIONS,
	senderLabel,
	withInherit,
} from "./inboxText";
import PigeonCards from "./PigeonCards";
import SwitchInfo from "./SwitchInfo";

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

// An email as it was sent, in a frame of its own: no scripts run, links open in a new tab.
function EmailView({ id, onClose }) {
	const { data, isLoading, error } = usePigeonItemHtml(id);
	const doc = data?.html
		? `<base target="_blank"><meta name="referrer" content="no-referrer">${data.html}`
		: null;
	return (
		<PvModal
			open={!!id}
			title="The email"
			onCancel={onClose}
			footer={null}
			showClose
			width={780}
		>
			{error ? (
				<PvAlert type="error" title="Couldn't fetch the email">
					{errorText(error)}
				</PvAlert>
			) : isLoading ? (
				<PvSpin block label="Fetching it from Gmail…" />
			) : doc ? (
				<iframe
					className="inbox-email-frame"
					title="The email"
					sandbox="allow-popups allow-popups-to-escape-sandbox"
					srcDoc={doc}
				/>
			) : (
				<PvEmpty description="This email is plain text: it's all in the chat." />
			)}
		</PvModal>
	);
}

// An email's text in a chat: its start, the rest behind "View email".
const EMAIL_CLIP = 700;

// `group`: more than one person writes here, so each message says who.
// `onOpen`: an email's, opens it as it was sent (its text is clipped here).
// `channel`: where it came, when a person's chat mixes channels.
function Message({ item, group, senders, onOpen, channel }) {
	const out = item.direction === "out";
	const media = mediaWords(item.media);
	const files = mediaFiles(item.media);
	const full = bodyText(item.body, item.media);
	const body =
		onOpen && full && full.length > EMAIL_CLIP
			? `${full.slice(0, EMAIL_CLIP).trimEnd()}…`
			: full;
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
				<InboxMedia item={item.id} files={files} />
				{body ? <div className="inbox-msg-body">{body}</div> : null}
				<div className="inbox-msg-meta">
					{onOpen ? (
						<button
							type="button"
							className="inbox-msg-open"
							onClick={() => onOpen(item.id)}
						>
							View email
						</button>
					) : null}
					{channel ? (
						<span className="inbox-msg-channel">{channel} · </span>
					) : null}
					{item.author === "pigeon" ? <span>🕊 Pigeon · </span> : null}
					{formatTime(item.at)}
				</div>
			</div>
		</div>
	);
}

// The switches: may Pigeon reply here, and how it rings. A person's are theirs
// on every channel; a group's its own.
function Switches({ switches, onSave, scope }) {
	const reply = switches.reply_own ?? "inherit";
	const alerts = switches.alerts_own ?? "inherit";
	return (
		<div className="inbox-switches">
			<PvField
				label={
					<>
						Pigeon's replies {scope}
						<SwitchInfo kind="reply" />
					</>
				}
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
					onChange={(v) => onSave({ reply: v })}
				/>
			</PvField>
			<PvField
				label={
					<>
						Alerts
						<SwitchInfo kind="alerts" />
					</>
				}
				as="div"
				hint={ALERT_HINT[alerts === "inherit" ? switches.alerts : alerts]}
			>
				<PvSegmented
					size="sm"
					options={withInherit(ALERT_OPTIONS, switches.alerts)}
					value={alerts}
					onChange={(v) => onSave({ alerts: v })}
				/>
			</PvField>
		</div>
	);
}

const unique = (xs) => [...new Set(xs)];

// A chat: a person's (`person`: all their threads, every channel, as one) or a
// thread's of its own (`id`: a group). A thread that is a person's opens their
// chat instead.
export default function ChatView({ id, person }) {
	const navigate = useNavigate();
	const threadChat = usePigeonConversation(person ? null : id);
	const personChat = usePigeonPersonChat(person);
	const { data, isLoading, error } = person ? personChat : threadChat;
	const [channel, setChannel] = useState("");
	const threadItems = usePigeonItems(person ? null : id);
	const personItems = usePigeonPersonItems(person, channel);
	const items = person ? personItems : threadItems;
	const timeline = useTimeline(items.data);
	const senders = items.data?.senders;
	const [email, setEmail] = useState(null);
	const group = useMemo(
		() =>
			!person &&
			new Set(
				(items.data?.items ?? [])
					.filter((i) => i.direction === "in" && i.sender)
					.map((i) => i.sender),
			).size > 1,
		[items.data, person],
	);
	const markRead = useMarkPigeonRead();
	const markPersonRead = useMarkPigeonPersonRead();
	const handled = useMarkPigeonHandled();
	const personHandled = useMarkPigeonPersonHandled();
	const setThreadSwitches = useSetPigeonConversationSwitches();
	const setPersonSwitches = useSetPigeonContactSwitches();
	const send = useSendPigeonMessage();
	const draft = useComposePigeonReply();
	const askPiuma = useChatDockStore((s) => s.askPiuma);

	const [text, setText] = useState("");
	const [showSummary, setShowSummary] = useState(false);
	const [switchesOpen, setSwitchesOpen] = useState(false);
	const switchesRef = useRef(null);
	const scrollRef = useRef(null);
	const stickRef = useRef(true);

	const conv = data?.conversation;
	const threads = person ? (data?.threads ?? []) : conv ? [conv] : [];
	const channels = unique(threads.map((t) => t.connector));
	// where a reply goes: the channel of the last message shown (the chips on
	// top narrow it to one)
	const replyOn =
		channel ||
		items.data?.items?.at(-1)?.connector ||
		conv?.connector ||
		channels[0];
	const thread = threads.find((t) => t.connector === replyOn) ?? conv;
	const tid = thread?.id;
	const summary = usePigeonSummary(tid, showSummary);
	const unread = person
		? data?.unread
		: conv?.last_in_at &&
			(!conv.read_at || new Date(conv.last_in_at) > new Date(conv.read_at));

	// A thread that is someone's opens as their chat.
	// biome-ignore lint/correctness/useExhaustiveDependencies: on the thread's person only
	useEffect(() => {
		if (!person && conv?.contact_id)
			navigate(`/inbox/p/${conv.contact_id}`, { replace: true });
	}, [person, conv?.contact_id]);

	// Opening the chat reads what came in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per new message in, not per mutation object
	useEffect(() => {
		if (!unread) return;
		if (person) markPersonRead.mutate(person);
		else if (id) markRead.mutate(id);
	}, [id, person, unread]);

	// A new chat starts with an empty composer, every channel shown, at the bottom.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chat changes
	useEffect(() => {
		setText("");
		setShowSummary(false);
		setChannel("");
		stickRef.current = true;
	}, [id, person]);

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

	const fail = (e) => pvMessage.error(errorText(e));
	const onSend = () => {
		const t = text.trim();
		if (!t || !tid) return;
		stickRef.current = true;
		send.mutate(
			{ id: tid, text: t },
			{ onSuccess: () => setText(""), onError: fail },
		);
	};

	const onDraft = () => {
		if (!tid) return;
		stickRef.current = true;
		// Pigeon writes the reply into the box (what you typed is what it follows);
		// you send it, or change it first.
		draft.mutate(
			{ id: tid, instructions: text.trim() },
			{ onSuccess: (d) => setText(d.text), onError: fail },
		);
	};

	const needsYou = threads.some((t) => t.attention || t.needs_note);
	const mixed = person && channels.length > 1;
	const contact = data.contact;
	const realName = person ? data.name : null;

	return (
		<section className="inbox-chat">
			<header className="inbox-chat-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<PvAvatar size={36} tone={channelTone(thread?.connector)}>
					{initials(realName || data.with)}
				</PvAvatar>
				<div className="inbox-chat-who">
					<div className="inbox-chat-name">{data.with}</div>
					<div className="inbox-chat-sub">
						{realName && realName !== data.with ? `${realName} · ` : ""}
						{channels.map(channelLabel).join(", ")}
						{!person && contact?.slug ? ` · @${contact.slug}` : ""}
						{contact?.relationship ? ` · ${contact.relationship}` : ""}
						{contact?.note_id ? (
							<>
								{" · "}
								<Link to={`/notes/${contact.note_id}`}>note</Link>
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
								person
									? personHandled.mutate(person, { onError: fail })
									: handled.mutate(id, { onError: fail })
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
							label={person ? "Their switches" : "This chat's switches"}
							active={switchesOpen}
							onClick={() => setSwitchesOpen((o) => !o)}
						/>
					</span>
					<PvButton
						size="sm"
						variant="accent"
						icon={<MessageOutlined />}
						onClick={() => askPiuma({ id: tid, title: data.with })}
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
					title={person ? data.with : "This chat"}
				>
					<Switches
						switches={data.switches}
						scope={person ? "to them" : "here"}
						onSave={(patch) =>
							person
								? setPersonSwitches.mutate(
										{ id: person, ...patch },
										{ onError: fail },
									)
								: setThreadSwitches.mutate({ id, ...patch }, { onError: fail })
						}
					/>
				</PvPopover>
			</header>

			{mixed ? (
				<div className="inbox-chat-channels">
					<PvSegmented
						size="sm"
						options={[
							{ value: "", label: "All" },
							...channels.map((c) => ({ value: c, label: channelLabel(c) })),
						]}
						value={channel}
						onChange={(v) => {
							stickRef.current = true;
							setChannel(v);
						}}
					/>
				</div>
			) : null}

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
							channel={
								mixed && !channel
									? channelLabel(r.item.connector ?? conv.connector)
									: null
							}
							onOpen={
								(r.item.connector ?? conv.connector) === "gmail"
									? setEmail
									: undefined
							}
						/>
					),
				)}
				<PigeonCards cards={data.cards} conversationId={tid} />
			</div>
			<EmailView id={email} onClose={() => setEmail(null)} />

			{thread?.window_until && new Date(thread.window_until) < new Date() ? (
				<PvAlert type="warning" title="The reply window is closed">
					{channelLabel(thread.connector)} only takes a reply within its window
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
					placeholder={`Write to ${data.with}${mixed ? ` on ${channelLabel(replyOn)}` : ""}… (or tell Pigeon what to say, then ✍)`}
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
