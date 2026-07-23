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
    if (resolved) return;
    const current = selected[question.question] ?? [];
    selected[question.question] = question.multiSelect
      ? current.includes(label) ? current.filter(item => item !== label) : [...current, label]
      : [label];
  }

  function submit(): void {
    if (resolved) return;
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      answers[question.question] = [...(selected[question.question] ?? []), other[question.question]?.trim()]
        .filter((answer): answer is string => !!answer);
    }
    respond(answers);
  }

  function selectedPreviews(question: ChatQuestion): ChatQuestion["options"] {
    return question.options.filter(option =>
      option.preview !== undefined && selected[question.question]?.includes(option.label));
  }

  const complete = $derived(questions.every(question =>
    (selected[question.question]?.length ?? 0) > 0 || !!other[question.question]?.trim()));
</script>

<div class="question-card" class:resolved>
  {#each questions as question (question.question)}
    {@const previews = selectedPreviews(question)}
    <fieldset>
      <legend>
        <span class="question-header">{question.header}</span>
        <span class="question-text">{question.question}</span>
        {#if question.multiSelect}<small>select all that apply</small>{/if}
      </legend>
      <div class="question-options">
        {#each question.options as option (option.label)}
          <button class:on={selected[question.question]?.includes(option.label)}
            disabled={!!resolved} onclick={() => pick(question, option.label)}>
            <span>{option.label}</span>
            <small>{option.description}</small>
          </button>
        {/each}
      </div>
      {#each previews as option (option.label)}
        {#if question.multiSelect && previews.length > 1}
          <div class="option-preview-label">{option.label}</div>
        {/if}
        <pre class="option-preview">{option.preview}</pre>
      {/each}
      {#if !resolved || other[question.question]}
        <input placeholder="Other…" aria-label={`Other answer for ${question.header}`}
          value={other[question.question] ?? ""} disabled={!!resolved}
          oninput={(event) => other[question.question] = event.currentTarget.value} />
      {/if}
    </fieldset>
  {/each}
  {#if resolved}
    <div class="request-resolved" class:dismissed={resolved === "dismissed"}>{resolved}</div>
  {:else}
    <button class="question-submit" disabled={!complete} onclick={submit}>Submit answer</button>
  {/if}
</div>
