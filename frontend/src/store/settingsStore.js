import { create } from "zustand";

const STORAGE_KEY = "asr_user_settings";
const DEFAULT_ANNOTATION_SCHEMA_CREATE_DRAFT = {
	name: "",
	schema: { global: [], inline: [] },
};

// Helper functions for localStorage
const loadSettings = () => {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved ? JSON.parse(saved) : {};
	} catch {
		return {};
	}
};

const saveSettings = (settings) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch (error) {
		console.error("Failed to save settings to localStorage:", error);
	}
};

const getPersistableSettings = (state) => ({
	dashboardViewMode: state.dashboardViewMode,
	batchListViewMode: state.batchListViewMode,
	annotationSchemaCreateDraft: state.annotationSchemaCreateDraft,
});

const useSettingsStore = create((set, get) => ({
	// Dashboard settings
	dashboardViewMode: "list", // "tree" | "list"
	// Batch list settings
	batchListViewMode: "explorer", // "table" | "explorer"
	annotationSchemaCreateDraft: DEFAULT_ANNOTATION_SCHEMA_CREATE_DRAFT,

	// Initialize from localStorage
	initializeSettings: () => {
		const saved = loadSettings();
		set({
			dashboardViewMode: saved.dashboardViewMode || "list",
			batchListViewMode: saved.batchListViewMode || "explorer",
			annotationSchemaCreateDraft:
				saved.annotationSchemaCreateDraft ||
				DEFAULT_ANNOTATION_SCHEMA_CREATE_DRAFT,
		});
	},

	// Update dashboard view mode
	setDashboardViewMode: (mode) => {
		set({ dashboardViewMode: mode });
		saveSettings(getPersistableSettings(get()));
	},

	// Update batch list view mode
	setBatchListViewMode: (mode) => {
		set({ batchListViewMode: mode });
		saveSettings(getPersistableSettings(get()));
	},

	setAnnotationSchemaCreateDraft: (draft) => {
		set({ annotationSchemaCreateDraft: draft });
		saveSettings(getPersistableSettings(get()));
	},

	resetAnnotationSchemaCreateDraft: () => {
		set({
			annotationSchemaCreateDraft: DEFAULT_ANNOTATION_SCHEMA_CREATE_DRAFT,
		});
		saveSettings(getPersistableSettings(get()));
	},

	// Reset to defaults
	resetSettings: () => {
		set({
			dashboardViewMode: "list",
			batchListViewMode: "explorer",
			annotationSchemaCreateDraft: DEFAULT_ANNOTATION_SCHEMA_CREATE_DRAFT,
		});
		localStorage.removeItem(STORAGE_KEY);
	},
}));

// Initialize settings on app load
if (typeof window !== "undefined") {
	useSettingsStore.getState().initializeSettings();
}

export default useSettingsStore;
