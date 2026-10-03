import axiosInstance from "./axiosInstance";

// Voice agent (speech-to-speech). The audio itself goes straight from the
// browser to the provider; these calls mint the session, relay the model's
// tool calls to the backend, and persist finished turns.

// → { conversation_id, provider, model, ws_url, setup }
export const startVoiceSession = async (payload) => {
	const { data } = await axiosInstance.post("/agents/voice/sessions", payload);
	return data;
};

// → { ok, label, result }
export const runVoiceTool = async (payload) => {
	const { data } = await axiosInstance.post("/agents/voice/tool", payload);
	return data;
};

// → { message_id }
export const saveVoiceTurn = async (payload) => {
	const { data } = await axiosInstance.post("/agents/voice/turns", payload);
	return data;
};
