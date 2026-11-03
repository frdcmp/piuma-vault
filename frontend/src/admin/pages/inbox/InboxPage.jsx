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

// The Inbox's own pages; `/inbox/p/:person` is a person's chat (all their
// channels), any other `/inbox/:x` a thread (the id the phone's pushes open
// too; one that is a person's opens their chat).
const PAGES = new Set(["general", "people", "rules", "settings"]);

// The Inbox: what people send (WhatsApp, Instagram, Gmail…) as chats, with
// Pigeon's cards (drafts, suggestions, questions) waiting for a tap. The chat
// list on the left, the open chat (or General, People, Rules, Settings) on the
// right; Piuma's dock beside it all, where "Ask Piuma" attaches a chat.
export default function InboxPage() {
	usePigeonLiveUpdates();
	const seg = useMatch("/inbox/:seg")?.params?.seg ?? null;
	const person = useMatch("/inbox/p/:person")?.params?.person ?? null;
	const activeId = seg && !PAGES.has(seg) ? seg : null;
	const activeKey = person ? `p:${person}` : activeId ? `c:${activeId}` : null;

	return (
		// On a narrow screen the list and the open page take turns.
		<div className={`inbox-page${seg || person ? " is-showing" : ""}`}>
			<div className="inbox-rail">
				<InboxRail activeKey={activeKey} page={activeKey ? null : seg} />
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
					<Route path="p/:person" element={<ChatView person={person} />} />
					<Route path=":id" element={<ChatView id={activeId} />} />
				</Routes>
			</main>
		</div>
	);
}
