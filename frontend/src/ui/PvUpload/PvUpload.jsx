import { useImperativeHandle, useRef, useState } from "react";
import "./PvUpload.css";

/**
 * File picker. Hands the chosen files to `onFiles` — the caller does the upload
 * (usually a TanStack mutation).
 *
 *   <PvUpload accept="image/*" onFiles={([f]) => upload(f)}>
 *     <PvButton icon={<CameraOutlined />} />
 *   </PvUpload>
 *
 *   <PvUpload drag multiple onFiles={(files) => files.forEach(upload)}>
 *     Click or drag files here
 *   </PvUpload>
 *
 * Props:
 *   onFiles:  (File[]) => void
 *   accept, multiple, disabled: as on <input type="file">
 *   drag:     render a drop zone (children = its content) instead of wrapping a trigger
 *   ref:      exposes { open() } to open the picker from elsewhere (menus, shortcuts);
 *             with no children nothing is rendered but the hidden input
 */
export default function PvUpload({
	onFiles,
	accept,
	multiple = false,
	disabled = false,
	drag = false,
	className = "",
	children,
	ref,
}) {
	const inputRef = useRef(null);
	const [over, setOver] = useState(false);

	const pick = () => !disabled && inputRef.current?.click();
	useImperativeHandle(ref, () => ({ open: pick }));
	const hand = (list) => {
		const files = Array.from(list || []);
		if (files.length) onFiles?.(multiple ? files : files.slice(0, 1));
	};

	const input = (
		<input
			ref={inputRef}
			type="file"
			hidden
			accept={accept}
			multiple={multiple}
			onChange={(e) => {
				hand(e.target.files);
				e.target.value = "";
			}}
		/>
	);

	if (!drag && children == null) return input;
	if (!drag) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the child is the focusable trigger (a button)
			// biome-ignore lint/a11y/useKeyWithClickEvents: the child button handles keyboard activation
			<span className={`pv-upload ${className}`.trim()} onClick={pick}>
				{children}
				{input}
			</span>
		);
	}

	const classes = [
		"pv-upload-drop",
		over && "is-over",
		disabled && "is-disabled",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button
			type="button"
			className={classes}
			disabled={disabled}
			onClick={pick}
			onDragOver={(e) => {
				e.preventDefault();
				if (!disabled) setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				if (!disabled) hand(e.dataTransfer.files);
			}}
		>
			{children}
			{input}
		</button>
	);
}
