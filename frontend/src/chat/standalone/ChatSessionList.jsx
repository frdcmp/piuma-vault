import {
	DeleteOutlined,
	HomeOutlined,
	PlusOutlined,
	SearchOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchConversations } from "../../api/agentChatApi";
import { timeAgo } from "../../utils/dateTime";
import SpriteRunner from "../SpriteRunner";

// Left rail: new-chat button, a search box that filters by title OR message
// text (server-side `q`), and the conversation list. Selecting a row lifts its
// id to the page; the active row is highlighted.
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

	const { data: sessions = [], isLoading } = useQuery({
		queryKey: ["agents", "conversations", null, q || ""],
		queryFn: () => fetchConversations(undefined, q || undefined),
		keepPreviousData: true,
	});

	return (
		<aside className="chatx-sidebar">
			<div className="chatx-sidebar-head">
				<Link to="/notes" className="chatx-brand" title="Back to vault">
					<span className="chatx-brand-dot" />
					chat
				</Link>
				<Link
					to="/notes"
					className="chatx-home"
					title="Back to vault"
					aria-label="Back to vault"
				>
					<HomeOutlined />
				</Link>
				<button
					type="button"
					className="chatx-new"
					onClick={onNew}
					title="New conversation"
				>
					<PlusOutlined /> New
				</button>
			</div>

			<div className="chatx-search">
				<SearchOutlined className="chatx-search-icon" />
				<input
					className="chatx-search-input"
					type="text"
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					placeholder="Search conversations…"
				/>
				{raw ? (
					<button
						type="button"
						className="chatx-search-clear"
						onClick={() => setRaw("")}
						aria-label="Clear search"
					>
						×
					</button>
				) : null}
			</div>

			<div className="chatx-session-list">
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
					sessions.map((c) => (
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
							<button
								type="button"
								className="chatx-session-del"
								onClick={() => onDelete(c.id)}
								aria-label="Delete conversation"
								title="Delete conversation"
							>
								<DeleteOutlined />
							</button>
						</div>
					))
				)}
			</div>
		</aside>
	);
}
