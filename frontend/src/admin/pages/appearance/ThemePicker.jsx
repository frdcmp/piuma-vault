import { useAppearance, useUpdateAppearance } from "@/queries";
import { themes, useTheme } from "@/theme";
import { PvPanel, pvMessage } from "@/ui";

const SWATCHES = ["accent", "success", "danger", "info", "warning", "violet"];

/**
 * Theme picker. Each card renders in its own theme — tokens.css keys the
 * --vp-* variables on [data-theme], so setting it on the card is the preview.
 * Saving writes app_settings (global); ThemeSync applies it everywhere.
 */
export default function ThemePicker() {
	const { theme } = useTheme();
	const { isLoading } = useAppearance();
	const update = useUpdateAppearance();

	const pick = (id) => {
		if (id === theme) return;
		update.mutate(
			{ theme: id },
			{ onError: () => pvMessage.error("Could not save the theme") },
		);
	};

	return (
		<PvPanel title="Theme">
			<p className="vp-text vp-muted vp-theme-hint">
				One palette for the whole vault — web and mobile follow it. Edit or
				add themes in <code>frontend/src/theme/tokens.json</code>.
			</p>
			<div className="vp-theme-cards">
				{Object.entries(themes).map(([id, t]) => (
					<button
						key={id}
						type="button"
						data-theme={id}
						className={`vp-theme-card${id === theme ? " is-active" : ""}`}
						disabled={isLoading || update.isPending}
						aria-pressed={id === theme}
						onClick={() => pick(id)}
					>
						<span className="vp-panel-bar">
							<span className="vp-dots">
								<span />
								<span />
								<span />
							</span>
							<span className="vp-panel-title">{t.label}</span>
						</span>
						<span className="vp-theme-card-body">
							<span className="vp-theme-card-text">
								The quick vault <span className="vp-muted">— muted</span>
							</span>
							<span className="vp-theme-swatches">
								{SWATCHES.map((s) => (
									<span
										key={s}
										className={`vp-theme-swatch vp-theme-swatch--${s}`}
										title={s}
									/>
								))}
							</span>
							<span className="vp-theme-card-foot">
								{id === theme ? "● active" : "use this theme"}
							</span>
						</span>
					</button>
				))}
			</div>
		</PvPanel>
	);
}
