import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createSprite,
	deleteSprite,
	dismissSpriteGeneration,
	generateSprite,
	getActiveSprite,
	listSpriteGenerations,
	listSprites,
	setActiveSprite,
	updateSprite,
} from "../api/sprites";
import { useResourceLiveUpdates } from "./liveUpdates";

export const spriteKeys = {
	all: ["sprites"],
	active: ["sprites", "active"],
	list: ["sprites", "list"],
	generations: ["sprites", "generations"],
};

// Active mascot — works pre-auth (public endpoint). Long staleTime: it changes
// rarely, and the SpriteProvider falls back to a baked-in default meanwhile.
export const useActiveSprite = () =>
	useQuery({
		queryKey: spriteKeys.active,
		queryFn: getActiveSprite,
		staleTime: 5 * 60 * 1000,
		retry: 1,
	});

export const useSprites = () =>
	useQuery({ queryKey: spriteKeys.list, queryFn: listSprites });

const invalidateAll = (qc) =>
	qc.invalidateQueries({ queryKey: spriteKeys.all });

export const useCreateSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createSprite,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useUpdateSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateSprite,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useDeleteSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteSprite,
		onSuccess: () => invalidateAll(qc),
	});
};

export const useSetActiveSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: setActiveSprite,
		onSuccess: () => invalidateAll(qc),
	});
};

// AI generation runs server-side in rounds. Starting returns the job id; the
// rounds arrive over SSE (useSpritesLiveUpdates invalidates the whole sprites
// family, generations included).
export const useGenerateSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: generateSprite,
		onSuccess: () => qc.invalidateQueries({ queryKey: spriteKeys.generations }),
	});
};

export const useSpriteGenerations = () =>
	useQuery({
		queryKey: spriteKeys.generations,
		queryFn: listSpriteGenerations,
	});

export const useDismissSpriteGeneration = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: dismissSpriteGeneration,
		onSuccess: () => qc.invalidateQueries({ queryKey: spriteKeys.generations }),
	});
};

// Live updates — every AI-generation round is broadcast from the backend. No
// surgical handler: a full family invalidate re-fetches the generations (and
// the sprite list and active mascot).
export const useSpritesLiveUpdates = () =>
	useResourceLiveUpdates({
		path: "/admin/sprites/events",
		event: "sprite",
		queryKey: spriteKeys.all,
	});
