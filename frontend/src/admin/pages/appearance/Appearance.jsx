import { useEffect, useState } from "react";
import {
	useCreateSprite,
	useDeleteSprite,
	useGenerateSprite,
	useSetActiveSprite,
	useSprites,
	useSpritesLiveUpdates,
	useUpdateSprite,
} from "../../../queries";
import {
	AnimatedPreview,
	SpritePreview,
} from "../../components/appearance/pixelRender";
import SpriteEditor, {
	NEW_TEMPLATE,
} from "../../components/appearance/SpriteEditor";
import { PageContent } from "../../components/layout/PageLayout";
import { PvButton, PvModal, pvMessage } from "../../components/ui";
import "../../vault-pixel.css";
import "./appearance.css";

const errMsg = (e, fallback) => e?.response?.data?.error || fallback;

// "Generating…" placeholders survive a refresh so the feedback isn't lost if the
// admin reloads while the LLM works. Stored locally with a start time; entries
// past the TTL (or whose sprite has arrived) drop. The TTL must comfortably
// exceed real generation time: the two-pass reasoning flow (draft + self-
// critique) runs ~5-8 min, so we keep the card up for 12.
const PENDING_KEY = "vault.sprite_pending";
const PENDING_TTL = 12 * 60 * 1000;

const loadPending = () => {
	try {
		const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
		const now = Date.now();
		return Array.isArray(raw)
			? raw.filter((p) => p?.key && now - (p.startedAt || 0) < PENDING_TTL)
			: [];
	} catch {
		return [];
	}
};

const savePending = (list) => {
	try {
		localStorage.setItem(PENDING_KEY, JSON.stringify(list));
	} catch {
		/* storage unavailable — placeholders just won't persist */
	}
};

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
	// Sprites being AI-generated server-side — [{ key, name, startedAt }].
	// Rendered as galloping placeholder cards; persisted so a refresh keeps them.
	const [pending, setPending] = useState(loadPending);

	// Drop a placeholder as soon as its sprite shows up in the refetched list.
	useEffect(() => {
		setPending((prev) => {
			const next = prev.filter((p) => !sprites.some((s) => s.key === p.key));
			if (next.length !== prev.length) savePending(next);
			return next;
		});
	}, [sprites]);

	// Expire placeholders the LLM never delivered, so a stuck card clears itself
	// at the TTL instead of spinning forever.
	useEffect(() => {
		if (!pending.length) return;
		const id = setInterval(() => {
			setPending((prev) => {
				const now = Date.now();
				const next = prev.filter((p) => now - (p.startedAt || 0) < PENDING_TTL);
				if (next.length !== prev.length) savePending(next);
				return next;
			});
		}, 5000);
		return () => clearInterval(id);
	}, [pending.length]);

	// A built-in sprite (or any) to animate inside the "generating" cards.
	const loader = sprites.find((s) => s.is_builtin) || sprites[0];
	const pendingCards = pending.filter(
		(p) => !sprites.some((s) => s.key === p.key),
	);

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
				pvMessage.success(
					editing.isNew ? "Sprite created" : "Sprite saved",
				);
				setEditing(null);
			},
			onError: (e) => pvMessage.error(errMsg(e, "Failed to save sprite")),
		});
	};

	// Kick off async AI generation. The job runs server-side for minutes, so we
	// fire it, tell the user it's cooking, and close the modal — the finished
	// sprite arrives live via SSE (useSpritesLiveUpdates).
	const onGenerate = ({ name, key, prompt }) => {
		generate.mutate(
			{ name, key, prompt },
			{
				onSuccess: () => {
					pvMessage.info(
						"Sprite generating… it'll appear here when it's ready.",
					);
					setPending((prev) => {
						const next = [...prev, { key, name, startedAt: Date.now() }];
						savePending(next);
						return next;
					});
					setEditing(null);
				},
				// Keep the modal open on failure (e.g. key taken) so the admin can fix it.
				onError: (e) =>
					pvMessage.error(errMsg(e, "Failed to start generation")),
			},
		);
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
							Choose the vault mascot, or design your own pixel sprite.
						</p>
					</div>
					<PvButton
						variant="primary"
						onClick={() => setEditing({ initial: NEW_TEMPLATE, isNew: true })}
					>
						+ New sprite
					</PvButton>
				</div>

				{isLoading ? (
					<p className="vp-text vp-muted">Loading sprites…</p>
				) : (
					<div className="vp-sprite-cards">
						{pendingCards.map((p) => (
							<div
								key={`pending-${p.key}`}
								className="vp-sprite-card vp-sprite-card--pending"
							>
								<div className="vp-sprite-card-art">
									{loader ? (
										<AnimatedPreview
											body={loader.definition.body}
											frames={loader.definition.gallopLegs}
											frameMs={loader.definition.gallopFrameMs}
											palette={loader.definition.palette}
											pixelSize={6}
										/>
									) : (
										<div className="vp-sprite-spinner" />
									)}
								</div>
								<div className="vp-sprite-card-head">
									<span className="vp-sprite-card-name">{p.name}</span>
									<span className="vp-sprite-badge vp-sprite-badge--muted">
										generating…
									</span>
								</div>
							</div>
						))}
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
