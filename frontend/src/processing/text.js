// Plain-text formats. No library, no lazy import — it's just a decode.

// Guard against a "text" file that's actually binary: if the decoded string is
// littered with replacement chars / control bytes, extracting it would feed the
// model megabytes of mojibake. (Counted by char code rather than a regex so no
// literal control characters need to live in the source.)
const isJunk = (code) =>
	code === 0xfffd ||
	(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);

const looksBinary = (s) => {
	const sample = s.slice(0, 4000);
	if (!sample) return false;
	let bad = 0;
	for (let i = 0; i < sample.length; i++)
		if (isJunk(sample.charCodeAt(i))) bad++;
	return bad / sample.length > 0.02;
};

export const extract = async (file) => {
	const text = await file.text();
	if (looksBinary(text))
		throw new Error(`${file.name} doesn't look like readable text`);
	return { text, meta: {} };
};
