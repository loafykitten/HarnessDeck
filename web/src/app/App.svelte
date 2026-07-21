<script lang="ts">
  import { app, startPolling } from "../stores/state.svelte";
  import { installHotkeys } from "../lib/hotkeys";
  import Rail from "./Rail.svelte";
  import NewsTicker from "../features/news/NewsTicker.svelte";
  import Dashboard from "../features/dashboard/Dashboard.svelte";

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
        {#await import("../features/project/ProjectView.svelte") then ProjectView}
          <section class="screen fill"><ProjectView.default project={app.route.name} /></section>
        {/await}
      {/key}
    {:else if app.route.view === "config"}
      {#await import("../features/config/ConfigView.svelte") then ConfigView}
        <section class="screen"><ConfigView.default /></section>
      {/await}
    {:else if app.route.view === "skills"}
      {#await import("../features/skills/SkillsView.svelte") then SkillsView}
        <section class="screen"><SkillsView.default /></section>
      {/await}
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
