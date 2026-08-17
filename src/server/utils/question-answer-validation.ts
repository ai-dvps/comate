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

    // AskUserQuestion always provides an Other choice, so answer values are
    // opaque user text rather than an enum constrained to the listed options.
    answers[question.question] = rawAnswer.trim();
  }

  return { valid: true, answers };
}
