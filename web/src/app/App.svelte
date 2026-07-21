<script lang="ts">
  import { app, startPolling } from "../stores/state.svelte";
  import { installHotkeys } from "../lib/hotkeys";
  import Rail from "./Rail.svelte";
  import NewsTicker from "../features/news/NewsTicker.svelte";
  import Dashboard from "../features/dashboard/Dashboard.svelte";
  import ProjectView from "../features/project/ProjectView.svelte";
  import ConfigView from "../features/config/ConfigView.svelte";
  import SkillsView from "../features/skills/SkillsView.svelte";

  startPolling();
  installHotkeys();
</script>

<div class="bg"></div>
<div class="orbs"><span class="orb o1"></span><span class="orb o2"></span><span class="orb o3"></span></div>
<div class="crt"></div>
<div class="crt-glow"></div>
<div class="grain"></div>

<Rail />

<main class="main">
  <div class="inner">
    <!-- outside the route {#if}: survives view switches, crawl never resets -->
    <NewsTicker />
    {#if app.route.view === "dash"}
      <section class="screen"><Dashboard /></section>
    {:else if app.route.view === "project"}
      {#key app.route.name}
        <section class="screen"><ProjectView project={app.route.name} /></section>
      {/key}
    {:else if app.route.view === "config"}
      <section class="screen"><ConfigView /></section>
    {:else if app.route.view === "skills"}
      <section class="screen"><SkillsView /></section>
    {/if}
  </div>
</main>

<footer class="hotkey-bar">
  <span><kbd>⌃1</kbd> dash</span>
  <span><kbd>⌃2</kbd> projects · again to cycle</span>
  <span><kbd>⌃3</kbd> skills</span>
  <span><kbd>⌃4</kbd> config</span>
  <span><kbd>⌃⇧[</kbd><kbd>⌃⇧]</kbd> session tabs</span>
</footer>
