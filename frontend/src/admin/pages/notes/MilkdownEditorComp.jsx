import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	editorViewOptionsCtx,
	parserCtx,
	rootCtx,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { commonmark, imageSchema } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import { $prose, $view } from "@milkdown/kit/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { useEffect, useRef, useState } from "react";
import {
	attachmentMeta,
	isAttachmentUrl,
	widthFromUrl,
	withWidth,
} from "../../../utils/attachments";
import "./MilkdownEditorComp.css";

const searchPluginKey = new PluginKey("search-plugin");

const searchHighlightPlugin = $prose(() => {
	return new Plugin({
		key: searchPluginKey,
		state: {
			init() {
				return {
					query: "",
					decos: DecorationSet.empty,
					matches: [],
					activeIndex: -1,
				};
			},
			apply(tr, old) {
				let query = old.query;
				let activeIndex = old.activeIndex;

				const meta = tr.getMeta(searchPluginKey);
				let forceUpdate = false;

				if (meta !== undefined) {
					if (typeof meta === "string") {
						query = meta;
						activeIndex = -1;
						forceUpdate = true;
					} else if (meta.action === "next") {
						activeIndex =
							old.matches.length > 0
								? (old.activeIndex + 1) % old.matches.length
								: -1;
						forceUpdate = true;
					} else if (meta.action === "prev") {
						activeIndex =
							old.matches.length > 0
								? (old.activeIndex - 1 + old.matches.length) %
									old.matches.length
								: -1;
						forceUpdate = true;
					}
				}

				if (!tr.docChanged && !forceUpdate) {
					return {
						query,
						activeIndex,
						matches: old.matches.map((m) => ({
							from: tr.mapping.map(m.from),
							to: tr.mapping.map(m.to),
						})),
						decos: old.decos.map(tr.mapping, tr.doc),
					};
				}

				const matches = [];
				if (query && query.trim().length > 0) {
					const regex = new RegExp(
						query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
						"gi",
					);
					tr.doc.descendants((node, pos) => {
						if (node.isText) {
							regex.lastIndex = 0;
							let match;
							while ((match = regex.exec(node.text)) !== null) {
								matches.push({
									from: pos + match.index,
									to: pos + match.index + match[0].length,
								});
							}
						}
					});
				}

				if (matches.length > 0 && activeIndex === -1) {
					activeIndex = 0;
				} else if (matches.length === 0) {
					activeIndex = -1;
				} else if (activeIndex >= matches.length) {
					activeIndex = matches.length - 1;
				}

				const decos = matches.map((m, i) =>
					Decoration.inline(m.from, m.to, {
						class:
							i === activeIndex
								? "search-highlight active"
								: "search-highlight",
					}),
				);

				return {
					query,
					activeIndex,
					matches,
					decos: DecorationSet.create(tr.doc, decos),
				};
			},
		},
		props: {
			decorations(state) {
				return this.getState(state).decos;
			},
		},
		view(editorView) {
			return {
				update: (view, prevState) => {
					const newState = searchPluginKey.getState(view.state);
					const oldState = searchPluginKey.getState(prevState);
					if (
						newState &&
						(!oldState ||
							oldState.query !== newState.query ||
							oldState.matches.length !== newState.matches.length ||
							oldState.activeIndex !== newState.activeIndex)
					) {
						view.dom.dispatchEvent(
							new CustomEvent("search-update", {
								detail: {
									count: newState.matches.length,
									activeIndex: newState.activeIndex,
								},
								bubbles: true,
							}),
						);

						if (
							newState.activeIndex !== -1 &&
							(!oldState ||
								oldState.activeIndex !== newState.activeIndex ||
								oldState.query !== newState.query)
						) {
							// scroll the active element into view safely without disturbing typing focus
							setTimeout(() => {
								const activeEl = view.dom.querySelector(
									".search-highlight.active",
								);
								if (activeEl) {
									activeEl.scrollIntoView({
										behavior: "smooth",
										block: "center",
									});
								}
							}, 10);
						}
					}
				},
			};
		},
	});
});

const attachmentViewKey = new PluginKey("attachment-view");

