import {
	CopyOutlined,
	DeleteOutlined,
	MessageOutlined,
	PlusOutlined,
	RedoOutlined,
} from "@ant-design/icons";
import { Bubble, Sender } from "@ant-design/x";
import { Avatar, Flex, message, Space, Spin, Tooltip, theme } from "antd";
import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatWithLLM, useUserMe } from "../../../queries";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton } from "../../components/ui";
import "../../vault-pixel.css";
import "./llm.css";

// Helper for unique keys
const getKey = () =>
	`bubble_${Date.now()}_${Math.random().toString(36).slice(2)}`;

// Reusable Markdown renderer for consistent styling
const MarkdownRender = ({ content }) => {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				ul: (props) => (
					<ul
						style={{
							paddingLeft: 20,
							listStyleType: "disc",
							marginBottom: "8px",
						}}
						{...props}
					/>
				),
				ol: (props) => (
					<ol
						style={{
							paddingLeft: 20,
							listStyleType: "decimal",
							marginBottom: "8px",
						}}
						{...props}
					/>
				),
				li: (props) => (
					<li
						style={{ listStyle: "inherit", marginBottom: "4px" }}
						{...props}
					/>
				),
				p: (props) => (
					<p style={{ marginBottom: "8px", marginTop: 0 }} {...props} />
				),
				code: (props) => <code className="vp-llm-code" {...props} />,
				pre: (props) => <pre className="vp-llm-pre" {...props} />,
			}}
		>
			{content}
		</Markdown>
	);
};

// Markdown renderer for user bubbles without bottom margin
const UserMarkdownRender = ({ content }) => {
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			components={{
				ul: (props) => (
					<ul
						style={{
							paddingLeft: 20,
							listStyleType: "disc",
							marginBottom: 0,
						}}
						{...props}
					/>
				),
				ol: (props) => (
					<ol
						style={{
							paddingLeft: 20,
							listStyleType: "decimal",
							marginBottom: 0,
						}}
						{...props}
					/>
				),
				li: (props) => (
					<li style={{ listStyle: "inherit", marginBottom: 0 }} {...props} />
				),
				p: (props) => (
					<p style={{ marginBottom: 0, marginTop: 0 }} {...props} />
				),
				code: (props) => <code className="vp-llm-code" {...props} />,
				pre: (props) => <pre className="vp-llm-pre" {...props} />,
			}}
		>
			{content}
		</Markdown>
	);
};

// Service and model configurations
const SERVICE_CONFIG = {
	hyperbolic: {
		name: "Hyperbolic",
		models: [
			{ value: "deepseek-ai/DeepSeek-V3-0324", label: "DeepSeek V3" },
			{
				value: "meta-llama/Llama-3.3-70B-Instruct",
				label: "Llama 3.3 70B Instruct",
			},
			{
				value: "Qwen/Qwen2.5-72B-Instruct",
				label: "Qwen 2.5 72B Instruct",
			},
			{
				value: "Qwen/Qwen2.5-Coder-32B-Instruct",
				label: "Qwen 2.5 Coder 32B",
			},
		],
	},
	azure: {
		name: "Azure OpenAI",
		models: [{ value: "gpt-5-chat", label: "GPT-5 Chat" }],
	},
};

