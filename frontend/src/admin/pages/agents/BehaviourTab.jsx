import { useEffect, useState } from "react";
import {
	PvButton,
	PvField,
	PvInput,
	PvPanel,
	PvSpin,
	PvTextarea,
	pvMessage,
} from "@/ui";
import { useAgentProfile, useUpdateAgentProfile } from "../../../queries";
import { errMsg } from "./ModelsTab";

/**
 * How Piuma behaves, in one panel: its name (what the chat calls it), its
 * personality (who it is, how it talks) and the instructions it reads every turn
 * (how it works). What it knows about you is on the Memory page.
 */
export default function BehaviourTab({ agent }) {
	const { data: profile, isLoading } = useAgentProfile(agent);
	if (isLoading) return <PvSpin block label="Loading the agent…" />;
	return <AgentPanel agent={agent} profile={profile} />;
}

const fields = (profile) => ({
	display_name: profile?.display_name || "",
	personality: profile?.personality || "",
	instructions: profile?.instructions || "",
});

function AgentPanel({ agent, profile }) {
	const save = useUpdateAgentProfile();
	const saved = fields(profile);
	const [v, setV] = useState(saved);
	useEffect(() => setV(fields(profile)), [profile]);
	const dirty = JSON.stringify(v) !== JSON.stringify(saved);
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const submit = async () => {
		try {
			await save.mutateAsync({ agent, ...v });
			pvMessage.success("Saved");
		} catch (e) {
			pvMessage.error(errMsg(e, "Couldn't save"));
		}
	};
	return (
		<PvPanel
			title={saved.display_name || "The agent"}
			extra={
				<SaveBar
					dirty={dirty}
					busy={save.isPending}
					onSave={submit}
					onReset={() => setV(saved)}
				/>
			}
		>
			<div className="ag-form">
				<PvField label="Name" hint="What the chat calls it">
					<PvInput
						value={v.display_name}
						onChange={(e) => set({ display_name: e.target.value })}
					/>
				</PvField>
				<PvField label="Personality" hint="Who it is and how it talks">
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={8}
						value={v.personality}
						onChange={(e) => set({ personality: e.target.value })}
					/>
				</PvField>
				<PvField
					label="Instructions"
					hint="Read on every turn: how it works, what it must and mustn't do"
				>
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={10}
						value={v.instructions}
						onChange={(e) => set({ instructions: e.target.value })}
					/>
				</PvField>
			</div>
		</PvPanel>
	);
}

/** A panel's save: "Saved" until something changes, then Undo and Save. */
export function SaveBar({ dirty, busy, onSave, onReset }) {
	if (!dirty) return <span className="vp-muted ag-saved">Saved</span>;
	return (
		<div className="ag-row-actions">
			<PvButton size="sm" variant="ghost" onClick={onReset} disabled={busy}>
				Undo
			</PvButton>
			<PvButton size="sm" variant="primary" onClick={onSave} loading={busy}>
				Save
			</PvButton>
		</div>
	);
}
