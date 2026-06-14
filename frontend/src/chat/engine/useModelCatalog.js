import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAllModels } from "../../api/agentChatApi";

// Loads the model catalog once and resolves the model actually in use for this
// chat: the conversation's override (`modelId`), or — when it has none — the one
// flagged `is_default` (what the backend falls back to). Exposes vision gating,
// a ref to the active model (for the stream's onDone stamp), and a resolver from
// a message's stored wire id to a friendly display name.
export default function useModelCatalog(modelId) {
	const [allModels, setAllModels] = useState([]);

	useEffect(() => {
		fetchAllModels()
			.then(setAllModels)
			.catch(() => {});
	}, []);

	const activeModel = useMemo(() => {
		if (!allModels.length) return null;
		return modelId
			? allModels.find((m) => m.id === modelId)
			: allModels.find((m) => m.is_default);
	}, [allModels, modelId]);
	const visionEnabled = !!activeModel?.supports_vision;

	// The active model as a ref, so the stream's onDone can stamp the model onto
	// the just-streamed reply without re-creating the handlers.
	const activeModelRef = useRef(activeModel);
	useEffect(() => {
		activeModelRef.current = activeModel;
	}, [activeModel]);

	const modelLabelFor = useCallback(
		(m) => {
			if (!m?.model) return null;
			const hit = allModels.find(
				(x) => x.model_id === m.model || x.id === m.model,
			);
			return hit?.display_name || m.model;
		},
		[allModels],
	);

	return {
		allModels,
		activeModel,
		visionEnabled,
		activeModelRef,
		modelLabelFor,
	};
}
