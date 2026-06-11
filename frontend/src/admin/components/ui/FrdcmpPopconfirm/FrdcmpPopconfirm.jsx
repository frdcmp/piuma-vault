import { ExclamationCircleFilled } from "@ant-design/icons";
import { cloneElement, useRef, useState } from "react";
import PvButton from "../PvButton";
import PvPopover from "../PvPopover";
import "./PvPopconfirm.css";

/**
 * Pixel-themed confirmation bubble anchored to its trigger — the pv
 * replacement for antd's <Popconfirm>. Wrap the trigger element as the single
 * child; clicking it opens a small confirm popover (built on PvPopover)
 * with Cancel / Confirm actions. Dismisses on Escape or outside click.
 *
 * Props:
 *   title       — the confirmation question.
 *   description — optional secondary line.
 *   okText / cancelText — button labels (default "Confirm" / "Cancel").
 *   okVariant   — PvButton variant for the confirm button (default "danger").
 *   onConfirm   — called when confirmed (the popover then closes).
 *   align       — "start" | "end" passed through to PvPopover (default "end").
 */
export default function PvPopconfirm({
	title,
	description,
	okText = "Confirm",
	cancelText = "Cancel",
	okVariant = "danger",
	onConfirm,
	align = "end",
	children,
}) {
	const anchorRef = useRef(null);
	const [open, setOpen] = useState(false);

	const confirm = () => {
		setOpen(false);
		onConfirm?.();
	};

	// Inject the toggle onto the trigger itself (an interactive element) so the
	// anchor span stays a passive positioning wrapper.
	const trigger = cloneElement(children, {
		onClick: (e) => {
			children.props.onClick?.(e);
			setOpen((o) => !o);
		},
	});

	return (
		<>
			<span ref={anchorRef} className="pv-popconfirm-anchor">
				{trigger}
			</span>
			<PvPopover
				open={open}
				anchorRef={anchorRef}
				onClose={() => setOpen(false)}
				align={align}
				width={250}
				className="pv-popconfirm"
			>
				<div className="pv-popconfirm-head">
					<ExclamationCircleFilled className="pv-popconfirm-icon" />
					<div className="pv-popconfirm-text">
						<div className="pv-popconfirm-title">{title}</div>
						{description != null && (
							<div className="pv-popconfirm-desc">{description}</div>
						)}
					</div>
				</div>
				<div className="pv-popconfirm-actions">
					<PvButton
						size="sm"
						variant="ghost"
						onClick={() => setOpen(false)}
					>
						{cancelText}
					</PvButton>
					<PvButton size="sm" variant={okVariant} onClick={confirm}>
						{okText}
					</PvButton>
				</div>
			</PvPopover>
		</>
	);
}
