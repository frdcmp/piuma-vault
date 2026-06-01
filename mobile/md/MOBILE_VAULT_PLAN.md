# Mobile Vault App Plan

## Overview
A mobile companion app for the pv-vault notes system. It will sync with the Rust/PostgreSQL backend and allow users to view, create, edit, and search their markdown notes. It will be built using Expo and React Native.

## Features
- **Authentication**: JWT-based authentication with the backend.
- **Notes List**: View all notes with search functionality.
- **Note Editor**: Edit notes using Markdown.
- **Offline Support**: Cache notes locally for offline viewing/editing using AsyncStorage and React Query Persist.
- **Sync**: Background/foreground sync with the server.

## Tech Stack
- **Framework**: React Native with Expo
- **Navigation**: React Navigation (Native Stack)
- **State Management**: Zustand
- **Data Fetching/Caching**: TanStack React Query with AsyncStorage persistence
- **Markdown Rendering**: `marked` (or custom component if needed)
- **Network**: Axios
- **Secure Storage**: `expo-secure-store` for auth tokens.

## Architecture & Folder Structure
```text
mobile/
  assets/           # Images, fonts, etc.
  src/
    api/            # API communication logic (axios instance, auth, notes)
    components/     # Reusable UI components (NoteCard, Button, Input)
    navigation/     # React Navigation setup
    screens/        # Main app screens (Login, NoteList, NoteEditor)
    stores/         # Zustand stores (Auth, Theme)
    utils/          # Helper functions (date formatting, etc.)
  App.js            # Entry point
```

## Step-by-Step Implementation

1.  **Setup & Configuration**:
    - [x] Create Expo app (`mobile` folder).
    - [x] Install dependencies (`@react-navigation/native`, `@react-navigation/native-stack`, `axios`, `@tanstack/react-query`, `zustand`, etc.).
    - [ ] Configure `app.json` for vault-specific settings.

2.  **Authentication**:
    - [ ] Implement `src/api/auth.js` for login.
    - [ ] Create Zustand store for auth state (`src/stores/authStore.js`).
    - [ ] Build Login screen (`src/screens/LoginScreen.js`).
    - [ ] Setup secure storage for tokens.

3.  **Navigation**:
    - [ ] Configure Stack Navigator.
    - [ ] Create auth flow (Login vs. Main App).

4.  **Notes API & Data Management**:
    - [ ] Implement `src/api/notesApi.js` (fetch, create, update, delete).
    - [ ] Configure React Query with persistent client (`src/utils/queryClient.js`).

5.  **UI/Screens**:
    - [ ] **NoteListScreen**: Fetch and display notes. Add search bar.
    - [ ] **NoteEditorScreen**: Markdown input and preview. Save functionality.

6.  **Polishing**:
    - [ ] Styling (Bosidian/Obsidian style - dark mode preferred).
    - [ ] Error handling and loading states.
    - [ ] Offline sync logic refinement.
