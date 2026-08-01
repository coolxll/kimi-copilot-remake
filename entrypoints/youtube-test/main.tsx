import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ExtractorTestApp } from "../../src/ui/youtube-test/App";

createRoot(document.getElementById("root")!).render(<StrictMode><ExtractorTestApp /></StrictMode>);
