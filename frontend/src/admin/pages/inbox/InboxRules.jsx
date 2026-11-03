import { ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import {
	PvButton,
	PvDrawer,
	PvField,
	PvIconButton,
	PvInput,
	PvPopconfirm,
	PvSegmented,
	PvSelect,
	PvTable,
	PvTag,
	PvTextarea,
	pvMessage,
} from "@/ui";
import {
	useDeletePigeonRule,
	usePigeonContacts,
	usePigeonRuleRuns,
	usePigeonRules,
	useSetPigeonRule,
	useTryPigeonRule,
} from "../../../queries";
import { formatDate, formatTime } from "../../../utils/dateTime";
import { channelLabel, errorText } from "./inboxText";

const CONNECTORS = [
	{ value: "gmail", label: "Gmail" },
	{ value: "whatsapp", label: "WhatsApp" },
	{ value: "instagram", label: "Instagram" },
	{ value: "*", label: "Any channel" },
];
const RECORD = [
	{ value: "", label: "Nothing" },
	{ value: "vault_log", label: "A line in a note" },
	{ value: "vault_create_task", label: "A task" },
	{ value: "vault_create_event", label: "An event" },
];
const THEN = [
	{ value: "none", label: "Leave it" },
	{ value: "mark_read", label: "Mark read" },
	{ value: "archive", label: "Archive" },
	{ value: "trash", label: "Trash" },
];
const MODES = [
	{ value: "ask", label: "Ask" },
	{ value: "auto", label: "Auto" },
	{ value: "paused", label: "Paused" },
];

const EMPTY = {
	name: "",
	connector: "gmail",
	sender: "",
	contact_id: "",
	subject_has: "",
	expects: "",
	record_tool: "",
	record_instructions: "",
	then_action: "none",
	mode: "ask",
};

const when = (v) => (v ? `${formatDate(v)} ${formatTime(v)}` : "");

function Runs({ ruleId }) {
	const { data: runs = [], isLoading } = usePigeonRuleRuns(ruleId);
	return (
		<PvTable
			size="sm"
			loading={isLoading}
			rowKey="id"
			data={runs}
			emptyText="No runs yet."
			columns={[
				{ key: "at", title: "When", render: (_v, r) => when(r.created_at) },
				{
					key: "msg",
					title: "Message",
					render: (_v, r) => r.message?.subject || r.message?.from || "—",
				},
				{ key: "status", title: "", dataIndex: "status" },
			]}
		/>
	);
}

// Make or change a rule; try it on what came in already.
function RuleDrawer({ rule, onClose }) {
	const save = useSetPigeonRule();
	const del = useDeletePigeonRule();
	const tryRule = useTryPigeonRule();
	const { data: people = [] } = usePigeonContacts("");
	const [form, setForm] = useState(EMPTY);
	const [tried, setTried] = useState(null);
	const id = rule?.id ?? null;

	useEffect(() => {
		setTried(null);
		if (!rule) return;
		setForm(
			rule.id
				? {
						name: rule.name ?? "",
						connector: rule.connector ?? "gmail",
						sender: rule.sender ?? "",
						contact_id: rule.contact_id ?? "",
						subject_has: rule.subject_has ?? "",
						expects: rule.expects ?? "",
						record_tool: rule.record_tool ?? "",
						record_instructions: rule.record_instructions ?? "",
						then_action: rule.then_action ?? "none",
						mode: rule.mode ?? "ask",
					}
				: EMPTY,
		);
	}, [rule]);

	const fail = (e) => pvMessage.error(errorText(e));
	const text = (k) => ({
		value: form[k],
		onChange: (e) => setForm((f) => ({ ...f, [k]: e.target.value })),
	});
	const pick = (k) => ({
		value: form[k],
		onChange: (v) => setForm((f) => ({ ...f, [k]: v ?? "" })),
	});

	const onSave = () =>
		save.mutate(
			{ ...(id ? { rule_id: id } : {}), ...form },
			{
				onSuccess: () => {
					pvMessage.success("Saved");
					if (!id) onClose();
				},
				onError: fail,
			},
		);

	const onTry = (apply) =>
		tryRule.mutate(
			{ id, limit: 5, apply },
			{
				onSuccess: (r) => {
					setTried(r);
					if (apply) pvMessage.success("Ran on them");
				},
				onError: fail,
			},
		);

	const results = tried?.messages ?? [];

	return (
		<PvDrawer
			open={!!rule}
			onClose={onClose}
			placement="right"
			width={460}
			title={id ? rule.name : "New rule"}
		>
			<div className="inbox-rule">
				<PvField label="Name">
					<PvInput {...text("name")} placeholder="Bank transfers" />
				</PvField>
				<PvField label="Channel" as="div">
					<PvSegmented size="sm" options={CONNECTORS} {...pick("connector")} />
				</PvField>
				<PvField
					label="From"
					hint="An address, @domain for anyone there, a phone number."
				>
					<PvInput {...text("sender")} placeholder="alerts@bank.example" />
				</PvField>
				<PvField label="Or a person">
					<PvSelect
						allowClear
						placeholder="Anyone"
						options={people.map((p) => ({
							value: p.contact_id,
							label: p.name || p.slug,
						}))}
						{...pick("contact_id")}
					/>
				</PvField>
				<PvField label="The subject has">
					<PvInput {...text("subject_has")} />
				</PvField>
				<PvField
					label="What these messages are"
					hint="Jev checks each one is this."
				>
					<PvInput
						{...text("expects")}
						placeholder="a notice of a successful transfer or payment"
					/>
				</PvField>
				<PvField label="Record" as="div">
					<PvSelect options={RECORD} {...pick("record_tool")} />
				</PvField>
				{form.record_tool ? (
					<PvField
						label="How to fill it in"
						hint="Say the note's folder, title and line format."
					>
						<PvTextarea
							autoSize
							maxHeight={160}
							{...text("record_instructions")}
						/>
					</PvField>
				) : null}
				<PvField label="Then the message" as="div">
					<PvSegmented size="sm" options={THEN} {...pick("then_action")} />
				</PvField>
				<PvField label="Mode" as="div" hint="Ask: each run waits for your tap.">
					<PvSegmented size="sm" options={MODES} {...pick("mode")} />
				</PvField>
				<div className="inbox-rule-actions">
					<PvButton variant="primary" loading={save.isPending} onClick={onSave}>
						Save
					</PvButton>
					{id ? (
						<>
							<PvButton
								loading={tryRule.isPending}
								onClick={() => onTry(false)}
							>
								Try on past messages
							</PvButton>
							<PvPopconfirm
								title="Delete this rule?"
								description="Its runs go with it; what it did stays done."
								okText="Delete"
								onConfirm={() =>
									del.mutate(id, { onSuccess: onClose, onError: fail })
								}
							>
								<PvButton variant="danger">Delete</PvButton>
							</PvPopconfirm>
						</>
					) : null}
				</div>

				{tried ? (
					<PvField label="Tried" as="div">
						{results.length ? (
							<ul className="inbox-rule-tried">
								{results.map((r, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: a one-off result list
									<li key={i}>
										<PvTag
											color={r.steps || r.run ? "var(--vp-success)" : undefined}
										>
											{Math.round((r.matched ?? 0) * 100)}%
										</PvTag>{" "}
										{r.message?.subject || r.message?.from}{" "}
										<span className="inbox-muted">{when(r.message?.at)}</span>
										{r.would ? (
											<div className="inbox-muted">→ {r.would}</div>
										) : null}
										{r.run ? (
											<div className="inbox-muted">→ {r.run.status}</div>
										) : null}
									</li>
								))}
							</ul>
						) : (
							<div className="inbox-muted">Nothing it would have met.</div>
						)}
						{!tried.applied && results.some((r) => r.steps) ? (
							<PvButton
								size="sm"
								loading={tryRule.isPending}
								onClick={() => onTry(true)}
							>
								Run it on them
							</PvButton>
						) : null}
					</PvField>
				) : null}

				{id ? (
					<PvField label="Runs" as="div">
						<Runs ruleId={id} />
					</PvField>
				) : null}
			</div>
		</PvDrawer>
	);
}

export default function InboxRules() {
	const { data: rules = [], isLoading } = usePigeonRules();
	const [open, setOpen] = useState(null);

	const columns = [
		{ key: "name", title: "Rule", dataIndex: "name" },
		{
			key: "connector",
			title: "Channel",
			render: (_v, r) =>
				r.connector === "*" ? "Any" : channelLabel(r.connector),
		},
		{
			key: "match",
			title: "Matches",
			render: (_v, r) =>
				[r.sender, r.subject_has && `“${r.subject_has}”`]
					.filter(Boolean)
					.join(" · ") || "a person",
		},
		{
			key: "then",
			title: "Then",
			render: (_v, r) =>
				[
					r.record_tool?.replace("vault_", ""),
					r.then_action !== "none" && r.then_action,
				]
					.filter(Boolean)
					.join(", ") || "—",
		},
		{ key: "mode", title: "Mode", dataIndex: "mode" },
		{
			key: "runs",
			title: "30 days",
			render: (_v, r) =>
				Object.entries(r.runs_30_days ?? {})
					.map(([k, n]) => `${n} ${k}`)
					.join(", ") || "—",
		},
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
				<h1>Rules</h1>
				<PvButton
					size="sm"
					variant="primary"
					icon={<PlusOutlined />}
					onClick={() => setOpen({})}
				>
					New rule
				</PvButton>
			</header>
			<p className="inbox-muted">
				For what a sender keeps sending (bank alerts, receipts): record it in
				the vault, then archive or trash it. Piuma can make them too.
			</p>
			<PvTable
				columns={columns}
				data={rules}
				rowKey="id"
				loading={isLoading}
				emptyText="No rules yet."
				onRowClick={(r) => setOpen(r)}
			/>
			<RuleDrawer rule={open} onClose={() => setOpen(null)} />
		</section>
	);
}