// Builds the live viewer DOM for a pdf / video / audio attachment. Plain DOM
// (no React) — these render natively in the browser.
const buildAttachmentViewer = (href, label, category) => {
	const wrap = document.createElement("div");
	wrap.className = "pv-att-view";
	wrap.contentEditable = "false";
	if (category === "pdf") {
		const f = document.createElement("iframe");
		f.src = href;
		f.title = label || "PDF";
		f.className = "pv-att-pdf";
		wrap.appendChild(f);
	} else if (category === "video") {
		const v = document.createElement("video");
		v.src = href;
		v.controls = true;
		v.className = "pv-att-video";
		wrap.appendChild(v);
	} else if (category === "audio") {
		const a = document.createElement("audio");
		a.src = href;
		a.controls = true;
		a.className = "pv-att-audio";
		wrap.appendChild(a);
	}
	return wrap;
};

// Purely presentational: renders an inline pdf/video/audio viewer right after
// any attachment link, WITHOUT changing the document — the link stays a normal
// markdown link, so serialization/autosave are untouched. Widgets are keyed by
// href so the player DOM is reused (not reset) while editing elsewhere.
const buildAttachmentDecos = (doc) => {
	const decos = [];
	let seq = 0;
	doc.descendants((node, pos) => {
		if (!node.isText) return;
		const link = node.marks.find((m) => m.type.name === "link");
		const href = link?.attrs?.href;
		if (!href || !isAttachmentUrl(href)) return;
		const { category } = attachmentMeta(href);
		if (!["pdf", "video", "audio"].includes(category)) return;
		const end = pos + node.nodeSize;
		const key = `att-${category}-${href}-${seq++}`;
		decos.push(
			Decoration.widget(
				end,
				() => buildAttachmentViewer(href, node.text, category),
				{ key, side: 1 },
			),
		);
	});
	return DecorationSet.create(doc, decos);
};

const attachmentViewPlugin = $prose(
	() =>
		new Plugin({
			key: attachmentViewKey,
			state: {
				init: (_, state) => buildAttachmentDecos(state.doc),
				apply: (tr, old) =>
					tr.docChanged ? buildAttachmentDecos(tr.doc) : old,
			},
			props: {
				decorations(state) {
					return this.getState(state);
				},
			},
		}),
);

