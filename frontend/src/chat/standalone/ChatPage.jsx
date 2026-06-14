import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { PvModal } from "@/admin/components/ui";
import { deleteConversation } from "../../api/agentChatApi";
import "../ChatPage.css";
import ChatConversation from "./ChatConversation";
import ChatSessionList from "./ChatSessionList";
import "./ChatStandalone.css";

// Persist the open conversation so a reload restores it.
const STORAGE_KEY = "pv:chat-page-active";

// Standalone full-screen chat at /chat: a searchable conversation rail on the
// left, a ChatGPT-style streaming conversation in the center.
export default function ChatPage() {
	const qc = useQueryClient();
	const [activeId, setActiveId] = useState(
		() => localStorage.getItem(STORAGE_KEY) || null,
	);
	const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
	const [pendingDelete, setPendingDelete] = useState(null);

	const refreshSessions = useCallback(() => {
		qc.invalidateQueries({ queryKey: ["agents", "conversations"] });
	}, [qc]);

	const select = useCallback((id) => {
		setActiveId(id);
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
		setSidebarOpen(false);
	}, []);

	const newChat = useCallback(() => {
		select(null);
	}, [select]);

	const onConversationCreated = useCallback((id) => {
		setActiveId(id);
		if (id) localStorage.setItem(STORAGE_KEY, id);
	}, []);

	const confirmDelete = useCallback(async () => {
		const id = pendingDelete;
		setPendingDelete(null);
		if (!id) return;
		if (id === activeId) select(null);
		try {
			await deleteConversation(id);
		} catch {
			/* ignore */
		}
		refreshSessions();
	}, [pendingDelete, activeId, select, refreshSessions]);

	return (
		<div className="chatx-page">
			<div className={`chatx-rail${sidebarOpen ? " is-open" : ""}`}>
				<ChatSessionList
					activeId={activeId}
					onSelect={select}
					onNew={newChat}
					onDelete={(id) => setPendingDelete(id)}
				/>
			</div>
			{sidebarOpen ? (
				<button
					type="button"
					className="chatx-scrim"
					aria-label="Close conversations"
					onClick={() => setSidebarOpen(false)}
				/>
			) : null}

			<ChatConversation
				conversationId={activeId}
				onConversationCreated={onConversationCreated}
				onConversationsChanged={refreshSessions}
				onToggleSidebar={() => setSidebarOpen((o) => !o)}
				onNewChat={newChat}
			/>

			<PvModal
				open={!!pendingDelete}
				title="Delete this conversation?"
				confirmText="Delete"
				cancelText="Cancel"
				danger
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			>
				This permanently removes the conversation and its messages.
			</PvModal>
		</div>
	);
}
