import { mount } from "svelte";
import "./app.css";
import "@xterm/xterm/css/xterm.css";
import App from "./App.svelte";

const saved = localStorage.getItem("cc-theme");
document.documentElement.setAttribute("data-theme", saved === "crimson" || saved === "aero" ? saved : "");

export default mount(App, { target: document.getElementById("app")! });
