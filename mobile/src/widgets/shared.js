import { FlexWidget, TextWidget } from "react-native-android-widget";
import { colors } from "../utils/theme";
import { PixelSprite } from "./PixelSprite";

// Shared building blocks for the home-screen widgets so Tasks and Calendar stay
// visually identical: same pixel/terminal aesthetic (monospace, hard square
// edges), padding, header and empty/overflow states.

const MONO = "monospace";

// Outer card. Hard square inner elements, a soft outer radius + hairline border
// so the widget reads as a framed panel on any wallpaper.
export const FRAME_STYLE = {
	height: "match_parent",
	width: "match_parent",
	flexDirection: "column",
	backgroundColor: colors.bg,
	borderRadius: 16,
	borderWidth: 1,
	borderColor: colors.border,
	paddingHorizontal: 14,
	paddingTop: 12,
	paddingBottom: 10,
};

// Header: Piuma + UPPERCASE title on the left, a square count pill on the right,
// then a hairline divider. `tint` colors the title accent + pill text.
export function Header({ title, count, tint = colors.accent2 }) {
	return (
		<FlexWidget style={{ flexDirection: "column", width: "match_parent" }}>
			<FlexWidget
				style={{
					flexDirection: "row",
					alignItems: "center",
					width: "match_parent",
				}}
			>
				<PixelSprite pixelSize={3} />
				<TextWidget
					text={title.toUpperCase()}
					style={{
						fontFamily: MONO,
						fontSize: 13,
						fontWeight: "700",
						letterSpacing: 1,
						color: colors.text,
						marginLeft: 8,
					}}
				/>
				<FlexWidget style={{ flex: 1 }} />
				{count > 0 ? (
					<FlexWidget
						style={{
							backgroundColor: colors.panel,
							borderWidth: 1,
							borderColor: colors.borderStrong,
							paddingHorizontal: 6,
							paddingVertical: 1,
						}}
					>
						<TextWidget
							text={String(count)}
							style={{
								fontFamily: MONO,
								fontSize: 12,
								fontWeight: "700",
								color: tint,
							}}
						/>
					</FlexWidget>
				) : null}
			</FlexWidget>
			<FlexWidget
				style={{
					height: 1,
					width: "match_parent",
					backgroundColor: colors.border,
					marginTop: 8,
					marginBottom: 4,
				}}
			/>
		</FlexWidget>
	);
}

// Small square status marker (pixel style — no radius).
export function Dot({ color }) {
	return (
		<FlexWidget
			style={{ height: 8, width: 8, marginRight: 9, backgroundColor: color }}
		/>
	);
}

// One list line: square dot + truncating title + right-aligned "when" label.
export function Row({ uri, dotColor, title, titleColor, when, whenColor }) {
	return (
		<FlexWidget
			clickAction="OPEN_URI"
			clickActionData={{ uri }}
			style={{
				flexDirection: "row",
				alignItems: "center",
				width: "match_parent",
				paddingVertical: 5,
			}}
		>
			<Dot color={dotColor} />
			<FlexWidget style={{ flex: 1, flexDirection: "column" }}>
				<TextWidget
					text={title}
					maxLines={1}
					truncate="END"
					style={{ fontFamily: MONO, fontSize: 13, color: titleColor }}
				/>
			</FlexWidget>
			{when ? (
				<TextWidget
					text={when}
					maxLines={1}
					style={{
						fontFamily: MONO,
						fontSize: 11,
						color: whenColor ?? colors.muted,
						marginLeft: 8,
					}}
				/>
			) : null}
		</FlexWidget>
	);
}

// Centered placeholder — a bigger Piuma over a one-liner — for the empty /
// logged-out states.
export function EmptyState({ text }) {
	return (
		<FlexWidget
			style={{
				flex: 1,
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				width: "match_parent",
			}}
		>
			<PixelSprite pixelSize={4} />
			<TextWidget
				text={text}
				style={{
					fontFamily: MONO,
					fontSize: 12,
					color: colors.muted,
					marginTop: 10,
				}}
			/>
		</FlexWidget>
	);
}

// "+N MORE" footer, indented to line up with the row titles.
export function OverflowRow({ count }) {
	if (count <= 0) return null;
	return (
		<TextWidget
			text={`+${count} MORE`}
			style={{
				fontFamily: MONO,
				fontSize: 11,
				letterSpacing: 0.5,
				color: colors.muted,
				marginTop: 6,
				marginLeft: 17,
			}}
		/>
	);
}
