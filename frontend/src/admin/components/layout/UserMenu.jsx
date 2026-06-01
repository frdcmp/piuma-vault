import {
	DashboardOutlined,
	LogoutOutlined,
	MailOutlined,
	ProfileOutlined,
	SettingOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Dropdown, Space, Typography, theme } from "antd";
import { useNavigate } from "react-router-dom";
import { useUserMe } from "../../../queries";
import "../../vault-pixel.css";
import "./layout.css";

const { Text, Title } = Typography;
const { useToken } = theme;

const UserMenu = ({ showFullDetails = false }) => {
	const { token } = useToken();
	const navigate = useNavigate();
	const { data: userProfile } = useUserMe();

	const userData = userProfile
		? {
				email: userProfile.email || "",
				first_name: userProfile.first_name || "",
				last_name: userProfile.last_name || "",
				permissions: userProfile.permissions || [],
				groups: userProfile.groups || [],
				hasAdminAccess: (userProfile.permissions || []).includes(
					"svo_portal.admin",
				),
			}
		: {
				email: "",
				hasAdminAccess: false,
				permissions: [],
				groups: [],
				first_name: "",
				last_name: "",
			};

	const getInitials = (userData) => {
		// Use first_name and last_name from JWT if available
		if (userData.first_name && userData.last_name) {
			return (userData.first_name[0] + userData.last_name[0]).toUpperCase();
		} else if (userData.first_name) {
			return userData.first_name.substring(0, 2).toUpperCase();
		}

		// Fallback to email-based logic
		const name = userData.email;
		if (!name) return "US";

		// Handle email addresses
		if (name.includes("@")) {
			// Get the part before the @ symbol
			const localPart = name.split("@")[0];

			// If the local part contains a period
			if (localPart.includes(".")) {
				const parts = localPart.split(".");
				return (parts[0][0] + parts[1][0]).toUpperCase();
			}
			// If the local part contains a hyphen
			else if (localPart.includes("-")) {
				const parts = localPart.split("-");
				return (parts[0][0] + parts[1][0]).toUpperCase();
			}
			// For emails without periods or hyphens, take first two letters
			else {
				return localPart.substring(0, 2).toUpperCase();
			}
		}

		// For non-email names
		return name
			.split(/\s+/)
			.map((word) => word[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
	};

	const goToLogin = () => {
		const redirectUrl = encodeURIComponent(
			window.location.pathname + window.location.search,
		);
		window.location.href = `${import.meta.env.BASE_URL}admin/login?redirectTo=${redirectUrl}`;
	};

	const hasToken = !!localStorage.getItem("token");
	/* const isLoggedIn = hasToken && !!userData.email; */
	// SVO Logic: guest logic deprecated
	const isGuest = false;

	const getFormattedName = () => {
		if (userData.first_name && userData.last_name) {
			return `${userData.first_name} ${userData.last_name}`;
		} else if (userData.first_name) {
			return userData.first_name;
		} else if (userData.email) {
			const displayName = userData.email.split("@")[0].replace(/[.-]/g, " ");
			return displayName
				.split(" ")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" ");
		}
		return "User";
	};

	const formattedName = getFormattedName();

	const avatarStyle = {
		width: "36px",
		height: "36px",
		borderRadius: "50%",
		background: token.colorPrimary,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		fontSize: "14px",
		color: "#fff",
		textTransform: "uppercase",
		cursor: "pointer",
		border: `2px solid ${token.colorBorderSecondary}`,
	};

	const menuItems = [
		...(userData.hasAdminAccess && hasToken
			? [
					{
						key: "admin",
						icon: <DashboardOutlined />,
						label: "Admin Dashboard",
						onClick: () => {
							navigate("/admin");
						},
					},
				]
			: []),
		...(hasToken && userData.email
			? [
					{
						key: "profile",
						icon: <ProfileOutlined />,
						label: "Profile",
						onClick: () => {
							navigate("/admin/profile");
						},
					},
				]
			: []),
		...(isGuest
			? [
					{
						key: "login",
						icon: <UserOutlined />,
						label: "Log In",
						onClick: () => {
							goToLogin();
						},
					},
				]
			: []),
		{
			type: "divider",
		},
		{
			key: "settings",
			icon: <SettingOutlined />,
			label: "Settings",
			onClick: () => {
				navigate("/admin/settings");
			},
		},
		{
			key: "logout",
			icon: <LogoutOutlined />,
			label: isGuest ? "Clear Guest" : "Logout",
			onClick: () => {
				localStorage.removeItem("token");
				localStorage.removeItem("refreshToken");
				goToLogin();
			},
		},
	];

	// If showing full details in sidebar
	if (showFullDetails && hasToken && userData.email) {
		return (
			<Dropdown
				menu={{
					items: menuItems,
				}}
				trigger={["click"]}
				placement="bottomRight"
			>
				<button
					type="button"
					style={{
						display: "flex",
						alignItems: "center",
						gap: "12px",
						padding: "8px 12px",
						borderRadius: `${token.borderRadius}px`,
						cursor: "pointer",
						transition: "background-color 0.2s",
						background: "transparent",
						border: "none",
						width: "100%",
						textAlign: "left",
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.background = token.colorFillTertiary;
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.background = "transparent";
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
						}
					}}
				>
					<div
						style={{
							width: "32px",
							height: "32px",
							borderRadius: "50%",
							background: token.colorPrimary,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#fff",
							fontSize: "14px",
							fontWeight: 500,
						}}
					>
						{getInitials(userData)}
					</div>
					<div style={{ flex: 1, minWidth: 0 }}>
						<div
							style={{
								fontSize: "14px",
								fontWeight: 500,
								color: token.colorText,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{formattedName}
						</div>
						<div
							style={{
								fontSize: "12px",
								color: token.colorTextSecondary,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{userData.email}
						</div>
					</div>
					<div style={{ fontSize: "16px", color: token.colorTextTertiary }}>
						<UserOutlined />
					</div>
				</button>
			</Dropdown>
		);
	}

	return (
		<Space>
			{hasToken && userData.email ? (
				<Dropdown
					menu={{
						items: menuItems,
					}}
					popupRender={(menu) => (
						<div
							style={{
								width: "320px",
								background: token.colorBgElevated,
								borderRadius: token.borderRadiusLG,
								boxShadow: token.boxShadowSecondary,
								overflow: "hidden",
								border: `1px solid ${token.colorBorder}`,
							}}
						>
							{/* Welcome Header */}
							<div
								style={{
									background: token.colorPrimary,
									padding: "16px",
									borderBottom: `1px solid ${token.colorBorder}`,
								}}
							>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										marginBottom: "8px",
									}}
								>
									<div
										style={{
											...avatarStyle,
											width: "42px",
											height: "42px",
											fontSize: "16px",
											marginRight: "12px",
											background: "rgba(255, 255, 255, 0.15)",
											border: `2px solid rgba(255, 255, 255, 0.2)`,
											color: "#fff",
										}}
									>
										{getInitials(userData)}
									</div>
									<div style={{ width: "calc(100% - 54px)" }}>
										<Title
											level={5}
											style={{
												margin: 0,
												color: token.colorTextLightSolid,
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
										>
											Welcome,{" "}
											{userData.first_name || formattedName.split(" ")[0]}!
											{isGuest ? (
												<span style={{ fontSize: 12, marginLeft: 6 }}>
													(Guest)
												</span>
											) : null}
										</Title>
										<Text
											style={{
												fontSize: "12px",
												color: token.colorTextLightSolid,
												display: "block",
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
										>
											<MailOutlined style={{ marginRight: "4px" }} />{" "}
											{userData.email}
										</Text>
										{isGuest && (
											<Text
												style={{
													fontSize: 12,
													display: "block",
													marginTop: 6,
													color: token.colorTextLightSolid,
												}}
											>
												You are using a guest identity stored locally. Log in to
												save this identity to your account.
											</Text>
										)}
									</div>
								</div>
							</div>

							{/* User Role Info */}
							{hasToken && userData.email && (
								<div
									style={{
										padding: "8px 16px",
										background: token.colorBgContainer,
										borderBottom: `1px solid ${token.colorBorderSecondary}`,
									}}
								>
									<Text
										style={{
											fontSize: "12px",
											color: token.colorTextSecondary,
										}}
									>
										<Text
											strong
											style={{
												marginRight: "4px",
												color: token.colorText,
											}}
										>
											Role:
										</Text>{" "}
										{userData.groups.length > 0
											? userData.groups.join(", ")
											: "Guest"}
									</Text>
								</div>
							)}
							{/* Menu Items */}
							{/* Clone menu to potentially pass style if needed, currently just rendering */}
							{/* AntD Dropdown handles the menu rendering logic inside, but we need to ensure styling is correct */}
							{/* Using a wrapping div for background is enough for the outer container */}
							{menu}
						</div>
					)}
					trigger={["click"]}
					placement="bottomRight"
				>
					<button type="button" className="vp-avatar">
						{getInitials(userData)}
					</button>
				</Dropdown>
			) : (
				<button
					type="button"
					className="vp-btn vp-btn--primary"
					onClick={() => {
						goToLogin();
					}}
				>
					Log In
				</button>
			)}
		</Space>
	);
};

export default UserMenu;
