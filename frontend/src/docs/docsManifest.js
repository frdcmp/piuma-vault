// Single source of truth for the public docs site (/docs).
//
// Each entry pairs a URL slug + title with its markdown body, imported raw at
// build time via Vite's `?raw` suffix — so the docs are version-controlled and
// need no backend. The sidebar is rendered from `DOC_GROUPS`.

import adminPanel from "./content/admin-panel.md?raw";
import agentsLlm from "./content/agents-llm.md?raw";
import architecture from "./content/architecture.md?raw";
import authSecurity from "./content/auth-security.md?raw";
import gettingStarted from "./content/getting-started.md?raw";
import mobile from "./content/mobile.md?raw";
import notes from "./content/notes.md?raw";
import notifications from "./content/notifications.md?raw";
import operations from "./content/operations.md?raw";
import overview from "./content/overview.md?raw";
import sharing from "./content/sharing.md?raw";
import storage from "./content/storage.md?raw";
import tasksCalendar from "./content/tasks-calendar.md?raw";

// Ordered groups of docs, rendered top-to-bottom in the sidebar.
export const DOC_GROUPS = [
	{
		group: "Introduction",
		items: [
			{ slug: "overview", title: "Overview", body: overview },
			{
				slug: "getting-started",
				title: "Getting Started",
				body: gettingStarted,
			},
		],
	},
	{
		group: "Architecture",
		items: [
			{
				slug: "architecture",
				title: "System Architecture",
				body: architecture,
			},
			{ slug: "auth-security", title: "Auth & Security", body: authSecurity },
		],
	},
	{
		group: "Features",
		items: [
			{ slug: "notes", title: "Notes", body: notes },
			{
				slug: "tasks-calendar",
				title: "Tasks, Calendar & Agenda",
				body: tasksCalendar,
			},
			{ slug: "agents-llm", title: "LLM Chat & Agents", body: agentsLlm },
			{ slug: "storage", title: "File Storage", body: storage },
			{ slug: "sharing", title: "Sharing", body: sharing },
			{
				slug: "notifications",
				title: "Notifications & Alerts",
				body: notifications,
			},
		],
	},
	{
		group: "Operations",
		items: [
			{ slug: "admin-panel", title: "Admin Panel", body: adminPanel },
			{ slug: "mobile", title: "Mobile App", body: mobile },
			{ slug: "api-reference", title: "API Reference", body: apiReference },
			{
				slug: "operations",
				title: "Operations & Deployment",
				body: operations,
			},
		],
	},
];

// Flat slug → doc lookup, derived from the groups.
export const DOC_BY_SLUG = Object.fromEntries(
	DOC_GROUPS.flatMap((g) => g.items).map((item) => [item.slug, item]),
);

// The landing doc when visiting /docs with no slug.
export const FIRST_SLUG = DOC_GROUPS[0].items[0].slug;
