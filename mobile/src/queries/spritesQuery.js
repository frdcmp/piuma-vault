import { useQuery } from "@tanstack/react-query";
import { getActiveSprite } from "../api/spritesApi";

export const spriteKeys = {
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
