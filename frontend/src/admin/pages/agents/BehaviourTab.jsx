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
import {
	useAgentPersonas,
	useAgentProfile,
	useUpdateAgentProfile,
	useUpdatePersona,
} from "../../../queries";
import { errMsg } from "./ModelsTab";

/**
 * How Piuma behaves, in one panel: its name (what the chat calls it), the
 * instructions it reads every turn (how it works) and its voice (who it is, how
 * it talks). What it knows about you is on the Memory page.
 */
export default function BehaviourTab({ agent }) {
	const { data: profile, isLoading } = useAgentProfile(agent);
	const { data: personas = [] } = useAgentPersonas(agent);
	const persona = personas[0];
	if (isLoading || !persona) return <PvSpin block label="Loading the agent…" />;
	return <AgentPanel agent={agent} profile={profile} persona={persona} />;
}

const fields = (profile, persona) => ({
	display_name: profile?.display_name || "",
	instructions: profile?.instructions || "",
	voice: persona?.system_prompt || "",
});

function AgentPanel({ agent, profile, persona }) {
	const saveProfile = useUpdateAgentProfile();
	const savePersona = useUpdatePersona();
	const saved = fields(profile, persona);
	const [v, setV] = useState(saved);
	useEffect(() => setV(fields(profile, persona)), [profile, persona]);
	const dirty = JSON.stringify(v) !== JSON.stringify(saved);
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const busy = saveProfile.isPending || savePersona.isPending;
	const submit = async () => {
		try {
			if (
				v.display_name !== saved.display_name ||
				v.instructions !== saved.instructions
			)
				await saveProfile.mutateAsync({
					agent,
					display_name: v.display_name,
					instructions: v.instructions,
				});
			if (v.voice !== saved.voice)
				await savePersona.mutateAsync({
					id: persona.id,
					system_prompt: v.voice,
				});
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
					busy={busy}
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
				<PvField label="Voice" hint="Who it is and how it talks">
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={8}
						value={v.voice}
						onChange={(e) => set({ voice: e.target.value })}
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
