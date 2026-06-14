import "../../../vault-pixel.css";
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
 *   }>
 *   data:      Array<object>             // rows
 *   rowKey:    string | (row) => key     // defaults to "id"
 *   loading:   boolean
 *   emptyText: ReactNode                 // shown when there are no rows
 *   onRowClick?: (row) => void
 */
export default function PvTable({
	columns = [],
	data = [],
	rowKey = "id",
	loading = false,
	emptyText = "No data",
	className = "",
	onRowClick,
}) {
	const keyFor = (row, i) =>
		typeof rowKey === "function" ? rowKey(row) : (row?.[rowKey] ?? i);

	const cellValue = (col, row, i) => {
		const value = col.dataIndex != null ? row[col.dataIndex] : undefined;
		return col.render ? col.render(value, row, i) : value;
	};

	return (
		<div className={`pv-table-wrap ${className}`.trim()}>
			<table className="pv-table">
				<thead>
					<tr>
						{columns.map((col) => (
							<th
								key={col.key}
								style={{ width: col.width, textAlign: col.align }}
							>
								{col.title}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{loading ? (
						<tr className="pv-table-state">
							<td colSpan={columns.length}>Loading…</td>
						</tr>
					) : data.length === 0 ? (
						<tr className="pv-table-state">
							<td colSpan={columns.length}>{emptyText}</td>
						</tr>
					) : (
						data.map((row, i) => (
							<tr
								key={keyFor(row, i)}
								className={onRowClick ? "pv-table-row--clickable" : ""}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
							>
								{columns.map((col) => (
									<td key={col.key} style={{ textAlign: col.align }}>
										{cellValue(col, row, i)}
									</td>
								))}
							</tr>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}
