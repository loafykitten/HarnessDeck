import { mount } from "svelte";
import "./app/app.css";
import App from "./app/App.svelte";
import { getRenamedItem } from "./utils/storage";

const saved = getRenamedItem("hd-theme", "cc-theme");
document.documentElement.setAttribute("data-theme", saved === "crimson" || saved === "aero" ? saved : "");

export default mount(App, { target: document.getElementById("app")! });
