import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import PageLayout from "./admin/components/layout/PageLayout";
import ProtectedRoute from "./admin/components/layout/ProtectedRoute";
import About from "./admin/pages/about";
import ApiKeysPage from "./admin/pages/apiKeys";
import ApiTest from "./admin/pages/apiTest";
import ForgotPassword from "./admin/pages/auth/forgotPassword";
import Login from "./admin/pages/auth/login";
import VerifyEmail from "./admin/pages/auth/verifyEmail";
import CalendarPage from "./admin/pages/calendar/CalendarPage";
import DbDump from "./admin/pages/dbDump";
import Files from "./admin/pages/files";
import Health from "./admin/pages/health";
import Homepage from "./admin/pages/homepage";
import LLMPage from "./admin/pages/llm";
import NoteEditor from "./admin/pages/notes/NoteEditor";
import NotesLayout from "./admin/pages/notes/NotesLayout";
import Profile from "./admin/pages/profile";
import Projects from "./admin/pages/projects";
import Services from "./admin/pages/services";
import Settings from "./admin/pages/settings";
import StorageExplorer from "./admin/pages/storage/StorageExplorer";
import TasksPage from "./admin/pages/tasks/TasksPage";
import TrashPage from "./admin/pages/trash";
import { queryClient } from "./api/queryClient";
import SharedFolderPage from "./share/SharedFolderPage";
import SharedNotePage from "./share/SharedNotePage";

function AppContent() {
	return (
		<BrowserRouter
			basename={import.meta.env.BASE_URL}
			future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
		>
			<Routes>
				{/* Vault (notes) — served at the app root */}
				<Route
					path="/"
					element={
						<ProtectedRoute requiredPermission="admin_access">
							<NotesLayout />
						</ProtectedRoute>
					}
				>
					<Route path=":id" element={<NoteEditor />} />
				</Route>

				{/* Public shared note viewer */}
				<Route path="/share/v/:slug" element={<SharedNotePage />} />

				{/* Public shared folder viewer */}
				<Route path="/s/:slug" element={<SharedFolderPage />} />

				{/* Admin auth routes (no layout) */}
				<Route path="/admin/login" element={<Login />} />
				<Route path="/admin/forgot-password" element={<ForgotPassword />} />
				<Route path="/admin/verify-email" element={<VerifyEmail />} />

				{/* Admin app routes (with PageLayout) */}
				<Route
					path="/admin"
					element={
						<ProtectedRoute requiredPermission="admin_access">
							<PageLayout />
						</ProtectedRoute>
					}
				>
					<Route index element={<Homepage />} />
					<Route path="about" element={<About />} />
					<Route path="projects" element={<Projects />} />
					<Route path="files" element={<Files />} />
					<Route path="api-keys" element={<ApiKeysPage />} />
					<Route path="health" element={<Health />} />
					<Route path="llm" element={<LLMPage />} />
					<Route path="profile" element={<Profile />} />
					<Route path="settings" element={<Settings />} />
					<Route path="settings/:tab" element={<Settings />} />
					<Route path="services" element={<Services />} />
					<Route path="trash" element={<TrashPage />} />
					<Route path="db-backups" element={<DbDump />} />
					<Route path="test" element={<ApiTest />} />
				</Route>

				{/* Old vault path moved to / — keep redirects so admin links still work */}
				<Route path="/admin/notes" element={<Navigate to="/" replace />} />
				<Route path="/admin/notes/:id" element={<Navigate to="/" replace />} />

				{/* Admin Storage explorer (standalone pixel layout, no PageLayout) */}
				<Route
					path="/admin/storage"
					element={
						<ProtectedRoute requiredPermission="admin_access">
							<StorageExplorer />
						</ProtectedRoute>
					}
				/>

				{/* Calendar & Tasks (standalone pixel layout, like Storage) */}
				<Route
					path="/admin/calendar"
					element={
						<ProtectedRoute requiredPermission="admin_access">
							<CalendarPage />
						</ProtectedRoute>
					}
				/>
				<Route
					path="/admin/tasks"
					element={
						<ProtectedRoute requiredPermission="admin_access">
							<TasksPage />
						</ProtectedRoute>
					}
				/>
			</Routes>
		</BrowserRouter>
	);
}

function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<AppContent />
		</QueryClientProvider>
	);
}

export default App;
