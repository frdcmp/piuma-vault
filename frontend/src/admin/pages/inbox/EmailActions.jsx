import {
	DeleteOutlined,
	ExportOutlined,
	InboxOutlined,
} from "@ant-design/icons";
import { PvButton, pvConfirm, pvMessage } from "@/ui";
import { usePigeonEmailAction } from "../../../queries";
import { errorText } from "./inboxText";

// Under an email, as on the phone: open it in Gmail, archive it (out of the
// inbox, kept: then marked here) or delete it (to Gmail's Trash, after a yes:
// gone from here). Archive and delete only for one that came in.
export default function EmailActions({ item }) {
	const act = usePigeonEmailAction();
	const theirs = item.direction === "in";
	const run = (action) =>
		act.mutate(
			{ item: item.id, action },
			{
				onSuccess: () =>
					pvMessage.success(
						action === "trash" ? "Moved to Gmail's Trash" : "Archived",
					),
				onError: (e) => pvMessage.error(errorText(e)),
			},
		);
	const busy = (action) => act.isPending && act.variables?.action === action;
	const onDelete = async () => {
		const yes = await pvConfirm({
			title: "Delete this email?",
			content:
				"It goes to Gmail's Trash (Gmail deletes it for good after 30 days) and leaves this chat.",
			okText: "Delete",
			danger: true,
		});
		if (yes) run("trash");
	};
	return (
		<div className="inbox-email-actions">
			{item.open_url ? (
				<PvButton
					size="sm"
					icon={<ExportOutlined />}
					href={item.open_url}
					target="_blank"
					rel="noreferrer"
				>
					Open
				</PvButton>
			) : null}
			{theirs && !item.archived ? (
				<PvButton
					size="sm"
					icon={<InboxOutlined />}
					loading={busy("archive")}
					disabled={act.isPending}
					onClick={() => run("archive")}
				>
					Archive
				</PvButton>
			) : null}
			{theirs ? (
				<PvButton
					size="sm"
					variant="danger"
					icon={<DeleteOutlined />}
					loading={busy("trash")}
					disabled={act.isPending}
					onClick={onDelete}
				>
					Delete
				</PvButton>
			) : null}
			{item.archived ? (
				<span className="inbox-email-archived">
					<InboxOutlined /> Archived
				</span>
			) : null}
		</div>
	);
}
