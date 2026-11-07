// A person's colour in a group chat, the same every time (as WhatsApp): picked
// from their handle with the same hash and colours as the phone app's
// (pigeon-mobile src/ui/theme.js hueOf), so they look alike on both.
const HUES = [
	"#3fae8c",
	"#9a68c0",
	"#c9ad6b",
	"#e0565b",
	"#4f8fd6",
	"#e8798a",
	"#d9853b",
	"#5bb3b0",
];

const hashOf = (text) => {
	let h = 5381;
	for (const ch of String(text ?? "")
		.trim()
		.toLowerCase())
		h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
	return h;
};

export const senderColor = (handle) => HUES[hashOf(handle) % HUES.length];
