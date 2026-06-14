// The dropdown rendered above the composer for both the slash-command list and
// the `/title` two-option submenu — same `.slash-menu` markup, different items.
// Each item: { key, name, desc, agent? }. `activeRef` (optional) is attached to
// the highlighted row so the host can scroll it into view (the dock does this).
export default function SlashMenu({
	items,
	active,
	onPick,
	onHover,
	activeRef,
}) {
	if (!items.length) return null;
	return (
		<div className="slash-menu">
			{items.map((it, i) => (
				<button
					key={it.key}
					type="button"
					ref={activeRef && i === active ? activeRef : null}
					className={`slash-item${i === active ? " is-active" : ""}${it.agent ? " slash-item--agent" : ""}`}
					onClick={() => onPick(it, i)}
					onMouseEnter={() => onHover(i)}
				>
					<span className="slash-item-name">{it.name}</span>
					<span className="slash-item-desc">{it.desc}</span>
				</button>
			))}
		</div>
	);
}
