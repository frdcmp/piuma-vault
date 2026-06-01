import axiosInstance from "./axiosInstance";

export const getHello = async () => {
	try {
		const response = await axiosInstance.get("/health");
		return response.data;
	} catch (error) {
		console.error("Error fetching hello:", error);
		throw error;
	}
};

// Health CRUD operations
export const getHealths = async () => {
	try {
		const response = await axiosInstance.get("/health/list");
		return response.data;
	} catch (error) {
		console.error("Error fetching healths:", error);
		throw error;
	}
};

export const getHealth = async (id) => {
	try {
		const response = await axiosInstance.get(`/health/${id}`);
		return response.data;
	} catch (error) {
		console.error("Error fetching health:", error);
		throw error;
	}
};

export const createHealth = async (name) => {
	try {
		const response = await axiosInstance.post("/health", { name });
		return response.data;
	} catch (error) {
		console.error("Error creating health:", error);
		throw error;
	}
};

export const updateHealth = async (id, name) => {
	try {
		const response = await axiosInstance.put(`/health/${id}`, { name });
		return response.data;
	} catch (error) {
		console.error("Error updating health:", error);
		throw error;
	}
};

export const deleteHealth = async (id) => {
	try {
		const response = await axiosInstance.delete(`/health/${id}`);
		return response.data;
	} catch (error) {
		console.error("Error deleting health:", error);
		throw error;
	}
};
