// Enforces the design system: colours and fonts come only from the --vp-* tokens
// (src/theme/tokens.json), UI primitives only from @/ui.
//
//   bun scripts/lint-theme.mjs            colour/font violations; exit 1 if any
//   bun scripts/lint-theme.mjs --report   also print the UI-adoption counters (raw elements,
//                                         inline styles, antd imports) tracked by the plan
//
// Colour literals (hex, rgb/rgba/hsl/hsla) are allowed only in src/theme/ and in ALLOW.
// Tints use color-mix(): color-mix(in srgb, var(--vp-accent) 12%, transparent).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Art, not theme: pixel-sprite palettes and per-speaker colours are data.
const ALLOW = [
	"theme/",
	"sprites/",
	"admin/components/appearance/",
	"admin/pages/recorder/speakerColors.js",
];

const report = process.argv.includes("--report");

const walk = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});

const stripComments = (text, css) =>
	(css
		? text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		: text
				.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
				.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
	).split("\n");

const HEX = /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const FUNC = /\b(?:rgba?|hsla?)\(/;
const FONT_VALUE_OK = /^\s*(var\(--vp-font|inherit|unset|initial)/;

const violations = [];
const counters = {
	button: 0,
	input: 0,
	select: 0,
	textarea: 0,
	inlineStyle: 0,
	antdFiles: 0,
};

for (const file of walk(SRC)) {
	const rel = relative(SRC, file);
	const css = file.endsWith(".css");
	if (!css && !/\.(jsx?|mjs)$/.test(file)) continue;
	const text = readFileSync(file, "utf8");

	if (!css && report) {
		counters.button += (text.match(/<button\b/g) || []).length;
		counters.input += (text.match(/<input\b/g) || []).length;
		counters.select += (text.match(/<select\b/g) || []).length;
		counters.textarea += (text.match(/<textarea\b/g) || []).length;
		counters.inlineStyle += (text.match(/style=\{\{/g) || []).length;
		if (/from "antd"/.test(text)) counters.antdFiles++;
	}

	if (ALLOW.some((a) => rel.startsWith(a))) continue;
	const lines = stripComments(text, css);
	lines.forEach((line, i) => {
		const font = css && line.match(/font-family\s*:(.*)$/);
		// a value wrapped onto the next line (Biome does that for long stacks)
		const fontValue = font && (font[1].trim() ? font[1] : (lines[i + 1] ?? ""));
		const hit =
			(HEX.test(line) && "colour literal") ||
			(FUNC.test(line) && "colour function") ||
			(font &&
				!FONT_VALUE_OK.test(fontValue) &&
				"font-family without --vp-font");
		if (hit)
			violations.push(`${rel}:${i + 1}  ${hit}  ${line.trim().slice(0, 90)}`);
	});
}

if (report) {
	console.log("UI adoption (target 0):");
	for (const [k, v] of Object.entries(counters))
		console.log(`  ${k.padEnd(12)} ${v}`);
	console.log("");
}

if (violations.length) {
	for (const v of violations) console.log(v);
	const files = new Set(violations.map((v) => v.split(":")[0])).size;
	console.error(`\n✗ ${violations.length} theme violations in ${files} files`);
	process.exit(1);
}
console.log("✓ theme: no literal colours or fonts outside src/theme");
