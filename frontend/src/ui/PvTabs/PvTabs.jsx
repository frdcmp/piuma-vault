import { useState } from "react";
import "./PvTabs.css";

/**
 * Pixel tab strip + the active tab's content.
 *
 * Props:
 *   items:            Array<{ key, label, children, disabled? }>
 *   activeKey:        controlled active key (omit for uncontrolled)
 *   defaultActiveKey: initial key when uncontrolled (default: first item)
 *   onChange:         (key) => void
 *   extra:            node right-aligned in the strip
 */
export default function PvTabs({
	items = [],
	activeKey,
	defaultActiveKey,
	onChange,
	extra,
	className = "",
}) {
	const [own, setOwn] = useState(defaultActiveKey ?? items[0]?.key);
	const active = activeKey ?? own;
	const current = items.find((it) => it.key === active);

	const select = (key) => {
		if (key === active) return;
		if (activeKey === undefined) setOwn(key);
		onChange?.(key);
	};

	return (
		<div className={`pv-tabs ${className}`.trim()}>
			<div className="pv-tabs-strip" role="tablist">
				{items.map((it) => (
					<button
						key={it.key}
						type="button"
						role="tab"
						aria-selected={it.key === active}
						disabled={it.disabled}
						className={`pv-tabs-tab${it.key === active ? " is-active" : ""}`}
						onClick={() => select(it.key)}
					>
						{it.label}
					</button>
				))}
				{extra != null && <div className="pv-tabs-extra">{extra}</div>}
			</div>
			<div className="pv-tabs-panel" role="tabpanel">
				{current?.children}
			</div>
		</div>
	);
}
