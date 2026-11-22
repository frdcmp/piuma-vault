import { ArrowLeftOutlined, SearchOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
	PvAvatar,
	PvButton,
	PvDrawer,
	PvEmpty,
	PvField,
	PvIconButton,
	PvInput,
	PvSegmented,
	PvSelect,
	PvSpin,
	PvTable,
	PvTag,
	PvTextarea,
	pvConfirm,
	pvMessage,
} from "@/ui";
import {
	useJudgePigeonFact,
	useLearnPigeonContact,
	useMergePigeonContacts,
	usePigeonContact,
	usePigeonContactAccess,
	usePigeonContacts,
	usePigeonSettings,
	useRevokePigeonAccess,
	useSetPigeonContact,
	useSetPigeonContactNote,
	useSetPigeonContactSwitches,
} from "../../../queries";
import {
	ALERT_OPTIONS,
	channelLabel,
	errorText,
	initials,
	POLICY_OPTIONS,
	withInherit,
} from "./inboxText";
import SwitchInfo from "./SwitchInfo";

// What Pigeon knows about them: facts it learnt from their conversations, in the
// vault's memory. A guess (pending) waits for a yes; any can be dropped.
const FACT_KINDS = {
	who: "Who they are",
	fact: "Facts",
	preference: "Preferences",
	goal: "Open between you",
};

