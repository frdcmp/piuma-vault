import { useMemo, useState } from "react";
import { PvButton, PvField, PvIconButton, PvInput, PvSegmented } from "@/ui";
import PixelCanvas from "./PixelCanvas";
import { AnimatedPreview, SpritePreview } from "./pixelRender";

const WIDTH = 16;
const BODY_ROWS = 10;
const blankRow = () => ".".repeat(WIDTH);
const blankLegs = () => [blankRow(), blankRow()];
const POSES = ["standing", "walk", "gallop"];

// Starting point for a brand-new sprite.
export const NEW_TEMPLATE = {
	key: "",
	name: "",
	definition: {
		palette: { B: "#aaaaaa" },
		body: Array.from({ length: BODY_ROWS }, blankRow),
		idleLegs: blankLegs(),
		walkLegs: [blankLegs()],
		walkFrameMs: 120,
		gallopLegs: [blankLegs()],
		gallopFrameMs: 140,
	},
};

export const slugify = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");

// Next unused uppercase letter for a new palette code.
const nextCode = (palette) => {
	for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		if (!(ch in palette)) return ch;
	}
	return "z";
};

export default function SpriteEditor({
	initial,
	isNew,
	onSave,
	onGenerate,
	onCancel,
	saving,
	generating,
}) {
	const [name, setName] = useState(initial.name);
	const [key, setKey] = useState(initial.key);
	const [def, setDef] = useState(initial.definition);
	const [paint, setPaint] = useState(
		Object.keys(initial.definition.palette)[0] || ".",
	);
	const [tab, setTab] = useState("standing"); // standing | walk | gallop
	const [walkIdx, setWalkIdx] = useState(0);
	const [gallopIdx, setGallopIdx] = useState(0);
	const [error, setError] = useState("");
	const [aiPrompt, setAiPrompt] = useState("");

	const patch = (p) => setDef((d) => ({ ...d, ...p }));

	// Start server-side AI generation. It runs in rounds for a few minutes; the
	// parent closes this editor and the rounds appear on the Appearance page,
	// where one can be opened back in here to name and save.
	const handleGenerate = () => {
		const prompt = aiPrompt.trim();
		if (!prompt || generating) return;
		onGenerate({ name: name.trim(), prompt });
	};

	// The 2 leg rows the bottom of the canvas currently binds to.
	const legsIdx = tab === "walk" ? walkIdx : tab === "gallop" ? gallopIdx : 0;
	const currentLegs =
		tab === "standing"
			? def.idleLegs
			: tab === "walk"
				? def.walkLegs[walkIdx] || blankLegs()
				: def.gallopLegs[gallopIdx] || blankLegs();

	const canvasRows = [...def.body, ...currentLegs];

	const onCanvasChange = (next) => {
		const body = next.slice(0, BODY_ROWS);
		const legs = next.slice(BODY_ROWS);
		if (tab === "standing") patch({ body, idleLegs: legs });
		else if (tab === "walk") {
			patch({
				body,
				walkLegs: def.walkLegs.map((f, i) => (i === walkIdx ? legs : f)),
			});
		} else {
			patch({
				body,
				gallopLegs: def.gallopLegs.map((f, i) => (i === gallopIdx ? legs : f)),
			});
		}
	};

	// ── palette ops ──
	const setColor = (code, color) =>
		patch({ palette: { ...def.palette, [code]: color } });
	const addColor = () => {
		const code = nextCode(def.palette);
		patch({ palette: { ...def.palette, [code]: "#ffffff" } });
		setPaint(code);
	};
	const removeColor = (code) => {
		const { [code]: _drop, ...rest } = def.palette;
		patch({ palette: rest });
		if (paint === code) setPaint(".");
	};

	// ── frame ops (walk/gallop) ──
	const framesKey = tab === "walk" ? "walkLegs" : "gallopLegs";
	const setIdx = tab === "walk" ? setWalkIdx : setGallopIdx;
	const addFrame = () => {
		const frames = [...def[framesKey], blankLegs()];
		patch({ [framesKey]: frames });
		setIdx(frames.length - 1);
	};
	const delFrame = () => {
		if (def[framesKey].length <= 1) return;
		const frames = def[framesKey].filter((_, i) => i !== legsIdx);
		patch({ [framesKey]: frames });
		setIdx(Math.max(0, legsIdx - 1));
	};

	const paletteCodes = useMemo(() => Object.keys(def.palette), [def.palette]);

	const validate = () => {
		if (!name.trim()) return "Name is required";
		if (isNew && !slugify(key)) return "Key is required";
		if (!paletteCodes.length) return "Add at least one color";
		return "";
	};

	const handleSave = () => {
		const err = validate();
		if (err) {
			setError(err);
			return;
		}
		setError("");
		onSave({
			key: isNew ? slugify(key) : initial.key,
			name: name.trim(),
			definition: def,
		});
	};

	return (
		<div className="vp-sprite-editor">
			{/* Meta */}
			<div className="vp-sprite-meta">
				<PvField label="Name">
					<PvInput
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							if (isNew && (!key || key === slugify(name)))
								setKey(slugify(e.target.value));
						}}
						placeholder="Bubu"
					/>
				</PvField>
				<PvField label="Key">
					<PvInput
						value={key}
						disabled={!isNew}
						onChange={(e) => setKey(e.target.value)}
						placeholder="bubu"
					/>
				</PvField>
			</div>

			{/* AI generate — starts a server-side job that drafts the sprite in
			    rounds. Only offered for new sprites. */}
			{isNew && (
				<div className="vp-sprite-ai">
					<PvInput
						value={aiPrompt}
						onChange={(e) => setAiPrompt(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleGenerate();
						}}
						placeholder="Describe a creature — e.g. a small purple owl"
						disabled={generating}
					/>
					<PvButton
						size="sm"
						onClick={handleGenerate}
						disabled={generating || !aiPrompt.trim()}
					>
						{generating ? "Starting…" : "✨ AI generate"}
					</PvButton>
				</div>
			)}

			<div className="vp-sprite-editor-grid">
				{/* ── Canvas ── */}
				<section className="vp-editor-panel vp-editor-canvas">
					<div className="vp-editor-panel-head">
						<PvSegmented
							size="sm"
							options={POSES}
							value={tab}
							onChange={setTab}
						/>

						{tab !== "standing" && (
							<div className="vp-frame-bar">
								<PvButton
									size="sm"
									onClick={() => setIdx(Math.max(0, legsIdx - 1))}
								>
									‹
								</PvButton>
								<span>
									{legsIdx + 1}/{def[framesKey].length}
								</span>
								<PvButton
									size="sm"
									onClick={() =>
										setIdx(Math.min(def[framesKey].length - 1, legsIdx + 1))
									}
								>
									›
								</PvButton>
								<PvButton size="sm" onClick={addFrame}>
									+
								</PvButton>
								<PvButton
									size="sm"
									variant="danger"
									onClick={delFrame}
									disabled={def[framesKey].length <= 1}
								>
									−
								</PvButton>
							</div>
						)}
					</div>

					<div className="vp-canvas-wrap">
						<PixelCanvas
							rows={canvasRows}
							palette={def.palette}
							paint={paint}
							onChange={onCanvasChange}
						/>
					</div>
					<p className="vp-hint">
						Top 10 rows are the shared body; the bottom 2 are this pose's legs.
					</p>
				</section>

				{/* ── Palette ── */}
				<section className="vp-editor-panel">
					<h4 className="vp-h4">Palette</h4>
					<div className="vp-palette">
						<div className="vp-palette-row vp-palette-row--erase">
							<button
								type="button"
								className={`vp-swatch vp-swatch--erase ${paint === "." ? "is-active" : ""}`}
								onClick={() => setPaint(".")}
								title="Erase (transparent)"
							>
								⌫
							</button>
						</div>
						{paletteCodes.map((code) => (
							<div key={code} className="vp-palette-row">
								<button
									type="button"
									className={`vp-swatch ${paint === code ? "is-active" : ""}`}
									style={{ backgroundColor: def.palette[code] }}
									onClick={() => setPaint(code)}
									title={`paint ${code}`}
								>
									{code}
								</button>
								<input
									type="color"
									value={def.palette[code]}
									onChange={(e) => setColor(code, e.target.value)}
								/>
								<PvIconButton
									variant="ghost-danger"
									size="sm"
									icon="✕"
									label="remove color"
									onClick={() => removeColor(code)}
								/>
							</div>
						))}
					</div>
					<PvButton size="sm" block onClick={addColor}>
						+ color
					</PvButton>
				</section>
			</div>

			{/* ── Preview (full width) ── */}
			<section className="vp-editor-panel vp-editor-preview-full">
				<h4 className="vp-h4">Preview</h4>
				<div className="vp-sprite-previews">
					<div>
						<SpritePreview
							rows={[...def.body, ...def.idleLegs]}
							palette={def.palette}
							pixelSize={12}
						/>
						<span>idle</span>
					</div>
					<div>
						<AnimatedPreview
							body={def.body}
							frames={def.walkLegs}
							frameMs={def.walkFrameMs}
							palette={def.palette}
							pixelSize={12}
						/>
						<span>walk</span>
					</div>
					<div>
						<AnimatedPreview
							body={def.body}
							frames={def.gallopLegs}
							frameMs={def.gallopFrameMs}
							palette={def.palette}
							pixelSize={12}
						/>
						<span>gallop</span>
					</div>
				</div>

				<div className="vp-editor-divider" />

				<div className="vp-sprite-timings">
					<PvField label="Walk frame ms">
						<PvInput
							type="number"
							value={def.walkFrameMs}
							min={30}
							onChange={(e) =>
								patch({ walkFrameMs: Number(e.target.value) || 120 })
							}
						/>
					</PvField>
					<PvField label="Gallop frame ms">
						<PvInput
							type="number"
							value={def.gallopFrameMs}
							min={30}
							onChange={(e) =>
								patch({ gallopFrameMs: Number(e.target.value) || 140 })
							}
						/>
					</PvField>
				</div>
			</section>

			{error && <p className="vp-text vp-sprite-error">{error}</p>}
			<div className="vp-sprite-actions">
				<PvButton variant="ghost" onClick={onCancel}>
					Cancel
				</PvButton>
				<PvButton variant="primary" onClick={handleSave} disabled={saving}>
					{saving ? "Saving…" : "Save sprite"}
				</PvButton>
			</div>
		</div>
	);
}
