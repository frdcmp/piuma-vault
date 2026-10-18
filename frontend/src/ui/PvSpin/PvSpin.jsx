import "./PvSpin.css";

/**
 * Inline loading indicator (the stepped pixel spinner from `.vp-btn-spinner`).
 * For the full-screen loader use components/PixelLoader.
 *
 * Props:
 *   label: optional text next to the spinner (e.g. "Loading…")
 *   block: centre it in its own padded row (for panels / page sections)
 */
export default function PvSpin({ label, block = false, className = "" }) {
	return (
		<span
			className={`pv-spin${block ? " pv-spin--block" : ""} ${className}`.trim()}
			role="status"
			aria-live="polite"
		>
			<span className="vp-btn-spinner" aria-hidden="true" />
			{label != null ? (
				<span className="pv-spin-label">{label}</span>
			) : (
				<span className="pv-sr-only">Loading</span>
			)}
		</span>
	);
}
