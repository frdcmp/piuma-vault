import {
	ArrowLeftOutlined,
	CheckOutlined,
	ControlOutlined,
	EditOutlined,
	FileTextOutlined,
	MessageOutlined,
	PaperClipOutlined,
	PauseOutlined,
	PlayCircleOutlined,
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
	PvPopover,
	PvSegmented,
	PvSpin,
	PvTag,
	PvTextarea,
	PvUpload,
	pvMessage,
} from "@/ui";
import {
	useComposePigeonReply,
	useMarkPigeonHandled,
	useMarkPigeonPersonHandled,
	useMarkPigeonPersonRead,
	useMarkPigeonRead,
	usePigeonConversation,
	usePigeonItems,
	usePigeonPersonChat,
	usePigeonPersonItems,
	usePigeonSummary,
	useResumePigeonAuto,
	useResumePigeonPersonAuto,
	useSendPigeonFile,
	useSendPigeonMessage,
	useSetPigeonContactSwitches,
	useSetPigeonConversationSwitches,
} from "../../../queries";
import useChatDockStore from "../../../store/chatDockStore";
import { formatDate, formatTime } from "../../../utils/dateTime";
import EmailActions from "./EmailActions";
import EmailFrame from "./EmailFrame";
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
	mediaLinks,
	mediaWords,
	POLICY_OPTIONS,
	reactionGroups,
	senderLabel,
	tagParts,
	withInherit,
} from "./inboxText";
import { arrived, localItem, outboxEntry } from "./outbox";
import PigeonCards from "./PigeonCards";
import SentBy from "./SentBy";
import SwitchInfo from "./SwitchInfo";
import { senderColor } from "./senderColor";
import Used from "./Used";
import Working from "./Working";

// What the channels take in one file (the vault's limit too).
const MAX_SEND_BYTES = 95 * 1024 * 1024;

// Auto replies in a chat's bar, as on the phone: the word is their state, the
// icon what a click does.
//   AUTO ⏸   they answer here; pauses them (the chat's replies to ask)
//   PAUSED ▶ you paused them; puts auto back
//   11:25 ▶  paused a while because you wrote here (`until`); back now
function AutoPill({ until, off, onPause, onPlay, onResume, busy }) {
	const [, tick] = useState(0);
	// the timed pause ends without a refetch
	useEffect(() => {
		const left = until ? new Date(until) - Date.now() : 0;
		if (left <= 0) return;
		const t = setTimeout(() => tick((n) => n + 1), left + 500);
		return () => clearTimeout(t);
	}, [until]);
	const timed = !off && !!until && new Date(until) > Date.now();
	const view = off
		? {
				tone: "is-paused",
				icon: <PlayCircleOutlined />,
				word: "PAUSED",
				label: "Auto replies paused by you: turn them back on",
				onClick: onPlay,
			}
		: timed
			? {
					tone: "is-timed",
					icon: <PlayCircleOutlined />,
					word: formatTime(until),
					label: `Auto replies paused until ${formatTime(until)} because you wrote here: resume them now`,
					onClick: onResume,
				}
			: {
					tone: "is-auto",
					icon: <PauseOutlined />,
					word: "AUTO",
					label: "Auto replies on: pause them",
					onClick: onPause,
				};
	return (
		<PvButton
			size="sm"
			className={`inbox-auto ${view.tone}`}
			icon={view.icon}
			loading={busy}
			title={view.label}
			aria-label={view.label}
			onClick={view.onClick}
		>
			{view.word}
		</PvButton>
	);
}

// A chat's messages and Pigeon's news, oldest first, with a day line whenever
// the day changes; the first message of a run has the tail. `outbox`: what's
// being sent (./outbox), in the chat at once, each until its message comes
// from the vault.
function useTimeline(data, outbox) {
	return useMemo(() => {
		const items = [
			...(data?.items ?? []),
			...outbox.filter((e) => !arrived(e, data?.items)).map(localItem),
		];
		const rows = [
			...items.map((i) => ({ type: "item", at: i.at, item: i })),
			...(data?.news ?? []).map((n) => ({ type: "news", at: n.at, news: n })),
		].sort((a, b) => new Date(a.at) - new Date(b.at));
		const out = [];
		let day = null;
		let prev = null;
		for (const r of rows) {
			const d = formatDate(r.at);
			if (d !== day) {
				out.push({ type: "day", key: `day-${d}`, label: d });
				day = d;
				prev = null;
			}
			const tail =
				r.type === "item" &&
				(prev?.type !== "item" ||
					prev.item.direction !== r.item.direction ||
					prev.item.sender !== r.item.sender);
			out.push({
				...r,
				tail,
				key: r.type === "item" ? r.item.id : `news-${r.news.id}`,
			});
			prev = r;
		}
		return out;
	}, [data, outbox]);
}

