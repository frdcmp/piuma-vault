import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createMcpServer,
	deleteMcpServer,
	getMcpHealth,
	listMcpServers,
	testMcpServer,
	updateMcpServer,
} from "../api/mcpServers";

const MCP_SERVERS_KEY = ["mcp-servers"];
const MCP_HEALTH_KEY = ["mcp-health"];

export const useMcpServers = () =>
	useQuery({
		queryKey: MCP_SERVERS_KEY,
		queryFn: listMcpServers,
	});

export const useMcpHealth = () =>
	useQuery({
		queryKey: MCP_HEALTH_KEY,
		queryFn: getMcpHealth,
		retry: false,
	});

export const useCreateMcpServer = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createMcpServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
	});
};

export const useUpdateMcpServer = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateMcpServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
	});
};

export const useDeleteMcpServer = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteMcpServer,
		onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
	});
};

// A test reconnects and re-discovers tools; last_status/tools change
// server-side on success *and* failure, so refetch the list either way.
export const useTestMcpServer = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: testMcpServer,
		onSettled: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
	});
};
