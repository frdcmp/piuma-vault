import {
	ArrowLeftOutlined,
	DisconnectOutlined,
	LinkOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
	PvAlert,
	PvButton,
	PvField,
	PvIconButton,
	PvModal,
	PvPanel,
	PvPopconfirm,
	PvSegmented,
	PvSelect,
	PvSpin,
	PvSwitch,
	PvTag,
	pvMessage,
} from "@/ui";
import {
	useAllModels,
	useDisconnectPigeon,
	useImportPigeonWhatsappNames,
	useLearnAllPigeonContacts,
	usePigeonConnections,
	usePigeonConnectLink,
	usePigeonPairing,
	usePigeonSettings,
	useSetPigeonSettings,
	useUserMe,
} from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import {
	ALERT_HINT,
	ALERT_OPTIONS,
	channelLabel,
	errorText,
	POLICY_OPTIONS,
} from "./inboxText";
import SwitchInfo from "./SwitchInfo";

// WhatsApp pairs as a linked device: the QR the bridge shows, scanned from the
// phone (WhatsApp → Linked devices). The code turns over, so it's polled.
function PairingModal({ connector, onClose }) {
	const { data, error } = usePigeonPairing(connector, !!connector);
	useEffect(() => {
		if (data?.state === "connected") {
			pvMessage.success(
				`${channelLabel(connector)} connected${data.account ? `: ${data.account}` : ""}`,
			);
			onClose();
		}
	}, [data, connector, onClose]);
	return (
		<PvModal
			open={!!connector}
			title={`Connect ${channelLabel(connector)}`}
			onCancel={onClose}
			footer={null}
			showClose
		>
			{error ? (
				<PvAlert type="error" title="Couldn't start pairing">
					{errorText(error)}
				</PvAlert>
			) : data?.state === "code" ? (
				<div className="inbox-pairing">
					<img
						src={`data:image/png;base64,${data.qr_png}`}
						alt="The pairing code to scan"
					/>
					<p>
						{data.how ||
							"Scan it from the phone: WhatsApp → Settings → Linked devices → Link a device."}
					</p>
				</div>
			) : (
				<PvSpin block label="Waiting for the code…" />
			)}
		</PvModal>
	);
}

function Channel({ c, accounts, onPair }) {
	const link = usePigeonConnectLink();
	const disconnect = useDisconnectPigeon();
	const connect = () => {
		if (c.connects_by_pairing) return onPair(c.id);
		link.mutate(c.id, {
			// the provider's consent screen, then back here
			onSuccess: (r) => window.location.assign(r.url),
			onError: (e) => pvMessage.error(errorText(e)),
		});
	};
	const canConnect =
		c.available && (c.connects_by_link || c.connects_by_pairing);
	const problem =
		c.health && c.health.ok === false
			? c.health.error || c.health.problem || "not working"
			: null;

	return (
		<div className="inbox-channel">
			<div className="inbox-channel-head">
				<span className="inbox-channel-name">{c.title}</span>
				{!c.available ? (
					<PvTag>off</PvTag>
				) : problem ? (
					<PvTag color="var(--vp-danger)">trouble</PvTag>
				) : null}
				<span className="inbox-channel-grow" />
				{canConnect ? (
					<PvButton
						size="sm"
						icon={<LinkOutlined />}
						loading={link.isPending}
						onClick={connect}
					>
						{accounts.length ? "Add account" : "Connect"}
					</PvButton>
				) : null}
			</div>
			{!c.available ? (
				<div className="inbox-channel-note">{c.why_not}</div>
			) : null}
			{problem ? (
				<div className="inbox-channel-note is-bad">{problem}</div>
			) : null}
			{accounts.map((a) => (
				<div key={a.id} className="inbox-account">
					<span className="inbox-account-name">{a.account}</span>
					<PvTag
						color={
							a.status === "connected"
								? "var(--vp-success)"
								: "var(--vp-warning)"
						}
					>
						{a.status}
					</PvTag>
					{a.last_ok_at ? (
						<span className="inbox-account-when">
							ok {timeAgo(a.last_ok_at)}
						</span>
					) : null}
					{a.last_error ? (
						<span className="inbox-channel-note is-bad">{a.last_error}</span>
					) : null}
					<span className="inbox-channel-grow" />
					<PvPopconfirm
						title={`Disconnect ${a.account}?`}
						description="Pigeon stops reading and writing there. The chats stay."
						okText="Disconnect"
						onConfirm={() =>
							disconnect.mutate(a.id, {
								onSuccess: () => pvMessage.success("Disconnected"),
								onError: (e) => pvMessage.error(errorText(e)),
							})
						}
					>
						<PvIconButton
							size="sm"
							variant="ghost-danger"
							icon={<DisconnectOutlined />}
							label={`Disconnect ${a.account}`}
						/>
					</PvPopconfirm>
				</div>
			))}
		</div>
	);
}

