import {
	DeleteOutlined,
	PlusOutlined,
	SendOutlined,
	StarFilled,
	StarOutlined,
} from "@ant-design/icons";
import {
	Button,
	Card,
	Collapse,
	Empty,
	Form,
	Input,
	List,
	Modal,
	message,
	Popconfirm,
	Select,
	Space,
	Spin,
	Tabs,
	Tag,
	Typography,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { streamChat } from "../../../api/agentChatApi";
import {
	useAgentList,
	useAgentPersonas,
	useAgentProfile,
	useConversation,
	useConversations,
	useCreateConversation,
	useCreateModel,
	useCreateProvider,
	useDeleteConversation,
	useDeleteModel,
	useDeleteProvider,
	useModels,
	useProviders,
	useUpdateAgentProfile,
	useUpdateModel,
	useUpdatePersona,
} from "../../../queries";

const { Title, Text, Paragraph } = Typography;
const PROVIDER_KINDS = ["deepseek", "anthropic", "openai", "gemini", "minimax"];

// ── Providers + models ───────────────────────────────────────────────────────

function ModelsList({ providerId }) {
	const { data: models = [], isLoading } = useModels(providerId);
	const createModel = useCreateModel();
	const updateModel = useUpdateModel();
	const deleteModel = useDeleteModel();
	const [form] = Form.useForm();

	const onAdd = async (v) => {
		try {
			await createModel.mutateAsync({ providerId, ...v });
			form.resetFields();
			message.success("Model added");
		} catch (e) {
			message.error(e?.response?.data?.error || "Failed to add model");
		}
	};

	if (isLoading) return <Spin size="small" />;
	return (
		<div style={{ marginTop: 8 }}>
			{models.map((m) => (
				<div
					key={m.id}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "4px 0",
					}}
				>
					<Button
						type="text"
						size="small"
						icon={
							m.is_default ? (
								<StarFilled style={{ color: "#f7c948" }} />
							) : (
								<StarOutlined />
							)
						}
						title={m.is_default ? "Default model" : "Set as default"}
						onClick={() => updateModel.mutate({ id: m.id, is_default: true })}
					/>
					<Text strong>{m.display_name}</Text>
					<Text type="secondary" style={{ fontSize: 12 }}>
						{m.model_id}
					</Text>
					{m.supports_thinking && <Tag color="purple">thinking</Tag>}
					<Popconfirm
						title="Delete model?"
						onConfirm={() => deleteModel.mutate(m.id)}
					>
						<Button type="text" size="small" danger icon={<DeleteOutlined />} />
					</Popconfirm>
				</div>
			))}
			<Form
				form={form}
				layout="inline"
				onFinish={onAdd}
				style={{ marginTop: 8, rowGap: 8 }}
			>
				<Form.Item name="model_id" rules={[{ required: true }]}>
					<Input placeholder="wire id (e.g. deepseek-chat)" size="small" />
				</Form.Item>
				<Form.Item name="display_name" rules={[{ required: true }]}>
					<Input placeholder="display name" size="small" />
				</Form.Item>
				<Form.Item>
					<Button size="small" htmlType="submit" icon={<PlusOutlined />}>
						Add model
					</Button>
				</Form.Item>
			</Form>
		</div>
	);
}

