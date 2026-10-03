import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { navTargetToPath } from "../chat/engine/messageModel";
import {
	useRunVoiceTool,
	useSaveVoiceTurn,
	useStartVoiceSession,
} from "../queries";
import useChatDockStore from "../store/chatDockStore";
import voiceEngine from "./voiceEngine";
import useVoiceStore from "./voiceStore";

// Wires the voice engine into the app. Mounted once by the workspace shell, so
// a voice conversation keeps running while you move between pages. Provides
// the engine's data calls (TanStack mutations), lets Piuma navigate, and binds
// Ctrl+Space to start/end a conversation from anywhere.
export default function VoiceProvider() {
	const navigate = useNavigate();
	const location = useLocation();
	const startSession = useStartVoiceSession();
	const runTool = useRunVoiceTool();
	const saveTurn = useSaveVoiceTurn();
	const focusConversation = useChatDockStore((s) => s.focusConversation);
	const openChat = useChatDockStore((s) => s.openChat);

	useEffect(() => {
		voiceEngine.setDeps({
			startSession: startSession.mutateAsync,
			runTool: runTool.mutateAsync,
			saveTurn: saveTurn.mutateAsync,
			navigate: (target) => {
				const path = navTargetToPath(target);
				if (!path) return;
				if (/^https?:\/\//i.test(path)) window.open(path, "_blank", "noopener");
				else navigate(path);
			},
			focusConversation: (id) => {
				openChat();
				focusConversation(id);
			},
		});
	}, [
		startSession.mutateAsync,
		runTool.mutateAsync,
		saveTurn.mutateAsync,
		navigate,
		focusConversation,
		openChat,
	]);

	useEffect(() => {
		const onKey = (e) => {
			if (!(e.ctrlKey && e.code === "Space")) return;
			e.preventDefault();
			if (voiceEngine.active) {
				voiceEngine.stop();
			} else {
				if (location.pathname !== "/voice") navigate("/voice");
				voiceEngine.start();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [location.pathname, navigate]);

	return null;
}

// Header pill shown while a voice conversation runs on another page.
export function VoiceIndicator() {
	const navigate = useNavigate();
	const location = useLocation();
	const status = useVoiceStore((s) => s.status);
	if (status === "idle" || status === "error" || location.pathname === "/voice")
		return null;
	return (
		<button
			type="button"
			className="voice-indicator"
			title="Voice conversation in progress"
			onClick={() => navigate("/voice")}
		>
			<span className={`voice-indicator-dot is-${status}`} aria-hidden="true" />
			LIVE
		</button>
	);
}
