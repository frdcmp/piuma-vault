import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createSprite,
	deleteSprite,
	getActiveSprite,
	listSprites,
	setActiveSprite,
	updateSprite,
} from "../api/sprites";

export const spriteKeys = {
	all: ["sprites"],
	active: ["sprites", "active"],
	list: ["sprites", "list"],
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
