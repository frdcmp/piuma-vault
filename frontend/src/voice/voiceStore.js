import { create } from "zustand";

// Live state of the voice agent, written by the engine (voiceEngine.js) and
// read by the Voice page + header indicator. Nothing here is persisted.
//
// status: idle → connecting → listening ⇄ (thinking | speaking) → idle | error
const useVoiceStore = create((set) => ({
	status: "idle",
	error: null,
	conversationId: null,
	muted: false,
	// 0..1 loudness, ~20 Hz: the mic while you talk, Piuma's voice while it talks.
	micLevel: 0,
	outLevel: 0,
	// The turn in progress: what you're saying, what Piuma is saying, and the
	// tools it ran for this answer ({ id, name, label, done, ok }).
	userText: "",
	piumaText: "",
	tools: [],

	patch: (p) => set(p),
	resetTurn: () => set({ userText: "", piumaText: "", tools: [] }),
	reset: () =>
		set({
			status: "idle",
			error: null,
			muted: false,
			micLevel: 0,
			outLevel: 0,
			userText: "",
			piumaText: "",
			tools: [],
		}),
}));

export default useVoiceStore;
