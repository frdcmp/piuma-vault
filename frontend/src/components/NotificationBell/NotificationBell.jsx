import {
	BellOutlined,
	CheckOutlined,
	CloseOutlined,
	InboxOutlined,
	LoadingOutlined,
} from "@ant-design/icons";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate } from "react-router-dom";
import { PvButton, PvIconButton, PvModal, PvPopover } from "@/ui";
import {
	useDismissNotification,
	useMarkAllNotificationsRead,
	useNotificationInbox,
	useNotificationLiveUpdates,
	useUnreadNotificationCount,
} from "../../queries";
import { formatDateTime, timeAgo } from "../../utils/dateTime";
import { remarkPlugins } from "../../utils/markdown";
import "./NotificationBell.css";

// Notification levels with their own dot colour (`.nb-item-dot--<level>` in the
// CSS, mirroring the vault-pixel accents); anything else falls back to info.
const LEVELS = new Set(["info", "success", "warning", "error"]);

function NotificationItem({ n, onSelect, onDismiss }) {
	const unread = !n.read_at;
	const [dismissing, setDismissing] = useState(false);

	// Optimistic feedback: grey the row + spin the X while the request is in
	// flight. On success the row disappears (the list refetches); on failure we
	// restore it so the user can retry.
	const handleDismiss = () => {
		setDismissing(true);
		Promise.resolve(onDismiss(n.id)).catch(() => setDismissing(false));
	};

	return (
		<div
			className={`nb-item${unread ? " nb-item-unread" : ""}${dismissing ? " nb-item-dismissing" : ""}`}
		>
			<button
				type="button"
				className="nb-item-main"
				onClick={() => onSelect(n)}
				disabled={dismissing}
			>
				<span
					className={`nb-item-dot nb-item-dot--${LEVELS.has(n.level) ? n.level : "info"}`}
					aria-hidden="true"
				/>
				<span className="nb-item-body">
					<span className="nb-item-title">
						{n.title}
						{n.count > 1 && <span className="nb-item-count">×{n.count}</span>}
					</span>
					{n.body && <span className="nb-item-text">{n.body}</span>}
					<span className="nb-item-time">{timeAgo(n.created_at)}</span>
				</span>
			</button>
			<PvIconButton
				variant="ghost"
				size="sm"
				className="nb-item-dismiss"
				icon={dismissing ? <LoadingOutlined /> : <CloseOutlined />}
				label="Dismiss"
				onClick={handleDismiss}
				disabled={dismissing}
			/>
		</div>
	);
}

function NotificationList({
	items,
	isLoading,
	onSelect,
	onDismiss,
	hasNextPage,
	fetchNextPage,
	isFetchingNextPage,
}) {
	return (
		<>
			<div className="nb-list">
				{isLoading ? (
					<div className="nb-loading">loading…</div>
				) : items.length === 0 ? (
					<div className="nb-empty">
						<InboxOutlined className="nb-empty-icon" />
						<span>you're all caught up</span>
					</div>
				) : (
					items.map((n) => (
						<NotificationItem
							key={n.id}
							n={n}
							onSelect={onSelect}
							onDismiss={onDismiss}
						/>
					))
				)}
			</div>

			{hasNextPage && (
				<div className="nb-more">
					<PvButton
						size="sm"
						loading={isFetchingNextPage}
						disabled={isFetchingNextPage}
						onClick={() => fetchNextPage()}
					>
						load more
					</PvButton>
				</div>
			)}
		</>
	);
}

/**
 * Header notification bell — pixel-art popover inbox + unread badge, built on
 * the piuma primitives. "Open is seen": opening the panel marks all read and
 * clears the badge. Selecting a notification with an `action_url` (a pointer,
 * e.g. a task alert) navigates there; without one (a content notification, e.g.
 * a cron report) it opens in a detail modal so you read it in place.
 */
export default function NotificationBell() {
	const [open, setOpen] = useState(false);
	const bellRef = useRef(null);
	const [detail, setDetail] = useState(null);
	const navigate = useNavigate();
	const { data: count = 0 } = useUnreadNotificationCount();
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useNotificationInbox({ enabled: open });
	const markAll = useMarkAllNotificationsRead();
	const dismiss = useDismissNotification();
	useNotificationLiveUpdates();

	const items = (data?.pages || []).flat();

	const handleOpenChange = (next) => {
		setOpen(next);
		// Open = seen: clear the badge as soon as the panel opens.
		if (next && count > 0) markAll.mutate();
	};

	const handleSelect = (n) => {
		setOpen(false);
		if (n.action_url) {
			if (n.action_url.startsWith("/")) navigate(n.action_url);
			else window.open(n.action_url, "_blank", "noopener");
		} else {
			setDetail(n);
		}
	};

	return (
		<>
			<PvIconButton
				ref={bellRef}
				className="nb-bell"
				label="Notifications"
				onClick={() => handleOpenChange(!open)}
				icon={
					<>
						<BellOutlined />
						{count > 0 && (
							<span className="nb-badge">{count > 99 ? "99+" : count}</span>
						)}
					</>
				}
			/>
			<PvPopover
				open={open}
				anchorRef={bellRef}
				onClose={() => handleOpenChange(false)}
				align="end"
				gap={8}
				width={340}
				title="Notifications"
				extra={
					<PvButton
						variant="text"
						icon={<CheckOutlined />}
						disabled={markAll.isPending || items.every((i) => i.read_at)}
						onClick={() => markAll.mutate()}
					>
						mark all read
					</PvButton>
				}
			>
				<NotificationList
					items={items}
					isLoading={isLoading}
					onSelect={handleSelect}
					onDismiss={dismiss.mutateAsync}
					hasNextPage={hasNextPage}
					fetchNextPage={fetchNextPage}
					isFetchingNextPage={isFetchingNextPage}
				/>
			</PvPopover>

			<PvModal
				open={!!detail}
				title={detail?.title}
				onCancel={() => setDetail(null)}
				width={560}
				footer={
					<>
						<PvButton
							variant="danger"
							onClick={() => {
								if (detail) dismiss.mutate(detail.id);
								setDetail(null);
							}}
						>
							dismiss
						</PvButton>
						<PvButton variant="primary" onClick={() => setDetail(null)}>
							close
						</PvButton>
					</>
				}
			>
				{detail && (
					<>
						<div className="nb-detail-meta">
							{formatDateTime(detail.created_at).date}{" "}
							{formatDateTime(detail.created_at).time}
						</div>
						<div className="nb-detail-body">
							<ReactMarkdown remarkPlugins={remarkPlugins}>
								{detail.body || "_(no content)_"}
							</ReactMarkdown>
						</div>
					</>
				)}
			</PvModal>
		</>
	);
}
