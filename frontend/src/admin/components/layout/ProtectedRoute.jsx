import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import PixelLoader from "../../../components/PixelLoader";
import { useUserMe } from "../../../queries";

const ProtectedRoute = ({ children, requiredPermission = "admin_access" }) => {
	const location = useLocation();
	const { data: me, isError, fetchStatus, status } = useUserMe();

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

	// Still resolving the user (or the axios interceptor is mid-refresh).
	if (fetchStatus === "fetching" && !me) {
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
