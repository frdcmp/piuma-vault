import remarkGfm from "remark-gfm";

// Shared react-markdown plugin list.
//
// GFM lets a *single* `~` open a strikethrough, so prose that uses `~` to mean
// "approximately" (`~5% ... (~$500)`) ends up struck through between the two
// tildes. `singleTilde: false` requires `~~` for a real strikethrough.
export const remarkPlugins = [[remarkGfm, { singleTilde: false }]];
