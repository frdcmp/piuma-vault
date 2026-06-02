import "@ant-design/v5-patch-for-react-19";
import "./utils/dayjsConfig";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./index.css";
import App from "./App.jsx";
import { registerServiceWorker } from "./utils/webPush";

createRoot(document.getElementById("root")).render(<App />);

// Register the push service worker early so previously-granted subscriptions
// keep receiving notifications across reloads. No-op where unsupported.
registerServiceWorker().catch(() => {});
