import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AlarmHost from "./admin/components/alarm/AlarmHost";
import PageLayout from "./admin/components/layout/PageLayout";
import ProtectedRoute from "./admin/components/layout/ProtectedRoute";
import About from "./admin/pages/about";
import AgentsPage from "./admin/pages/agents/AgentsPage";
import ApiKeysPage from "./admin/pages/apiKeys";
import ApiTest from "./admin/pages/apiTest";
import Appearance from "./admin/pages/appearance";
import ForgotPassword from "./admin/pages/auth/forgotPassword";
import Login from "./admin/pages/auth/login";
import VerifyEmail from "./admin/pages/auth/verifyEmail";
import CalendarPage from "./admin/pages/calendar/CalendarPage";
import DbDump from "./admin/pages/dbDump";
import Files from "./admin/pages/files";
import Health from "./admin/pages/health";
import Homepage from "./admin/pages/homepage";
import Memory from "./admin/pages/memory";
import NoteEditor from "./admin/pages/notes/NoteEditor";
import NotesLayout from "./admin/pages/notes/NotesLayout";
import Profile from "./admin/pages/profile";
import Projects from "./admin/pages/projects";
import RecorderPage from "./admin/pages/recorder/RecorderPage";
import RecorderSessionsPage from "./admin/pages/recorder/RecorderSessionsPage";
import RecordingDetailPage from "./admin/pages/recorder/RecordingDetailPage";
import Security from "./admin/pages/security";
import Services from "./admin/pages/services";
import SharesPage from "./admin/pages/shares";
import StorageExplorer from "./admin/pages/storage/StorageExplorer";
import TasksPage from "./admin/pages/tasks/TasksPage";
import TokenUsage from "./admin/pages/token-usage/TokenUsage";
import TrashPage from "./admin/pages/trash";
import { queryClient } from "./api/queryClient";
import WorkspaceLayout from "./chat/WorkspaceLayout";
import PixelLoader from "./components/PixelLoader";
import { ScreenLockGate } from "./components/screenLock";
import SharedFolderPage from "./share/SharedFolderPage";
import SharedNotePage from "./share/SharedNotePage";
import { SpriteProvider } from "./sprites";

// Public docs site — code-split so it stays out of the main app bundle.
const DocsLayout = lazy(() => import("./docs/DocsLayout"));
const DocsPage = lazy(() => import("./docs/DocsPage"));

function AppContent() {
	return (
		<BrowserRouter
			basename={import.meta.env.BASE_URL}
			future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
		>
			<Routes>
				{/* Workspace pages (Notes, Storage, Tasks, Calendar) share ONE
				    persistent shell, so the WorkspaceHeader + ChatDock stay mounted and
				    the chat (incl. a live stream) survives navigation between them. The
				    shell is auth-gated; admin-only pages add their own admin_access check. */}
				<Route
					element={
						<ProtectedRoute requiredPermission={null}>
							<WorkspaceLayout />
						</ProtectedRoute>
					}
				>
					{/* Vault (notes) — served at /notes */}
					<Route
						path="/notes"
						element={
							<ProtectedRoute requiredPermission="admin_access">
								<NotesLayout />
							</ProtectedRoute>
						}
					>
						<Route path=":id" element={<NoteEditor />} />
					</Route>

					{/* Storage explorer */}
					<Route
						path="/storage"
						element={
							<ProtectedRoute requiredPermission={null}>
								<StorageExplorer />
							</ProtectedRoute>
						}
					/>

					{/* Tasks */}
					<Route
						path="/tasks"
						element={
							<ProtectedRoute requiredPermission={null}>
								<TasksPage />
							</ProtectedRoute>
						}
					/>

					{/* Calendar */}
					<Route
						path="/calendar"
						element={
							<ProtectedRoute requiredPermission="admin_access">
								<CalendarPage />
							</ProtectedRoute>
						}
					/>

					{/* Recorder → Transcriber → Summarizer */}
					<Route
						path="/recorder"
						element={
							<ProtectedRoute requiredPermission="admin_access">
								<RecorderPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/recorder/sessions"
						element={
							<ProtectedRoute requiredPermission="admin_access">
								<RecorderSessionsPage />
							</ProtectedRoute>
						}
					/>
					<Route
						path="/recorder/sessions/:id"
						element={
							<ProtectedRoute requiredPermission="admin_access">
								<RecordingDetailPage />
							</ProtectedRoute>
						}
					/>
				</Route>

				{/* App root redirects to the notes vault */}
				<Route path="/" element={<Navigate to="/notes" replace />} />

				{/* Public shared note viewer */}
				<Route path="/share/v/:slug" element={<SharedNotePage />} />

				{/* Public shared folder viewer */}
				<Route path="/s/:slug" element={<SharedFolderPage />} />

				{/* Public documentation site */}
				<Route
					path="/docs"
					element={
						<Suspense fallback={<PixelLoader />}>
							<DocsLayout />
						</Suspense>
					}
				>
					<Route index element={<Navigate to="overview" replace />} />
					<Route
						path=":slug"
						element={
							<Suspense fallback={<PixelLoader />}>
								<DocsPage />
							</Suspense>
						}
					/>
				</Route>

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
					<Route path="agents" element={<AgentsPage />} />
					<Route path="appearance" element={<Appearance />} />
					<Route path="memory" element={<Memory />} />
					<Route path="about" element={<About />} />
					<Route path="projects" element={<Projects />} />
					<Route path="files" element={<Files />} />
					<Route path="api-keys" element={<ApiKeysPage />} />
					<Route path="health" element={<Health />} />
					<Route path="profile" element={<Profile />} />
					<Route path="security" element={<Security />} />
					<Route path="services" element={<Services />} />
					<Route path="token-usage" element={<TokenUsage />} />
					<Route path="shares" element={<SharesPage />} />
					<Route path="trash" element={<TrashPage />} />
					<Route path="db-backups" element={<DbDump />} />
					<Route path="test" element={<ApiTest />} />
				</Route>

				{/* Old vault paths — keep redirects so existing links still work */}
				<Route path="/admin/notes" element={<Navigate to="/notes" replace />} />
				<Route
					path="/admin/notes/:id"
					element={<Navigate to="/notes" replace />}
				/>

				{/* Legacy /admin/* aliases for the workspace pages (now served under
				    the shared WorkspaceLayout above). */}
				<Route
					path="/admin/storage"
					element={<Navigate to="/storage" replace />}
				/>
				<Route path="/admin/tasks" element={<Navigate to="/tasks" replace />} />
				<Route
					path="/admin/calendar"
					element={<Navigate to="/calendar" replace />}
				/>
			</Routes>
			{/* Loud, must-dismiss in-app alarm — rings when an alert fires while
			    the app is open (the OS notification covers the closed-tab case). */}
			<AlarmHost />
			{/* Idle screen lock — blocks the whole app after inactivity. */}
			<ScreenLockGate />
		</BrowserRouter>
	);
}

function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<SpriteProvider>
				<AppContent />
			</SpriteProvider>
		</QueryClientProvider>
	);
}

export default App;
