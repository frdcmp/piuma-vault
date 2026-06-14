// Custom markdown <a>: internal app paths navigate client-side (keeping the
// chat surface mounted); external http(s) links open in a new tab; anything else
// (e.g. a stripped/odd scheme) renders as inert text.
export default function VaultLink({ href = "", children, onNavigate }) {
	if (href.startsWith("/")) {
		return (
			<a
				className="vault-chat-link"
				href={href}
				onClick={(e) => {
					e.preventDefault();
					onNavigate?.(href);
				}}
			>
				{children}
			</a>
		);
	}
	if (/^https?:\/\//i.test(href)) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	}
	return <span>{children}</span>;
}
