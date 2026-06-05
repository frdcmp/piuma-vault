import { HomeOutlined } from "@ant-design/icons";
import { Link, useLocation } from "react-router-dom";
import "../../vault-pixel.css";
import "./layout.css";

// Static label map for top-level routes
const PAGE_LABELS = {
	files: "File Storage",
	llm: "LLM Chat",
	alignment: "Alignment",
	health: "Health Database",
	languages: "Languages",
	settings: "Settings",
	tasks: "Tasks",
	"annotation-schemas": "Annotations",
	about: "About",
	profile: "Profile",
	theme: "Theme",
	test: "API Test",
};

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID_RE.test(s);

const titleCase = (s) =>
	s
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");

const AppBreadcrumbs = () => {
	const location = useLocation();
	const segments = location.pathname.split("/").filter(Boolean);

	const isProjectRoute = segments[0] === "admin" && segments[1] === "projects";
	const projectUuid =
		isProjectRoute && isUuid(segments[2]) ? segments[2] : null;
	const batchUuid = projectUuid && isUuid(segments[3]) ? segments[3] : null;
	const fileUuid = batchUuid && isUuid(segments[4]) ? segments[4] : null;

	// Build a flat list of { label, to? } crumbs.
	const items = [{ label: <HomeOutlined />, to: "/notes" }];

	if (segments[0] === "admin") {
		items.push(
			segments.length > 1
				? { label: "Admin", to: "/admin" }
				: { label: "Admin" },
		);
	}

	if (!isProjectRoute) {
		if (segments.length > 1) {
			const featureSegment = segments[1];
			const displayLabel =
				PAGE_LABELS[featureSegment] ?? titleCase(featureSegment);

			if (segments.length > 2) {
				items.push({ label: displayLabel, to: `/admin/${featureSegment}` });
				for (let i = 2; i < segments.length; i++) {
					const sub = titleCase(segments[i]);
					if (i < segments.length - 1) {
						items.push({
							label: sub,
							to: `/${segments.slice(0, i + 1).join("/")}`,
						});
					} else {
						items.push({ label: sub });
					}
				}
			} else {
				items.push({ label: displayLabel });
			}
		}
	} else if (!projectUuid) {
		items.push({ label: "Projects" });
	} else {
		items.push({ label: "Projects", to: "/admin/projects" });
		if (!batchUuid) {
			items.push({ label: projectUuid });
		} else {
			items.push({ label: projectUuid, to: `/admin/projects/${projectUuid}` });
			if (!fileUuid) {
				items.push({ label: batchUuid });
			} else {
				items.push({
					label: batchUuid,
					to: `/admin/projects/${projectUuid}/${batchUuid}`,
				});
				items.push({ label: fileUuid });
			}
		}
	}

	return (
		<nav className="vp-crumbs" aria-label="Breadcrumb">
			{items.map((item, i) => (
				<span
					key={
						typeof item.label === "string" ? `${item.label}-${i}` : `crumb-${i}`
					}
					className="vp-row"
					style={{ gap: 8 }}
				>
					{i > 0 && <span className="vp-crumb-sep">/</span>}
					{item.to ? (
						<Link to={item.to} className="vp-crumb">
							{item.label}
						</Link>
					) : (
						<span className="vp-crumb vp-crumb--current">{item.label}</span>
					)}
				</span>
			))}
		</nav>
	);
};

export default AppBreadcrumbs;
