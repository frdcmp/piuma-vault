import {
	ApiOutlined,
	AppstoreOutlined,
	BookOutlined,
	CloudServerOutlined,
	FolderOpenOutlined,
	HeartOutlined,
	HomeOutlined,
	KeyOutlined,
	SearchOutlined,
	SettingOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import "../../vault-pixel.css";
import "./SearchModal.css";

// Real navigation targets — mirrors the sidebar plus the other admin routes
// registered in App.jsx. `keywords` widen what a query matches.
const COMMANDS = [
	{
		group: "Navigation",
		icon: <HomeOutlined />,
		label: "Home",
		to: "/admin",
		keywords: "dashboard",
	},
	{
		group: "Navigation",
		icon: <BookOutlined />,
		label: "Vault",
		to: "/notes",
		keywords: "notes editor",
	},
	{
		group: "Navigation",
		icon: <FolderOpenOutlined />,
		label: "Storage",
		to: "/storage",
		keywords: "files explorer",
	},
	{
		group: "Navigation",
		icon: <FolderOpenOutlined />,
		label: "Files",
		to: "/admin/files",
		keywords: "uploads attachments",
	},
	{
		group: "Navigation",
		icon: <AppstoreOutlined />,
		label: "About",
		to: "/admin/about",
	},
	{
		group: "Resources",
		icon: <KeyOutlined />,
		label: "API Keys",
		to: "/admin/api-keys",
		keywords: "tokens",
	},
	{
		group: "Resources",
		icon: <ApiOutlined />,
		label: "Services",
		to: "/admin/services",
		keywords: "azure openclaw config",
	},
	{
		group: "Resources",
		icon: <HeartOutlined />,
		label: "Health",
		to: "/admin/health",
		keywords: "status uptime",
	},
	{
		group: "Resources",
		icon: <CloudServerOutlined />,
		label: "API Test",
		to: "/admin/test",
		keywords: "endpoint debug",
	},
	{
		group: "Account",
		icon: <UserOutlined />,
		label: "Profile",
		to: "/admin/profile",
		keywords: "account me",
	},
	{
		group: "Account",
		icon: <SettingOutlined />,
		label: "Settings",
		to: "/admin/settings",
		keywords: "security 2fa otp preferences",
	},
];

const SearchModal = ({ open, onClose }) => {
	const navigate = useNavigate();
	const [searchValue, setSearchValue] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const listRef = useRef(null);
	const inputRef = useRef(null);

	// Flat, filtered list (the array the keyboard cursor walks over).
	const filtered = useMemo(() => {
		const q = searchValue.trim().toLowerCase();
		if (!q) return COMMANDS;
		return COMMANDS.filter((c) =>
			`${c.label} ${c.group} ${c.keywords || ""}`.toLowerCase().includes(q),
		);
	}, [searchValue]);

	// Group the filtered items for display while keeping a stable flat index.
	const groups = useMemo(() => {
		const out = [];
		let flatIndex = 0;
		for (const cmd of filtered) {
			let bucket = out.find((g) => g.name === cmd.group);
			if (!bucket) {
				bucket = { name: cmd.group, items: [] };
				out.push(bucket);
			}
			bucket.items.push({ ...cmd, flatIndex: flatIndex++ });
		}
		return out;
	}, [filtered]);

	const onQueryChange = (value) => {
		setSearchValue(value);
		setSelectedIndex(0);
	};

	// Focus the input and clear stale state each time the palette opens.
	useEffect(() => {
		if (open) {
			setSearchValue("");
			setSelectedIndex(0);
			inputRef.current?.focus();
		}
	}, [open]);

	// Keyboard navigation.
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e) => {
			const total = filtered.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((p) => (total ? (p + 1) % total : 0));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((p) => (total ? (p - 1 + total) % total : 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const cmd = filtered[selectedIndex];
				if (cmd) {
					onClose();
					navigate(cmd.to);
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [open, selectedIndex, filtered, navigate, onClose]);

	// Keep the active row scrolled into view.
	useEffect(() => {
		const rows = listRef.current?.querySelectorAll(".vp-search-item");
		rows?.[selectedIndex]?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const go = (cmd) => {
		if (!cmd) return;
		onClose();
		navigate(cmd.to);
	};

	if (!open) return null;

	return createPortal(
		// biome-ignore lint/a11y/noStaticElementInteractions: overlay backdrop, ESC handled globally
		// biome-ignore lint/a11y/useKeyWithClickEvents: overlay backdrop, ESC handled globally
		<div
			className="vp-search-overlay"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="vp-search"
				role="dialog"
				aria-modal="true"
				aria-label="Search"
			>
				<div className="vp-search-head">
					<SearchOutlined className="vp-search-icon" />
					<input
						ref={inputRef}
						className="vp-search-input"
						placeholder="Search pages…"
						value={searchValue}
						onChange={(e) => onQueryChange(e.target.value)}
					/>
					<button
						type="button"
						className="vp-search-esc"
						onClick={onClose}
						aria-label="Close"
					>
						ESC
					</button>
				</div>

				<div className="vp-search-results" ref={listRef}>
					{groups.length === 0 ? (
						<div className="vp-search-empty">
							No matches for “{searchValue}”
						</div>
					) : (
						groups.map((group) => (
							<div key={group.name}>
								<div className="vp-search-group">{group.name}</div>
								{group.items.map((item) => {
									const isSelected = item.flatIndex === selectedIndex;
									return (
										<button
											key={item.label}
											type="button"
											data-selected={isSelected}
											className={`vp-search-item ${isSelected ? "vp-search-item--active" : ""}`}
											onMouseEnter={() => setSelectedIndex(item.flatIndex)}
											onClick={() => go(item)}
										>
											<span className="vp-search-item-icon">{item.icon}</span>
											<span className="vp-search-item-label">{item.label}</span>
											<span className="vp-search-item-path">{item.to}</span>
										</button>
									);
								})}
							</div>
						))
					)}
				</div>

				<div className="vp-search-footer">
					<span>
						<kbd>↑</kbd>
						<kbd>↓</kbd> to navigate
					</span>
					<span>
						<kbd>↵</kbd> to select
					</span>
					<span>
						<kbd>ESC</kbd> to close
					</span>
				</div>
			</div>
		</div>,
		document.body,
	);
};

export default SearchModal;
