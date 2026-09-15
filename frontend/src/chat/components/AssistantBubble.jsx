import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "../../utils/markdown";
import { normalizeChatMarkdown } from "../engine/markdown";
import { NAV_FALLBACK_LABEL, navTargetToPath } from "../engine/messageModel";
import SpriteRunner from "./SpriteRunner";
import ToolList from "./ToolList";
import VaultLink from "./VaultLink";

// An assistant reply: text, tool runs, mid-turn injections, and "Go" nav actions
// rendered in stream order, plus the pixel-Piuma "thinking…" loader while the
// reply is still empty and streaming.
function AssistantBubble({ parts, isStreaming, label, onNavigate }) {
	const empty = !parts?.length;
	// Bind the custom link renderer to this bubble's navigation handler.
	const mdComponents = useMemo(
		() => ({ a: (props) => <VaultLink {...props} onNavigate={onNavigate} /> }),
		[onNavigate],
	);
	return (
		<div className="chat-assistant-row">
			<span className="chat-role">{label}</span>
			<div className="chat-assistant-body">
				{empty && isStreaming ? (
					<div className="chat-thinking">
						<SpriteRunner pixelSize={2} />
						<div className="chat-thinking-body">
							<span className="chat-thinking-label">thinking…</span>
							<span className="chat-thinking-dots" aria-hidden="true">
								<i />
								<i />
								<i />
							</span>
						</div>
					</div>
				) : (
					<>
						{/* Text, tool runs, and mid-turn injections — in stream order. */}
						{parts.map((p) => {
							if (p.kind === "tools")
								return <ToolList key={p.id} tools={p.tools} />;
							if (p.kind === "inject")
								return (
									<div key={p.id} className="chat-inject">
										<span className="chat-inject-label">you ↩</span>
										<span className="chat-inject-text">{p.text}</span>
									</div>
								);
							if (p.kind === "nav") {
								const to = navTargetToPath({
									target: p.target,
									id: p.navId,
									route: p.route,
									url: p.url,
								});
								if (!to) return null;
								const navLabel =
									p.label || NAV_FALLBACK_LABEL[p.target] || "open";
								return (
									<button
										key={p.id}
										type="button"
										className="chat-nav-action"
										onClick={() => onNavigate?.(to)}
										title={to}
									>
										<span className="chat-nav-action-icon" aria-hidden="true">
											↗
										</span>
										<span className="chat-nav-action-label">
											Go → {navLabel}
										</span>
									</button>
								);
							}
							return (
								<ReactMarkdown
									key={p.id}
									remarkPlugins={remarkPlugins}
									components={mdComponents}
								>
									{normalizeChatMarkdown(p.text)}
								</ReactMarkdown>
							);
						})}
						{isStreaming ? <span className="chat-cursor" /> : null}
					</>
				)}
			</div>
		</div>
	);
}

// Memoised because the chat input's state lives in the host component: without
// this, every keystroke re-renders the whole list and react-markdown re-parses
// every message in the conversation (~47ms for 40 messages, ~74ms for 80),
// which is felt directly as lag while typing. The props are all stable per
// message — `parts` only gets a new identity when that message actually
// changes, and the host's navigation handler is a useCallback.
export default memo(AssistantBubble);
