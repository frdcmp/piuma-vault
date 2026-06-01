import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createHealth,
	deleteHealth,
	getHealth,
	getHealths,
	getHello,
	updateHealth,
} from "../api/health";

// Query Keys
export const healthKeys = {
	all: ["health"],
	lists: () => [...healthKeys.all, "list"],
	list: (filter) => [...healthKeys.lists(), { filter }],
	details: () => [...healthKeys.all, "detail"],
	detail: (id) => [...healthKeys.details(), id],
	hello: ["hello"],
};

// Queries
export const useGetHello = () => {
	return useQuery({
		queryKey: healthKeys.hello,
		queryFn: getHello,
	});
};

export const useGetHealths = () => {
	return useQuery({
		queryKey: healthKeys.lists(),
		queryFn: getHealths,
	});
};

export const useGetHealth = (id) => {
	return useQuery({
		queryKey: healthKeys.detail(id),
		queryFn: () => getHealth(id),
		enabled: !!id,
	});
};

// Mutations
export const useCreateHealth = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: createHealth,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: healthKeys.lists() });
		},
	});
};

export const useUpdateHealth = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }) => updateHealth(id, name),
		onSuccess: (variables) => {
			queryClient.invalidateQueries({
				queryKey: healthKeys.detail(variables.id),
			});
			queryClient.invalidateQueries({ queryKey: healthKeys.lists() });
		},
	});
};

export const useDeleteHealth = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: deleteHealth,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: healthKeys.lists() });
		},
	});
};
