import { MailOutlined, MessageOutlined } from "@ant-design/icons";
import PvModal from "../ui/PvModal";
import "../../vault-pixel.css";

const supportOptions = [
	{
		icon: <MailOutlined />,
		title: "Email Support",
		description: "Get in touch via email for detailed inquiries",
		contact: "user.user@protonmail.com",
		href: "mailto:user.user@protonmail.com",
	},
	{
		icon: <MessageOutlined />,
		title: "Microsoft Teams",
		description: "Chat directly for quick responses",
		contact: "Piuma Vault",
		href: null,
	},
];

const SupportModal = ({ open, onCancel }) => {
	return (
		<PvModal
			open={open}
			title="Support"
			onCancel={onCancel}
			cancelText="Close"
		>
			<p className="vp-text vp-muted" style={{ marginTop: 0 }}>
				Need help? Choose your preferred support channel below:
			</p>

			<div className="vp-stack" style={{ gap: 12 }}>
				{supportOptions.map((option) => {
					const Tag = option.href ? "a" : "div";
					return (
						<Tag
							key={option.title}
							className={`vp-card vp-row${option.href ? " vp-card--link" : ""}`}
							href={option.href || undefined}
							style={{ gap: 14, alignItems: "flex-start" }}
						>
							<span
								className="vp-accent"
								style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}
							>
								{option.icon}
							</span>
							<div style={{ flex: 1 }}>
								<p className="vp-card-title">{option.title}</p>
								<p className="vp-card-desc">{option.description}</p>
								<p className="vp-accent" style={{ margin: "8px 0 0" }}>
									{option.contact}
								</p>
							</div>
						</Tag>
					);
				})}
			</div>
		</PvModal>
	);
};

export default SupportModal;
