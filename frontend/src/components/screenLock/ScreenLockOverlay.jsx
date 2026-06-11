import { useEffect, useRef, useState } from "react";
import SpriteStage from "../../admin/components/notes/SpriteStage";
import Starfield from "../../admin/components/notes/Starfield";
import { PvButton } from "../../admin/components/ui";
import { verifyScreenLockPin } from "../../api/screenLock";
import useScreenLockStore from "../../store/screenLockStore";
import PixelLoader from "../PixelLoader";
import "./ScreenLockOverlay.css";

// Stable keys for the six fixed PIN slots (index-as-key trips the linter).
const PIN_SLOTS = ["s0", "s1", "s2", "s3", "s4", "s5"];

// Full-screen blocker shown while the vault is locked. The only ways out are the
// correct 6-digit PIN (verified server-side) or a full logout. Auto-submits once
// six digits are entered.
export default function ScreenLockOverlay() {
	const unlock = useScreenLockStore((s) => s.unlock);
	const [pin, setPin] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [shake, setShake] = useState(false);
	const [focused, setFocused] = useState(false);
	const [unlocking, setUnlocking] = useState(false);
	const inputRef = useRef(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const fail = (msg) => {
		setError(msg);
		setPin("");
		setShake(true);
		setTimeout(() => setShake(false), 400);
		// The input is still `disabled` (busy clears in submit's finally), so a
		// focus() now is a no-op. Defer it until after the re-enable re-render.
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const submit = async (value) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const { ok } = await verifyScreenLockPin(value);
			if (ok) {
				// Show the pixel loader briefly, then drop the overlay — a smooth
				// transition back into the vault instead of an instant cut.
				setUnlocking(true);
				setTimeout(unlock, 2000);
			} else {
				fail("Wrong PIN. Try again.");
			}
		} catch (e) {
			if (e?.response?.status === 429) {
				const secs = e.response.data?.retry_after_seconds;
				fail(`Too many attempts. Wait ${secs ? `${secs}s` : "a moment"}.`);
			} else {
				fail("Could not verify PIN. Try again.");
			}
		} finally {
			setBusy(false);
		}
	};

	const onChange = (e) => {
		const next = e.target.value.replace(/\D/g, "").slice(0, 6);
		setPin(next);
		setError("");
		if (next.length === 6) submit(next);
	};

	const logout = () => {
		localStorage.removeItem("token");
		localStorage.removeItem("refreshToken");
		useScreenLockStore.getState().unlock();
		window.location.href = `${import.meta.env.BASE_URL}admin/login`;
	};

	if (unlocking) {
		return <PixelLoader message="Unlocking" />;
	}

	return (
		<div className="vp-lock-overlay">
			{/* Animated pixel starfield, same as the empty-state background. */}
			<Starfield />
			<div className={`vp-lock-card${shake ? " vp-lock-shake" : ""}`}>
				<SpriteStage pixelSize={8} />
				<h2 className="vp-lock-title">Vault locked</h2>
				<p className="vp-text vp-muted">Enter your 6-digit PIN to unlock.</p>

				{/* Segmented pixel PIN: a transparent input captures keystrokes
				    (and the mobile keyboard) while six cells render the state. */}
				<button
					type="button"
					className="vp-lock-pin"
					onClick={() => inputRef.current?.focus()}
					aria-label="6-digit PIN"
				>
					<input
						ref={inputRef}
						className="vp-lock-pin-field"
						type="password"
						inputMode="numeric"
						autoComplete="off"
						maxLength={6}
						value={pin}
						disabled={busy}
						onChange={onChange}
						onFocus={() => setFocused(true)}
						onBlur={() => {
							// Keep the keyboard captured by the PIN field at all times —
							// pull focus straight back unless we're unlocking/unmounting.
							if (!unlocking) {
								requestAnimationFrame(() => inputRef.current?.focus());
							}
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && pin.length === 6) submit(pin);
						}}
					/>
					{PIN_SLOTS.map((slot, i) => {
						const filled = i < pin.length;
						const active = focused && !busy && i === pin.length;
						return (
							<span
								key={slot}
								className={`vp-lock-cell${filled ? " is-filled" : ""}${
									active ? " is-active" : ""
								}`}
							>
								{filled ? <span className="vp-lock-dot" /> : null}
							</span>
						);
					})}
				</button>

				{error && <p className="vp-text vp-lock-error">{error}</p>}
				<PvButton variant="ghost" size="sm" onClick={logout}>
					Log out instead
				</PvButton>
			</div>
		</div>
	);
}
