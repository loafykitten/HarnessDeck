<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getChatStore } from "../../../stores/chat.svelte";
  import { getChatDraft } from "../../../stores/chatSessions.svelte";
  import type { ChatSession } from "../../../types/chat";
  import ChatFeed from "./ChatFeed.svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import Composer from "./Composer.svelte";

  let { project, session, active, branch }: {
    project: string; session: ChatSession; active: boolean; branch?: string;
  } = $props();
  const chat = getChatStore(untrack(() => session));
  const draft = getChatDraft(chat.sessionId);
  /** When drilled into a subagent, the composer yields its space to the view. */
  let viewingAgent = $state<string | null>(null);

  $effect(() => chat.setActive(active));
  onMount(() => () => chat.setActive(false));
</script>

<section class="chat-pane" class:active>
  <ChatHeader session={chat.session} {branch} connected={chat.connected} reconnecting={chat.reconnecting} />
  <ChatFeed feed={chat.feed} harness={chat.session.harness} bind:viewing={viewingAgent}
    permission={(id, behavior, always, message) => chat.respondPermission(id, behavior, always, message)}
    question={(id, answers) => chat.respondQuestion(id, answers)} />
  {#if !viewingAgent}
    <Composer {project} {draft} session={chat.session} status={chat.status} connected={chat.connected}
      attachments={chat.attachments} uploadingImages={chat.uploadingImages}
      attachmentError={chat.attachmentError}
      attachImage={(blob) => chat.attachImage(blob)} removeAttachment={(path) => chat.removeAttachment(path)}
      send={(text) => chat.send(text)} setOptions={(options) => chat.setOptions(options)}
      interrupt={() => chat.interrupt()} />
  {/if}
</section>
