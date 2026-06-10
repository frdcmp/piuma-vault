import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ProfileHeader from "../../components/ProfileHeader";
import SettingsHeader from "../../components/SettingsHeader";
import { useUpdateProfile, useUserMe } from "../../queries/userQuery";
import { colors, mono } from "../../utils/theme";

// Editable profile fields. The mascot greeting up top doubles as a live preview
// of the name as you type. Pixel/terminal styling throughout.
function Field({ label, value, onChangeText, placeholder, multiline }) {
	return (
		<View style={styles.field}>
			<Text style={styles.label}>{label}</Text>
			<TextInput
				style={[styles.input, multiline && styles.inputMultiline]}
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={colors.muted}
				multiline={multiline}
				autoCapitalize={multiline ? "sentences" : "words"}
			/>
		</View>
	);
}

export default function ProfileScreen({ navigation }) {
	const insets = useSafeAreaInsets();
	const { data: user, isLoading } = useUserMe();
	const update = useUpdateProfile();

	const [firstName, setFirstName] = useState("");
	const [lastName, setLastName] = useState("");
	const [location, setLocation] = useState("");
	const [bio, setBio] = useState("");
	const [saved, setSaved] = useState(false);

	// Seed the form once the profile loads.
	useEffect(() => {
		if (!user) return;
		setFirstName(user.first_name || "");
		setLastName(user.last_name || "");
		setLocation(user.location || "");
		setBio(user.bio || "");
	}, [user]);

	// Live-preview the typed name in the header without mutating the cache.
	const preview = {
		...user,
		first_name: firstName,
		last_name: lastName,
	};

	const save = () => {
		setSaved(false);
		update.mutate(
			{
				first_name: firstName.trim(),
				last_name: lastName.trim(),
				location: location.trim(),
				bio: bio.trim(),
			},
			{ onSuccess: () => setSaved(true) },
		);
	};

	return (
		<View style={styles.root}>
			<SettingsHeader title="Profile" onBack={() => navigation.goBack()} />
			{isLoading ? (
				<View style={styles.center}>
					<ActivityIndicator color={colors.accent} />
				</View>
			) : (
				<KeyboardAvoidingView
					style={styles.flex}
					behavior={Platform.OS === "ios" ? "padding" : undefined}
				>
					<ScrollView
						contentContainerStyle={[
							styles.scroll,
							{ paddingBottom: insets.bottom + 24 },
						]}
					>
						<ProfileHeader user={preview} />

						<Text style={styles.sectionTitle}>Edit profile</Text>
						<View style={styles.panel}>
							<Field
								label="First name"
								value={firstName}
								onChangeText={setFirstName}
								placeholder="User"
							/>
							<Field
								label="Last name"
								value={lastName}
								onChangeText={setLastName}
								placeholder="User"
							/>
							<Field
								label="Location"
								value={location}
								onChangeText={setLocation}
								placeholder="Where in the world"
							/>
							<Field
								label="Bio"
								value={bio}
								onChangeText={setBio}
								placeholder="A line about you"
								multiline
							/>

							<Pressable
								onPress={save}
								disabled={update.isPending}
								style={({ pressed }) => [
									styles.saveBtn,
									pressed && styles.saveBtnPressed,
								]}
							>
								<Text style={styles.saveText}>
									{update.isPending ? "Saving…" : "Save changes"}
								</Text>
							</Pressable>
							{saved && !update.isPending ? (
								<Text style={styles.savedNote}>✓ Saved</Text>
							) : null}
							{update.isError ? (
								<Text style={styles.errorNote}>Couldn't save — try again.</Text>
							) : null}
						</View>
					</ScrollView>
				</KeyboardAvoidingView>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.bg },
	flex: { flex: 1 },
	center: { flex: 1, alignItems: "center", justifyContent: "center" },
	scroll: { padding: 12, gap: 8 },
	sectionTitle: {
		fontFamily: mono,
		color: colors.muted,
		fontSize: 12,
		textTransform: "uppercase",
		letterSpacing: 1,
		marginTop: 12,
		marginBottom: 4,
		marginLeft: 4,
	},
	panel: {
		backgroundColor: colors.panel,
		borderWidth: 2,
		borderColor: colors.border,
		padding: 16,
		gap: 14,
	},
	field: { gap: 6 },
	label: {
		fontFamily: mono,
		color: colors.text,
		fontSize: 12,
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	input: {
		fontFamily: mono,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderWidth: 2,
		borderColor: colors.border,
		backgroundColor: colors.bgSoft,
		color: colors.text,
		fontSize: 15,
	},
	inputMultiline: { minHeight: 80, textAlignVertical: "top" },
	saveBtn: {
		borderWidth: 2,
		borderColor: colors.accent,
		paddingVertical: 12,
		alignItems: "center",
		marginTop: 4,
	},
	saveBtnPressed: { backgroundColor: colors.bgSoft },
	saveText: {
		fontFamily: mono,
		color: colors.accent,
		fontSize: 14,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	savedNote: {
		fontFamily: mono,
		color: colors.accent2,
		fontSize: 13,
		textAlign: "center",
	},
	errorNote: {
		fontFamily: mono,
		color: colors.accent3,
		fontSize: 13,
		textAlign: "center",
	},
});
