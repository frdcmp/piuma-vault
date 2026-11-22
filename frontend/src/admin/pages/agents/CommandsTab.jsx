import { useEffect, useState } from "react";
import {
	PvButton,
	PvField,
	PvIconButton,
	PvInput,
	PvModal,
	PvPanel,
	PvSpin,
	PvTable,
	PvTextarea,
	pvConfirm,
	pvMessage,
} from "@/ui";
import { useAgentProfile, useUpdateAgentProfile } from "../../../queries";
import { errMsg } from "./ModelsTab";

/**
 * The agent's slash commands: a name typed in chat (/brief) sends its prompt. Each is added,
 * edited or deleted on its own, and saved at once with the agent's profile.
 */
export default function CommandsTab({ agent }) {
	const { data: profile, isLoading } = useAgentProfile(agent);
	const save = useUpdateAgentProfile();
	const [editing, setEditing] = useState(null);
	const commands = Array.isArray(profile?.commands) ? profile.commands : [];

	const write = (next, done) =>
		save.mutate(
			{ agent, commands: next },
			{
				onSuccess: () => pvMessage.success(done),
				onError: (e) =>
					pvMessage.error(errMsg(e, "Couldn't save the commands")),
			},
		);
	const remove = async (i) => {
		const ok = await pvConfirm({
			title: `Delete /${commands[i].name}?`,
			okText: "Delete",
			danger: true,
		});
		if (ok)
			write(
				commands.filter((_, j) => j !== i),
				"Command deleted",
			);
	};

	const columns = [
		{
			key: "name",
			title: "Command",
			width: 180,
			sorter: (a, b) => (a.name || "").localeCompare(b.name || ""),
			render: (_, c) => <code className="ag-cmd">/{c.name}</code>,
		},
		{
			key: "description",
			title: "What it does",
			render: (_, c) => c.description || <span className="vp-muted">—</span>,
		},
		{
			key: "prompt",
			title: "Prompt",
			render: (_, c) => <span className="ag-clip vp-muted">{c.prompt}</span>,
		},
		{
			key: "actions",
			title: "",
			width: 72,
			align: "right",
			render: (_, c) => (
				<div className="ag-row-actions">
					<PvIconButton
						size="sm"
						variant="ghost"
						label="Edit"
						icon="✎"
						onClick={(e) => {
							e.stopPropagation();
							setEditing(c);
						}}
					/>
					<PvIconButton
						size="sm"
						variant="ghost-danger"
						label="Delete"
						icon="✕"
						onClick={(e) => {
							e.stopPropagation();
							remove(c._i);
						}}
					/>
				</div>
			),
		},
	];

	if (isLoading) return <PvSpin block label="Loading commands…" />;
	return (
		<PvPanel
			title="Slash commands"
			extra={
				<PvButton size="sm" variant="primary" onClick={() => setEditing("new")}>
					+ Add command
				</PvButton>
			}
		>
			<p className="vp-muted ag-lead">
				Type <code>/name</code> in a chat and the agent gets the command's
				prompt.
			</p>
			<PvTable
				size="sm"
				minWidth={560}
				columns={columns}
				data={commands.map((c, i) => ({ ...c, _i: i }))}
				rowKey="_i"
				onRowClick={(c) => setEditing(c)}
				emptyText="No commands yet."
			/>
			<CommandModal
				target={editing}
				taken={commands.map((c) => c.name)}
				onClose={() => setEditing(null)}
				onSave={(c) => {
					const next =
						editing === "new"
							? [...commands, c]
							: commands.map((x, j) => (j === editing._i ? c : x));
					write(next, editing === "new" ? "Command added" : "Command saved");
					setEditing(null);
				}}
			/>
		</PvPanel>
	);
}

function CommandModal({ target, taken, onClose, onSave }) {
	const isNew = target === "new";
	const [v, setV] = useState({ name: "", description: "", prompt: "" });
	useEffect(() => {
		if (target)
			setV(
				isNew
					? { name: "", description: "", prompt: "" }
					: {
							name: target.name || "",
							description: target.description || "",
							prompt: target.prompt || "",
						},
			);
	}, [target, isNew]);
	const set = (patch) => setV((x) => ({ ...x, ...patch }));
	const submit = () => {
		const name = v.name.trim().replace(/^\//, "");
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name))
			return pvMessage.error("A name is letters, digits, - and _ (no spaces)");
		if (!v.prompt.trim())
			return pvMessage.error(
				"The prompt is what the command sends: it's needed",
			);
		if (taken.includes(name) && (isNew || name !== target.name))
			return pvMessage.error(`/${name} exists already`);
		onSave({ name, description: v.description.trim(), prompt: v.prompt });
	};
	return (
		<PvModal
			open={!!target}
			width={560}
			title={isNew ? "Add a command" : `Edit /${target?.name ?? ""}`}
			confirmText={isNew ? "Add command" : "Save"}
			onConfirm={submit}
			onCancel={onClose}
		>
			<div className="ag-form">
				<PvField label="Name" required hint="Typed after / in a chat">
					<PvInput
						prefix="/"
						value={v.name}
						placeholder="brief"
						onChange={(e) => set({ name: e.target.value })}
					/>
				</PvField>
				<PvField label="What it does" hint="Shown in the chat's command list">
					<PvInput
						value={v.description}
						placeholder="A short brief on today"
						onChange={(e) => set({ description: e.target.value })}
					/>
				</PvField>
				<PvField
					label="Prompt"
					required
					hint="Sent to the agent when the command is used"
				>
					<PvTextarea
						autoSize
						maxHeight="40vh"
						rows={5}
						value={v.prompt}
						onChange={(e) => set({ prompt: e.target.value })}
					/>
				</PvField>
			</div>
		</PvModal>
	);
}
