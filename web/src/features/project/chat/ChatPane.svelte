<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getChatStore } from "../../../stores/chat.svelte";
  import type { ChatSession } from "../../../types/chat";
  import ChatFeed from "./ChatFeed.svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import Composer from "./Composer.svelte";

  let { sessionId, active, branch, onSession }: {
    sessionId: string; active: boolean; branch?: string; onSession?: (session: ChatSession) => void;
  } = $props();
  const chat = getChatStore(untrack(() => sessionId));

  $effect(() => chat.setActive(active));
  $effect(() => { if (chat.session) onSession?.({ ...chat.session }); });
  onMount(() => () => chat.setActive(false));
</script>

<section class="chat-pane" class:active>
  <ChatHeader session={chat.session} {branch} connected={chat.connected} reconnecting={chat.reconnecting} />
  <ChatFeed feed={chat.feed}
    permission={(id, behavior, always, message) => chat.respondPermission(id, behavior, always, message)}
    question={(id, answers) => chat.respondQuestion(id, answers)} />
  <Composer session={chat.session} status={chat.status} connected={chat.connected}
    send={(text) => chat.send(text)} setOptions={(options) => chat.setOptions(options)}
    interrupt={() => chat.interrupt()} />
</section>
