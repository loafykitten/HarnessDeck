<script lang="ts">
  import { app, startPolling } from "./lib/state.svelte";
  import { installHotkeys } from "./lib/hotkeys";
  import Rail from "./components/Rail.svelte";
  import Dashboard from "./components/Dashboard.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import ConfigView from "./components/ConfigView.svelte";
  import SkillsView from "./components/SkillsView.svelte";

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
