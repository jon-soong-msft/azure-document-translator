/**
 * Server-only feature flag for the evaluation report.
 *
 * Kept separate from `evaluation.ts` (which is imported by client components)
 * so no `process.env` access leaks into the client bundle. Evaluation is a
 * platform-level toggle: on by default, set EVALUATION_ENABLED=false to hide
 * the feature entirely.
 */

export function isEvaluationEnabled(): boolean {
  const value = process.env.EVALUATION_ENABLED;
  if (value == null || value.trim() === "") return true; // default on
  return !/^(0|false|no|off)$/i.test(value.trim());
}
