import {
	BellOutlined,
	CameraOutlined,
	GlobalOutlined,
	LockOutlined,
	MailOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import {
	PvAvatar,
	PvField,
	PvIconButton,
	PvPanel,
	PvSelect,
	PvSpin,
	PvSwitch,
	PvUpload,
	pvMessage,
} from "@/ui";
import { useUserMe } from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import NotificationSettings from "./NotificationSettings";
import "./profile.css";

const LANGUAGE_OPTIONS = [
	{ value: "en", label: "English" },
	{ value: "es", label: "Spanish" },
	{ value: "fr", label: "French" },
	{ value: "de", label: "German" },
];

const TIMEZONE_OPTIONS = [
	{ value: "America/New_York", label: "Eastern Time" },
	{ value: "America/Chicago", label: "Central Time" },
	{ value: "America/Denver", label: "Mountain Time" },
	{ value: "America/Los_Angeles", label: "Pacific Time" },
	{ value: "Europe/London", label: "GMT" },
];

const Profile = () => {
	const { data: userData, isLoading, error } = useUserMe();

	// Mock additional data - in a real app, this would come from API or be editable
	const [additionalData, setAdditionalData] = useState({
		bio: "Full-stack developer with a passion for creating amazing user experiences.",
		language: "en",
		timezone: "America/New_York",
		notifications: {
			email: true,
			push: false,
			sms: true,
		},
		privacy: {
			profileVisible: true,
			showEmail: false,
			showPhone: false,
		},
	});

	// Avatar upload has no backend endpoint yet — only the client-side checks
	// exist.
	const handleAvatarFiles = ([file]) => {
		if (!file) return;
		const isJpgOrPng = file.type === "image/jpeg" || file.type === "image/png";
		if (!isJpgOrPng) {
			pvMessage.error("You can only upload JPG/PNG file!");
		}
		const isLt2M = file.size / 1024 / 1024 < 2;
		if (!isLt2M) {
			pvMessage.error("Image must smaller than 2MB!");
		}
	};

	const setPrivacy = (key) => (checked) =>
		setAdditionalData((prev) => ({
			...prev,
			privacy: { ...prev.privacy, [key]: checked },
		}));

	return (
		<PageContent>
			<div className="vp-page vp-profile">
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Profile Settings</h1>
						<p className="vp-page-subtitle">
							Manage your account profile and preferences
						</p>
					</div>
				</div>

				{isLoading && (
					<div className="vp-profile-center">
						<PvSpin />
					</div>
				)}

				{error && (
					<div className="vp-profile-center">
						<p className="vp-text vp-profile-error">
							Failed to load profile data. Please try again.
						</p>
					</div>
				)}

				{userData && (
					<div className="vp-profile-grid">
						{/* Left column */}
						<div className="vp-stack">
							{/* Profile Overview */}
							<PvPanel title="profile">
								<div className="vp-profile-overview">
									<div className="vp-profile-avatar-wrap">
										<PvAvatar size={120} tone="info">
											<UserOutlined />
										</PvAvatar>
										<PvUpload
											accept="image/jpeg,image/png"
											onFiles={handleAvatarFiles}
											className="vp-profile-avatar-btn"
										>
											<PvIconButton
												variant="accent"
												icon={<CameraOutlined />}
												label="Upload avatar"
											/>
										</PvUpload>
									</div>
									<h2 className="vp-h2 vp-profile-name">
										{userData.first_name} {userData.last_name}
									</h2>
									<p className="vp-muted vp-profile-email">
										<MailOutlined className="vp-profile-icon" />
										{userData.email}
									</p>
									<p className="vp-text vp-profile-bio">{additionalData.bio}</p>
								</div>
							</PvPanel>

							{/* Account Info */}
							<PvPanel title="account info">
								<div className="vp-stack vp-profile-rows">
									<div className="vp-row vp-spread">
										<span className="vp-muted">User ID</span>
										<span className="vp-text">{userData.user_id}</span>
									</div>
									<div className="vp-row vp-spread">
										<span className="vp-muted">Groups</span>
										<span className="vp-text">
											{userData.groups?.join(", ") || "None"}
										</span>
									</div>
									<div className="vp-row vp-spread">
										<span className="vp-muted">Permissions</span>
										<span className="vp-text">
											{userData.permissions?.length || 0} permissions
										</span>
									</div>
									<div className="vp-row vp-spread">
										<span className="vp-muted">Status</span>
										<span className="vp-tag vp-tag--green">Active</span>
									</div>
								</div>
							</PvPanel>
						</div>

						{/* Right column */}
						<div className="vp-stack">
							{/* Personal Information */}
							<PvPanel title="personal information">
								<div className="vp-profile-info-grid">
									<div className="vp-field vp-profile-field">
										<span className="vp-label">First Name</span>
										<span className="vp-text">{userData.first_name}</span>
									</div>
									<div className="vp-field vp-profile-field">
										<span className="vp-label">Last Name</span>
										<span className="vp-text">{userData.last_name}</span>
									</div>
								</div>
								<div className="vp-field vp-profile-field vp-profile-field--spaced">
									<span className="vp-label">Bio</span>
									<span className="vp-text">{additionalData.bio}</span>
								</div>
							</PvPanel>

							{/* Notifications + Privacy */}
							<div className="vp-profile-info-grid">
								<PvPanel
									title={
										<>
											<BellOutlined className="vp-profile-icon" />
											Notifications
										</>
									}
								>
									<NotificationSettings />
								</PvPanel>

								<PvPanel
									title={
										<>
											<LockOutlined className="vp-profile-icon" />
											Privacy
										</>
									}
								>
									<div className="vp-stack vp-profile-toggles">
										<div className="vp-row vp-spread">
											<span className="vp-text">Profile Visible</span>
											<PvSwitch
												aria-label="Profile Visible"
												checked={additionalData.privacy.profileVisible}
												onChange={setPrivacy("profileVisible")}
											/>
										</div>
										<div className="vp-row vp-spread">
											<span className="vp-text">Show Email</span>
											<PvSwitch
												aria-label="Show Email"
												checked={additionalData.privacy.showEmail}
												onChange={setPrivacy("showEmail")}
											/>
										</div>
										<div className="vp-row vp-spread">
											<span className="vp-text">Show Phone</span>
											<PvSwitch
												aria-label="Show Phone"
												checked={additionalData.privacy.showPhone}
												onChange={setPrivacy("showPhone")}
											/>
										</div>
									</div>
								</PvPanel>
							</div>

							{/* Preferences */}
							<PvPanel
								title={
									<>
										<GlobalOutlined className="vp-profile-icon" />
										Preferences
									</>
								}
							>
								<div className="vp-profile-info-grid">
									<PvField label="Language" className="vp-profile-field">
										<PvSelect
											options={LANGUAGE_OPTIONS}
											value={additionalData.language}
											onChange={(value) =>
												setAdditionalData((prev) => ({
													...prev,
													language: value,
												}))
											}
										/>
									</PvField>
									<PvField label="Timezone" className="vp-profile-field">
										<PvSelect
											options={TIMEZONE_OPTIONS}
											value={additionalData.timezone}
											onChange={(value) =>
												setAdditionalData((prev) => ({
													...prev,
													timezone: value,
												}))
											}
										/>
									</PvField>
								</div>
							</PvPanel>
						</div>
					</div>
				)}
			</div>
		</PageContent>
	);
};

export default Profile;
