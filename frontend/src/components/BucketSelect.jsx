import { useEffect, useRef, useState } from "react";
import "./BucketTags.css";

/**
 * Color-aware bucket picker for the task/event editors. A custom dropdown (the
 * native <select> can't render the per-bucket colour dots) that mirrors the
 * pixel/terminal aesthetic. `value` is the bucket id ("" = no bucket).
 */
export default function BucketSelect({ value, onChange, buckets = [] }) {
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	const selected = buckets.find((b) => String(b.id) === String(value));

	useEffect(() => {
		if (!open) return;
		const onDoc = (e) => {
			if (!ref.current?.contains(e.target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDoc);
		return () => document.removeEventListener("mousedown", onDoc);
	}, [open]);

	const pick = (id) => {
		onChange?.(id);
		setOpen(false);
	};

	return (
		<div className={`bucket-select${open ? " is-open" : ""}`} ref={ref}>
			<button
				type="button"
				className="bucket-select-trigger"
				onClick={() => setOpen((o) => !o)}
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<span className="bucket-select-value">
					{selected ? (
						<>
							<span
								className="bucket-dot"
								style={{ background: selected.color || "#5cd0a9" }}
							/>
							{selected.name}
						</>
					) : (
						<span className="bucket-select-placeholder">No bucket</span>
					)}
				</span>
				<span className="bucket-select-arrow" aria-hidden="true">
					▾
				</span>
			</button>
			{open ? (
				<ul className="bucket-select-menu">
					<li>
						<button
							type="button"
							className={`bucket-select-opt${!value ? " is-active" : ""}`}
							onClick={() => pick("")}
						>
							<span className="bucket-dot bucket-dot--none" />
							No bucket
						</button>
					</li>
					{buckets.map((b) => (
						<li key={b.id}>
							<button
								type="button"
								className={`bucket-select-opt${
									String(b.id) === String(value) ? " is-active" : ""
								}`}
								onClick={() => pick(b.id)}
							>
								<span
									className="bucket-dot"
									style={{ background: b.color || "#5cd0a9" }}
								/>
								{b.name}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
