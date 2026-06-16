import { useCallback, useRef } from "react";
import { fetchConversation } from "../../api/agentChatApi";
import { appendTextPart, mapServerMessage } from "./messageModel";
import { createTextSmoother } from "./textSmoother";

// The streaming machinery shared by every turn (send / regenerate / fork): the
// stream callback factory, dropped-stream recovery, and the post-turn reload to
// server truth. All writes target the trailing assistant message (the empty
// bubble the host just pushed). The host owns `messages`/`isStreaming` state and
// the abort controller; this hook just produces handlers that drive them.
//
// `convRef` is the active-conversation ref so async writers (a detached stream,
// the recover poller) bail if the user switched away. `recoverTimeoutText`, when
// set, replaces the trailing reply's content after recovery gives up (the dock
// shows a "reopen to see it" note; the full page leaves it as-is).
export default function useChatStream({
	convRef,
	setMessages,
	setIsStreaming,
	activeModelRef,
	recoverTimeoutText = null,
}) {
	// The typewriter smoothing the active turn's text (one per turn). Held in a
	// ref so the post-turn reload can wait for it to finish painting, and an abort
	// can stop it mid-flight.
	const smootherRef = useRef(null);

	// Append literal text to the trailing assistant message (the smoother's sink).
	const commitText = useCallback(
		(delta) =>
			setMessages((curr) => {
				const updated = [...curr];
				const last = updated[updated.length - 1];
				updated[updated.length - 1] = {
					...last,
					parts: appendTextPart(last.parts, delta),
				};
				return updated;
			}),
		[setMessages],
	);

	// Poll the conversation until the assistant message lands, then rebuild from
	// server truth (what a manual reload does, automatically).
	const recoverTurn = useCallback(
		async (convId) => {
			for (let i = 0; i < 24; i++) {
				await new Promise((r) => setTimeout(r, 2500)); // ~60s total
				// Bail if the user switched away — don't overwrite another conversation.
				if (convRef.current !== convId) return;
				try {
					const d = await fetchConversation(convId);
					if (convRef.current !== convId) return;
					const msgs = d.messages || [];
					const last = msgs[msgs.length - 1];
					if (last && last.role === "assistant") {
						setMessages(msgs.map(mapServerMessage));
						return;
					}
				} catch {
					/* keep trying */
				}
			}
			if (convRef.current !== convId || !recoverTimeoutText) return;
			setMessages((curr) => {
				const updated = [...curr];
				const last = updated[updated.length - 1];
				if (last?.role === "assistant") {
					updated[updated.length - 1] = {
						...last,
						content: recoverTimeoutText,
					};
				}
				return updated;
			});
		},
		[convRef, setMessages, recoverTimeoutText],
	);

	// Refetch the active branch from the server and replace the message list —
	// gives every message its real id + branch metadata after a turn.
	const reloadActivePath = useCallback(
		async (convId) => {
			// Let the typewriter finish painting what it already received, then
			// reconcile to server truth — so the swap is seamless (no end-of-message
			// snap). On abort the smoother is already cancelled, so this resolves at
			// once.
			await (smootherRef.current?.finish() ?? Promise.resolve());
			smootherRef.current = null;
			if (!convId) return;
			try {
				const d = await fetchConversation(convId);
				if (convRef.current !== convId) return;
				setMessages((d.messages || []).map(mapServerMessage));
			} catch {
				/* ignore */
			}
		},
		[convRef, setMessages],
	);

	// Stream callbacks for a turn. onText/onTool append to the trailing assistant
	// message; onDone stamps the producing model and clears the streaming flag.
	const buildHandlers = useCallback(
		(convId, signal) => {
			// Fresh typewriter for this turn; abandon any previous one.
			smootherRef.current?.cancel();
			const smoother = createTextSmoother(commitText);
			smootherRef.current = smoother;
			// Stop (kill the turn) / switch conversations aborts the fetch — halt the
			// typewriter too so it doesn't keep typing into a stale message.
			signal?.addEventListener("abort", () => smoother.cancel(), {
				once: true,
			});
			return {
				onText: (delta) => smoother.push(delta),
				onThinking: () => {},
				onTool: (t) => {
					// Paint any buffered text before this non-text part so order holds.
					smoother.flush();
					if (t.name === "navigate") {
						if (t.done) return;
						setMessages((curr) => {
							const updated = [...curr];
							const last = { ...updated[updated.length - 1] };
							const parts = [...(last.parts || [])];
							const a = t.args || {};
							parts.push({
								kind: "nav",
								id: `p${parts.length}`,
								target: a.target,
								navId: a.id,
								route: a.route,
								url: a.url,
								label: a.label,
							});
							last.parts = parts;
							updated[updated.length - 1] = last;
							return updated;
						});
						return;
					}
					setMessages((curr) => {
						const updated = [...curr];
						const last = { ...updated[updated.length - 1] };
						const parts = [...(last.parts || [])];
						if (t.done) {
							for (let i = parts.length - 1; i >= 0; i--) {
								if (parts[i].kind !== "tools") continue;
								const idx = parts[i].tools.findIndex((x) => x.id === t.id);
								if (idx >= 0) {
									const tools = [...parts[i].tools];
									tools[idx] = {
										...tools[idx],
										label: t.label || tools[idx].label,
										status: t.ok ? "done" : "error",
									};
									parts[i] = { ...parts[i], tools };
									break;
								}
							}
						} else {
							let run = parts[parts.length - 1];
							if (run?.kind !== "tools") {
								run = { kind: "tools", id: `p${parts.length}`, tools: [] };
								parts.push(run);
							} else {
								run = { ...run, tools: [...run.tools] };
								parts[parts.length - 1] = run;
							}
							run.tools.push({
								id: t.id,
								name: t.name,
								args: t.args,
								status: "running",
							});
						}
						last.parts = parts;
						updated[updated.length - 1] = last;
						return updated;
					});
				},
				onError: (e) => {
					// Drain buffered text first, then append the notice after it.
					smoother.flush();
					if (e?.isTransport && convId) {
						commitText("\n\n_(reconnecting…)_");
						recoverTurn(convId);
						return;
					}
					commitText(`\n\n**Error:** ${e.message}`);
				},
				onDone: () => {
					const used = activeModelRef.current?.model_id || null;
					if (used)
						setMessages((curr) => {
							const updated = [...curr];
							const last = updated[updated.length - 1];
							if (last?.role === "assistant")
								updated[updated.length - 1] = { ...last, model: used };
							return updated;
						});
					setIsStreaming(false);
				},
			};
		},
		[commitText, recoverTurn, setMessages, setIsStreaming, activeModelRef],
	);

	return { buildHandlers, recoverTurn, reloadActivePath };
}
