<script lang="ts">
  import { untrack } from "svelte";
  import type { ChatFeedItem } from "../../../types/chat";
  import ApprovalCard from "./ApprovalCard.svelte";
  import Markdown from "./Markdown.svelte";
  import QuestionCard from "./QuestionCard.svelte";
  import ToolCard from "./ToolCard.svelte";

  let { item, permission, question, agentLabel = "Claude" }: {
    item: ChatFeedItem;
    permission: (id: string, behavior: "allow" | "deny", always?: boolean, message?: string) => void;
    question: (id: string, answers: Record<string, string[]>) => void;
    agentLabel?: string;
  } = $props();
  let thinkingOpen = $state(untrack(() => item.type === "thinking" && !!item.streaming));
</script>

{#if item.type === "message"}
  <article class="chat-message {item.role}">
    <div class="message-role">{item.role === "user" ? "You" : agentLabel}</div>
    <Markdown text={item.text} />
  </article>
{:else if item.type === "thinking"}
  <details class="thinking-card" bind:open={thinkingOpen}>
    <summary>{item.streaming ? "Thinking…" : "Thinking"}</summary>
    <Markdown text={item.text} />
  </details>
{:else if item.type === "tool"}
  <ToolCard name={item.name} input={item.input} result={item.result} isError={item.isError} running={item.running} />
{:else if item.type === "permission"}
  <ApprovalCard toolName={item.toolName} input={item.input} resolved={item.resolved}
    respond={(behavior, always, message) => permission(item.requestId, behavior, always, message)} />
{:else if item.type === "question"}
  <QuestionCard questions={item.questions} resolved={item.resolved}
    respond={(answers) => question(item.requestId, answers)} />
{:else}
  <div class="chat-error">{item.message}</div>
{/if}
