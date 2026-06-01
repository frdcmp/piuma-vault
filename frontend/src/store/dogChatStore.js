import { create } from "zustand";
import lisaImg from "../img/dogs/lisa.png";
import piumaImg from "../img/dogs/piuma.png";
import sofiaImg from "../img/dogs/sofia.png";
import stellaImg from "../img/dogs/stella.png";

export const DOG_AGENTS = {
	piuma: {
		name: "piuma",
		displayName: "Piuma",
		title: "Head of Security · Barking Division",
		image: piumaImg,
		greeting:
			"Hi! I'm Piuma 🐾 — User's dog and the host of this little chat. Ask me about my human, his work, or this website.",
		typingLine: "Piuma is sniffing for the answer…",
		inputPlaceholder: "Ask Piuma something…",
		suggestions: [
			"Who is User?",
			"What does he do at Example?",
			"How is this website built?",
			"Why are you the Head of Security?",
		],
	},
	stella: {
		name: "stella",
		displayName: "Stella",
		title: "VP of Naps & Treats",
		image: stellaImg,
		greeting:
			"Hey, I'm Stella 🐶 — Piuma's calmer sister. Settle in and ask me anything about User, his work, or this little website.",
		typingLine: "Stella is taking a moment to think…",
		inputPlaceholder: "Ask Stella something…",
		suggestions: [
			"Who is User?",
			"What does he do at Example?",
			"How is this website built?",
			"What's your favorite spot for a nap?",
		],
	},
	lisa: {
		name: "lisa",
		displayName: "Lisa",
		title: "Chief Elegance Officer",
		image: lisaImg,
		greeting:
			"Hello. I'm Lisa 🐕. I may be a champion hound, but right now I'm here to answer your questions about User.",
		typingLine: "Lisa is composing a response…",
		inputPlaceholder: "Ask Lisa something…",
		suggestions: [
			"Who is User?",
			"What does he do at Example?",
			"Tell me about your hunting competitions",
		],
	},
	sofia: {
		name: "sofia",
		displayName: "Sofia",
		title: "Head of Hugs & Protection",
		image: sofiaImg,
		greeting:
			"Woof! I'm Sofia 🐾, the big friendly sheepdog. I'm always looking out for User, but I'm happy to chat with you too!",
		typingLine: "Sofia is wagging her tail and thinking…",
		inputPlaceholder: "Ask Sofia something…",
		suggestions: [
			"Who is User?",
			"What does he do at Example?",
			"Why are you so good at hugging?",
		],
	},
};

const useDogChatStore = create((set) => ({
	activeAgent: "piuma",
	open: false,

	setActiveAgent: (name) =>
		set(() => ({
			activeAgent: DOG_AGENTS[name] ? name : "piuma",
		})),

	openChatWith: (name) =>
		set(() => ({
			activeAgent: DOG_AGENTS[name] ? name : "piuma",
			open: true,
		})),

	toggleChat: () => set((state) => ({ open: !state.open })),
	closeChat: () => set({ open: false }),
}));

export default useDogChatStore;
