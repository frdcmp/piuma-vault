import { useState } from "react";
import { PvButton, PvModal, pvMessage } from "@/ui";
import {
	useCreateSprite,
	useDeleteSprite,
	useDismissSpriteGeneration,
	useGenerateSprite,
	useSetActiveSprite,
	useSpriteGenerations,
	useSprites,
	useSpritesLiveUpdates,
	useUpdateSprite,
} from "../../../queries";
import { SpritePreview } from "../../components/appearance/pixelRender";
import SpriteEditor, {
	NEW_TEMPLATE,
	slugify,
} from "../../components/appearance/SpriteEditor";
import SpriteGenerations from "../../components/appearance/SpriteGenerations";
import { PageContent } from "../../components/layout/PageLayout";
import ThemePicker from "./ThemePicker";
import "./appearance.css";

const errMsg = (e, fallback) => e?.response?.data?.error || fallback;

export default function Appearance() {
	const { data: sprites = [], isLoading } = useSprites();
	const setActive = useSetActiveSprite();
	const createSprite = useCreateSprite();
	const updateSprite = useUpdateSprite();
	const deleteSprite = useDeleteSprite();
	const generate = useGenerateSprite();
	useSpritesLiveUpdates(); // new AI-generated sprites stream in here when ready

	// { initial, isNew } while the editor modal is open, else null.
	const [editing, setEditing] = useState(null);
	const [confirmDelete, setConfirmDelete] = useState(null); // sprite key
	// AI generation jobs (running and recent), each with its rounds so far.
	const { data: generations = [] } = useSpriteGenerations();
	const dismissGeneration = useDismissSpriteGeneration();
	// A built-in sprite to animate while a round is being drawn.
	const loader = sprites.find((s) => s.is_builtin) || sprites[0];

	const onSetActive = (key) => {
		setActive.mutate(key, {
			onSuccess: () => pvMessage.success("Active mascot updated"),
			onError: (e) => pvMessage.error(errMsg(e, "Failed to set active")),
		});
	};

	const onSave = (payload) => {
		const mutation = editing.isNew ? createSprite : updateSprite;
		mutation.mutate(payload, {
			onSuccess: () => {
				pvMessage.success(editing.isNew ? "Sprite created" : "Sprite saved");
				setEditing(null);
			},
			onError: (e) => pvMessage.error(errMsg(e, "Failed to save sprite")),
		});
	};

	// Start an AI generation job. It runs for a few minutes in rounds, so close
	// the editor; the rounds show up live in the generations panel.
	const onGenerate = ({ name, prompt }) => {
		generate.mutate(
			{ name, prompt },
			{
				onSuccess: () => {
					pvMessage.info(
						"Generating… each round shows up below as it finishes.",
					);
					setEditing(null);
				},
				// Keep the editor open (e.g. the default model can't see images).
				onError: (e) =>
					pvMessage.error(errMsg(e, "Failed to start generation")),
			},
		);
	};

	// Open a generated round in the editor as a new sprite, to name and save.
	const onPickRound = (round, generation) => {
		setEditing({
			initial: {
				key: slugify(generation.name),
				name: generation.name,
				definition: round.definition,
			},
			isNew: true,
		});
	};

	const onDismissGeneration = (id) => {
		dismissGeneration.mutate(id, {
			onError: (e) => pvMessage.error(errMsg(e, "Failed to dismiss")),
		});
	};

	const onDelete = () => {
		const key = confirmDelete;
		deleteSprite.mutate(key, {
			onSuccess: () => {
				pvMessage.success("Sprite deleted");
				setConfirmDelete(null);
			},
			onError: (e) => {
				pvMessage.error(errMsg(e, "Failed to delete sprite"));
				setConfirmDelete(null);
			},
		});
	};

	const saving = createSprite.isPending || updateSprite.isPending;

	return (
		<PageContent>
			<div className="vp-page vp-appearance">
				<div className="vp-page-head">
					<div>
						<h1 className="vp-page-title">Appearance</h1>
						<p className="vp-page-subtitle">
							Pick the vault theme and mascot, or design your own pixel sprite.
						</p>
					</div>
					<PvButton
						variant="primary"
						onClick={() => setEditing({ initial: NEW_TEMPLATE, isNew: true })}
					>
						+ New sprite
					</PvButton>
				</div>

				<ThemePicker />

				<h2 className="vp-h2 vp-appearance-section">Mascot</h2>
				<SpriteGenerations
					generations={generations}
					loader={loader}
					onPick={onPickRound}
					onDismiss={onDismissGeneration}
				/>
				{isLoading ? (
					<p className="vp-text vp-muted">Loading sprites…</p>
				) : (
					<div className="vp-sprite-cards">
						{sprites.map((s) => (
							<div
								key={s.key}
								className={`vp-sprite-card ${s.active ? "is-active" : ""}`}
							>
								<div className="vp-sprite-card-art">
									<SpritePreview
										rows={[...s.definition.body, ...s.definition.idleLegs]}
										palette={s.definition.palette}
										pixelSize={6}
									/>
								</div>
								<div className="vp-sprite-card-head">
									<span className="vp-sprite-card-name">{s.name}</span>
									{s.active && <span className="vp-sprite-badge">active</span>}
									{s.is_builtin && (
										<span className="vp-sprite-badge vp-sprite-badge--muted">
											built-in
										</span>
									)}
								</div>
								<div className="vp-sprite-card-actions">
									{!s.active && (
										<PvButton
											size="sm"
											variant="accent"
											onClick={() => onSetActive(s.key)}
										>
											Set active
										</PvButton>
									)}
									<PvButton
										size="sm"
										onClick={() =>
											setEditing({
												initial: {
													key: s.key,
													name: s.name,
													definition: s.definition,
												},
												isNew: false,
											})
										}
									>
										Edit
									</PvButton>
									<PvButton
										size="sm"
										onClick={() =>
											setEditing({
												initial: {
													key: "",
													name: `${s.name} copy`,
													definition: s.definition,
												},
												isNew: true,
											})
										}
									>
										Duplicate
									</PvButton>
									<PvButton
										size="sm"
										variant="danger"
										disabled={s.active}
										title={
											s.active ? "Switch the active mascot first" : "Delete"
										}
										onClick={() => setConfirmDelete(s.key)}
									>
										Delete
									</PvButton>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<PvModal
				open={!!editing}
				title={editing?.isNew ? "New sprite" : "Edit sprite"}
				className="vp-sprite-modal"
				showClose={false}
			>
				{editing && (
					<SpriteEditor
						initial={editing.initial}
						isNew={editing.isNew}
						saving={saving}
						generating={generate.isPending}
						onSave={onSave}
						onGenerate={onGenerate}
						onCancel={() => setEditing(null)}
					/>
				)}
			</PvModal>

			<PvModal
				open={!!confirmDelete}
				title="Delete sprite?"
				danger
				confirmText="Delete"
				onConfirm={onDelete}
				onCancel={() => setConfirmDelete(null)}
			>
				This permanently removes the “{confirmDelete}” sprite.
			</PvModal>
		</PageContent>
	);
}
