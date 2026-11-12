import { useState } from "react";
import { PvButton, PvModal, PvTag, pvMessage } from "@/ui";
import { useMarkPigeonReplyWrong } from "../../../queries";
import { timeAgo } from "../../../utils/dateTime";
import { errorText, percent, permissionLabel } from "./inboxText";

// Under a reply of Pigeon's that told something ("🔑 Used Place · City"): a
// click says what it was told, by which permission and where that comes from,
// and how sure Jev was that they asked for it. "This was wrong" puts the
// permissions behind it back to Ask.
// item: a message of the user's side with `used` ([use]) and `action_id`.
export default function Used({ item }) {
	const wrong = useMarkPigeonReplyWrong();
	const [open, setOpen] = useState(false);
	const used = item.used ?? [];
	if (!used.length) return null;
	const marked = used.some((u) => u.wrong);
	const close = () => setOpen(false);
	const onWrong = () =>
		wrong.mutate(
			{ actionId: item.action_id },
			{
				onSuccess: (d) =>
					pvMessage.success(
						d?.changed?.length
							? `Back to Ask: ${d.changed.map(permissionLabel).join(", ")}`
							: "Noted",
					),
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);
	return (
		<>
			<PvButton
				size="sm"
				variant="text"
				plain
				className={`inbox-used${marked ? " is-wrong" : ""}`}
				onClick={() => setOpen(true)}
			>
				🔑 Used {used.map(permissionLabel).join(", ")}
				{marked ? " · wrong" : ""}
			</PvButton>
			<PvModal
				open={open}
				title="What Pigeon used"
				onCancel={close}
				width="460px"
				footer={
					<>
						{item.action_id && !marked ? (
							<PvButton
								size="sm"
								variant="danger"
								loading={wrong.isPending}
								onClick={onWrong}
							>
								This was wrong
							</PvButton>
						) : null}
						<PvButton size="sm" onClick={close}>
							Close
						</PvButton>
					</>
				}
			>
				<div className="inbox-used-list">
					{used.map((u) => (
						<div key={`${u.tool}${u.grant_id ?? u.via}`}>
							<div className="inbox-used-head">
								<strong>{permissionLabel(u)}</strong>
								{u.auto ? <PvTag color="var(--vp-accent)">Auto</PvTag> : null}
								{u.stale ? <PvTag color="var(--vp-warning)">Old</PvTag> : null}
								{u.wrong ? <PvTag color="var(--vp-danger)">Wrong</PvTag> : null}
							</div>
							{u.told ? <div className="inbox-used-told">{u.told}</div> : null}
							<div className="inbox-used-how">
								{[
									u.via ? `Allowed: ${u.via}` : null,
									u.at ? `known ${timeAgo(u.at)}` : null,
									typeof u.jev === "number"
										? `Jev was ${percent(u.jev)} sure they asked`
										: null,
								]
									.filter(Boolean)
									.join(" · ")}
							</div>
						</div>
					))}
					{marked ? (
						<p className="inbox-used-how">
							Marked wrong: what allowed it asks you again.
						</p>
					) : null}
				</div>
			</PvModal>
		</>
	);
}
