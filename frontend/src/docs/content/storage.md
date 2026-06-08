# File Storage

The `storage` app is an S3-compatible object store fronted by a CDN. Uploads and
downloads go **directly** between the client and storage using presigned URLs — the
backend signs, it does not proxy the bytes.

## Capabilities

- List objects and folders
- Presigned upload and download URLs
- Delete an object or a folder (recursively)
- Bulk delete and bulk move/rename
- Bundle multiple objects into a zip for download

Storage is configured at runtime in the **Services** dashboard (endpoint, bucket,
region, CDN host).

## Upload flow

1. The client requests a presigned upload URL.
2. The client uploads the file bytes straight to storage.
3. The object is immediately served from the CDN.

The mobile app uses `expo-document-picker` and uploads directly to the presigned
URL.

## Download / open

A short-lived presigned URL (≈1 hour) is used to open or download an object.

## Browsers

- **Web** — the `/storage` route renders a pixel-styled object explorer with folder
  navigation, bulk select, signed URLs, and CDN delivery. Hooks: `useStorageList`,
  `useStorageUpload`, `useStorageSignedUrl`, `useStorageDeleteObject`,
  `useStorageDeleteFolder`, `useStorageBulkDelete`, `useStorageZip`.
- **Mobile** — the Storage screen offers breadcrumb folder browsing, type icons,
  upload, rename/move/delete, create-folder, folder sharing, and zip download.

Folders can be shared publicly — see **Sharing**.