export default function InboxSettings() {
	const { data: s, isLoading } = usePigeonSettings();
	const { data: connections = [] } = usePigeonConnections();
	const { data: me } = useUserMe();
	const isAdmin = !!me?.permissions?.includes("admin_access");
	const { data: models = [] } = useAllModels({ enabled: isAdmin });
	const save = useSetPigeonSettings();
	const learnAll = useLearnAllPigeonContacts();
	const whatsappNames = useImportPigeonWhatsappNames();
	const [pairing, setPairing] = useState(null);
	const closePairing = useCallback(() => setPairing(null), []);
	const [params, setParams] = useSearchParams();

	// Back from a provider's consent screen: how it went.
	useEffect(() => {
		const connected = params.get("connected");
		const failed = params.get("error");
		if (!connected && !failed) return;
		if (connected)
			pvMessage.success(
				`${channelLabel(connected)} connected${params.get("account") ? `: ${params.get("account")}` : ""}`,
			);
		else
			pvMessage.error(
				`${channelLabel(params.get("connector") || "")}: ${failed}`,
			);
		setParams({}, { replace: true });
	}, [params, setParams]);

	if (isLoading || !s) return <PvSpin block label="loading…" />;

	const set = (patch) =>
		save.mutate(patch, { onError: (e) => pvMessage.error(errorText(e)) });
	const channels = (s.connectors ?? []).filter(
		(c) => c.id !== "console" || s.console,
	);

	return (
		<section className="inbox-pane">
			<header className="inbox-pane-head">
				<PvIconButton
					to="/inbox"
					icon={<ArrowLeftOutlined />}
					label="Back to the chats"
					className="inbox-back"
				/>
				<h1>Inbox settings</h1>
			</header>

			<PvPanel title="Channels">
				{channels.map((c) => (
					<Channel
						key={c.id}
						c={c}
						accounts={connections.filter((a) => a.connector === c.id)}
						onPair={setPairing}
					/>
				))}
			</PvPanel>

			<PvPanel title="What Pigeon may do">
				<PvField
					label="Auto"
					as="div"
					hint="Off: every Auto switch below and on chats asks you instead. A quick stop for everything."
				>
					<PvSwitch
						checked={!!s.auto_enabled}
						onChange={(on) => set({ auto_enabled: on })}
						label={
							s.auto_enabled
								? "Allowed where a switch says Auto"
								: "Off everywhere"
						}
					/>
				</PvField>
				<PvField
					label={
						<>
							Replies to people
							<SwitchInfo kind="reply" top />
						</>
					}
					as="div"
					hint="The default; a person or a chat can have its own."
				>
					<PvSegmented
						size="sm"
						options={POLICY_OPTIONS}
						value={s.defaults?.reply}
						onChange={(v) => set({ reply: v })}
					/>
				</PvField>
				<PvField label="Recording (tasks, events, notes)" as="div">
					<PvSegmented
						size="sm"
						options={POLICY_OPTIONS}
						value={s.defaults?.record}
						onChange={(v) => set({ record: v })}
					/>
				</PvField>
				<PvField label="Organizing (read, archive)" as="div">
					<PvSegmented
						size="sm"
						options={POLICY_OPTIONS}
						value={s.defaults?.organize}
						onChange={(v) => set({ organize: v })}
					/>
				</PvField>
				<PvField
					label={
						<>
							Alerts on the phone
							<SwitchInfo kind="alerts" top />
						</>
					}
					as="div"
					hint={ALERT_HINT[s.alerts]}
				>
					<PvSegmented
						size="sm"
						options={ALERT_OPTIONS}
						value={s.alerts}
						onChange={(v) => set({ alerts: v })}
					/>
				</PvField>
			</PvPanel>

			<PvPanel title="Pigeon's brain">
				{!s.writer_available ? (
					<PvAlert type="warning" title="No model to write with">
						Pigeon needs a model to draft replies: add one in Agents.
					</PvAlert>
				) : null}
				{!s.jev_available ? (
					<PvAlert type="warning" title="Jev isn't set up">
						Without Jev (PIGEON_JEV_*), Pigeon can't sort what comes in.
					</PvAlert>
				) : null}
				{isAdmin ? (
					<PvField
						label="The model Pigeon writes with"
						hint="For everyone on this vault."
					>
						<PvSelect
							value={s.model_id ?? ""}
							onChange={(v) => set({ model_id: v ?? "" })}
							options={[
								{ value: "", label: "The default model" },
								...models.map((m) => ({
									value: m.id,
									label: `${m.display_name || m.model_id} · ${m.provider}`,
								})),
							]}
						/>
					</PvField>
				) : null}
				<PvField
					label="What Pigeon knows about people"
					as="div"
					hint="Reads your past chats (the last 90 days) to learn who everyone is and how you write to them."
				>
					<PvButton
						size="sm"
						loading={learnAll.isPending}
						onClick={() =>
							learnAll.mutate(
								{ days: 90 },
								{
									onSuccess: (r) =>
										pvMessage.success(
											r?.started
												? "Pigeon is learning: it takes a while."
												: "Pigeon is already learning.",
										),
									onError: (e) => pvMessage.error(errorText(e)),
								},
							)
						}
					>
						Learn from past chats
					</PvButton>
				</PvField>
				<PvField
					label="Names from your phone"
					as="div"
					hint="Names everyone Pigeon knows only by number the way you saved them on your phone, and adds your saved WhatsApp contacts as people."
				>
					<PvButton
						size="sm"
						loading={whatsappNames.isPending}
						onClick={() =>
							whatsappNames.mutate(undefined, {
								onSuccess: (r) =>
									pvMessage.success(
										`${r.named + r.named_from_whatsapp + r.named_from_messages} named, ${r.added} added (of ${r.address_book} in your address book).`,
									),
								onError: (e) => pvMessage.error(errorText(e)),
							})
						}
					>
						Names from WhatsApp
					</PvButton>
				</PvField>
			</PvPanel>

			<PairingModal connector={pairing} onClose={closePairing} />
		</section>
	);
}
