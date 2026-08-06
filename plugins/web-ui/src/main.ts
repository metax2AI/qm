import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { initializeLocale } from "./localization.ts";

async function main(): Promise<void> {
  await initializeLocale();
  await import("./app.ts");
}

void main();
