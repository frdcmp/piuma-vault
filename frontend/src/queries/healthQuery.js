import { useQuery } from "@tanstack/react-query";
import { getHello } from "../api/health";

// Query Keys
export const healthKeys = {
	hello: ["hello"],
};

// Queries
export const useGetHello = () => {
	return useQuery({
		queryKey: healthKeys.hello,
		queryFn: getHello,
	});
};
