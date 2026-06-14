import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLogout, useUserMe } from "../../queries";
import "./UserMenu.css";

function getInitials(user) {
	if (user?.first_name && user?.last_name) {
		return (user.first_name[0] + user.last_name[0]).toUpperCase();
	}
	if (user?.first_name) {
		return user.first_name.substring(0, 2).toUpperCase();
	}
	if (user?.email) {
		return user.email.substring(0, 2).toUpperCase();
	}
	return "US";
}

function getDisplayName(user) {
	const full = [user?.first_name, user?.last_name].filter(Boolean).join(" ");
	return full || user?.email || "User";
}

function getRole(user) {
	if (user?.groups?.length) return user.groups.join(", ");
	if (user?.permissions?.includes("admin_access")) return "Administrator";
	return "Member";
}

/**
 * Pixel/terminal avatar + dropdown. The component is position-neutral — it
 * flows inline wherever the parent renders it, and the parent owns placement.
 * `size` sets the avatar's pixel dimension (font scales with it). `align`
 * controls which edge the dropdown anchors to: "right" (default) opens it
 * leftward, "left" opens it rightward — use "left" when the avatar sits near
 * the left edge of a narrow container (e.g. the notes sidebar).
 */
export default function UserMenu({ size = 42, align = "right" }) {
	const { data: me } = useUserMe();
	const logout = useLogout();
	const [open, setOpen] = useState(false);
	const ref = useRef(null);

	const avatarStyle = {
		width: size,
		height: size,
		fontSize: Math.round(size * 0.29),
	};

	useEffect(() => {
		if (!open) return;
		const onClick = (e) => {
			if (ref.current && !ref.current.contains(e.target)) setOpen(false);
		};
		const onKey = (e) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Not logged in — show login button.
	if (!me) {
		return (
			<div className="user-menu">
				<Link className="user-menu-login" to="/admin/login">
					[ login ]
				</Link>
			</div>
		);
	}

	const isAdmin = me.permissions?.includes("admin_access");

	return (
		<div className="user-menu" ref={ref}>
			<button
				type="button"
				className="user-menu-avatar"
				style={avatarStyle}
				onClick={() => setOpen((v) => !v)}
				aria-label="User menu"
				aria-expanded={open}
			>
				{getInitials(me)}
			</button>

			{open && (
				<div
					className={`user-menu-dropdown ${align === "left" ? "user-menu-dropdown--left" : ""}`}
				>
					<div className="user-menu-info">
						<div className="user-menu-name">{getDisplayName(me)}</div>
						{me.email && <div className="user-menu-email">{me.email}</div>}
						<div className="user-menu-role">
							<span className="user-menu-role-label">role:</span> {getRole(me)}
						</div>
					</div>

					<div className="user-menu-divider" />

					{isAdmin && (
						<>
							<Link
								className="user-menu-item"
								to="/notes"
								onClick={() => setOpen(false)}
							>
								&gt; notes
							</Link>
							<Link
								className="user-menu-item"
								to="/storage"
								onClick={() => setOpen(false)}
							>
								&gt; storage
							</Link>
							<Link
								className="user-menu-item"
								to="/tasks"
								onClick={() => setOpen(false)}
							>
								&gt; tasks
							</Link>
							<Link
								className="user-menu-item"
								to="/calendar"
								onClick={() => setOpen(false)}
							>
								&gt; calendar
							</Link>
							<Link
								className="user-menu-item"
								to="/chat"
								onClick={() => setOpen(false)}
							>
								&gt; chat
							</Link>
							<Link
								className="user-menu-item"
								to="/admin"
								onClick={() => setOpen(false)}
							>
								&gt; admin
							</Link>
							<div className="user-menu-divider" />
						</>
					)}

					<button
						type="button"
						className="user-menu-item user-menu-logout"
						onClick={() => {
							setOpen(false);
							logout();
						}}
					>
						&gt; logout
					</button>
				</div>
			)}
		</div>
	);
}
