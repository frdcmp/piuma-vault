import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	getServices,
	testEmbedding,
	testStorage,
	testWebsearch,
	updateServices,
} from "../api/services";

const SERVICES_KEY = ["services"];

export const useServices = () =>
	useQuery({
		queryKey: SERVICES_KEY,
		queryFn: getServices,
	});

export const useUpdateServices = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateServices,
		onSuccess: (data) => {
			// The PUT returns the fresh config — seed the cache directly.
			qc.setQueryData(SERVICES_KEY, data);
		},
	});
};

export const useTestEmbedding = () =>
	useMutation({ mutationFn: testEmbedding });

export const useTestStorage = () => useMutation({ mutationFn: testStorage });

export const useTestWebsearch = () =>
	useMutation({ mutationFn: testWebsearch });
