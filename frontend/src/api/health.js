import axiosInstance from "./axiosInstance";

// Lightweight liveness check — confirms the API is reachable.
export const getHello = async () => {
	try {
		const response = await axiosInstance.get("/health");
		return response.data;
	} catch (error) {
		console.error("Error fetching health:", error);
		throw error;
	}
};
