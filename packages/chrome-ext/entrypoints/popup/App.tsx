/**
 * Popup App — renders the shared dashboard with browser primitives.
 *
 * The old hardcoded UI is replaced by the dashboard package components
 * powered by Effect Atoms + the browser primitives layer.
 */
import { BrowserDashboard } from "./dashboard/index.tsx";

function App() {
  return <BrowserDashboard />;
}

export default App;
