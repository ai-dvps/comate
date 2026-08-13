import type { QuestionPayload } from '../types/message.js';

export type QuestionAnswerValidation =
  | { valid: true; answers: Record<string, string> }
  | { valid: false; error: string };

/** Validate answers against the pending server-side questions, never a client copy. */
export function validateQuestionAnswers(
  questions: QuestionPayload[],
  input: unknown,
): QuestionAnswerValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'answers must be an object for a question response' };
  }

  const answerRecord = input as Record<string, unknown>;
  const expectedKeys = new Set(questions.map((question) => question.question));
  if (
    Object.keys(answerRecord).length !== questions.length
    || Object.keys(answerRecord).some((key) => !expectedKeys.has(key))
  ) {
    return { valid: false, error: 'answers must contain one value for each pending question' };
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    const rawAnswer = answerRecord[question.question];
    if (typeof rawAnswer !== 'string' || rawAnswer.trim().length === 0) {
      return { valid: false, error: 'each pending question requires a non-empty string answer' };
    }

    const answer = rawAnswer.trim();
    if ((question.options?.length ?? 0) === 0) {
      answers[question.question] = answer;
      continue;
    }

    const allowed = new Set(question.options.map((option) => option.label));
    if (!question.multiSelect) {
      if (!allowed.has(answer)) {
        return { valid: false, error: 'single-choice answers must match one pending option' };
      }
      answers[question.question] = answer;
      continue;
    }

    const selections = answer.split(',').map((value) => value.trim()).filter(Boolean);
    if (
      selections.length === 0
      || new Set(selections).size !== selections.length
      || selections.some((selection) => !allowed.has(selection))
    ) {
      return { valid: false, error: 'multi-choice answers must contain unique pending options' };
    }
    answers[question.question] = selections.join(', ');
  }

  return { valid: true, answers };
}
