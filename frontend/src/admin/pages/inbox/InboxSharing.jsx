import { KeyOutlined } from "@ant-design/icons";
import { PvButton, PvField, PvSwitch, pvMessage } from "@/ui";
import {
	usePausePigeonSharing,
	usePigeonAccess,
	useResumePigeonSharing,
} from "../../../queries";
import { formatTime } from "../../../utils/dateTime";
import { errorText } from "./inboxText";

// What Pigeon may tell the people who write (the user's place, their calendar,
// their flights, something left for someone) is set per person, chat or group:
// in the phone's app, or by asking Claude. Here: the pause, a quick stop for all
// of it.

const fail = (e) => pvMessage.error(errorText(e));

// Under the rail's head while telling is paused; Resume brings it back.
export function SharingStrip() {
	const { data } = usePigeonAccess();
	const resume = useResumePigeonSharing();
	const paused = data?.paused;
	if (!paused) return null;
	return (
		<div className="inbox-away" role="status">
			<KeyOutlined />
			<span className="inbox-away-text">
				Telling paused
				{paused.until ? ` · until ${formatTime(paused.until)}` : ""}
			</span>
			<PvButton
				size="sm"
				loading={resume.isPending}
				onClick={() => resume.mutate(undefined, { onError: fail })}
			>
				Resume
			</PvButton>
		</div>
	);
}

// The settings' switch.
export function SharingField() {
	const { data } = usePigeonAccess();
	const pause = usePausePigeonSharing();
	const resume = useResumePigeonSharing();
	if (!data) return null;
	const paused = data.paused;
	return (
		<PvField
			label="Telling people"
			as="div"
			hint="Where you are, whether you're free, your flights, what you left for someone: only to who you allowed (per person, in the app or by asking Claude). Off: Pigeon tells nobody any of it."
		>
			<PvSwitch
				checked={!paused}
				loading={pause.isPending || resume.isPending}
				onChange={(on) =>
					(on ? resume : pause).mutate(undefined, { onError: fail })
				}
				label={
					paused
						? `Paused${paused.until ? ` until ${formatTime(paused.until)}` : ""}`
						: "To who you allowed"
				}
			/>
		</PvField>
	);
}