const LLMPage = () => {
	const { token } = theme.useToken();
	const [service, setService] = useState("hyperbolic");
	const [model, setModel] = useState("deepseek-ai/DeepSeek-V3-0324");

	const buildInitialItems = useCallback(
		() => [
			{
				key: getKey(),
				role: "system",
				content:
					"Hello! I'm your AI assistant. Select a service and model, then ask me anything!",
			},
		],
		[],
	);

	const [items, setItems] = useState(buildInitialItems);
	const [inputValue, setInputValue] = useState("");
	const [loading, setLoading] = useState(false);

	// Conversation management
	const [conversations, setConversations] = useState([]);
	const [activeConversationKey, setActiveConversationKey] = useState(null);

	const createNewConversation = useCallback(() => {
		const newKey = `conv_${Date.now()}`;
		const newConv = {
			key: newKey,
			label: `New Chat ${conversations.length + 1}`,
			messages: buildInitialItems(),
			service: "hyperbolic",
			model: "deepseek-ai/DeepSeek-V3-0324",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		setConversations((prev) => [newConv, ...prev]);
		setActiveConversationKey(newKey);
		setItems(buildInitialItems());
		setService("hyperbolic");
		setModel("deepseek-ai/DeepSeek-V3-0324");
		return newKey;
	}, [conversations.length, buildInitialItems]);

	// Load conversations from localStorage on mount
	useEffect(() => {
		const savedConversations = localStorage.getItem("llm_conversations");
		if (savedConversations) {
			try {
				const parsed = JSON.parse(savedConversations);
				setConversations(parsed);
				if (parsed.length > 0) {
					setActiveConversationKey(parsed[0].key);
					setItems(parsed[0].messages || buildInitialItems());
					if (parsed[0].service) setService(parsed[0].service);
					if (parsed[0].model) setModel(parsed[0].model);
				}
			} catch (error) {
				console.error("Failed to load conversations:", error);
			}
		} else {
			// Create initial conversation if none exists
			const newKey = `conv_${Date.now()}`;
			const newConv = {
				key: newKey,
				label: "New Chat 1",
				messages: buildInitialItems(),
				service: "hyperbolic",
				model: "deepseek-ai/DeepSeek-V3-0324",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			setConversations([newConv]);
			setActiveConversationKey(newKey);
			setItems(buildInitialItems());
		}
	}, [buildInitialItems]);

	// Save conversations to localStorage whenever they change
	useEffect(() => {
		if (conversations.length > 0) {
			localStorage.setItem("llm_conversations", JSON.stringify(conversations));
		}
	}, [conversations]);

	// Update current conversation messages when items change
	useEffect(() => {
		if (activeConversationKey) {
			setConversations((prev) =>
				prev.map((conv) =>
					conv.key === activeConversationKey
						? {
								...conv,
								messages: items,
								service,
								model,
								updatedAt: Date.now(),
							}
						: conv,
				),
			);
		}
	}, [items, activeConversationKey, service, model]);

	const switchConversation = (key) => {
		const conv = conversations.find((c) => c.key === key);
		if (conv) {
			setActiveConversationKey(key);
			setItems(conv.messages || buildInitialItems());
			setService(conv.service || "hyperbolic");
			setModel(conv.model || "deepseek-ai/DeepSeek-V3-0324");
			setInputValue("");
			setLoading(false);
		}
	};

	const deleteConversation = (key) => {
		const newConversations = conversations.filter((c) => c.key !== key);
		setConversations(newConversations);

		if (key === activeConversationKey) {
			if (newConversations.length > 0) {
				const newActive = newConversations[0];
				setActiveConversationKey(newActive.key);
				setItems(newActive.messages || buildInitialItems());
				setService(newActive.service || "hyperbolic");
				setModel(newActive.model || "deepseek-ai/DeepSeek-V3-0324");
				setInputValue("");
				setLoading(false);
			} else {
				createNewConversation();
			}
		}
	};

	const getConversationLabel = (conv) => {
		// Try to get label from first user message
		const userMessages = conv.messages?.filter((m) => m.role === "user");
		if (userMessages && userMessages.length > 0) {
			const firstMessage = userMessages[0].content;
			return (
				firstMessage.substring(0, 30) + (firstMessage.length > 30 ? "..." : "")
			);
		}
		return conv.label;
	};

	const getGroupForConversation = (timestamp) => {
		const now = Date.now();
		const diff = now - timestamp;
		const day = 24 * 60 * 60 * 1000;

		if (diff < day) return "Today";
		if (diff < 2 * day) return "Yesterday";
		if (diff < 7 * day) return "Previous 7 Days";
		return "Older";
	};

	const chatMutation = useChatWithLLM();
	const { data: userProfile } = useUserMe();

	// Get user initials for avatar
	const getUserInitials = () => {
		if (!userProfile) return "U";
		if (userProfile.first_name && userProfile.last_name) {
			return (
				userProfile.first_name[0] + userProfile.last_name[0]
			).toUpperCase();
		}
		if (userProfile.first_name) {
			return userProfile.first_name.substring(0, 2).toUpperCase();
		}
		if (userProfile.email) {
			return userProfile.email.substring(0, 2).toUpperCase();
		}
		return "U";
	};

	const handleCopyMessage = (content) => {
		navigator.clipboard.writeText(content);
		message.success("Message copied to clipboard");
	};

	const handleRegenerateMessage = async (itemKey) => {
		// Find the AI message and the user message before it
		const itemIndex = items.findIndex((item) => item.key === itemKey);
		if (itemIndex <= 0) return;

		const userMessage = items[itemIndex - 1];
		if (userMessage.role !== "user") return;

		// Remove the AI message being regenerated
		const newItems = items.slice(0, itemIndex);
		setItems(newItems);
		setLoading(true);

		const loadingKey = getKey();

		try {
			// Add a loading placeholder for AI
			setItems((prev) => [
				...prev,
				{
					key: loadingKey,
					role: "ai",
					content: "",
					loading: true,
					status: "loading",
					model: model,
				},
			]);

			// Prepare history for API (excluding the message being regenerated)
			const apiHistory = newItems
				.filter(
					(item) =>
						(item.role === "user" || item.role === "ai") && !item.loading,
				)
				.slice(-6)
				.map((item) => ({
					role: item.role === "ai" ? "assistant" : "user",
					content: item.content,
				}));

			const response = await chatMutation.mutateAsync({
				service,
				model,
				message: userMessage.content,
				history: apiHistory,
			});

			// Update the loading bubble with the actual response and enable typing
			setItems((prev) =>
				prev.map((item) => {
					if (item.key === loadingKey) {
						return {
							...item,
							content: response.response,
							loading: false,
							status: "updating",
							model: model,
						};
					}
					return item;
				}),
			);
		} catch (error) {
			console.error("Chat error:", error);
			setItems((prev) => {
				const hasLoading = prev.some((i) => i.key === loadingKey);
				if (hasLoading) {
					return prev.map((item) =>
						item.key === loadingKey
							? {
									...item,
									loading: false,
									status: "success",
									content: "Sorry, I encountered an error. Please try again.",
									model: model,
								}
							: item,
					);
				}
				return [
					...prev,
					{
						key: getKey(),
						role: "ai",
						status: "success",
						content: "Sorry, I encountered an error. Please try again.",
						model: model,
					},
				];
			});
		} finally {
			setLoading(false);
		}
	};

	const roles = {
		system: {
			placement: "end",
			variant: "borderless",
			style: {
				width: "100%",
				display: "flex",
				justifyContent: "center",
			},
			styles: {
				content: {
					background: "transparent",
					border: "none",
					boxShadow: "none",
				},
			},
			contentRender: (content) => <Bubble.System content={content} />,
		},
		ai: {
			placement: "start",
			variant: "borderless",
			typing: (_, { status }) =>
				status === "updating"
					? { effect: "typing", step: 5, interval: 20 }
					: false,
			style: {
				maxWidth: "100%",
				display: "block",
				width: "100%",
				color: token.colorText,
			},
			contentRender: (content, item) => {
				const itemKey = item.key;
				// Find the full item from the items array to get the model property
				const fullItem = items.find((i) => i.key === itemKey);
				const itemModel = fullItem?.model;
				return (
					<div className="vp-llm-bubble vp-llm-bubble--ai">
						<MarkdownRender content={content} />
						<div className="vp-llm-bubble-foot">
							<span className="vp-tag vp-tag--blue">
								{itemModel || "Unknown model"}
							</span>
							<Space size="small">
								<Tooltip title="Copy message">
									<button
										type="button"
										className="vp-llm-iconbtn"
										aria-label="Copy message"
										onClick={() => handleCopyMessage(content)}
									>
										<CopyOutlined />
									</button>
								</Tooltip>
								<Tooltip title="Regenerate response">
									<button
										type="button"
										className="vp-llm-iconbtn"
										aria-label="Regenerate response"
										onClick={() => handleRegenerateMessage(itemKey)}
									>
										<RedoOutlined />
									</button>
								</Tooltip>
							</Space>
						</div>
					</div>
				);
			},
			loadingRender: () => (
				<div className="vp-llm-bubble vp-llm-bubble--ai">
					<Flex align="center" gap="small">
						<Spin size="small" />
						<span className="vp-muted vp-llm-thinking">Thinking...</span>
					</Flex>
				</div>
			),
		},
		user: {
			placement: "end",
			avatar: (
				<Avatar className="vp-llm-avatar" shape="square">
					{getUserInitials()}
				</Avatar>
			),
			variant: "borderless",
			shape: "corner",
			style: {
				maxWidth: "100%",
			},
			styles: {
				content: {
					background: "transparent",
					border: "none",
					boxShadow: "none",
					padding: 0,
				},
			},
			contentRender: (content) => (
				<div className="vp-llm-bubble vp-llm-bubble--user">
					<UserMarkdownRender content={content} />
				</div>
			),
		},
	};

	const handleServiceChange = (e) => {
		const value = e.target.value;
		setService(value);
		// Set first model of new service as default
		const firstModel = SERVICE_CONFIG[value].models[0].value;
		setModel(firstModel);
	};

	const resetChat = () => {
		createNewConversation();
	};

	const handleSubmit = async (value) => {
		if (!value.trim()) return;

		// Create user message object
		const userItem = {
			key: getKey(),
			role: "user",
			content: value,
		};

		// Optimistically add user message
		const newItems = [...items, userItem];
		setItems(newItems);
		setInputValue("");
		setLoading(true);

		// AI loading bubble key
		const loadingKey = getKey();

		try {
			// Add a loading placeholder for AI
			setItems((prev) => [
				...prev,
				{
					key: loadingKey,
					role: "ai",
					content: "",
					loading: true,
					status: "loading",
					model: model,
				},
			]);

			// Prepare history for API
			const apiHistory = newItems
				.filter(
					(item) =>
						(item.role === "user" || item.role === "ai") && !item.loading,
				)
				.slice(-6)
				.map((item) => ({
					role: item.role === "ai" ? "assistant" : "user",
					content: item.content,
				}));

			const response = await chatMutation.mutateAsync({
				service,
				model,
				message: value,
				history: apiHistory,
			});

			// Update the loading bubble with the actual response and enable typing
			setItems((prev) =>
				prev.map((item) => {
					if (item.key === loadingKey) {
						return {
							...item,
							content: response.response,
							loading: false,
							status: "updating",
							model: model,
						};
					}
					return item;
				}),
			);
		} catch (error) {
			console.error("Chat error:", error);
			setItems((prev) => {
				const hasLoading = prev.some((i) => i.key === loadingKey);
				if (hasLoading) {
					return prev.map((item) =>
						item.key === loadingKey
							? {
									...item,
									loading: false,
									status: "success",
									content: "Sorry, I encountered an error. Please try again.",
									model: model,
								}
							: item,
					);
				}
				return [
					...prev,
					{
						key: getKey(),
						role: "ai",
						status: "success",
						content: "Sorry, I encountered an error. Please try again.",
						model: model,
					},
				];
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<PageContent variant="wide">
			<div className="vp-page-head">
				<div>
					<h1 className="vp-page-title">LLM Chat</h1>
					<p className="vp-page-subtitle">
						Chat with different AI models from various providers — pixel
						terminal edition.
					</p>
				</div>
				<PvButton
					variant="primary"
					icon={<PlusOutlined />}
					onClick={resetChat}
				>
					New Chat
				</PvButton>
			</div>

			<div className="vp-llm-layout">
				{/* Conversations Sidebar */}
				<section className="vp-panel vp-llm-side">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">Conversations</h3>
						<button
							type="button"
							className="vp-llm-iconbtn"
							aria-label="New conversation"
							onClick={createNewConversation}
						>
							<PlusOutlined />
						</button>
					</header>
					<div className="vp-llm-conv-list">
						{conversations.length === 0 && (
							<p className="vp-muted vp-llm-empty">No conversations yet.</p>
						)}
						{conversations.map((conv) => {
							const active = conv.key === activeConversationKey;
							return (
								<div
									key={conv.key}
									className={`vp-llm-conv ${active ? "vp-llm-conv--active" : ""}`}
								>
									<button
										type="button"
										className="vp-llm-conv-main"
										onClick={() => switchConversation(conv.key)}
									>
										<MessageOutlined className="vp-llm-conv-icon" />
										<span className="vp-llm-conv-label">
											{getConversationLabel(conv)}
										</span>
										<span className="vp-llm-conv-group">
											{getGroupForConversation(
												conv.updatedAt || conv.createdAt,
											)}
										</span>
									</button>
									<button
										type="button"
										className="vp-llm-conv-del"
										aria-label="Delete conversation"
										onClick={() => deleteConversation(conv.key)}
									>
										<DeleteOutlined />
									</button>
								</div>
							);
						})}
					</div>
				</section>

				{/* Main Content */}
				<section className="vp-panel vp-llm-main">
					<header className="vp-panel-bar">
						<span className="vp-dots">
							<span />
							<span />
							<span />
						</span>
						<h3 className="vp-panel-title">Terminal</h3>
						<div className="vp-llm-selects">
							<select
								className="vp-select vp-llm-select"
								value={service}
								onChange={handleServiceChange}
							>
								{Object.entries(SERVICE_CONFIG).map(([key, config]) => (
									<option key={key} value={key}>
										{config.name}
									</option>
								))}
							</select>
							<select
								className="vp-select vp-llm-select"
								value={model}
								onChange={(e) => setModel(e.target.value)}
							>
								{SERVICE_CONFIG[service].models.map((modelOption) => (
									<option key={modelOption.value} value={modelOption.value}>
										{modelOption.label}
									</option>
								))}
							</select>
						</div>
					</header>

					<div className="vp-llm-chat">
						{/* Bubble List Area */}
						<Bubble.List
							items={items}
							role={roles}
							autoScroll
							className="vp-llm-bubbles"
						/>

						{/* Input Area */}
						<div className="vp-llm-sender">
							<Sender
								value={inputValue}
								onChange={setInputValue}
								onSubmit={handleSubmit}
								placeholder="Type your message..."
								loading={loading || chatMutation.isPending}
							/>
						</div>
					</div>
				</section>
			</div>
		</PageContent>
	);
};

export default LLMPage;
