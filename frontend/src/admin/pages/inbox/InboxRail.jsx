import {
	ApartmentOutlined,
	SearchOutlined,
	SettingOutlined,
	TeamOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PvAvatar, PvIconButton, PvInput, PvSegmented, PvSpin } from "@/ui";
import { usePigeonChats, usePigeonGeneral } from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import { channelLabel, channelTone, initials } from "./inboxText";

const FILTERS = [
	{ value: "all", label: "All" },
	{ value: "needs", label: "Needs you" },
];

const CHANNELS = [
	{ value: "", label: "Every channel" },
	{ value: "whatsapp", label: "WhatsApp" },
	{ value: "instagram", label: "Instagram" },
	{ value: "gmail", label: "Gmail" },
];

// Where a chat opens: a person's (all their channels), else the group's own.
export const chatPath = (c) =>
	c.contact_id
		? `/inbox/p/${c.contact_id}`
		: `/inbox/${c.conversation_id ?? c.latest}`;

// The chat list: General (what isn't about one chat) on top, then a chat per
// person (all their channels in one) and per group, latest first, more loading
// as it scrolls. Search by @slug, name or title; narrow to a channel.
export default function InboxRail({ activeKey, page }) {
	const [raw, setRaw] = useState("");
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState("all");
	const [channel, setChannel] = useState("");

	useEffect(() => {
		const t = setTimeout(() => setQ(raw.trim()), 220);
		return () => clearTimeout(t);
	}, [raw]);

	const params = {
		...(filter === "needs" ? { filter: "needs" } : {}),
		...(channel ? { connector: channel } : {}),
		...(q ? { q } : {}),
	};
	const {
		data: chats = [],
		isLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = usePigeonChats(params);
	const { data: general } = usePigeonGeneral();
	const generalCards = general?.cards?.length ?? 0;

	const onScroll = useCallback(
		(e) => {
			if (!hasNextPage || isFetchingNextPage) return;
			const el = e.currentTarget;
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 240)
				fetchNextPage();
		},
		[hasNextPage, isFetchingNextPage, fetchNextPage],
	);

	return (
		<aside className="inbox-side">
			<div className="inbox-side-head">
				<Link to="/inbox" className="inbox-brand">
					<span className="inbox-brand-dot" />
					inbox
				</Link>
				<PvIconButton
					to="/inbox/people"
					icon={<TeamOutlined />}
					label="People"
					active={page === "people"}
				/>
				<PvIconButton
					to="/inbox/rules"
					icon={<ApartmentOutlined />}
					label="Rules"
					active={page === "rules"}
				/>
				<PvIconButton
					to="/inbox/settings"
					icon={<SettingOutlined />}
					label="Settings"
					active={page === "settings"}
				/>
			</div>

			<div className="inbox-side-tools">
				<PvInput
					size="sm"
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					placeholder="Search chats or @someone…"
					aria-label="Search chats"
					prefix={<SearchOutlined />}
					suffix={
						raw ? (
							<PvIconButton
								variant="ghost-danger"
								size="sm"
								icon="×"
								label="Clear search"
								onClick={() => setRaw("")}
							/>
						) : null
					}
				/>
				<PvSegmented
					size="sm"
					block
					options={FILTERS}
					value={filter}
					onChange={setFilter}
				/>
				<PvSegmented
					size="sm"
					block
					options={CHANNELS}
					value={channel}
					onChange={setChannel}
				/>
			</div>

			<div className="inbox-list" onScroll={onScroll}>
				<Link
					to="/inbox/general"
					className={`inbox-row${page === "general" ? " is-active" : ""}`}
				>
					<PvAvatar size={36} tone="accent">
						🕊
					</PvAvatar>
					<span className="inbox-row-main">
						<span className="inbox-row-top">
							<span className="inbox-row-name">General</span>
						</span>
						<span className="inbox-row-preview">
							New emails, confirmations, Pigeon's news
						</span>
					</span>
					{generalCards ? (
						<span className="inbox-badge">{generalCards}</span>
					) : null}
				</Link>

				{isLoading ? (
					<PvSpin block label="loading…" />
				) : chats.length === 0 ? (
					<div className="inbox-list-empty">
						{q
							? "No chats match."
							: filter === "needs"
								? "Nothing needs you."
								: "No chats yet: connect a channel in Settings."}
					</div>
				) : (
					chats.map((c) => (
						<Link
							key={c.key}
							to={chatPath(c)}
							className={`inbox-row${c.key === activeKey ? " is-active" : ""}${
								c.unread ? " is-unread" : ""
							}`}
						>
							<PvAvatar size={36} tone={channelTone(c.connector)}>
								{initials(c.name || c.with)}
							</PvAvatar>
							<span className="inbox-row-main">
								<span className="inbox-row-top">
									<span className="inbox-row-name">
										{c.with}
										{c.slug && c.name ? (
											<span className="inbox-row-realname"> {c.name}</span>
										) : null}
									</span>
									<span className="inbox-row-time">
										{timeAgo(c.last_item_at)}
									</span>
								</span>
								<span className="inbox-row-preview">
									<span className="inbox-row-channel">
										{(c.connectors?.length > 1 ? c.connectors : [c.connector])
											.map(channelLabel)
											.join(" · ")}
									</span>
									{c.last_author === "me"
										? "You: "
										: c.last_author === "pigeon"
											? "🕊 "
											: ""}
									{c.preview}
								</span>
							</span>
							{c.cards ? (
								<span
									className={`inbox-badge${c.attention ? " is-hot" : ""}`}
									title={
										c.attention ? `Needs you: ${c.attention}` : "Cards waiting"
									}
								>
									{c.cards}
								</span>
							) : c.unread ? (
								<span className="inbox-dot" role="img" aria-label="Unread" />
							) : null}
						</Link>
					))
				)}
				{isFetchingNextPage ? <PvSpin block /> : null}
			</div>
		</aside>
	);
}
