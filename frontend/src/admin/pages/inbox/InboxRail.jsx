import {
	ApartmentOutlined,
	SearchOutlined,
	SettingOutlined,
	TeamOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PvAvatar, PvIconButton, PvInput, PvSegmented, PvSpin } from "@/ui";
import { usePigeonConversations, usePigeonGeneral } from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import { channelLabel, channelTone, initials } from "./inboxText";

const FILTERS = [
	{ value: "all", label: "All" },
	{ value: "needs", label: "Needs you" },
];

// The chat list: General (what isn't about one chat) on top, then the chats,
// latest first, more loading as it scrolls. Search by name, title or @slug.
export default function InboxRail({ activeId, page }) {
	const [raw, setRaw] = useState("");
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState("all");

	useEffect(() => {
		const t = setTimeout(() => setQ(raw.trim()), 220);
		return () => clearTimeout(t);
	}, [raw]);

	const params = {
		...(filter === "needs" ? { filter: "needs" } : {}),
		...(q ? { q } : {}),
	};
	const {
		data: chats = [],
		isLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = usePigeonConversations(params);
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
							key={c.id}
							to={`/inbox/${c.id}`}
							className={`inbox-row${c.id === activeId ? " is-active" : ""}${
								c.unread ? " is-unread" : ""
							}`}
						>
							<PvAvatar size={36} tone={channelTone(c.connector)}>
								{initials(c.with)}
							</PvAvatar>
							<span className="inbox-row-main">
								<span className="inbox-row-top">
									<span className="inbox-row-name">{c.with}</span>
									<span className="inbox-row-time">
										{timeAgo(c.last_item_at)}
									</span>
								</span>
								<span className="inbox-row-preview">
									<span className="inbox-row-channel">
										{channelLabel(c.connector)}
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
