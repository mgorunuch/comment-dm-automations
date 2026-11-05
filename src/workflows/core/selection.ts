import type { WorkflowDefinition } from "./engine";

/** Decides whether this worker instance runs the handler for `state` of `workflow`. */
export type HandlerSelection = (workflow: string, state: string) => boolean;

/** Named lists of selectors, so a machine can be given a role with one word (e.g. "@comments"). */
export type HandlerGroups = Readonly<Record<string, readonly string[]>>;

export const ALL_HANDLERS: HandlerSelection = () => true;

/**
 * Build a HandlerSelection from selectors. Each entry may itself be a comma-separated list.
 *
 *   *                 every handler
 *   workflow          every handler of one workflow
 *   workflow:state    one handler
 *   *:state           that state in every workflow
 *   @group            the selectors of a named group
 *   !selector         exclude (applied after all includes), e.g. "*,!direct_message_after_comment"
 *
 * Unknown workflows, states and groups throw, so a typo cannot silently leave work unhandled.
 * An empty spec selects everything.
 */
export function selectHandlers(
  spec: string | readonly string[] | undefined,
  workflows: readonly WorkflowDefinition[],
  groups: HandlerGroups = {},
): HandlerSelection {
  const entries = (typeof spec === "string" ? [spec] : (spec ?? []))
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return ALL_HANDLERS;

  const byName = new Map(workflows.map((w) => [w.name, w]));
  type Matcher = (workflow: string, state: string) => boolean;

  const expand = (selector: string, seen: ReadonlySet<string>): Matcher[] => {
    if (selector.startsWith("@")) {
      const name = selector.slice(1);
      const group = groups[name];
      if (!group) throw new Error(`Unknown handler group "@${name}". Known: ${Object.keys(groups).map((g) => `@${g}`).join(", ") || "none"}`);
      if (seen.has(name)) throw new Error(`Handler group "@${name}" includes itself`);
      return group.flatMap((s) => expand(s, new Set([...seen, name])));
    }
    if (selector === "*") return [() => true];
    const [workflow, state, extra] = selector.split(":");
    if (extra !== undefined || !workflow) throw new Error(`Invalid handler selector "${selector}"`);
    if (workflow === "*") {
      if (!state || state === "*") return [() => true];
      if (!workflows.some((w) => w.handlers[state])) throw new Error(`No workflow has a handler for state "${state}"`);
      return [(_w, s) => s === state];
    }
    const def = byName.get(workflow);
    if (!def) throw new Error(`Unknown workflow "${workflow}". Known: ${[...byName.keys()].join(", ")}`);
    if (!state || state === "*") return [(w) => w === workflow];
    if (!def.handlers[state]) {
      throw new Error(`Workflow "${workflow}" has no handler for state "${state}". Handled states: ${Object.keys(def.handlers).join(", ")}`);
    }
    return [(w, s) => w === workflow && s === state];
  };

  const include = entries.filter((e) => !e.startsWith("!")).flatMap((e) => expand(e, new Set()));
  const exclude = entries.filter((e) => e.startsWith("!")).flatMap((e) => expand(e.slice(1), new Set()));
  const included: Matcher = include.length === 0 ? () => true : (w, s) => include.some((m) => m(w, s));
  return (w, s) => included(w, s) && !exclude.some((m) => m(w, s));
}

/** The handlers a selection picks, per workflow (workflows with none are left out). */
export function selectedHandlers(
  workflows: readonly WorkflowDefinition[],
  selection: HandlerSelection,
): { workflow: WorkflowDefinition; states: string[] }[] {
  return workflows
    .map((workflow) => ({ workflow, states: Object.keys(workflow.handlers).filter((s) => selection(workflow.name, s)) }))
    .filter((p) => p.states.length > 0);
}