function MilkdownEditor({
	initialMarkdown,
	onChange,
	searchQuery,
	searchAction,
	editorApiRef,
}) {
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const editorRef = useRef(null);

	// Milkdown fires `markdownUpdated` while it parses/normalizes the initial
	// content on mount — that's NOT a user edit. Forwarding it would mark the
	// note dirty and auto-save on mere open (and, mid note-switch, stamp the
	// previous note's title onto the one being loaded). So we only forward
	// changes once the user has actually typed/pasted into THIS editor instance.
	// Normalization and programmatic edits never fire a `beforeinput`/`paste`
	// DOM event, so they stay suppressed; the editor remounts per note (keyed),
	// resetting this flag for each note.
	const userEditedRef = useRef(false);
	const initialMarkdownRef = useRef(initialMarkdown);

	useEditor((root) => {
		const markUserEdit = () => {
			userEditedRef.current = true;
		};
		root.addEventListener("beforeinput", markUserEdit);
		root.addEventListener("paste", markUserEdit);
		root.addEventListener("cut", markUserEdit);
		root.addEventListener("drop", markUserEdit);

		// Links aren't navigable in edit mode, so an attachment link can't be
		// opened by clicking. Intercept clicks on attachment anchors and open
		// them in a new tab (non-attachment links keep normal editing behaviour).
		root.addEventListener("click", (e) => {
			const a = e.target?.closest?.("a[href]");
			const href = a?.getAttribute("href");
			if (href && isAttachmentUrl(href)) {
				e.preventDefault();
				window.open(href, "_blank", "noopener");
			}
		});

		// Custom image node view: renders the image at its stored `?w` width and
		// adds a corner drag handle to resize it. Aspect ratio is kept by only
		// ever setting width (height stays auto). On release we persist the new
		// width back into the image `src` query param so it round-trips through
		// markdown and autosaves.
		const imageResizeView = $view(
			imageSchema.node,
			() => (node, view, getPos) => {
				const dom = document.createElement("span");
				dom.className = "pv-img-wrap";
				const img = document.createElement("img");
				img.className = "pv-img";
				const handle = document.createElement("span");
				handle.className = "pv-img-handle";
				handle.contentEditable = "false";
				dom.append(img, handle);

				const applyAttrs = (n) => {
					img.src = n.attrs.src || "";
					img.alt = n.attrs.alt || "";
					if (n.attrs.title) img.title = n.attrs.title;
					const w = widthFromUrl(n.attrs.src || "");
					img.style.width = w ? `${w}px` : "";
				};
				applyAttrs(node);

				let dragging = false;
				let startX = 0;
				let startW = 0;
				const onMove = (e) => {
					if (!dragging) return;
					const max = dom.parentElement?.clientWidth || 2000;
					const next = Math.max(
						60,
						Math.min(startW + (e.clientX - startX), max),
					);
					img.style.width = `${Math.round(next)}px`;
				};
				const onUp = () => {
					if (!dragging) return;
					dragging = false;
					document.removeEventListener("pointermove", onMove);
					document.removeEventListener("pointerup", onUp);
					const pos = typeof getPos === "function" ? getPos() : null;
					if (pos == null) return;
					const cur = view.state.doc.nodeAt(pos);
					if (!cur) return;
					const finalW = Math.round(img.getBoundingClientRect().width);
					const newSrc = withWidth(cur.attrs.src || "", finalW);
					if (newSrc === cur.attrs.src) return;
					userEditedRef.current = true;
					view.dispatch(
						view.state.tr.setNodeMarkup(pos, null, {
							...cur.attrs,
							src: newSrc,
						}),
					);
				};
				handle.addEventListener("pointerdown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					dragging = true;
					startX = e.clientX;
					startW = img.getBoundingClientRect().width;
					document.addEventListener("pointermove", onMove);
					document.addEventListener("pointerup", onUp);
				});

				return {
					dom,
					// Image is an atomic leaf — ignore DOM mutations we make ourselves.
					ignoreMutation: () => true,
					update: (updated) => {
						if (updated.type.name !== "image") return false;
						applyAttrs(updated);
						return true;
					},
					selectNode: () => dom.classList.add("selected"),
					deselectNode: () => dom.classList.remove("selected"),
					destroy: () => {
						document.removeEventListener("pointermove", onMove);
						document.removeEventListener("pointerup", onUp);
					},
				};
			},
		);

		const editor = Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, root);
				ctx.set(defaultValueCtx, initialMarkdownRef.current || "");
				ctx.update(editorViewOptionsCtx, (prev) => ({
					...prev,
					attributes: {
						class: "pv-milkdown-editor",
						spellcheck: "false",
					},
				}));
				ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
					if (!userEditedRef.current) return;
					onChangeRef.current?.(markdown);
				});
			})
			.use(commonmark)
			.use(gfm)
			.use(history)
			.use(clipboard)
			.use(cursor)
			.use(trailing)
			.use(listener)
			.use(searchHighlightPlugin)
			.use(imageResizeView)
			.use(attachmentViewPlugin);

		editorRef.current = editor;
		return editor;
	}, []);

	useEffect(() => {
		if (!editorRef.current) return;
		try {
			editorRef.current.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				if (!view || !view.state) return;
				const tr = view.state.tr.setMeta(searchPluginKey, searchQuery || "");
				view.dispatch(tr);

				// Manually trigger the event after dispatching the query update
				// because sometimes the view update hook in the plugin misses the first render
				const newState = searchPluginKey.getState(view.state);
				if (newState) {
					view.dom.dispatchEvent(
						new CustomEvent("search-update", {
							detail: {
								count: newState.matches.length,
								activeIndex: newState.activeIndex,
							},
							bubbles: true,
						}),
					);
				}
			});
		} catch (e) {
			// ignore errors if view is destroyed
		}
	}, [searchQuery]);

	useEffect(() => {
		if (!editorRef.current || !searchAction) return;
		try {
			editorRef.current.action((ctx) => {
				const view = ctx.get(editorViewCtx);
				if (!view || !view.state) return;
				const tr = view.state.tr.setMeta(searchPluginKey, {
					action: searchAction.dir,
				});
				view.dispatch(tr);
			});
		} catch (e) {}
	}, [searchAction]);

	// Expose an imperative `insertMarkdown` so the toolbar can drop attachment
	// markdown in at the caret. Parses the snippet to a ProseMirror slice and
	// replaces the current selection; flags a user edit so onChange/autosave fire.
	useEffect(() => {
		if (!editorApiRef) return;
		editorApiRef.current = {
			insertMarkdown: (md) => {
				const editor = editorRef.current;
				if (!editor || !md) return;
				userEditedRef.current = true;
				try {
					editor.action((ctx) => {
						const view = ctx.get(editorViewCtx);
						const parser = ctx.get(parserCtx);
						const doc = parser(md);
						if (!view || !doc) return;
						const slice = doc.slice(0);
						view.dispatch(
							view.state.tr.replaceSelection(slice).scrollIntoView(),
						);
						view.focus();
					});
				} catch (e) {}
			},
		};
		return () => {
			if (editorApiRef) editorApiRef.current = null;
		};
	}, [editorApiRef]);

	return <Milkdown />;
}

