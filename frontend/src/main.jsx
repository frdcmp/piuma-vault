import "@ant-design/v5-patch-for-react-19";
import "./utils/dayjsConfig";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
