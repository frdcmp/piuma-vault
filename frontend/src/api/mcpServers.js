import axiosInstance from "./axiosInstance";

// Admin-managed MCP servers (Services → MCP). Each server exposes its tools to
// the chat agent as `mcp__{name}__{tool}`. Auth tokens and env values are
// write-only: the list returns `auth_token_set` / `env_keys`, never the values.

export const listMcpServers = async () => {
	const { data } = await axiosInstance.get("/admin/mcp/servers");
	return data;
};

export const createMcpServer = async (payload) => {
	const { data } = await axiosInstance.post("/admin/mcp/servers", payload);
	return data;
};

export const updateMcpServer = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/mcp/servers/${id}`, payload);
	return data;
};

export const deleteMcpServer = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/mcp/servers/${id}`);
	return data;
};

// Reconnects to the server and re-discovers its tools. Resolves to
// { server, count, tools }; the row's last_status/tools update server-side,
// so refetch the list afterwards.
export const testMcpServer = async (id) => {
	const { data } = await axiosInstance.post(`/admin/mcp/servers/${id}/test`);
	return data;
};

// Worker health snapshot: { status: "ok", servers: [...] }, or a 502 when the
// MCP worker itself is unreachable.
export const getMcpHealth = async () => {
	const { data } = await axiosInstance.get("/admin/mcp/health");
	return data;
};
