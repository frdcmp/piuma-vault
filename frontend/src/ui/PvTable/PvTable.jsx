import { Fragment, useEffect, useMemo, useState } from "react";
import PvExpander from "../PvExpander";
import "./PvTable.css";

/**
 * Pixel-style data table built on plain HTML — no antd, no theme fighting.
 *
 * Props:
 *   columns: Array<{
 *     key: string,                       // unique column key
 *     title: ReactNode,                  // header label
 *     dataIndex?: string,                // field to read from a row
 *     render?: (value, row, index) => ReactNode,  // custom cell renderer
 *     width?: string|number,             // optional fixed width
 *     align?: "left" | "center" | "right",
 *     sorter?: (a, b) => number,         // makes the header click-to-sort
 *   }>
 *   data:       Array<object>            // rows
 *   rowKey:     string | (row) => key    // defaults to "id"
 *   loading:    boolean
 *   emptyText:  ReactNode                // shown when there are no rows
 *   onRowClick?: (row) => void
 *   size:       "md" (default) | "sm"    // tighter cells
 *   minWidth?:  number                   // table min width; the wrapper scrolls horizontally
 *   pagination: false (default) | { pageSize: number, hideOnSinglePage?: boolean }
 *   expandable?: { expandedRowRender: (row) => ReactNode, rowExpandable?: (row) => boolean }
 */
export default function PvTable({
	columns = [],
	data = [],
	rowKey = "id",
	loading = false,
	emptyText = "No data",
	className = "",
	onRowClick,
	size = "md",
	minWidth,
	pagination = false,
	expandable,
}) {
	const [sort, setSort] = useState(null); // { key, dir: 1 | -1 }
	const [page, setPage] = useState(1);
	const [expanded, setExpanded] = useState(() => new Set());

	const keyFor = (row, i) =>
		typeof rowKey === "function" ? rowKey(row) : (row?.[rowKey] ?? i);

	const cellValue = (col, row, i) => {
		const value = col.dataIndex != null ? row[col.dataIndex] : undefined;
		return col.render ? col.render(value, row, i) : value;
	};

	const sorted = useMemo(() => {
		const col = sort && columns.find((c) => c.key === sort.key);
		if (!col?.sorter) return data;
		return [...data].sort((a, b) => col.sorter(a, b) * sort.dir);
	}, [data, columns, sort]);

	const pageSize = pagination ? pagination.pageSize : sorted.length;
	const pages = Math.max(1, Math.ceil(sorted.length / (pageSize || 1)));
	useEffect(() => {
		if (page > pages) setPage(pages);
	}, [page, pages]);
	const rows = pagination
		? sorted.slice((page - 1) * pageSize, page * pageSize)
		: sorted;

	const toggleSort = (col) => {
		if (!col.sorter) return;
		setSort((s) =>
			s?.key !== col.key
				? { key: col.key, dir: 1 }
				: s.dir === 1
					? { key: col.key, dir: -1 }
					: null,
		);
	};

	const toggleRow = (k) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});

	const span = columns.length + (expandable ? 1 : 0);
	const showPager = pagination && !(pagination.hideOnSinglePage && pages <= 1);

	return (
		<div className={`pv-table-wrap ${className}`.trim()}>
			<table
				className={`pv-table${size === "sm" ? " pv-table--sm" : ""}`}
				style={minWidth ? { minWidth } : undefined}
			>
				<thead>
					<tr>
						{expandable && <th className="pv-table-expand-col" />}
						{columns.map((col) => {
							const dir = sort?.key === col.key ? sort.dir : 0;
							return (
								<th
									key={col.key}
									style={{ width: col.width, textAlign: col.align }}
									aria-sort={
										dir === 1
											? "ascending"
											: dir === -1
												? "descending"
												: undefined
									}
								>
									{col.sorter ? (
										<button
											type="button"
											className="pv-table-sort"
											onClick={() => toggleSort(col)}
										>
											{col.title}
											<span className="pv-table-sort-mark" aria-hidden="true">
												{dir === 1 ? "▲" : dir === -1 ? "▼" : "◆"}
											</span>
										</button>
									) : (
										col.title
									)}
								</th>
							);
						})}
					</tr>
				</thead>
				<tbody>
					{loading ? (
						<tr className="pv-table-state">
							<td colSpan={span}>Loading…</td>
						</tr>
					) : rows.length === 0 ? (
						<tr className="pv-table-state">
							<td colSpan={span}>{emptyText}</td>
						</tr>
					) : (
						rows.map((row, i) => {
							const k = keyFor(row, i);
							const canExpand =
								expandable && (expandable.rowExpandable?.(row) ?? true);
							const open = canExpand && expanded.has(k);
							return (
								<Fragment key={k}>
									<tr
										className={onRowClick ? "pv-table-row--clickable" : ""}
										onClick={onRowClick ? () => onRowClick(row) : undefined}
									>
										{expandable && (
											<td className="pv-table-expand-col">
												{canExpand && (
													<PvExpander
														expanded={open}
														record={k}
														onExpand={(key, e) => {
															e.stopPropagation();
															toggleRow(key);
														}}
													/>
												)}
											</td>
										)}
										{columns.map((col) => (
											<td key={col.key} style={{ textAlign: col.align }}>
												{cellValue(col, row, i)}
											</td>
										))}
									</tr>
									{open && (
										<tr className="pv-table-expanded">
											<td colSpan={span}>
												{expandable.expandedRowRender(row)}
											</td>
										</tr>
									)}
								</Fragment>
							);
						})
					)}
				</tbody>
			</table>
			{showPager && (
				<div className="pv-table-pager">
					<button
						type="button"
						className="vp-btn vp-btn--sm vp-btn--ghost"
						disabled={page <= 1}
						onClick={() => setPage((p) => p - 1)}
						aria-label="Previous page"
					>
						‹
					</button>
					<span className="pv-table-pager-info">
						{page} / {pages}
					</span>
					<button
						type="button"
						className="vp-btn vp-btn--sm vp-btn--ghost"
						disabled={page >= pages}
						onClick={() => setPage((p) => p + 1)}
						aria-label="Next page"
					>
						›
					</button>
				</div>
			)}
		</div>
	);
}
