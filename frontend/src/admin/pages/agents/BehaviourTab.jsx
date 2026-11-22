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
 * How the Vault Agent behaves: its profile (instructions it always reads, who the user is) and
 * its persona (its voice and the tools it may use), side by side, each saved on its own.
 */
export default function BehaviourTab({ agent }) {
	const { data: profile, isLoading } = useAgentProfile(agent);
	const { data: personas = [] } = useAgentPersonas(agent);
	const persona = personas[0];
	if (isLoading) return <PvSpin block label="Loading the agent…" />;
	return (
		<div className="ag-behaviour">
			<ProfilePanel agent={agent} profile={profile} />
			{persona && <PersonaPanel persona={persona} />}
		</div>
	);
}

const profileFields = (p) => ({
	display_name: p?.display_name || "",
	instructions: p?.instructions || "",
	user_context: p?.user_context || "",
});

function ProfilePanel({ agent, profile }) {
	const save = useUpdateAgentProfile();
	const [v, setV] = useState({
		display_name: "",
		instructions: "",
		user_context: "",
	});
	useEffect(() => setV(profileFields(profile)), [profile]);
	const dirty = JSON.stringify(v) !== JSON.stringify(profileFields(profile));
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const submit = () =>
		save.mutate(
			{ agent, ...v },
			{
				onSuccess: () => pvMessage.success("Profile saved"),
				onError: (e) => pvMessage.error(errMsg(e, "Couldn't save the profile")),
			},
		);
	return (
		<PvPanel
			title="Profile"
			extra={
				<SaveBar
					dirty={dirty}
					busy={save.isPending}
					onSave={submit}
					onReset={() => setV(profileFields(profile))}
				/>
			}
		>
			<div className="ag-form">
				<PvField label="Name" hint="What the chat calls the agent">
					<PvInput
						value={v.display_name}
						onChange={(e) => set({ display_name: e.target.value })}
					/>
				</PvField>
				<PvField
					label="Instructions"
					hint="Read on every turn: how it works, what it must and mustn't do"
				>
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={8}
						value={v.instructions}
						onChange={(e) => set({ instructions: e.target.value })}
					/>
				</PvField>
				<PvField
					label="About you"
					hint="Who you are, how you want answers, how your things are organised (the memory's first layer)"
				>
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={8}
						value={v.user_context}
						onChange={(e) => set({ user_context: e.target.value })}
					/>
				</PvField>
			</div>
		</PvPanel>
	);
}

const personaFields = (p) => ({
	display_name: p.display_name || "",
	emoji: p.emoji || "",
	system_prompt: p.system_prompt || "",
	allowed_tools: (p.allowed_tools || []).join(", "),
});

function PersonaPanel({ persona }) {
	const save = useUpdatePersona();
	const [v, setV] = useState(() => personaFields(persona));
	useEffect(() => setV(personaFields(persona)), [persona]);
	const dirty = JSON.stringify(v) !== JSON.stringify(personaFields(persona));
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const tools = v.allowed_tools
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const submit = () =>
		save.mutate(
			{
				id: persona.id,
				display_name: v.display_name,
				emoji: v.emoji,
				system_prompt: v.system_prompt,
				allowed_tools: tools.length ? tools : null,
			},
			{
				onSuccess: () => pvMessage.success("Persona saved"),
				onError: (e) => pvMessage.error(errMsg(e, "Couldn't save the persona")),
			},
		);
	return (
		<PvPanel
			title="Persona"
			extra={
				<SaveBar
					dirty={dirty}
					busy={save.isPending}
					onSave={submit}
					onReset={() => setV(personaFields(persona))}
				/>
			}
		>
			<div className="ag-form">
				<div className="ag-pair">
					<PvField label="Emoji" className="ag-pair__small">
						<PvInput
							value={v.emoji}
							onChange={(e) => set({ emoji: e.target.value })}
						/>
					</PvField>
					<PvField label="Name" className="ag-pair__grow">
						<PvInput
							value={v.display_name}
							onChange={(e) => set({ display_name: e.target.value })}
						/>
					</PvField>
				</div>
				<PvField
					label="Voice"
					hint="The system prompt: who it is and how it talks"
				>
					<PvTextarea
						autoSize
						maxHeight="50vh"
						rows={10}
						value={v.system_prompt}
						onChange={(e) => set({ system_prompt: e.target.value })}
					/>
				</PvField>
				<PvField
					label="Tools it may use"
					hint={
						tools.length
							? `${tools.length} tool${tools.length === 1 ? "" : "s"}, separated by commas`
							: "Empty: every tool"
					}
				>
					<PvTextarea
						autoSize
						rows={2}
						value={v.allowed_tools}
						placeholder="every tool"
						onChange={(e) => set({ allowed_tools: e.target.value })}
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
