import { useState } from "react";
import {
	PvButton,
	PvField,
	PvModal,
	PvSegmented,
	PvSelect,
	PvSpin,
	pvMessage,
} from "@/ui";
import {
	useGrantPigeonAccess,
	usePigeonAccess,
	usePigeonContacts,
	usePigeonNoteAccess,
	useRevokePigeonAccess,
} from "../../../queries";
import { formatDate } from "../../../utils/dateTime";
import { errorText } from "../../pages/inbox/inboxText";
import "./PigeonTell.css";

// "Pigeon can tell…" on a note or a folder: who Pigeon may answer from it when
// they ask (the Inbox's Notes permission), with add and take away. A folder is
// every note in and under it, the ones added later too. Mounted while open;
// target: { noteId } | { folder }.

const MODES = [
	{ value: "ask", label: "Ask me" },
	{ value: "auto", label: "Auto" },
];
const KINDS = { contact: "", conversation: "Chat · ", group: "Group · " };

const fail = (e) => pvMessage.error(errorText(e));

// One who holds it. What comes from a folder above is taken away there.
function Holder({ grant }) {
	const revoke = useRevokePigeonAccess();
	return (
		<li className="pigeon-tell-holder">
			<span className="pigeon-tell-who">
				{KINDS[grant.holder.kind]}
				{grant.holder.name}
			</span>
			<span className="pigeon-tell-how">
				{grant.mode === "auto" ? "Auto" : "Ask me"}
				{grant.until ? ` · until ${formatDate(grant.until)}` : ""}
				{grant.through ? ` · through ${grant.through}` : ""}
			</span>
			{grant.through ? null : (
				<PvButton
					size="sm"
					variant="text"
					loading={revoke.isPending}
					onClick={() => revoke.mutate(grant.id, { onError: fail })}
				>
					Take away
				</PvButton>
			)}
		</li>
	);
}

export default function PigeonTell({ target, onClose }) {
	const { data, isLoading, error } = usePigeonNoteAccess(target);
	const { data: people = [] } = usePigeonContacts("");
	const { data: access } = usePigeonAccess();
	const grant = useGrantPigeonAccess();
	const [who, setWho] = useState(null);
	const [mode, setMode] = useState("ask");

	const holders = data?.holders ?? [];
	const options = [
		...(access?.groups ?? []).map((g) => ({
			value: `group:${g.id}`,
			label: `Group · ${g.name}`,
		})),
		...people.map((p) => ({
			value: `contact:${p.contact_id}`,
			label: p.name || p.slug,
		})),
	];
	const add = () => {
		const [kind, id] = who.split(":");
		grant.mutate(
			{
				[`${kind}_id`]: id,
				permission: `notes.use.${mode}`,
				note_id: target.noteId,
				folder: target.folder,
			},
			{ onSuccess: () => setWho(null), onError: fail },
		);
	};

	return (
		<PvModal
			open
			title="Pigeon can tell…"
			onCancel={onClose}
			cancelText="Close"
			width="460px"
		>
			{data ? (
				<div className="pigeon-tell">
					<p className="pigeon-tell-help">
						{data.target.kind === "note"
							? `When they ask for something that is in «${data.target.title}», Pigeon may answer from it.`
							: `When they ask for something that is in a note of ${data.target.folder}, or of a folder under it, Pigeon may answer from it.`}
					</p>
					{data.shareable ? (
						<>
							{holders.length ? (
								<ul className="pigeon-tell-holders">
									{holders.map((g) => (
										<Holder key={g.id} grant={g} />
									))}
								</ul>
							) : (
								<p className="pigeon-tell-none">Nobody yet.</p>
							)}
							<PvField
								label="Add"
								as="div"
								hint={
									mode === "auto"
										? "Pigeon tells them on its own when it's sure that's what they ask, and says so after. Never bank details."
										: "Pigeon writes the reply; it goes when you send it."
								}
							>
								<div className="pigeon-tell-add">
									<PvSelect
										size="sm"
										value={who}
										onChange={setWho}
										placeholder="Someone, or a group…"
										allowClear
										options={options}
									/>
									<PvSegmented
										size="sm"
										options={MODES}
										value={mode}
										onChange={setMode}
									/>
									<PvButton
										size="sm"
										variant="primary"
										disabled={!who}
										loading={grant.isPending}
										onClick={add}
									>
										Add
									</PvButton>
								</div>
							</PvField>
						</>
					) : (
						<p className="pigeon-tell-none">
							{data.target.trashed
								? "This note is in the trash: nothing of it is told."
								: data.target.folder === "/" && data.target.kind === "folder"
									? "Not the whole vault: pick a folder."
									: "Nothing of /contacts is told to anyone: it is what you and Pigeon keep on people. Share from another folder."}
						</p>
					)}
				</div>
			) : isLoading ? (
				<PvSpin block label="loading…" />
			) : (
				<p className="pigeon-tell-none">{errorText(error)}</p>
			)}
		</PvModal>
	);
}