// A file on its way, in its bubble: a photo or video's picture, a file's
// name, and how much of it has gone up.
function Outgoing({ entry }) {
	const { file, preview, progress } = entry;
	return (
		<div className="inbox-outgoing">
			{preview ? (
				file.type.startsWith("video/") ? (
					<video src={preview} className="inbox-media-video" muted />
				) : (
					<img src={preview} alt={file.name} className="inbox-media-img" />
				)
			) : (
				<span className="inbox-media-file">
					<PaperClipOutlined /> {file.name}
				</span>
			)}
			{progress != null && progress < 1 ? (
				<div className="inbox-progress">
					<div style={{ width: `${Math.round(progress * 100)}%` }} />
				</div>
			) : null}
		</div>
	);
}

// A message's words: who it tags stands out, and opens the person when Pigeon
// knows them (you, and a number it doesn't, don't).
function Words({ text, mentions, senders }) {
	const parts = tagParts(text, mentions);
	if (!parts.some((p) => p.mention)) return text;
	return parts.map((p) => {
		if (!p.mention) return p.text;
		const person = p.mention.me ? null : senders?.[p.mention.phone]?.id;
		return person ? (
			<Link key={p.at} className="inbox-mention" to={`/inbox/p/${person}`}>
				{p.text}
			</Link>
		) : (
			<span
				key={p.at}
				className="inbox-mention"
				title={p.mention.phone || undefined}
			>
				{p.text}
			</span>
		);
	});
}

