import { InfoCircleOutlined } from "@ant-design/icons";
import { useState } from "react";
import { PvIconButton, PvModal } from "@/ui";
import { SWITCH_INFO } from "./inboxText";

// The ⓘ beside a switch's label: what each of its values does.
// kind: "reply" | "alerts" · top: the Inbox's own default (nothing above it to follow)
export default function SwitchInfo({ kind, top }) {
	const [open, setOpen] = useState(false);
	const info = SWITCH_INFO[kind];
	return (
		<>
			<PvIconButton
				size="sm"
				variant="ghost"
				icon={<InfoCircleOutlined />}
				label={`What ${info.title.toLowerCase()} do`}
				className="inbox-switch-info"
				onClick={(e) => {
					e.preventDefault();
					setOpen(true);
				}}
			/>
			<PvModal
				open={open}
				title={info.title}
				onCancel={() => setOpen(false)}
				footer={null}
				width={460}
			>
				<dl className="inbox-switch-explain">
					{info.rows
						.filter((r) => !top || r.label !== "Default")
						.map((r) => (
							<div key={r.label}>
								<dt>{r.label}</dt>
								<dd>{r.text}</dd>
							</div>
						))}
				</dl>
				{info.foot ? <p className="inbox-switch-foot">{info.foot}</p> : null}
			</PvModal>
		</>
	);
}
