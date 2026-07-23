<script lang="ts">
  import type { ChatQuestion } from "../../../types/chat";

  let { questions, resolved, respond }: {
    questions: ChatQuestion[];
    resolved?: string;
    respond: (answers: Record<string, string[]>) => void;
  } = $props();
  let selected = $state<Record<string, string[]>>({});
  let other = $state<Record<string, string>>({});

  function pick(question: ChatQuestion, label: string): void {
    const current = selected[question.question] ?? [];
    selected[question.question] = question.multiSelect
      ? current.includes(label) ? current.filter(item => item !== label) : [...current, label]
      : [label];
  }

  function submit(): void {
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      answers[question.question] = [...(selected[question.question] ?? []), other[question.question]?.trim()]
        .filter((answer): answer is string => !!answer);
    }
    respond(answers);
  }

  const complete = $derived(questions.every(question =>
    (selected[question.question]?.length ?? 0) > 0 || !!other[question.question]?.trim()));
</script>

<div class="question-card">
  {#each questions as question (question.question)}
    <fieldset>
      <legend><span>{question.header}</span>{question.question}</legend>
      <div class="question-options">
        {#each question.options as option (option.label)}
          <button class:on={selected[question.question]?.includes(option.label)}
            title={option.description} onclick={() => pick(question, option.label)}>{option.label}</button>
        {/each}
      </div>
      <input placeholder="Other…" aria-label={`Other answer for ${question.header}`}
        value={other[question.question] ?? ""}
        oninput={(event) => other[question.question] = event.currentTarget.value} />
    </fieldset>
  {/each}
  {#if resolved}
    <div class="request-resolved">{resolved}</div>
  {:else}
    <button class="question-submit" disabled={!complete} onclick={submit}>Submit answer</button>
  {/if}
</div>
