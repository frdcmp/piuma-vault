import { create } from "zustand";

// Where Pigeon is with a chat's newest messages: by thread, { stage, until?,
// outcome?, at (the vault's time), seen (this tab's, when it got here) }.
// From the live stream (`pigeon_working`) and a chat's payload (`working`, for
// a chat opened mid-way); the vault's time says which is newer.
// stage: listening (a voice note being heard) · reading (landed, a moment for
// more) · analysing (the triage reads it) · deciding (the agent decides and
// writes) · typing (the reply on its way; `until`: when it lands) · waiting
// (the user writes there: `until`, when Pigeon reads it again) · done
// (`outcome`: replied · asked · nothing · paused · stopped · failed).
const usePigeonWorkingStore = create((set) => ({
	by: {},
	note: (id, data) =>
		set((s) => {
			const have = s.by[id];
			const at = data?.at ? new Date(data.at).getTime() : Date.now();
			if (have && have.at > at) return s;
			if (have && have.at === at && have.stage === data?.stage) return s;
			return { by: { ...s.by, [id]: { ...data, at, seen: Date.now() } } };
		}),
}));

export default usePigeonWorkingStore;
