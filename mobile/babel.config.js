module.exports = (api) => {
	api.cache(true);
	return {
		presets: ["babel-preset-expo"],
		// Reanimated 4 is powered by react-native-worklets; its babel plugin must
		// be listed LAST. (Replaces the old `react-native-reanimated/plugin`.)
		plugins: ["react-native-worklets/plugin"],
	};
};
