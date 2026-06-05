import { useState } from "react";
import { useTagRegistry } from "../queries";
import { tagColor } from "../utils/tagColor";
import "./BucketTags.css";

/**
 * Tag editor for task/event modals. Manages an array of tag names (`value`),
 * suggesting existing registry tags via autocomplete. New names are added as-is
 * (lowercased) — the backend registers them uncategorized (Inbox) on save.
 */
export default function TagPicker({ value = [], onChange }) {
	const { data: registry = [] } = useTagRegistry();
	const [input, setInput] = useState("");

	const colorOf = (name) =>
		registry.find((r) => r.name === name)?.color || tagColor(name);

	const add = (raw) => {
		const name = raw.trim().toLowerCase();
		setInput("");
		if (!name || value.includes(name)) return;
		onChange?.([...value, name]);
	};
	const remove = (name) => onChange?.(value.filter((n) => n !== name));

	const suggestions = registry.filter((r) => !value.includes(r.name));

	return (
		<div className="tagpicker">
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
				list="tagpicker-suggestions"
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						e.stopPropagation(); // don't trigger the modal's Enter=confirm
						add(input);
					} else if (e.key === "Backspace" && !input && value.length) {
						remove(value[value.length - 1]);
					}
				}}
				onBlur={() => input.trim() && add(input)}
				placeholder="Add tag…"
			/>
			<datalist id="tagpicker-suggestions">
				{suggestions.map((r) => (
					<option key={r.id} value={r.name} />
				))}
			</datalist>
		</div>
	);
}
