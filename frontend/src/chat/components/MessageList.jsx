import { EditOutlined } from "@ant-design/icons";
import { partsToText } from "../engine/messageModel";
import AssistantBubble from "./AssistantBubble";
import { BranchSwitcher, MessageActions } from "./MessageActions";
import SpriteRunner from "./SpriteRunner";
import UserBubble from "./UserBubble";

// The scrolling message viewport shared by both chat surfaces: the loading /
// empty states, the message stream (user bubbles with inline edit, assistant
// bubbles with the actions row + fork switcher), and the jump-to-latest button.
// All conversation state + handlers are owned by the host and passed in.
export default function MessageList({
	messages,
	isStreaming,
	sending,
	agentLabel,
	loadingConv,
	editingId,
	editText,
	setEditingId,
	setEditText,
	onNavigate,
	onSwitchTo,
	onEditAndFork,
	onRegenerate,
	modelLabelFor,
	scrollRef,
	onScroll,
	showJump,
	onJump,
}) {
	return (
		<div className="chat-messages-viewport">
			<div ref={scrollRef} className="chat-messages" onScroll={onScroll}>
				<div className="chat-messages-inner">
					{loadingConv && messages.length === 0 ? (
						<div className="chat-loading">
							<SpriteRunner pixelSize={3} />
							<span className="chat-loading-label">loading conversation…</span>
						</div>
					) : messages.length === 0 ? (
						<div className="chat-empty">
							<div className="chat-empty-title">{agentLabel} is ready.</div>
							<div className="chat-empty-sub">
								Ask anything — markdown, code, plans. Streams back token by
								token.
							</div>
						</div>
					) : (
						messages.map((m, i) => {
							const isLast = i === messages.length - 1;
							const streamingThis =
								isStreaming && isLast && m.role === "assistant";
							const switcher =
								m.branchCount > 1 ? (
									<BranchSwitcher
										index={m.branchIndex}
										count={m.branchCount}
										onPrev={() => onSwitchTo(m.siblingIds?.[m.branchIndex - 2])}
										onNext={() => onSwitchTo(m.siblingIds?.[m.branchIndex])}
									/>
								) : null;
							if (m.role === "user") {
								return (
									<div key={m.id} className="chatx-msg chatx-msg--user">
										{editingId === m.id ? (
											<div className="chatx-edit">
												<textarea
													className="chatx-edit-input"
													value={editText}
													onChange={(e) => setEditText(e.target.value)}
													rows={3}
													// biome-ignore lint/a11y/noAutofocus: focus the editor on open
													autoFocus
													onKeyDown={(e) => {
														if (e.key === "Enter" && !e.shiftKey) {
															e.preventDefault();
															onEditAndFork(m.id, editText);
														} else if (e.key === "Escape") {
															setEditingId(null);
															setEditText("");
														}
													}}
												/>
												<div className="chatx-edit-actions">
													<button
														type="button"
														className="chatx-edit-btn"
														onClick={() => {
															setEditingId(null);
															setEditText("");
														}}
													>
														Cancel
													</button>
													<button
														type="button"
														className="chatx-edit-btn chatx-edit-send"
														onClick={() => onEditAndFork(m.id, editText)}
														disabled={!editText.trim()}
													>
														Send ↑
													</button>
												</div>
											</div>
										) : (
											<>
												<UserBubble
													content={m.content}
													context={m.context}
													images={m.images}
												/>
												<div className="chatx-msg-actions chatx-msg-actions--user">
													{switcher}
													{!isStreaming ? (
														<button
															type="button"
															className="chatx-msg-action"
															title="Edit message"
															aria-label="Edit message"
															onClick={() => {
																setEditingId(m.id);
																setEditText(m.content || "");
															}}
														>
															<EditOutlined />
														</button>
													) : null}
												</div>
											</>
										)}
									</div>
								);
							}
							return (
								<div key={m.id} className="chatx-msg">
									<AssistantBubble
										parts={m.parts}
										isStreaming={streamingThis}
										label={agentLabel}
										onNavigate={onNavigate}
									/>
									{!streamingThis && m.parts?.length ? (
										<MessageActions
											text={partsToText(m.parts)}
											modelLabel={modelLabelFor(m)}
											canRetry={!isStreaming && !sending}
											onRetry={() => onRegenerate(m.id)}
											leading={switcher}
										/>
									) : null}
								</div>
							);
						})
					)}
				</div>
			</div>
			{showJump ? (
				<button
					type="button"
					className="chat-jump"
					onClick={onJump}
					title="Jump to latest"
					aria-label="Jump to latest message"
				>
					↓
				</button>
			) : null}
		</div>
	);
}
