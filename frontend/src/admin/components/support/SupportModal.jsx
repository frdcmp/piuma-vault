import { GithubOutlined } from "@ant-design/icons";
import { PvModal } from "@/ui";
import "./SupportModal.css";

const supportOptions = [
	{
		icon: <GithubOutlined />,
		title: "GitHub",
		description: "Open an issue or reach out on GitHub",
		contact: "your-org",
		href: "https://github.com/your-org",
	},
];

const SupportModal = ({ open, onCancel }) => {
	return (
		<PvModal open={open} title="Support" onCancel={onCancel} cancelText="Close">
			<p className="vp-text vp-muted sm-intro">
				Need help? Choose your preferred support channel below:
			</p>

			<div className="vp-stack sm-options">
				{supportOptions.map((option) => {
					const Tag = option.href ? "a" : "div";
					return (
						<Tag
							key={option.title}
							className={`vp-card vp-row sm-option${option.href ? " vp-card--link" : ""}`}
							href={option.href || undefined}
						>
							<span className="vp-accent sm-option-icon">{option.icon}</span>
							<div className="sm-option-body">
								<p className="vp-card-title">{option.title}</p>
								<p className="vp-card-desc">{option.description}</p>
								<p className="vp-accent sm-option-contact">{option.contact}</p>
							</div>
						</Tag>
					);
				})}
			</div>
		</PvModal>
	);
};

export default SupportModal;