function TheirFacts({ id, facts }) {
	const judge = useJudgePigeonFact();
	if (!facts.length) return null;
	const act = (factId, verdict) =>
		judge.mutate(
			{ id, factId, verdict },
			{ onError: (e) => pvMessage.error(errorText(e)) },
		);
	const kinds = Object.keys(FACT_KINDS).filter((k) =>
		facts.some((f) => (f.category ?? "fact") === k),
	);
	return (
		<PvField
			label="What Pigeon knows"
			as="div"
			hint="From your conversations. A guess waits for your yes; what's open goes by itself once it stops coming up."
		>
			<div className="inbox-contact-facts">
				{kinds.map((k) => (
					<div key={k} className="inbox-contact-facts-kind">
						<div className="inbox-contact-facts-head">{FACT_KINDS[k]}</div>
						{facts
							.filter((f) => (f.category ?? "fact") === k)
							.map((f) => (
								<div key={f.id} className="inbox-contact-fact">
									<span>{f.content}</span>
									{f.status === "pending" ? <PvTag>guess</PvTag> : null}
									<span className="inbox-contact-fact-actions">
										{f.status === "pending" ? (
											<PvButton
												size="sm"
												variant="text"
												onClick={() => act(f.id, "confirm")}
											>
												Yes
											</PvButton>
										) : null}
										<PvButton
											size="sm"
											variant="text"
											onClick={() => act(f.id, "reject")}
										>
											Not true
										</PvButton>
									</span>
								</div>
							))}
					</div>
				))}
			</div>
		</PvField>
	);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The notes and folders Pigeon may answer a person from (their own, and what
// their groups hold); their own can be taken away here. Given from a note's or
// a folder's menu in Notes ("Pigeon can tell…"), or in the app.
function TheirNotes({ id }) {
	const { data } = usePigeonContactAccess(id);
	const revoke = useRevokePigeonAccess();
	const held = (data?.effective ?? []).filter((e) => e.target);
	if (!held.length) return null;
	return (
		<PvField label="Pigeon can tell them from" as="div">
			<ul className="inbox-contact-notes">
				{held.map((e) => (
					<li key={e.grant_id}>
						{e.target.kind === "note" ? (
							<Link to={`/notes/${e.target.note_id}`}>
								{e.target.title || "Untitled"}
							</Link>
						) : (
							<span>{e.target.folder}</span>
						)}
						<span className="inbox-muted">
							{e.mode === "auto" ? "Auto" : "Ask me"}
							{e.target.trashed ? " · in the trash" : ""}
							{e.from === "direct" ? "" : ` · ${e.origin}`}
						</span>
						{e.from === "direct" ? (
							<PvButton
								size="sm"
								variant="text"
								disabled={revoke.isPending}
								onClick={() =>
									revoke.mutate(e.grant_id, {
										onError: (err) => pvMessage.error(errorText(err)),
									})
								}
							>
								Take away
							</PvButton>
						) : null}
					</li>
				))}
			</ul>
		</PvField>
	);
}

// One person: who they are, the vault note about them, what Pigeon should know,
// their switches, what Pigeon keeps on them (notes in their folder of the
// vault); merge them into who they also are (the one picked stays), or learn
// them from past chats. onOpen(id): another person in the drawer.
function ContactDrawer({ id, people, onClose, onOpen }) {
	const { data: c, isLoading, error } = usePigeonContact(id);
	const { data: settings } = usePigeonSettings();
	const save = useSetPigeonContact();
	const saveNote = useSetPigeonContactNote();
	const switches = useSetPigeonContactSwitches();
	const merge = useMergePigeonContacts();
	const learn = useLearnPigeonContact();
	const [form, setForm] = useState(null);
	const [mergeId, setMergeId] = useState(null);

	// the form is this person's only: none while they load, or once the drawer closes
	useEffect(() => {
		if (!c) setForm(null);
		else
			setForm({
				name: c.name ?? "",
				slug: (c.slug ?? "").replace(/^@/, ""),
				relationship: c.relationship ?? "",
				language: c.language ?? "",
				note_id: c.note_id ?? "",
				note: c.note ?? "",
			});
	}, [c]);

	const fail = (e) => pvMessage.error(errorText(e));
	const field = (k) => ({
		value: form?.[k] ?? "",
		onChange: (e) => setForm((f) => ({ ...f, [k]: e.target.value })),
	});

	const onSave = async () => {
		// a note's link or its id
		const noteId = form.note_id.trim()
			? (form.note_id.match(UUID)?.[0] ?? null)
			: "";
		if (noteId === null)
			return pvMessage.error("That isn't a note's link or id");
		try {
			await save.mutateAsync({
				contact_id: id,
				name: form.name.trim(),
				slug: form.slug.trim(),
				relationship: form.relationship.trim(),
				language: form.language.trim(),
				note_id: noteId,
			});
			if (form.note.trim() !== (c.note ?? "").trim())
				await saveNote.mutateAsync({ id, note: form.note.trim() });
			pvMessage.success("Saved");
		} catch (e) {
			fail(e);
		}
	};

	const onMerge = async () => {
		const other = people.find((p) => p.contact_id === mergeId);
		if (!other) return;
		const ok = await pvConfirm({
			title: `Merge ${c.name || c.slug} into ${other.name || other.slug}?`,
			content: `${c.name || c.slug}'s handles, chats and what Pigeon knows move to ${other.name || other.slug}, whose name stays; ${c.name || c.slug} goes. It can't be undone.`,
			okText: "Merge",
			danger: true,
		});
		if (!ok) return;
		merge.mutate(
			{ id: mergeId, mergeId: id },
			{
				onSuccess: () => {
					setMergeId(null);
					pvMessage.success("Merged");
					// this one is gone: on to the one it went into
					onOpen?.(other.contact_id);
				},
				onError: fail,
			},
		);
	};

	const defaults = settings?.defaults ?? {};
	return (
		<PvDrawer
			open={!!id}
			onClose={onClose}
			placement="right"
			width={420}
			title={c?.name || c?.slug || "Someone"}
		>
			{error ? (
				<PvEmpty description={errorText(error)} />
			) : isLoading || !form || !c ? (
				<PvSpin block />
			) : (
				<div className="inbox-contact">
					{c.avatar ? (
						<a
							href={c.avatar_photo}
							target="_blank"
							rel="noreferrer"
							className="inbox-contact-photo"
							title="Their photo"
						>
							<PvAvatar size={96} src={c.avatar} className="inbox-avatar" />
						</a>
					) : null}
					<div className="inbox-contact-handles">
						{(c.handles ?? []).map((h) => (
							<PvTag key={`${h.channel}:${h.handle}`}>
								{channelLabel(h.channel)} · {h.shown_as || h.handle}
							</PvTag>
						))}
					</div>
					<PvField label="Name">
						<PvInput {...field("name")} />
					</PvField>
					<PvField
						label="@ in Piuma's chat"
						hint="How you mention them to Piuma: @anna"
					>
						<PvInput {...field("slug")} prefix="@" />
					</PvField>
					<PvField label="Who they are to you">
						<PvInput
							{...field("relationship")}
							placeholder="my sister, the landlord…"
						/>
					</PvField>
					<PvField label="Write to them in">
						<PvInput {...field("language")} placeholder="Italian" />
					</PvField>
					<PvField
						label="Their note in the vault"
						hint={
							c.note_id ? (
								<Link to={`/notes/${c.note_id}`}>Open the note</Link>
							) : (
								"Paste the note's link"
							)
						}
					>
						<PvInput {...field("note_id")} placeholder="…/notes/<id>" />
					</PvField>
					<PvField
						label="What Pigeon should know"
						hint="Pigeon reads it before writing to them."
					>
						<PvTextarea autoSize maxHeight={200} {...field("note")} />
					</PvField>
					<PvButton
						variant="primary"
						loading={save.isPending || saveNote.isPending}
						onClick={onSave}
					>
						Save
					</PvButton>

					<PvField
						label={
							<>
								Pigeon's replies to them
								<SwitchInfo kind="reply" />
							</>
						}
						as="div"
					>
						<PvSegmented
							size="sm"
							options={withInherit(POLICY_OPTIONS, defaults.reply ?? "ask")}
							value={c.replies_own ?? "inherit"}
							onChange={(v) =>
								switches.mutate({ id, reply: v }, { onError: fail })
							}
						/>
					</PvField>
					<PvField
						label={
							<>
								Alerts
								<SwitchInfo kind="alerts" />
							</>
						}
						as="div"
					>
						<PvSegmented
							size="sm"
							options={withInherit(ALERT_OPTIONS, settings?.alerts ?? "smart")}
							value={c.alerts_own ?? "inherit"}
							onChange={(v) =>
								switches.mutate({ id, alerts: v }, { onError: fail })
							}
						/>
					</PvField>

					<TheirNotes id={id} />

					<TheirFacts id={id} facts={c.facts ?? []} />
					{Object.keys(c.style_notes ?? {}).length ? (
						<PvField label="How you write to them" as="div">
							<div className="inbox-contact-styles">
								{Object.entries(c.style_notes).map(([channel, noteId]) => (
									<Link key={channel} to={`/notes/${noteId}`}>
										{channelLabel(channel)}
									</Link>
								))}
							</div>
						</PvField>
					) : null}
					<PvButton
						size="sm"
						loading={learn.isPending}
						onClick={() =>
							learn.mutate(
								{ id, days: 365 },
								{
									onSuccess: () =>
										pvMessage.success("Learnt from the last year"),
									onError: fail,
								},
							)
						}
					>
						Learn from past chats
					</PvButton>

					<PvField
						label="The same person as"
						as="div"
						hint="Who they also are (e.g. their email and their WhatsApp): this one merges into them."
					>
						<div className="inbox-contact-merge">
							<PvSelect
								value={mergeId}
								onChange={setMergeId}
								placeholder="Someone…"
								allowClear
								options={people
									.filter((p) => p.contact_id !== id)
									.map((p) => ({
										value: p.contact_id,
										label: p.name || p.slug,
									}))}
							/>
							<PvButton
								size="sm"
								variant="danger"
								disabled={!mergeId}
								loading={merge.isPending}
								onClick={onMerge}
							>
								Merge
							</PvButton>
						</div>
					</PvField>
				</div>
			)}
		</PvDrawer>
	);
}

export default function InboxPeople() {
	const [raw, setRaw] = useState("");
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(null);
	useEffect(() => {
		const t = setTimeout(() => setQ(raw.trim()), 220);
		return () => clearTimeout(t);
	}, [raw]);
	const { data: people = [], isLoading } = usePigeonContacts(q);
	const { data: everyone = [] } = usePigeonContacts("");

	const columns = [
		{
			key: "name",
			title: "Who",
			render: (_v, p) => (
				<span className="inbox-person-cell">
					<PvAvatar
						size={24}
						src={p.avatar ?? undefined}
						className="inbox-avatar"
					>
						{initials(p.name || p.slug)}
					</PvAvatar>
					{p.name || "—"}{" "}
					{p.slug ? <span className="inbox-muted">{p.slug}</span> : null}
				</span>
			),
		},
		{ key: "relationship", title: "To you", dataIndex: "relationship" },
		{
			key: "handles",
			title: "Where",
			render: (_v, p) =>
				[
					...new Set((p.handles ?? []).map((h) => channelLabel(h.channel))),
				].join(", "),
		},
		{ key: "replies", title: "Replies", dataIndex: "replies" },
		{ key: "alerts", title: "Alerts", dataIndex: "alerts" },
	];

	return (
		<section className="inbox-pane">
			<header className="inbox-pane-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<h1>People</h1>
				<PvInput
					size="sm"
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					placeholder="Search people…"
					aria-label="Search people"
					prefix={<SearchOutlined />}
					suffix={null}
				/>
			</header>
			<PvTable
				columns={columns}
				data={people}
				rowKey="contact_id"
				loading={isLoading}
				emptyText={
					q ? "Nobody matches." : "Nobody yet: people appear as they write."
				}
				onRowClick={(p) => setOpen(p.contact_id)}
				pagination={{ pageSize: 50, hideOnSinglePage: true }}
			/>
			<ContactDrawer
				id={open}
				people={everyone}
				onClose={() => setOpen(null)}
				onOpen={setOpen}
			/>
		</section>
	);
}
