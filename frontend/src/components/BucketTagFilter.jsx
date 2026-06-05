import { useState } from "react";
import { useTagRegistry } from "../queries";
import { tagColor } from "../utils/tagColor";
import "./BucketTags.css";

/**
 * Sidebar filter shared by Tasks and Calendar.
 *
 * - scope="tasks": a "Buckets" section (filters by the task's own `bucket_id`,
 *   plus a "no bucket" row) followed by a flat "Tags" section.
 * - scope="calendar": flat "Tags" only — calendar events have no bucket.
 *
 * Buckets group *tasks*; tags are flat, independent labels. Counts are derived
 * from `items` (the loaded tasks/events, each with `tags: string[]` and, for
 * tasks, `bucket_id`), so they stay in sync without a separate counts endpoint.
 *
 * Selection key: "all" | "nobucket" | `bucket:<id>` | `tag:<name>`. `onSelect`
 * gets { key, label, names, bucketId }: `names` is the tag-name array for tag
 * selections (null otherwise); `bucketId` the bucket for bucket selections. The
 * page owns the actual filtering.
 */
export default function BucketTagFilter({
	scope,
	items = [],
	buckets = [],
	selectedKey = "all",
	onSelect,
	totalCount,
}) {
	const { data: registry = [] } = useTagRegistry();
	const [q, setQ] = useState("");

	const filter = q.trim().toLowerCase();
	const match = (name) => !filter || name.toLowerCase().includes(filter);
	const colorOf = (name) =>
		registry.find((r) => r.name === name)?.color || tagColor(name);

	// Tag usage counts, derived from the loaded items.
	const tagCounts = new Map();
	for (const it of items) {
		for (const n of it.tags ?? [])
			tagCounts.set(n, (tagCounts.get(n) ?? 0) + 1);
	}
	const tagNames = [...tagCounts.keys()].filter(match).sort();

	const showBuckets = scope === "tasks" && buckets.length > 0;
	const total = typeof totalCount === "number" ? totalCount : items.length;

	const navBtn = ({ key, label, count, onClick, extraClass = "", color }) => (
		<li key={key}>
			<button
				type="button"
				className={`tag-nav-btn${extraClass}${selectedKey === key ? " is-active" : ""}`}
				onClick={onClick}
			>
				<span className="tag-nav-name" style={color ? { color } : undefined}>
					{label}
				</span>
				<span className="tag-nav-count">{count}</span>
			</button>
		</li>
	);

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
				{navBtn({
					key: "all",
					label: "all",
					count: total,
					onClick: () => onSelect?.({ key: "all", names: null, label: "All" }),
				})}
			</ul>

			{showBuckets ? (
				<div className="btf-group">
					<div className="btf-section-label">Buckets</div>
					<ul className="tag-nav">
						{buckets.map((b) =>
							navBtn({
								key: `bucket:${b.id}`,
								label: b.name,
								count: items.filter((it) => it.bucket_id === b.id).length,
								onClick: () =>
									onSelect?.({
										key: `bucket:${b.id}`,
										names: null,
										bucketId: b.id,
										label: b.name,
									}),
								extraClass: " btf-bucket",
								color: b.color || undefined,
							}),
						)}
						{navBtn({
							key: "nobucket",
							label: "no bucket",
							count: items.filter((it) => !it.bucket_id).length,
							onClick: () =>
								onSelect?.({
									key: "nobucket",
									names: null,
									label: "No bucket",
								}),
							extraClass: " btf-bucket btf-inbox-name",
						})}
					</ul>
				</div>
			) : null}

			<div className="btf-group">
				{showBuckets ? <div className="btf-section-label">Tags</div> : null}
				<ul className="tag-nav btf-tags">
					{tagNames.map((name) =>
						navBtn({
							key: `tag:${name}`,
							label: `#${name}`,
							count: tagCounts.get(name),
							onClick: () =>
								onSelect?.({
									key: `tag:${name}`,
									names: [name],
									label: `#${name}`,
								}),
							color: colorOf(name),
						}),
					)}
					{tagNames.length === 0 ? (
						<li className="btf-empty">No tags{filter ? " match" : " yet"}.</li>
					) : null}
				</ul>
			</div>
		</div>
	);
}