function ProvidersTab() {
	const { data: providers = [], isLoading } = useProviders();
	const createProvider = useCreateProvider();
	const deleteProvider = useDeleteProvider();
	const [open, setOpen] = useState(false);
	const [form] = Form.useForm();

	const onCreate = async (v) => {
		try {
			await createProvider.mutateAsync(v);
			setOpen(false);
			form.resetFields();
			message.success("Provider added");
		} catch (e) {
			message.error(e?.response?.data?.error || "Failed to add provider");
		}
	};

	if (isLoading) return <Spin />;
	return (
		<div>
			<Space style={{ marginBottom: 16 }}>
				<Button
					type="primary"
					icon={<PlusOutlined />}
					onClick={() => setOpen(true)}
				>
					Add provider
				</Button>
			</Space>
			{providers.length === 0 && (
				<Empty description="No providers yet — add DeepSeek to start." />
			)}
			{providers.map((p) => (
				<Card
					key={p.id}
					size="small"
					style={{ marginBottom: 12 }}
					title={
						<Space>
							<Text strong>{p.display_name}</Text>
							<Tag>{p.kind}</Tag>
							{p.has_key ? (
								<Text type="secondary" style={{ fontSize: 12 }}>
									key {p.api_key_masked}
								</Text>
							) : (
								<Tag color="red">no key</Tag>
							)}
						</Space>
					}
					extra={
						<Popconfirm
							title="Delete provider and its models?"
							onConfirm={() => deleteProvider.mutate(p.id)}
						>
							<Button type="text" danger icon={<DeleteOutlined />} />
						</Popconfirm>
					}
				>
					<ModelsList providerId={p.id} />
				</Card>
			))}

			<Modal
				title="Add provider"
				open={open}
				onCancel={() => setOpen(false)}
				onOk={() => form.submit()}
			>
				<Form
					form={form}
					layout="vertical"
					onFinish={onCreate}
					initialValues={{ kind: "deepseek" }}
				>
					<Form.Item name="kind" label="Kind" rules={[{ required: true }]}>
						<Select
							options={PROVIDER_KINDS.map((k) => ({ value: k, label: k }))}
						/>
					</Form.Item>
					<Form.Item
						name="display_name"
						label="Display name"
						rules={[{ required: true }]}
					>
						<Input placeholder="DeepSeek" />
					</Form.Item>
					<Form.Item
						name="api_key"
						label="API key"
						rules={[{ required: true }]}
					>
						<Input.Password placeholder="sk-…" />
					</Form.Item>
					<Form.Item name="base_url" label="Base URL (optional)">
						<Input placeholder="https://api.deepseek.com" />
					</Form.Item>
				</Form>
			</Modal>
		</div>
	);
}

// ── Agent config (profile + persona) ────────────────────────────────────────

function ConfigTab({ agent }) {
	const { data: profile, isLoading: lp } = useAgentProfile(agent);
	const { data: personas = [], isLoading: lpe } = useAgentPersonas(agent);
	const updateProfile = useUpdateAgentProfile();
	const updatePersona = useUpdatePersona();
	const [pForm] = Form.useForm();
	const [perForm] = Form.useForm();
	const persona = personas[0];

	useEffect(() => {
		if (profile) pForm.setFieldsValue(profile);
	}, [profile, pForm]);
	useEffect(() => {
		if (persona)
			perForm.setFieldsValue({
				...persona,
				allowed_tools: (persona.allowed_tools || []).join(", "),
			});
	}, [persona, perForm]);

	const saveProfile = async (v) => {
		try {
			await updateProfile.mutateAsync({ agent, ...v });
			message.success("Profile saved");
		} catch {
			message.error("Failed to save profile");
		}
	};
	const savePersona = async (v) => {
		const tools = (v.allowed_tools || "")
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean);
		try {
			await updatePersona.mutateAsync({
				id: persona.id,
				...v,
				allowed_tools: tools.length ? tools : null,
			});
			message.success("Persona saved");
		} catch {
			message.error("Failed to save persona");
		}
	};

	if (lp || lpe) return <Spin />;
	return (
		<div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
			<Card
				title="Agent profile"
				size="small"
				style={{ flex: 1, minWidth: 360 }}
			>
				<Form form={pForm} layout="vertical" onFinish={saveProfile}>
					<Form.Item name="display_name" label="Display name">
						<Input />
					</Form.Item>
					<Form.Item name="instructions" label="Instructions (always loaded)">
						<Input.TextArea autoSize={{ minRows: 6, maxRows: 20 }} />
					</Form.Item>
					<Form.Item name="user_context" label="User context">
						<Input.TextArea autoSize={{ minRows: 3, maxRows: 12 }} />
					</Form.Item>
					<Form.Item name="memory" label="Memory">
						<Input.TextArea autoSize={{ minRows: 3, maxRows: 12 }} />
					</Form.Item>
					<Button
						type="primary"
						htmlType="submit"
						loading={updateProfile.isPending}
					>
						Save profile
					</Button>
				</Form>
			</Card>

			{persona && (
				<Card
					title={`Persona — ${persona.display_name || persona.name}`}
					size="small"
					style={{ flex: 1, minWidth: 360 }}
				>
					<Form form={perForm} layout="vertical" onFinish={savePersona}>
						<Space>
							<Form.Item name="emoji" label="Emoji">
								<Input style={{ width: 80 }} />
							</Form.Item>
							<Form.Item name="display_name" label="Display name">
								<Input />
							</Form.Item>
						</Space>
						<Form.Item
							name="system_prompt"
							label="System prompt (voice / who-I-am)"
						>
							<Input.TextArea autoSize={{ minRows: 8, maxRows: 24 }} />
						</Form.Item>
						<Form.Item
							name="allowed_tools"
							label="Allowed tools (comma-separated; empty = inherit all)"
						>
							<Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
						</Form.Item>
						<Button
							type="primary"
							htmlType="submit"
							loading={updatePersona.isPending}
						>
							Save persona
						</Button>
					</Form>
				</Card>
			)}
		</div>
	);
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function renderBlocks(content) {
	const blocks = Array.isArray(content) ? content : [];
	const thinking = blocks
		.filter((b) => b.type === "thinking")
		.map((b) => b.text)
		.join("");
	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return { thinking, text };
}

