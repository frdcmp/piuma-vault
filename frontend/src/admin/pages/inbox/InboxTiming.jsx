import { useEffect, useState } from "react";
import { PvButton, PvField, PvInput, PvPanel, pvMessage } from "@/ui";
import { useSetPigeonSettings } from "../../../queries";
import { errorText } from "./inboxText";
import { landing, longestPacing } from "./timing";

// The settings, in order: [key, label, unit, hint].
const FIELDS = [
	[
		"wait_secs",
		"Wait for them to finish writing",
		"s",
		"Pigeon reads their messages this long after the last one; each new message starts it again.",
	],
	[
		"read_secs",
		"Reading pause",
		"s",
		"Their messages turn read, then this long before “typing…” starts.",
	],
	["chars_per_sec", "Typing speed", "characters a second", "As on a phone."],
	[
		"typing_secs",
		"Typing time",
		"s",
		"However long the reply, “typing…” lasts within this.",
	],
	[
		"cold_secs",
		"First reply in a quiet chat lands after",
		"s",
		"In a quiet chat, the reply comes no sooner than this after their message.",
	],
	[
		"quiet_minutes",
		"A chat is quiet after",
		"min",
		"Nobody on your side (you or Pigeon) wrote there for this long.",
	],
	[
		"stay_out_minutes",
		"After you write there, Pigeon stays out for",
		"min",
		"It doesn't answer in a chat you just wrote in yourself.",
	],
];

/** A number within the setting's limits (an empty or half-typed one waits). */
function NumberIn({ value, onChange, limits: [lo, hi], label }) {
	return (
		<PvInput
			size="sm"
			type="number"
			min={lo}
			max={hi}
			value={value}
			aria-label={label}
			className="inbox-timing-num"
			onChange={(e) => {
				const v = Number(e.target.value);
				if (e.target.value !== "" && Number.isFinite(v)) onChange(v);
			}}
		/>
	);
}

/**
 * Reply timing, as in the phone app's screen: how long Pigeon waits around a
 * reply it sends on its own (the backend's `timing`), with what a reply's wait
 * comes to. Save keeps it; Reset goes back to Pigeon's own.
 */
export default function InboxTiming({ view }) {
	const save = useSetPigeonSettings();
	const [t, setT] = useState(view.values);
	useEffect(() => setT(view.values), [view.values]);
	const set = (k, v) => setT((x) => ({ ...x, [k]: v }));
	const dirty = JSON.stringify(t) !== JSON.stringify(view.values);
	const isDefault = JSON.stringify(t) === JSON.stringify(view.defaults);
	const longest = longestPacing(t, view);
	const outside = FIELDS.find(([k]) => {
		const [lo, hi] = view.limits[k];
		const vs = [t[k]].flat();
		return (
			vs.some((v) => v < lo || v > hi) || (vs.length === 2 && vs[0] > vs[1])
		);
	});
	const tooLong = longest > view.max_pacing;
	const between = ([a, b]) => `${a}–${b} s`;
	const onSave = (reset) =>
		save.mutate(reset ? { timing_reset: true } : { timing: t }, {
			onSuccess: () =>
				pvMessage.success(reset ? "Back to Pigeon's timing" : "Saved"),
			onError: (e) => pvMessage.error(errorText(e)),
		});

	return (
		<PvPanel
			title="Reply timing"
			extra={
				<div className="inbox-timing-actions">
					<PvButton
						size="sm"
						variant="ghost"
						disabled={isDefault && !dirty}
						loading={save.isPending && save.variables?.timing_reset}
						onClick={() => onSave(true)}
					>
						Reset to defaults
					</PvButton>
					<PvButton
						size="sm"
						variant="primary"
						disabled={!dirty || tooLong || !!outside}
						loading={save.isPending && !!save.variables?.timing}
						onClick={() => onSave(false)}
					>
						Save
					</PvButton>
				</div>
			}
		>
			<p className="vp-muted inbox-timing-intro">
				How long Pigeon waits around a reply it sends on its own, so it comes
				like yours. On WhatsApp and Instagram they see it read and typing.
			</p>
			{FIELDS.map(([k, label, unit, hint]) => {
				const limits = view.limits[k];
				const range = Array.isArray(t[k]);
				return (
					<PvField
						key={k}
						label={label}
						as="div"
						hint={`${hint} From ${limits[0]} to ${limits[1]} ${unit}.`}
					>
						<div className="inbox-timing-row">
							{range ? (
								<>
									<NumberIn
										value={t[k][0]}
										limits={limits}
										label={`${label}, from`}
										onChange={(v) => set(k, [v, t[k][1]])}
									/>
									<span className="vp-muted">to</span>
									<NumberIn
										value={t[k][1]}
										limits={limits}
										label={`${label}, to`}
										onChange={(v) => set(k, [t[k][0], v])}
									/>
								</>
							) : (
								<NumberIn
									value={t[k]}
									limits={limits}
									label={label}
									onChange={(v) => set(k, v)}
								/>
							)}
							<span className="vp-muted">{unit}</span>
						</div>
					</PvField>
				);
			})}
			<div className="inbox-timing-preview">
				<strong>So a reply comes</strong>
				<span>
					Short (30 characters): about {between(landing(t, 30))} after their
					message · long (300 characters): about {between(landing(t, 300))} ·
					first in a quiet chat: about {between(landing(t, 30, true))}.
				</span>
				<span className="vp-muted">With 5–15 s for Pigeon to write it.</span>
				{outside ? (
					<span className="inbox-timing-bad">
						{outside[1]}: from {view.limits[outside[0]][0]} to{" "}
						{view.limits[outside[0]][1]}, the first no more than the second.
					</span>
				) : tooLong ? (
					<span className="inbox-timing-bad">
						Pigeon could wait up to {Math.round(longest)} s before a reply goes:
						at most {view.max_pacing} s. Shorten the typing, the reading pause
						or the quiet chat's landing.
					</span>
				) : null}
			</div>
		</PvPanel>
	);
}
