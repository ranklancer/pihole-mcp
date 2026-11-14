/**
 * One-line, model-readable summary of a failed argument parse, e.g.
 * `Invalid arguments: action: Invalid enum value...; domain: Required`.
 * Uses only `issues[].path` and `.message`, which are the same in zod 3 and 4.
 */
export function formatArgIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const parts = error.issues.map(i => {
    const where = i.path.map(String).join('.');
    return where ? `${where}: ${i.message}` : i.message;
  });
  return `Invalid arguments: ${parts.join('; ')}`;
}

