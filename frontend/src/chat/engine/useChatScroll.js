import { useCallback, useEffect, useRef, useState } from "react";

// Stick-to-bottom scrolling for the message viewport. Auto-follows new content
// only while parked near the bottom; scrolling up releases the lock (so a stream
// stops yanking you down) and reveals a jump-to-latest button.
export default function useChatScroll(messages) {
	const scrollRef = useRef(null);
	const atBottomRef = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 80;
		atBottomRef.current = atBottom;
		setShowJump((p) => (p === !atBottom ? p : !atBottom));
	}, []);

	const scrollToBottom = useCallback(() => {
		atBottomRef.current = true;
		setShowJump(false);
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		if (!atBottomRef.current || !scrollRef.current) return;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [messages]);

	return { scrollRef, atBottomRef, showJump, handleScroll, scrollToBottom };
}
