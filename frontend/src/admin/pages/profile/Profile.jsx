import {
	BellOutlined,
	CameraOutlined,
	GlobalOutlined,
	LockOutlined,
	MailOutlined,
	UserOutlined,
} from "@ant-design/icons";
import { Avatar, Select, Spin, Switch, Upload } from "antd";
import { useState } from "react";
import { useUserMe } from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import { PvPanel } from "../../components/ui";
import NotificationSettings from "./NotificationSettings";
import "../../vault-pixel.css";
import "./profile.css";

const { Option } = Select;

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

	const getInitials = (userData) => {
		if (userData?.first_name && userData?.last_name) {
			return (userData.first_name[0] + userData.last_name[0]).toUpperCase();
		} else if (userData?.first_name) {
			return userData.first_name.substring(0, 2).toUpperCase();
		}
		return "US";
	};

	const handleAvatarUpload = (info) => {
		if (info.file.status === "done") {
			message.success(`${info.file.name} file uploaded successfully`);
		} else if (info.file.status === "error") {
			message.error(`${info.file.name} file upload failed.`);
		}
	};

	const uploadProps = {
		name: "avatar",
		action: "/api/upload/avatar", // This would be your actual upload endpoint
		showUploadList: false,
		onChange: handleAvatarUpload,
		beforeUpload: (file) => {
			const isJpgOrPng =
				file.type === "image/jpeg" || file.type === "image/png";
			if (!isJpgOrPng) {
				message.error("You can only upload JPG/PNG file!");
			}
			const isLt2M = file.size / 1024 / 1024 < 2;
			if (!isLt2M) {
				message.error("Image must smaller than 2MB!");
			}
			return isJpgOrPng && isLt2M;
		},
	};

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
						<Spin size="large" />
					</div>
				)}

				{error && (
					<div className="vp-profile-center">
						<p className="vp-text" style={{ color: "var(--vp-accent-3)" }}>
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
										<Avatar
											size={120}
											style={{
												backgroundColor: "#1890ff",
												fontSize: "36px",
											}}
											icon={<UserOutlined />}
										>
											{getInitials(userData)}
										</Avatar>
										<Upload {...uploadProps}>
											<button
												type="button"
												className="vp-btn vp-btn--accent vp-btn--sm vp-profile-avatar-btn"
											>
												<CameraOutlined />
											</button>
										</Upload>
									</div>
									<h2 className="vp-h2 vp-profile-name">
										{userData.first_name} {userData.last_name}
									</h2>
									<p className="vp-muted vp-profile-email">
										<MailOutlined style={{ marginRight: 8 }} />
										{userData.email}
									</p>
									<p className="vp-text vp-profile-bio">{additionalData.bio}</p>
								</div>
							</PvPanel>

							{/* Account Info */}
							<PvPanel title="account info">
								<div className="vp-stack" style={{ gap: 10 }}>
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
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">First Name</span>
										<span className="vp-text">{userData.first_name}</span>
									</div>
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">Last Name</span>
										<span className="vp-text">{userData.last_name}</span>
									</div>
								</div>
								<div
									className="vp-field"
									style={{ marginTop: 16, marginBottom: 0 }}
								>
									<span className="vp-label">Bio</span>
									<span className="vp-text">{additionalData.bio}</span>
								</div>
							</PvPanel>

							{/* Notifications + Privacy */}
							<div className="vp-profile-info-grid">
								<PvPanel
									title={
										<>
											<BellOutlined style={{ marginRight: 8 }} />
											Notifications
										</>
									}
								>
									<NotificationSettings />
								</PvPanel>

								<PvPanel
									title={
										<>
											<LockOutlined style={{ marginRight: 8 }} />
											Privacy
										</>
									}
								>
									<div className="vp-stack" style={{ gap: 12 }}>
										<div className="vp-row vp-spread">
											<span className="vp-text">Profile Visible</span>
											<Switch
												checked={additionalData.privacy.profileVisible}
												onChange={(checked) =>
													setAdditionalData((prev) => ({
														...prev,
														privacy: {
															...prev.privacy,
															profileVisible: checked,
														},
													}))
												}
											/>
										</div>
										<div className="vp-row vp-spread">
											<span className="vp-text">Show Email</span>
											<Switch
												checked={additionalData.privacy.showEmail}
												onChange={(checked) =>
													setAdditionalData((prev) => ({
														...prev,
														privacy: { ...prev.privacy, showEmail: checked },
													}))
												}
											/>
										</div>
										<div className="vp-row vp-spread">
											<span className="vp-text">Show Phone</span>
											<Switch
												checked={additionalData.privacy.showPhone}
												onChange={(checked) =>
													setAdditionalData((prev) => ({
														...prev,
														privacy: { ...prev.privacy, showPhone: checked },
													}))
												}
											/>
										</div>
									</div>
								</PvPanel>
							</div>

							{/* Preferences */}
							<PvPanel
								title={
									<>
										<GlobalOutlined style={{ marginRight: 8 }} />
										Preferences
									</>
								}
							>
								<div className="vp-profile-info-grid">
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">Language</span>
										<Select
											value={additionalData.language}
											style={{ width: "100%" }}
											onChange={(value) =>
												setAdditionalData((prev) => ({
													...prev,
													language: value,
												}))
											}
										>
											<Option value="en">English</Option>
											<Option value="es">Spanish</Option>
											<Option value="fr">French</Option>
											<Option value="de">German</Option>
										</Select>
									</div>
									<div className="vp-field" style={{ marginBottom: 0 }}>
										<span className="vp-label">Timezone</span>
										<Select
											value={additionalData.timezone}
											style={{ width: "100%" }}
											onChange={(value) =>
												setAdditionalData((prev) => ({
													...prev,
													timezone: value,
												}))
											}
										>
											<Option value="America/New_York">Eastern Time</Option>
											<Option value="America/Chicago">Central Time</Option>
											<Option value="America/Denver">Mountain Time</Option>
											<Option value="America/Los_Angeles">Pacific Time</Option>
											<Option value="Europe/London">GMT</Option>
										</Select>
									</div>
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
