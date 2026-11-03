import { Route, Routes, useMatch } from "react-router-dom";
import { PvEmpty } from "@/ui";
import { usePigeonLiveUpdates } from "../../../queries";
import ChatView from "./ChatView";
import GeneralView from "./GeneralView";
import InboxPeople from "./InboxPeople";
import InboxRail from "./InboxRail";
import InboxRules from "./InboxRules";
import InboxSettings from "./InboxSettings";
import "./inbox.css";

// The Inbox's own pages; any other `/inbox/:x` is a chat (the id the phone's
// pushes open too).
const PAGES = new Set(["general", "people", "rules", "settings"]);

// The Inbox: what people send (WhatsApp, Instagram, Gmail…) as chats, with
// Pigeon's cards (drafts, suggestions, questions) waiting for a tap. The chat
// list on the left, the open chat (or General, People, Rules, Settings) on the
// right; Piuma's dock beside it all, where "Ask Piuma" attaches a chat.
export default function InboxPage() {
	usePigeonLiveUpdates();
	const seg = useMatch("/inbox/:seg")?.params?.seg ?? null;
	const activeId = seg && !PAGES.has(seg) ? seg : null;

	return (
		// On a narrow screen the list and the open page take turns.
		<div className={`inbox-page${seg ? " is-showing" : ""}`}>
			<div className="inbox-rail">
				<InboxRail activeId={activeId} page={activeId ? null : seg} />
			</div>
			<main className="inbox-main">
				<Routes>
					<Route
						index
						element={
							<div className="inbox-blank">
								<PvEmpty description="Pick a chat on the left." />
							</div>
						}
					/>
					<Route path="general" element={<GeneralView />} />
					<Route path="people" element={<InboxPeople />} />
					<Route path="rules" element={<InboxRules />} />
					<Route path="settings" element={<InboxSettings />} />
					<Route path=":id" element={<ChatView id={activeId} />} />
				</Routes>
			</main>
		</div>
	);
}
