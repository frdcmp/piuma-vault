import { ClockCircleOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import {
	PvButton,
	PvIconButton,
	PvInput,
	PvModal,
	PvSegmented,
	pvMessage,
} from "@/ui";
import {
	useEndPigeonAway,
	usePigeonAway,
	useSetPigeonAway,
} from "../../../queries";
import { formatTime } from "../../../utils/dateTime";
import { errorText } from "./inboxText";

// Away mode: while you're away Pigeon answers people on WhatsApp and Instagram
// itself, as Pigeon (each message marked), takes messages and notes what they
// want; Pigeon's chat says what happened when you're back.

const REASONS = [
	"Sleeping",
	"Taking a nap",
	"On a plane",
	"In a meeting",
	"Driving",
];
// How long: minutes, "morning" (the next 08:00), or "none" (until you end it).
const LONG = [
	{ value: "60", label: "1 hour" },
	{ value: "120", label: "2 hours" },
	{ value: "240", label: "4 hours" },
	{ value: "morning", label: "Until 08:00" },
	{ value: "none", label: "Until I'm back" },
];

const untilOf = (long) => {
	if (long === "none") return null;
	const d = new Date();
	if (long === "morning") {
		const eight = new Date(d);
		eight.setHours(8, 0, 0, 0);
		if (eight <= d) eight.setDate(eight.getDate() + 1);
		return eight.toISOString();
	}
	return new Date(d.getTime() + Number(long) * 60000).toISOString();
};

// The rail's button: go away, or change it.
export function AwayButton() {
	const { data } = usePigeonAway();
	const [open, setOpen] = useState(false);
	return (
		<>
			<PvIconButton
				icon={<ClockCircleOutlined />}
				label={data?.away ? "Away: change it" : "Go away"}
				active={!!data?.away}
				onClick={() => setOpen(true)}
			/>
			<AwayDialog open={open} onClose={() => setOpen(false)} />
		</>
	);
}

// Under the rail's head while you're away: why, until when; End brings you back.
export function AwayStrip() {
	const { data } = usePigeonAway();
	const end = useEndPigeonAway();
	const away = data?.away;
	if (!away) return null;
	return (
		<div className="inbox-away" role="status">
			<ClockCircleOutlined />
			<span className="inbox-away-text">
				Away · {away.reason}
				{away.until ? ` · until ${formatTime(away.until)}` : ""}
			</span>
			<PvButton
				size="sm"
				loading={end.isPending}
				onClick={() =>
					end.mutate(undefined, {
						onSuccess: () =>
							pvMessage.success(
								"Welcome back: Pigeon's chat says what happened",
							),
						onError: (e) => pvMessage.error(errorText(e)),
					})
				}
			>
				End
			</PvButton>
		</div>
	);
}

function AwayDialog({ open, onClose }) {
	const { data } = usePigeonAway();
	const set = useSetPigeonAway();
	const away = data?.away;
	const [reason, setReason] = useState("");
	const [long, setLong] = useState("none");
	useEffect(() => {
		if (open) {
			setReason(away?.reason ?? "");
			setLong("none");
		}
	}, [open, away?.reason]);
	const go = () => {
		if (!reason.trim()) return;
		set.mutate(
			{ reason: reason.trim(), until: untilOf(long) },
			{
				onSuccess: () => {
					pvMessage.success(
						away ? "Away: changed" : "Away: Pigeon answers for you now",
					);
					onClose();
				},
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);
	};
	return (
		<PvModal
			open={open}
			title={away ? "Away" : "Go away"}
			onCancel={onClose}
			onConfirm={go}
			confirmText={away ? "Save" : "Go away"}
			width="440px"
		>
			<div className="inbox-away-form">
				<p className="inbox-away-help">
					Pigeon answers people on WhatsApp and Instagram as Pigeon (each
					message marked 🕊️), says you're away, takes messages and notes what
					they want. It never agrees to anything for you. People you write to
					hear why; others only that you're away.
				</p>
				<div className="inbox-away-reasons">
					{REASONS.map((r) => (
						<PvButton
							key={r}
							size="sm"
							variant={reason === r ? "primary" : "default"}
							onClick={() => setReason(r)}
						>
							{r}
						</PvButton>
					))}
				</div>
				<PvInput
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="Or say why: at the dentist, on holiday…"
					maxLength={200}
					aria-label="Why you're away"
				/>
				<PvSegmented
					size="sm"
					block
					options={LONG}
					value={long}
					onChange={setLong}
				/>
			</div>
		</PvModal>
	);
}
