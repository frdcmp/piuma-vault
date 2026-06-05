import { useState } from "react";
import { useTagTree } from "../queries";
import { tagColor } from "../utils/tagColor";
import "./BucketTags.css";

const sumCounts = (tags) => tags.reduce((s, t) => s + (t.count || 0), 0);

/**
 * Two-level tag filter shared by Tasks and Calendar. Renders the bucket → tag
 * tree for `scope` ("tasks" | "calendar"), plus an "all" row and the virtual
 * "Inbox" group (uncategorized tags).
 *
 * Selection is identified by `selectedKey` ("all" | `bucket:<id>` | "inbox" |
 * `tag:<name>`). `onSelect` receives { key, names, label }, where `names` is the
 * array of tag names the selection matches (null for "all") — the page filters
 * its items with it, so this component owns the tree and the page stays simple.
 */
export default function BucketTagFilter({
	scope,
	selectedKey = "all",
	onSelect,
	totalCount,
}) {
	const { data: tree } = useTagTree(scope);
	const [q, setQ] = useState("");

	const buckets = tree?.buckets ?? [];
	const inbox = tree?.inbox ?? [];
	const filter = q.trim().toLowerCase();
	const match = (name) => !filter || name.toLowerCase().includes(filter);

	const tagRow = (t) => (
		<li key={t.id}>
			<button
				type="button"
				className={`tag-nav-btn${selectedKey === `tag:${t.name}` ? " is-active" : ""}`}
				onClick={() =>
					onSelect?.({
						key: `tag:${t.name}`,
						names: [t.name],
						label: `#${t.name}`,
					})
				}
			>
				<span
					className="tag-nav-name"
					style={{ color: t.color || tagColor(t.name) }}
				>
					#{t.name}
				</span>
				<span className="tag-nav-count">{t.count}</span>
			</button>
		</li>
	);

	const hasInbox = inbox.filter((t) => match(t.name)).length > 0;
	const empty = buckets.length === 0 && inbox.length === 0;

	return (
		<div className="btf">
			<input
				className="tag-search"
				type="text"
				value={q}
				onChange={(e) => setQ(e.target.value)}
				placeholder="Filter tags…"
				aria-label="Filter tags"
			/>

			<ul className="tag-nav">
				<li>
					<button
						type="button"
						className={`tag-nav-btn${selectedKey === "all" ? " is-active" : ""}`}
						onClick={() =>
							onSelect?.({ key: "all", names: null, label: "All" })
						}
					>
						<span className="tag-nav-name">all</span>
						{typeof totalCount === "number" ? (
							<span className="tag-nav-count">{totalCount}</span>
						) : null}
					</button>
				</li>
			</ul>

			{buckets.map((b) => {
				const tags = b.tags.filter((t) => match(t.name));
				if (filter && tags.length === 0) return null;
				return (
					<div key={b.id} className="btf-group">
						<button
							type="button"
							className={`tag-nav-btn btf-bucket${selectedKey === `bucket:${b.id}` ? " is-active" : ""}`}
							onClick={() =>
								onSelect?.({
									key: `bucket:${b.id}`,
									names: b.tags.map((t) => t.name),
									label: b.name,
								})
							}
						>
							<span
								className="tag-nav-name btf-bucket-name"
								style={{ color: b.color || undefined }}
							>
								{b.name}
							</span>
							<span className="tag-nav-count">{sumCounts(b.tags)}</span>
						</button>
						{tags.length ? (
							<ul className="tag-nav btf-tags">{tags.map(tagRow)}</ul>
						) : null}
					</div>
				);
			})}

			{hasInbox ? (
				<div className="btf-group">
					<button
						type="button"
						className={`tag-nav-btn btf-bucket${selectedKey === "inbox" ? " is-active" : ""}`}
						onClick={() =>
							onSelect?.({
								key: "inbox",
								names: inbox.map((t) => t.name),
								label: "Inbox",
							})
						}
					>
						<span className="tag-nav-name btf-inbox-name">⊕ inbox</span>
						<span className="tag-nav-count">{sumCounts(inbox)}</span>
					</button>
					<ul className="tag-nav btf-tags">
						{inbox.filter((t) => match(t.name)).map(tagRow)}
					</ul>
				</div>
			) : null}

			{empty ? <p className="btf-empty">No tags yet.</p> : null}
		</div>
	);
}
