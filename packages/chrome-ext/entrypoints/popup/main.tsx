import { render } from "solid-js/web";

// Dashboard's Tailwind v4 base — must come before the popup's local style.css so
// the local file (and the dashboard's per-component classes) compile against
// the right token palette + utilities.
import "dashboard/styles.css";
import "./style.css";
import App from "./App";

render(() => <App />, document.getElementById("root")!);
