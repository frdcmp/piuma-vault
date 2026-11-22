import { useSearchParams } from "react-router-dom";
import { PvTabs } from "@/ui";
import BehaviourTab from "./BehaviourTab";
import CommandsTab from "./CommandsTab";
import ModelsTab from "./ModelsTab";
import "./agents.css";

// The vault has one agent: the Vault Agent.
const AGENT = "vault_agent";
const TABS = ["models", "behaviour", "commands"];

/**
 * The Vault Agent: the models it can run (providers and their models, the one new chats start
 * on), how it behaves (name, personality, instructions) and its slash commands. The tab is in the URL
 * (?tab=), so a reload or a link keeps it.
 */
export default function AgentsPage() {
	const [params, setParams] = useSearchParams();
	const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "models";
	return (
		<div className="ag-page">
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">Agent</h1>
					<p className="vp-page-subtitle">
						The Vault Agent: the models it can run, how it behaves, its
						commands. You chat with it in the app and on the phone.
					</p>
				</div>
			</div>
			<PvTabs
				activeKey={tab}
				onChange={(k) =>
					setParams(k === "models" ? {} : { tab: k }, { replace: true })
				}
				items={[
					{ key: "models", label: "Models", children: <ModelsTab /> },
					{
						key: "behaviour",
						label: "Behaviour",
						children: <BehaviourTab agent={AGENT} />,
					},
					{
						key: "commands",
						label: "Commands",
						children: <CommandsTab agent={AGENT} />,
					},
				]}
			/>
		</div>
	);
}
