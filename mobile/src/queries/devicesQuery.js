import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteTrustedDevice, getTrustedDevices } from "../api/auth";

export const deviceKeys = {
	all: ["trusted-devices"],
};

// Trusted devices skip the OTP prompt for 30 days after their last login.
export const useTrustedDevices = (options = {}) =>
	useQuery({
		queryKey: deviceKeys.all,
		queryFn: getTrustedDevices,
		staleTime: 60_000,
		...options,
	});

export const useRevokeTrustedDevice = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteTrustedDevice,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: deviceKeys.all });
		},
	});
};