function MessageBubble({ sender, text, thinking }) {
	const isUser = sender === "user";
	return (
		<div
			style={{
				display: "flex",
				justifyContent: isUser ? "flex-end" : "flex-start",
				margin: "8px 0",
			}}
		>
			<div
				style={{
					maxWidth: "80%",
					background: isUser ? "#5cd0a9" : "#1b1e25",
					color: isUser ? "#0e0f12" : "#d6dbe5",
					border: isUser ? "none" : "1px solid #2a2f3a",
					borderRadius: 10,
					padding: "8px 12px",
				}}
			>
				{thinking ? (
					<Collapse
						ghost
						size="small"
						items={[
							{
								key: "t",
								label: "💭 thinking",
								children: (
									<div style={{ whiteSpace: "pre-wrap", opacity: 0.8 }}>
										{thinking}
									</div>
								),
							},
						]}
					/>
				) : null}
				<div style={{ whiteSpace: "pre-wrap" }}>{text}</div>
			</div>
		</div>
	);
}

function ChatTab({ agent }) {
	const { data: conversations = [] } = useConversations(agent);
	const createConversation = useCreateConversation();
	const deleteConversation = useDeleteConversation();
	const [activeId, setActiveId] = useState(null);
	const { data: convData, refetch } = useConversation(activeId);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [liveText, setLiveText] = useState("");
	const [liveThinking, setLiveThinking] = useState("");
	const [optimisticUser, setOptimisticUser] = useState(null);
	const abortRef = useRef(null);
	const scrollRef = useRef(null);

	const messages = convData?.messages || [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when new content arrives
	useEffect(() => {
		scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
	}, [messages, liveText, liveThinking]);

	const newConversation = async () => {
		try {
			const conv = await createConversation.mutateAsync({ agent });
			setActiveId(conv.id);
		} catch {
			message.error("Failed to start conversation");
		}
	};

	const send = async () => {
		const text = input.trim();
		if (!text || streaming) return;
		let convId = activeId;
		if (!convId) {
			try {
				const conv = await createConversation.mutateAsync({ agent });
				convId = conv.id;
				setActiveId(conv.id);
			} catch {
				message.error("Failed to start conversation");
				return;
			}
		}
		setInput("");
		setOptimisticUser(text);
		setLiveText("");
		setLiveThinking("");
		setStreaming(true);
		const controller = new AbortController();
		abortRef.current = controller;
		await streamChat({
			conversationId: convId,
			message: text,
			signal: controller.signal,
			onText: (d) => setLiveText((t) => t + d),
			onThinking: (d) => setLiveThinking((t) => t + d),
			onError: (e) => message.error(e.message || "Chat error"),
			onDone: () => {},
		});
		setStreaming(false);
		setOptimisticUser(null);
		setLiveText("");
		setLiveThinking("");
		await refetch();
	};

	return (
		<div style={{ display: "flex", gap: 16, height: "70vh" }}>
			<Card
				size="small"
				style={{ width: 240, overflowY: "auto" }}
				bodyStyle={{ padding: 8 }}
			>
				<Button
					block
					icon={<PlusOutlined />}
					onClick={newConversation}
					style={{ marginBottom: 8 }}
				>
					New chat
				</Button>
				<List
					size="small"
					dataSource={conversations}
					locale={{ emptyText: "No conversations" }}
					renderItem={(c) => (
						<List.Item
							style={{
								cursor: "pointer",
								background: c.id === activeId ? "#15171c" : "transparent",
								borderRadius: 6,
								padding: "6px 8px",
							}}
							onClick={() => setActiveId(c.id)}
							actions={[
								<Popconfirm
									key="d"
									title="Delete?"
									onConfirm={(e) => {
										e?.stopPropagation();
										deleteConversation.mutate(c.id);
										if (c.id === activeId) setActiveId(null);
									}}
								>
									<DeleteOutlined onClick={(e) => e.stopPropagation()} />
								</Popconfirm>,
							]}
						>
							<Text ellipsis style={{ fontSize: 13 }}>
								{c.title || "Untitled"}
							</Text>
						</List.Item>
					)}
				/>
			</Card>

			<Card
				size="small"
				style={{ flex: 1, display: "flex", flexDirection: "column" }}
				bodyStyle={{
					display: "flex",
					flexDirection: "column",
					flex: 1,
					minHeight: 0,
				}}
			>
				<div
					ref={scrollRef}
					style={{ flex: 1, overflowY: "auto", paddingRight: 8 }}
				>
					{messages.length === 0 && !optimisticUser && (
						<Empty description="Say hi to Piuma 🐾" style={{ marginTop: 80 }} />
					)}
					{messages.map((m) => {
						const { thinking, text } = renderBlocks(m.content);
						return (
							<MessageBubble
								key={m.id}
								sender={m.role}
								text={text}
								thinking={thinking}
							/>
						);
					})}
					{optimisticUser && (
						<MessageBubble sender="user" text={optimisticUser} />
					)}
					{streaming && (
						<MessageBubble
							sender="assistant"
							text={liveText || "…"}
							thinking={liveThinking}
						/>
					)}
				</div>
				<Space.Compact style={{ marginTop: 8 }}>
					<Input.TextArea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Message Piuma…"
						autoSize={{ minRows: 1, maxRows: 5 }}
						onPressEnter={(e) => {
							if (!e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<Button
						type="primary"
						icon={<SendOutlined />}
						loading={streaming}
						onClick={send}
					>
						Send
					</Button>
				</Space.Compact>
			</Card>
		</div>
	);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
	const { data: agents = [] } = useAgentList();
	const agent = agents[0]?.kind || "vault_agent";

	return (
		<div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
			<Title level={3}>Agents</Title>
			<Paragraph type="secondary">
				Multi-provider LLM chat. Add a provider + model, tune the agent's
				config, and chat.
			</Paragraph>
			<Tabs
				defaultActiveKey="chat"
				items={[
					{ key: "chat", label: "Chat", children: <ChatTab agent={agent} /> },
					{
						key: "providers",
						label: "Providers & models",
						children: <ProvidersTab />,
					},
					{
						key: "config",
						label: "Agent config",
						children: <ConfigTab agent={agent} />,
					},
				]}
			/>
		</div>
	);
}
