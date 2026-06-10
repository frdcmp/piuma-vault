import { createContext, useContext, useMemo } from 'react';
import { useActiveSprite } from '../queries/spritesQuery';
import DEFAULT_CHARACTER from './piuma';

// Provides the active mascot (fetched from the DB) to the whole tree. Until the
// query resolves — and on error / cold launch — it falls back to a baked-in
// default so the UI is never empty.

const SpriteContext = createContext(null);

function normalize(def, name) {
  const palette = def.palette || {};
  const body = def.body || [];
  const idleLegs = def.idleLegs || [];
  return {
    name: name || def.name || 'sprite',
    palette,
    body,
    idleLegs,
    walkLegs: def.walkLegs?.length ? def.walkLegs : [idleLegs],
    walkFrameMs: def.walkFrameMs || 120,
    gallopLegs: def.gallopLegs?.length ? def.gallopLegs : [idleLegs],
    gallopFrameMs: def.gallopFrameMs || 140,
    sprite: [...body, ...idleLegs],
    spriteColor: (code) => palette[code] || 'transparent',
  };
}

const DEFAULT = normalize(DEFAULT_CHARACTER, DEFAULT_CHARACTER.name);

export function SpriteProvider({ children }) {
  const { data } = useActiveSprite();
  const value = useMemo(
    () => (data?.definition ? normalize(data.definition, data.name) : DEFAULT),
    [data],
  );
  return (
    <SpriteContext.Provider value={value}>{children}</SpriteContext.Provider>
  );
}

// The active mascot. Safe outside a provider — returns the baked-in default.
export function useSprite() {
  return useContext(SpriteContext) || DEFAULT;
}
