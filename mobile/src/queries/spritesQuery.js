import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	getActiveSprite,
	listSprites,
	setActiveSprite,
} from "../api/spritesApi";

export const spriteKeys = {
	all: ["sprites"],
	list: ["sprites", "list"],
	active: ["sprites", "active"],
};

// Active mascot. Long staleTime (rarely changes); the persisted query cache
// keeps the last-known mascot offline, and SpriteProvider falls back to a
// baked-in default for a cold first launch.
export const useActiveSprite = () =>
	useQuery({
		queryKey: spriteKeys.active,
		queryFn: getActiveSprite,
		staleTime: 5 * 60 * 1000,
		retry: 1,
	});

// All mascots, for the Appearance picker.
export const useSprites = (options = {}) =>
	useQuery({
		queryKey: spriteKeys.list,
		queryFn: listSprites,
		staleTime: 60_000,
		...options,
	});

// Set the active mascot. Invalidates both the list (active flags shift) and the
// active sprite so SpriteProvider re-reads and the mascot updates app-wide.
export const useSetActiveSprite = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: setActiveSprite,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: spriteKeys.all });
		},
	});
};
