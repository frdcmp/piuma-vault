// PDFs via pdf.js.
//
// Two distinct kinds of PDF hide behind one extension:
//   • digital  — has a text layer; we extract it, with page markers so the
//                model can cite "page 4" and the user can check.
//   • scanned  — an image per page, NO text layer. Extraction returns empty
//                pages. Rather than hand the model a blank document, we render
//                the pages to PNGs and let them go down the vision path that
//                already exists for pasted screenshots.
//
// pdf.js runs its parsing in its own worker, and ships WASM for the compute-
// bound image codecs (openjpeg/jbig2/qcms) — both are wired below via the
// asset dir that `bun run prepare:pdfjs` copies into public/.

let libPromise = null;

// Vite rewrites these to hashed asset URLs at build time.
const ASSETS = `${import.meta.env.BASE_URL || "/"}pdfjs/`;

const lib = () => {
	libPromise ??= (async () => {
		const [pdfjs, workerUrl] = await Promise.all([
			import("pdfjs-dist"),
			import("pdfjs-dist/build/pdf.worker.mjs?url").then((m) => m.default),
		]);
		pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
		return pdfjs;
	})();
	libPromise.catch(() => {
		libPromise = null;
	});
	return libPromise;
};

const openDoc = async (file) => {
	const pdfjs = await lib();
	return pdfjs.getDocument({
		data: new Uint8Array(await file.arrayBuffer()),
		// CMaps matter for non-Latin PDFs (CJK, Thai): without them the text
		// layer extracts as garbage or nothing at all.
		cMapUrl: `${ASSETS}cmaps/`,
		cMapPacked: true,
		standardFontDataUrl: `${ASSETS}standard_fonts/`,
		wasmUrl: `${ASSETS}wasm/`,
		// The composer runs this on user-chosen local files; no eval, no scripting.
		isEvalSupported: false,
	}).promise;
};

// Average extractable characters per page below which we call it scanned. A
// digital page has hundreds; a scanned one yields 0, or a stray few from an
// OCR-less annotation layer.
const SCANNED_CHARS_PER_PAGE = 8;

// Caps for the scanned fallback: each page becomes an image the model has to
// look at, which is far more expensive per page than text.
const MAX_RENDER_PAGES = 10;
const RENDER_MAX_EDGE = 1600;

// pdf.js gives text as positioned items; `hasEOL` marks a line break. Joining
// blindly on " " runs table rows and paragraphs together.
const itemsToText = (items) =>
	items
		.map((it) => (it.str || "") + (it.hasEOL ? "\n" : ""))
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

const renderPage = async (page, index) => {
	const base = page.getViewport({ scale: 1 });
	const scale = Math.min(
		2,
		RENDER_MAX_EDGE / Math.max(base.width, base.height),
	);
	const viewport = page.getViewport({ scale: Math.max(1, scale) });
	const canvas = document.createElement("canvas");
	canvas.width = Math.ceil(viewport.width);
	canvas.height = Math.ceil(viewport.height);
	const canvasContext = canvas.getContext("2d");
	await page.render({ canvasContext, viewport, canvas }).promise;
	const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
	canvas.width = 0;
	canvas.height = 0;
	if (!blob) return null;
	return new File([blob], `page-${index}.png`, { type: "image/png" });
};

export const extract = async (file) => {
	const pdf = await openDoc(file);
	try {
		const pages = [];
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const content = await page.getTextContent();
			pages.push(itemsToText(content.items));
			page.cleanup();
		}
		const chars = pages.join("").replace(/\s/g, "").length;
		const scanned = chars < SCANNED_CHARS_PER_PAGE * pdf.numPages;

		if (!scanned) {
			const text = pages
				.map((t, i) => `--- page ${i + 1} ---\n${t}`)
				.join("\n\n")
				.trim();
			return { text, meta: { pages: pdf.numPages, scanned: false } };
		}

		// No text layer → render pages for the vision path instead.
		const limit = Math.min(pdf.numPages, MAX_RENDER_PAGES);
		const images = [];
		for (let i = 1; i <= limit; i++) {
			const page = await pdf.getPage(i);
			const img = await renderPage(page, i);
			page.cleanup();
			if (img) images.push(img);
		}
		if (!images.length)
			throw new Error(
				`${file.name} has no text layer and its pages could not be rendered`,
			);
		return {
			text: "",
			images,
			meta: {
				pages: pdf.numPages,
				scanned: true,
				rendered: images.length,
				truncatedPages: pdf.numPages > limit ? pdf.numPages - limit : 0,
			},
		};
	} finally {
		// Frees the worker's copy of the document; without it a few big PDFs in
		// one session hold on to hundreds of MB.
		await pdf.destroy();
	}
};
