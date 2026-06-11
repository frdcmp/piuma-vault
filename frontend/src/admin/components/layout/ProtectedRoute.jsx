import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import PixelLoader from "../../../components/PixelLoader";
import { useUserMe } from "../../../queries";

// Once the loader appears, keep it on screen for at least this long so the
// pixel transition reads as deliberate rather than a flicker.
const MIN_LOADER_MS = 2000;

const ProtectedRoute = ({ children, requiredPermission = "admin_access" }) => {
	const location = useLocation();
	const { data: me, isError, fetchStatus, status } = useUserMe();

	// True while resolving /me (initial load or a mid-refresh with no cached user).
	const resolving = fetchStatus === "fetching" && !me;

	// Whether the loader was showing on the first render — captured once so the
	// minimum-display timer is keyed on a stable value (keying it on `resolving`
	// would clear the timeout the instant /me resolves, hanging the loader).
	const [showedLoader] = useState(resolving);
	const [minElapsed, setMinElapsed] = useState(false);
	useEffect(() => {
		if (!showedLoader) return;
		const t = setTimeout(() => setMinElapsed(true), MIN_LOADER_MS);
		return () => clearTimeout(t);
	}, [showedLoader]);
	const holdingLoader = showedLoader && !minElapsed;

	const redirectToLogin = (
		<Navigate
			to={`/admin/login?redirectTo=${encodeURIComponent(
				location.pathname + location.search,
			)}`}
			replace
		/>
	);

	// Query is disabled (no tokens present) — not authenticated.
	if (status === "pending" && fetchStatus === "idle") {
		return redirectToLogin;
	}

	// Still resolving the user, or holding the loader out to its minimum.
	if (resolving || holdingLoader) {
		return <PixelLoader message="Loading vault" />;
	}

	// /me failed even after the interceptor's refresh attempt — session is dead.
	if (isError || !me) {
		return redirectToLogin;
	}

	const permissions = me.permissions || [];
	if (requiredPermission && !permissions.includes(requiredPermission)) {
		return redirectToLogin;
	}

	return <>{children}</>;
};

export default ProtectedRoute;
