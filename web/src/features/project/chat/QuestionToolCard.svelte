<script lang="ts">
  import { asRecord } from "../../../lib/tools";

  /* The AskUserQuestion tool call, rendered as questions and answers instead
     of its raw JSON payload. The interactive prompt is the QuestionCard (from
     the live question_request); this row is the record of what was asked and
     chosen — the only trace after rehydration, where requests aren't replayed. */

  let { input, result, isError, running }: {
    input?: unknown; result?: unknown; isError?: boolean; running: boolean;
  } = $props();

  type Asked = { header: string; question: string };
  const questions = $derived.by((): Asked[] => {
    const list = asRecord(input)?.questions;
    if (!Array.isArray(list)) return [];
    return list.flatMap(entry => {
      const record = asRecord(entry);
      return typeof record?.question === "string"
        ? [{ question: record.question, header: typeof record.header === "string" ? record.header : "" }]
        : [];
    });
  });

  // The result is prose: `Your questions have been answered: "Q"="A", …`.
  // Lift the pairs out; anything unparseable falls back to the raw text.
  const answers = $derived.by(() => {
    if (typeof result !== "string") return new Map<string, string>();
    return new Map([...result.matchAll(/"([^"]+)"="([^"]*)"/g)].map(match => [match[1], match[2]]));
  });
  const unparsed = $derived(
    typeof result === "string" && result && answers.size === 0 ? result : null);

  const arg = $derived(questions.length === 0 ? ""
    : questions.length === 1 ? questions[0].question
    : `${questions[0].question} +${questions.length - 1} more`);
</script>

<details class="tool-row" class:error={isError} class:running data-kind="question">
  <summary>
    <span class="tool-glyph">?</span>
    <b class="tool-name">Question</b>
    <span class="tool-arg">{arg}</span>
    {#if running}
      <span class="tool-live" aria-label="waiting for answer"></span>
    {:else if isError}
      <span class="tool-bad" aria-label="failed">×</span>
    {/if}
  </summary>
  <div class="qa-list">
    {#each questions as asked (asked.question)}
      {@const answer = answers.get(asked.question)}
      <div class="qa-item">
        {#if asked.header}<span class="qa-header">{asked.header}</span>{/if}
        <span class="qa-question">{asked.question}</span>
        {#if answer !== undefined}
          <span class="qa-answer">{answer}</span>
        {:else if running}
          <span class="qa-answer pending">waiting…</span>
        {/if}
      </div>
    {/each}
    {#if unparsed}<pre class:tool-result={!isError}>{unparsed}</pre>{/if}
  </div>
</details>
