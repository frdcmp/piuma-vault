import {
	DeleteOutlined,
	HomeOutlined,
	PlusOutlined,
	SearchOutlined,
} from "@ant-design/icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PvButton, PvIconButton, PvInput } from "@/ui";
import { fetchConversations } from "../../api/agentChatApi";
import { timeAgo } from "../../utils/dateTime";
import SpriteRunner from "../components/SpriteRunner";

// How many conversations to fetch per page (backend LIMIT/OFFSET).
const PAGE_SIZE = 25;

// Left rail: new-chat button, a search box that filters by title OR message
// text (server-side `q`), and the conversation list. The list is paginated —
// only the first page loads up front, and more pages lazy-load as the user
// scrolls toward the bottom. Selecting a row lifts its id to the page.
export default function ChatSessionList({
	activeId,
	onSelect,
	onNew,
	onDelete,
}) {
	const [raw, setRaw] = useState("");
	const [q, setQ] = useState("");

	// Debounce the search box so we don't refetch on every keystroke.
	useEffect(() => {
		const t = setTimeout(() => setQ(raw.trim()), 220);
		return () => clearTimeout(t);
	}, [raw]);

	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useInfiniteQuery({
			queryKey: ["agents", "conversations", null, q || ""],
			queryFn: ({ pageParam = 0 }) =>
				fetchConversations(undefined, q || undefined, {
					limit: PAGE_SIZE,
					offset: pageParam,
				}),
			initialPageParam: 0,
			// A short last page means we've hit the end; otherwise advance the offset.
			getNextPageParam: (lastPage, allPages) =>
				lastPage.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
		});

	const sessions = data?.pages.flat() ?? [];

	// Load the next page when the list is scrolled near its bottom.
	const onListScroll = useCallback(
		(e) => {
			if (!hasNextPage || isFetchingNextPage) return;
			const el = e.currentTarget;
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 240)
				fetchNextPage();
		},
		[hasNextPage, isFetchingNextPage, fetchNextPage],
	);

	return (
		<aside className="chatx-sidebar">
			<div className="chatx-sidebar-head">
				<Link to="/notes" className="chatx-brand" title="Back to vault">
					<span className="chatx-brand-dot" />
					chat
				</Link>
				<PvIconButton
					to="/notes"
					icon={<HomeOutlined />}
					label="Back to vault"
				/>
				<PvButton
					variant="primary"
					size="sm"
					icon={<PlusOutlined />}
					onClick={onNew}
					title="New conversation"
				>
					New
				</PvButton>
			</div>

			<PvInput
				size="sm"
				className="chatx-search"
				value={raw}
				onChange={(e) => setRaw(e.target.value)}
				placeholder="Search conversations…"
				aria-label="Search conversations"
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

			<div className="chatx-session-list" onScroll={onListScroll}>
				{isLoading ? (
					<div className="chatx-session-loading">
						<SpriteRunner pixelSize={2} />
						<span>loading…</span>
					</div>
				) : sessions.length === 0 ? (
					<div className="chatx-session-empty">
						{q ? "No matches." : "No conversations yet."}
					</div>
				) : (
					<>
						{sessions.map((c) => (
							<div
								key={c.id}
								className={`chatx-session${c.id === activeId ? " is-active" : ""}`}
							>
								<button
									type="button"
									className="chatx-session-main"
									onClick={() => onSelect(c.id)}
								>
									<span className="chatx-session-title">
										{c.title || "Untitled"}
									</span>
									{c.updated_at || c.created_at ? (
										<span className="chatx-session-time">
											{timeAgo(c.updated_at || c.created_at)}
										</span>
									) : null}
								</button>
								<PvIconButton
									variant="ghost-danger"
									size="sm"
									className="chatx-session-del"
									icon={<DeleteOutlined />}
									label="Delete conversation"
									onClick={() => onDelete(c.id)}
								/>
							</div>
						))}
						{isFetchingNextPage ? (
							<div className="chatx-session-more">
								<SpriteRunner pixelSize={2} />
							</div>
						) : null}
					</>
				)}
			</div>
		</aside>
	);
}
