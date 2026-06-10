import { useEffect, useRef, useState } from "react";
import { useTagRegistry } from "../queries";
import { tagColor } from "../utils/tagColor";
import "./BucketTags.css";

/**
 * Tag editor for task/event modals. Manages an array of tag names (`value`),
 * suggesting existing registry tags via a colour-coded dropdown. New names are
 * added as-is (lowercased) — the backend registers them uncategorised (Inbox)
 * on save.
 */
export default function TagPicker({ value = [], onChange }) {
	const { data: registry = [] } = useTagRegistry();
	const [input, setInput] = useState("");
	const [open, setOpen] = useState(false);
	const ref = useRef(null);

	const colorOf = (name) =>
		registry.find((r) => r.name === name)?.color || tagColor(name);

	const add = (raw) => {
		const name = raw.trim().toLowerCase();
		setInput("");
		if (!name || value.includes(name)) return;
		onChange?.([...value, name]);
	};
	const remove = (name) => onChange?.(value.filter((n) => n !== name));

	const q = input.trim().toLowerCase();
	const suggestions = registry
		.filter((r) => !value.includes(r.name))
		.filter((r) => !q || r.name.includes(q));
	const canCreate =
		q && !registry.some((r) => r.name === q) && !value.includes(q);

	// Close the dropdown when clicking outside the picker.
	useEffect(() => {
		if (!open) return;
		const onDoc = (e) => {
			if (!ref.current?.contains(e.target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	return (
		<div className="tagpicker" ref={ref}>
			{value.length ? (
				<div className="tagpicker-chips">
					{value.map((name) => (
						<span
							className="tagpicker-chip"
							key={name}
							style={{ borderColor: colorOf(name), color: colorOf(name) }}
						>
							#{name}
							<button
								type="button"
								onClick={() => remove(name)}
								aria-label={`Remove #${name}`}
							>
								×
							</button>
						</span>
					))}
				</div>
			) : null}
			<input
				className="tagpicker-input"
				value={input}
				onChange={(e) => {
					setInput(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						e.stopPropagation(); // don't trigger the modal's Enter=confirm
						add(input);
					} else if (e.key === "Backspace" && !input && value.length) {
						remove(value[value.length - 1]);
					} else if (e.key === "Escape") {
						setOpen(false);
					}
				}}
				onBlur={() => input.trim() && add(input)}
				placeholder="Add tag…"
			/>
			{open && (suggestions.length || canCreate) ? (
				<ul className="tagpicker-menu">
					{canCreate ? (
						<li>
							<button
								type="button"
								className="tagpicker-opt tagpicker-create"
								// Keep the input focused so onBlur doesn't double-add.
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => add(input)}
							>
								+ create “#{q}”
							</button>
						</li>
					) : null}
					{suggestions.map((r) => (
						<li key={r.id}>
							<button
								type="button"
								className="tagpicker-opt"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => add(r.name)}
							>
								<span
									className="tagpicker-dot"
									style={{ background: r.color || tagColor(r.name) }}
								/>
								#{r.name}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
