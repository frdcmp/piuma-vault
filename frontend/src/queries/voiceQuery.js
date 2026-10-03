import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runVoiceTool, saveVoiceTurn, startVoiceSession } from "../api/voice";

export const useStartVoiceSession = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: startVoiceSession,
		// A new voice conversation shows up in the chat session list.
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["agents", "conversations"] }),
	});
};

export const useRunVoiceTool = () => useMutation({ mutationFn: runVoiceTool });

export const useSaveVoiceTurn = () =>
	useMutation({ mutationFn: saveVoiceTurn });
