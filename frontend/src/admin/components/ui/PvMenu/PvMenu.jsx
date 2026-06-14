import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./PvMenu.css";

/**
 * A right-click / context popup menu, file-explorer style. Controlled: the
 * parent owns `open` + the anchor point (`x`, `y`) and clears them in `onClose`.
 *
 * `items` is a flat list of:
 *   { label, icon?, danger?, disabled?, onClick }   — an action row
 *   { type: "separator" }                            — a divider
 *
 * The menu portals to <body>, clamps itself inside the viewport, and closes on
 * outside click, Escape, scroll, resize, or after an item is chosen.
 */
export default function PvMenu({
	open,
	x = 0,
	y = 0,
	items = [],
	onClose,
}) {
	const menuRef = useRef(null);
	// Start at the raw anchor; the layout effect clamps it before paint.
	const [pos, setPos] = useState({ x, y });

	// Clamp inside the viewport once we can measure the rendered menu. Runs only
	// when the open anchor changes — it derives the new position from x/y, never
	// from `pos`, so there's no feedback loop.
	useLayoutEffect(() => {
		if (!open || !menuRef.current) return;
		const r = menuRef.current.getBoundingClientRect();
		const pad = 8;
		const nx =
			x + r.width > window.innerWidth - pad
				? Math.max(pad, window.innerWidth - r.width - pad)
				: x;
		const ny =
			y + r.height > window.innerHeight - pad
				? Math.max(pad, window.innerHeight - r.height - pad)
				: y;
		setPos({ x: nx, y: ny });
	}, [open, x, y]);

	useEffect(() => {
		if (!open) return;
		const close = () => onClose?.();
		const onKey = (e) => {
			if (e.key === "Escape") onClose?.();
		};
		// Capture-phase so a scroll inside any container still dismisses.
		window.addEventListener("keydown", onKey);
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open, onClose]);

	if (!open) return null;

	const choose = (item) => {
		if (item.disabled) return;
		item.onClick?.();
		onClose?.();
	};

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: full-screen click/right-click catcher to dismiss
		<div
			className="pv-menu-overlay"
			onMouseDown={() => onClose?.()}
			onContextMenu={(e) => {
				e.preventDefault();
				onClose?.();
			}}
		>
			<div
				ref={menuRef}
				className="pv-menu"
				role="menu"
				style={{ left: pos.x, top: pos.y }}
				onMouseDown={(e) => e.stopPropagation()}
				onContextMenu={(e) => e.preventDefault()}
			>
				{items.map((item, i) =>
					item.type === "separator" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable menu
						<div key={`sep-${i}`} className="pv-menu-sep" />
					) : (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable menu
							key={`item-${i}`}
							type="button"
							role="menuitem"
							className={`pv-menu-item ${item.danger ? "danger" : ""}`}
							disabled={item.disabled}
							onClick={() => choose(item)}
						>
							{item.icon != null && (
								<span className="pv-menu-icon">{item.icon}</span>
							)}
							<span className="pv-menu-label">{item.label}</span>
						</button>
					),
				)}
			</div>
		</div>,
		document.body,
	);
}