export default function MilkdownEditorComp({
	initialMarkdown,
	onChange,
	currentTheme,
	isMobile,
	searchQuery,
	searchAction,
	onSearchUpdate,
	editorApiRef,
}) {
	const wrapperRef = useRef(null);
	const [hoveredCell, setHoveredCell] = useState(null);
	const [copiedCell, setCopiedCell] = useState(null);

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const handleMouseMove = (e) => {
			const cell = e.target.closest("td, th");
			if (cell && wrapper.contains(cell)) {
				setHoveredCell(cell);
			} else {
				const isCopyBtn = e.target.closest(".pv-cell-copy-btn");
				if (!isCopyBtn) {
					setHoveredCell(null);
				}
			}
		};

		wrapper.addEventListener("mousemove", handleMouseMove);
		return () => wrapper.removeEventListener("mousemove", handleMouseMove);
	}, []);

	const onSearchUpdateRef = useRef(onSearchUpdate);
	onSearchUpdateRef.current = onSearchUpdate;

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		const handler = (e) => {
			if (onSearchUpdateRef.current) onSearchUpdateRef.current(e.detail);
		};
		// ProseMirror view.dom might be attached deeper, use capture phase just in case
		wrapper.addEventListener("search-update", handler, true);
		return () => wrapper.removeEventListener("search-update", handler, true);
	}, []);

	useEffect(() => {
		if (!wrapperRef.current || !searchAction) return;
		// Dispatch the searchAction to the plugin via the editorView action
		const dispatchAction = async () => {
			// Find the editor view from the milkdown context inside the provider
			// Since we don't have direct access to `editorRef` here, we handle this
			// by adding another useEffect inside MilkdownEditor instead.
		};
		dispatchAction();
	}, [searchAction]);

	const handleCopy = () => {
		if (hoveredCell) {
			navigator.clipboard.writeText(hoveredCell.innerText);
			setCopiedCell(hoveredCell);
			setTimeout(() => {
				setCopiedCell((prev) => (prev === hoveredCell ? null : prev));
			}, 3000);
		}
	};

	const renderCopyBtn = (cell, isCopied) => {
		if (!cell || !wrapperRef.current) return null;
		const rect = cell.getBoundingClientRect();
		const wrapperRect = wrapperRef.current.getBoundingClientRect();

		return (
			<div
				key={isCopied ? "copied" : "hovered"}
				className="pv-cell-copy-btn"
				style={{
					position: "absolute",
					top: rect.top - wrapperRect.top + 2,
					left: rect.right - wrapperRect.left - 24,
					zIndex: 10,
					height: 20,
					width: 20,
					padding: 0,
					fontSize: 12,
					background: "transparent",
					border: "none",
					color: isCopied ? "var(--accent-2)" : "var(--muted)",
					cursor: isCopied ? "default" : "pointer",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
				onClick={isCopied ? undefined : handleCopy}
				title={isCopied ? "Copied!" : "Copy cell content"}
			>
				{isCopied ? "✓" : "📋"}
			</div>
		);
	};

	return (
		<div
			ref={wrapperRef}
			className="pv-milkdown-wrapper"
			data-theme={currentTheme === "dark" ? "dark" : "light"}
			style={{
				"--pv-bg": "var(--panel)",
				"--pv-text": "var(--text)",
				"--pv-text-secondary": "var(--muted)",
				"--pv-border": "var(--border-strong)",
				"--pv-primary": "var(--accent)",
				"--pv-code-bg": "var(--bg-soft)",
				"--pv-code-text": "var(--accent-3)",
				paddingBottom: 0,
				position: "relative",
			}}
		>
			{copiedCell && renderCopyBtn(copiedCell, true)}
			{hoveredCell &&
				hoveredCell !== copiedCell &&
				renderCopyBtn(hoveredCell, false)}

			<MilkdownProvider>
				<MilkdownEditor
					initialMarkdown={initialMarkdown}
					onChange={onChange}
					currentTheme={currentTheme}
					isMobile={isMobile}
					searchQuery={searchQuery}
					searchAction={searchAction}
					editorApiRef={editorApiRef}
				/>
			</MilkdownProvider>
		</div>
	);
}
