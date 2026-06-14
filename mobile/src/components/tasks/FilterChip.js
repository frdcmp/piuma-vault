import { Pressable, Text, View } from "react-native";
import { s } from "./taskStyles";

// ── Filter chip (tag group / recurring) ─────────────────────────────────────

function Chip({ label, count, active, color, swatch, onPress }) {
	return (
		<Pressable
			style={[s.chip, active && s.chipOn]}
			onPress={onPress}
			hitSlop={6}
		>
			{/* Buckets get a filled colour square (hollow = "no bucket"); tags carry
			   their colour on the label text instead. */}
			{swatch ? (
				<View
					style={[
						s.chipSwatch,
						color ? { backgroundColor: color, borderColor: color } : null,
					]}
				/>
			) : null}
			<Text
				style={[
					s.chipText,
					swatch && s.chipTextBucket,
					active && s.chipTextOn,
					!swatch && color ? { color } : null,
				]}
			>
				{label}
			</Text>
			<Text style={[s.chipCount, active && s.chipTextOn]}>{count}</Text>
		</Pressable>
	);
}

export default Chip;
