import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { PvModal } from "@/admin/components/ui";
import { deleteConversation } from "../../api/agentChatApi";
import "../ChatPage.css";
import ChatConversation from "./ChatConversation";
import ChatSessionList from "./ChatSessionList";
import "./ChatStandalone.css";

// Standalone full-screen chat: a searchable conversation rail on the left, a
// ChatGPT-style streaming conversation in the center. The open conversation
// lives in the URL — /chat for a fresh chat, /chat/c/:id for an existing one —
// so it's shareable, bookmarkable, and survives a reload (ChatGPT-style).
export default function ChatPage() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	// Read the conversation id straight from the URL; null on the bare /chat.
	const match = useMatch("/chat/c/:id");
	const activeId = match?.params?.id ?? null;

	const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
	const [pendingDelete, setPendingDelete] = useState(null);

	const refreshSessions = useCallback(() => {
		qc.invalidateQueries({ queryKey: ["agents", "conversations"] });
	}, [qc]);

	const select = useCallback(
		(id) => {
			navigate(id ? `/chat/c/${id}` : "/chat");
			setSidebarOpen(false);
		},
		[navigate],
	);

	const newChat = useCallback(() => {
		navigate("/chat");
		setSidebarOpen(false);
	}, [navigate]);

	// A turn that creates the conversation adopts its id in the URL — `replace`
	// so Back doesn't return to the empty /chat we just left mid-stream.
	const onConversationCreated = useCallback(
		(id) => {
			if (id) navigate(`/chat/c/${id}`, { replace: true });
		},
		[navigate],
	);

	const confirmDelete = useCallback(async () => {
		const id = pendingDelete;
		setPendingDelete(null);
		if (!id) return;
		if (id === activeId) navigate("/chat");
		try {
			await deleteConversation(id);
		} catch {
			/* ignore */
		}
		refreshSessions();
	}, [pendingDelete, activeId, navigate, refreshSessions]);

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
