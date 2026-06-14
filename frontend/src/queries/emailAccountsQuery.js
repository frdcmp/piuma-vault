import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createEmailAccount,
	deleteEmailAccount,
	listEmailAccounts,
	setDefaultEmailAccount,
	testEmailImap,
	testEmailSmtp,
	updateEmailAccount,
} from "../api/emailAccounts";

const EMAIL_ACCOUNTS_KEY = ["email-accounts"];

export const useEmailAccounts = () =>
	useQuery({
		queryKey: EMAIL_ACCOUNTS_KEY,
		queryFn: listEmailAccounts,
	});

export const useCreateEmailAccount = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: createEmailAccount,
		onSuccess: () => qc.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_KEY }),
	});
};

export const useUpdateEmailAccount = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: updateEmailAccount,
		onSuccess: () => qc.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_KEY }),
	});
};

export const useDeleteEmailAccount = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: deleteEmailAccount,
		onSuccess: () => qc.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_KEY }),
	});
};

export const useSetDefaultEmailAccount = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: setDefaultEmailAccount,
		onSuccess: () => qc.invalidateQueries({ queryKey: EMAIL_ACCOUNTS_KEY }),
	});
};

export const useTestEmailSmtp = () =>
	useMutation({ mutationFn: testEmailSmtp });

export const useTestEmailImap = () =>
	useMutation({ mutationFn: testEmailImap });