// `group`: more than one person writes here, so each message says who.
// `email`: it's an email, shown as it was sent.
// `channel`: where it came, when a person's chat mixes channels.
// `connector`: its channel's id.
// `tail`: the first of a run. `item.local`: it's on its way (./outbox): faded
// with one tick (two once the vault has it: SentBy); not sent, framed red,
// `onRetry` on a click.
function Message({
	item,
	group,
	senders,
	email,
	channel,
	connector,
	tail,
	onRetry,
}) {
	const out = item.direction === "out";
	const local = item.local;
	const failed = local?.status === "failed";
	const media = mediaWords(item.media);
	const files = mediaFiles(item.media);
	const links = mediaLinks(item.media);
	const words = bodyText(item.body, item.media);
	const body = words ? (
		<div className="inbox-msg-body">
			<Words text={words} mentions={item.mentions} senders={senders} />
		</div>
	) : null;
	const sender = group && !out ? senderLabel(item, senders) : null;
	const reactions = reactionGroups(item.reactions, senders);
	return (
		<div
			className={[
				"inbox-msg",
				out ? "is-out" : "is-in",
				item.author === "pigeon" && "is-pigeon",
				tail && "has-tail",
				local && !failed && "is-sending",
				failed && "is-failed",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<div className={`inbox-bubble${email ? " is-email" : ""}`}>
				{sender ? (
					<div
						className="inbox-msg-sender"
						style={{ "--sender": senderColor(item.sender || sender) }}
					>
						{sender}
					</div>
				) : null}
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
				{links.map((l) => (
					<a
						key={l.url}
						className="inbox-shared"
						href={l.url}
						target="_blank"
						rel="noreferrer"
					>
						<span className="inbox-shared-name">▶ {l.name} ↗</span>
						{l.title ? (
							<span className="inbox-shared-title">{l.title}</span>
						) : null}
					</a>
				))}
				{local?.file ? (
					<Outgoing entry={local} />
				) : (
					<InboxMedia item={item.id} files={files} />
				)}
				{email && !local ? <EmailFrame id={item.id} fallback={body} /> : body}
				{email && !local ? <EmailActions item={item} /> : null}
				<div className="inbox-msg-meta">
					{channel ? (
						<span className="inbox-msg-channel">{channel} · </span>
					) : null}
					{local ? (
						failed ? null : (
							<CheckOutlined
								className="inbox-sent-by"
								aria-label="On its way"
							/>
						)
					) : (
						<SentBy item={item} connector={connector} />
					)}
					{formatTime(item.at)}
				</div>
				{out && !local ? <Used item={item} /> : null}
				{failed ? (
					<PvButton
						size="sm"
						variant="text"
						className="inbox-retry"
						title={local.error ?? undefined}
						onClick={onRetry}
					>
						Not sent · send it again
					</PvButton>
				) : null}
			</div>
			{reactions.length ? (
				<div className="inbox-reactions">
					{reactions.map((r) => (
						<span
							key={r.emoji}
							className="inbox-reaction"
							title={r.who.join(", ")}
						>
							{r.emoji}
							{r.count > 1 ? <small>{r.count}</small> : null}
						</span>
					))}
				</div>
			) : null}
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
	// what's being sent (./outbox), and the files picked for the next send
	const [outbox, setOutbox] = useState([]);
	const [toSend, setToSend] = useState([]);
	const timeline = useTimeline(items.data, outbox);
	const senders = items.data?.senders;
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
	const sendFile = useSendPigeonFile();
	const resume = useResumePigeonAuto();
	const personResume = useResumePigeonPersonAuto();
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
		setToSend([]);
		setOutbox([]);
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
	const patchOut = (key, p) =>
		setOutbox((o) => o.map((e) => (e.key === key ? { ...e, ...p } : e)));
	// one entry goes: its text, or its file with the text as the caption; it
	// stays in the chat until its message comes from the vault
	const deliver = async (entry) => {
		patchOut(entry.key, { status: "sending", progress: 0, error: null });
		try {
			if (entry.file)
				await sendFile.mutateAsync({
					id: entry.thread,
					file: entry.file,
					caption: entry.text,
					onProgress: (p) => patchOut(entry.key, { progress: p }),
				});
			else await send.mutateAsync({ id: entry.thread, text: entry.text });
			// it shows until its message comes (above); a message the vault words
			// differently isn't kept doubled past a while
			setTimeout(
				() => setOutbox((o) => o.filter((e) => e.key !== entry.key)),
				20 * 1000,
			);
		} catch (e) {
			patchOut(entry.key, { status: "failed", error: errorText(e) });
		}
	};
	// the box empties at once; files go one after the other (a video takes a
	// while), the text as the first one's caption
	const onSend = () => {
		const t = text.trim();
		if ((!t && !toSend.length) || !tid) return;
		stickRef.current = true;
		const entries = toSend.length
			? toSend.map((file, i) =>
					outboxEntry({
						thread: tid,
						connector: replyOn,
						file,
						text: i === 0 ? t : "",
					}),
				)
			: [outboxEntry({ thread: tid, connector: replyOn, text: t })];
		setText("");
		setToSend([]);
		setOutbox((o) => [...o, ...entries]);
		(async () => {
			for (const e of entries) await deliver(e);
		})();
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

	// Photos, videos and files picked: over the box until Send (a click there
	// takes one off).
	const onFiles = (files) => {
		const big = files.filter((f) => f.size > MAX_SEND_BYTES);
		if (big.length)
			pvMessage.error(
				`${big.map((f) => f.name).join(", ")}: over ${MAX_SEND_BYTES >> 20} MB`,
			);
		setToSend((p) => [...p, ...files.filter((f) => !big.includes(f))]);
	};

	const sw = data.switches ?? {};
	// auto replies answer this chat (the pill shows them, paused or on)
	const autoOn = (sw.reply_own ?? sw.reply) === "auto" && sw.auto_enabled;
	// paused from the pill: this chat's replies set to ask
	const pausedByMe = sw.reply_own === "ask" && sw.auto_enabled;
	const setSwitch = (patch) =>
		person
			? setPersonSwitches.mutate({ id: person, ...patch }, { onError: fail })
			: setThreadSwitches.mutate({ id, ...patch }, { onError: fail });
	const onResume = () =>
		(person ? personResume : resume).mutate(person ?? id, {
			onSuccess: () => pvMessage.success("Auto replies are back"),
			onError: fail,
		});

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
				{data.avatar_photo ? (
					<a
						href={data.avatar_photo}
						target="_blank"
						rel="noreferrer"
						title="Their photo"
					>
						<PvAvatar size={36} src={data.avatar} className="inbox-avatar" />
					</a>
				) : (
					<PvAvatar size={36} tone={channelTone(thread?.connector)}>
						{initials(realName || data.with)}
					</PvAvatar>
				)}
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
					{autoOn || pausedByMe ? (
						<AutoPill
							until={sw.auto_paused_until}
							off={pausedByMe}
							onPause={() => setSwitch({ reply: "ask" })}
							onPlay={() => setSwitch({ reply: "auto" })}
							onResume={onResume}
							busy={
								resume.isPending ||
								personResume.isPending ||
								setThreadSwitches.isPending ||
								setPersonSwitches.isPending
							}
						/>
					) : null}
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
						onSave={setSwitch}
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
							connector={r.item.connector ?? conv.connector}
							email={(r.item.connector ?? conv.connector) === "gmail"}
							tail={r.tail}
							onRetry={r.item.local ? () => deliver(r.item.local) : undefined}
						/>
					),
				)}
				<PigeonCards cards={data.cards} conversationId={tid} />
				<Working
					threads={threads.map((t) => t.id)}
					seed={data.working}
					on={autoOn}
				/>
			</div>

			{thread?.window_until && new Date(thread.window_until) < new Date() ? (
				<PvAlert type="warning" title="The reply window is closed">
					{channelLabel(thread.connector)} only takes a reply within its window
					after their last message.
				</PvAlert>
			) : null}

			{toSend.length ? (
				<div className="inbox-picked">
					{toSend.map((f, i) => (
						<PvTag
							// biome-ignore lint/suspicious/noArrayIndexKey: the picked list only grows or loses one
							key={`${f.name}-${i}`}
							onRemove={() => setToSend((p) => p.filter((_, j) => j !== i))}
						>
							<PaperClipOutlined /> {f.name}
						</PvTag>
					))}
				</div>
			) : null}
			<footer className="inbox-composer">
				<PvTextarea
					autoSize
					maxHeight={200}
					rows={1}
					className="inbox-composer-text"
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
				<PvUpload multiple onFiles={onFiles}>
					<PvIconButton
						icon={<PaperClipOutlined />}
						label="Photos, videos or files (what you type is the caption)"
					/>
				</PvUpload>
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
					disabled={!text.trim() && !toSend.length}
					onClick={onSend}
				/>
			</footer>
			{draft.isPending ? (
				<div className="inbox-writing">🕊 Pigeon is writing…</div>
			) : null}
		</section>
	);
}
