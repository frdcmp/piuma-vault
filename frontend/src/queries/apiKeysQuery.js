import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axiosInstance from "../api/axiosInstance";

const API_KEYS_KEY = ["apiKeys"];

// ── API calls ─────────────────────────────────────────────────────────────

const fetchApiKeys = async () => {
	const { data } = await axiosInstance.get("/admin/api-keys");
	return data;
};

const fetchApiKey = async (id) => {
	const { data } = await axiosInstance.get(`/admin/api-keys/${id}`);
	return data;
};

const createApiKey = async (payload) => {
	const { data } = await axiosInstance.post("/admin/api-keys", payload);
	return data;
};

const updateApiKey = async ({ id, ...payload }) => {
	const { data } = await axiosInstance.put(`/admin/api-keys/${id}`, payload);
	return data;
};

const revokeApiKey = async (id) => {
	const { data } = await axiosInstance.post(`/admin/api-keys/${id}/revoke`);
	return data;
};

const deleteApiKey = async (id) => {
	const { data } = await axiosInstance.delete(`/admin/api-keys/${id}`);
	return data;
};

// ── Hooks ─────────────────────────────────────────────────────────────────

export const useGetApiKeys = () =>
	useQuery({
		queryKey: API_KEYS_KEY,
		queryFn: fetchApiKeys,
	});

export const useGetApiKey = (id) =>
	useQuery({
		queryKey: [...API_KEYS_KEY, id],
		queryFn: () => fetchApiKey(id),
		enabled: !!id,
	});

export const useCreateApiKey = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createApiKey,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: API_KEYS_KEY });
		},
	});
};

export const useUpdateApiKey = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateApiKey,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: API_KEYS_KEY });
		},
	});
};

export const useRevokeApiKey = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: revokeApiKey,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: API_KEYS_KEY });
		},
	});
};

export const useDeleteApiKey = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteApiKey,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: API_KEYS_KEY });
		},
	});
};
