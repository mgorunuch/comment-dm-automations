import { describe, expect, test } from "bun:test";
import { selectHandlers, selectedHandlers } from "../src/workflows/core/selection";
import { HANDLER_GROUPS } from "../src/workflows/groups";
import { WORKFLOWS } from "../src/workflows/index";

const pick = (spec: string | string[] | undefined, groups = HANDLER_GROUPS) =>
  selectedHandlers(WORKFLOWS, selectHandlers(spec, WORKFLOWS, groups)).map((p) => `${p.workflow.name}:${p.states.join("|")}`);

const ALL = ["receive_dm_comment:comment_received|dm_sent", "direct_message_after_comment:awaiting_email|email_received"];

describe("selectHandlers", () => {
  test("no selectors, an empty string and * select every handler", () => {
    expect(pick(undefined)).toEqual(ALL);
    expect(pick("")).toEqual(ALL);
    expect(pick("*")).toEqual(ALL);
  });

  test("a workflow name selects all its handlers", () => {
    expect(pick("receive_dm_comment")).toEqual(["receive_dm_comment:comment_received|dm_sent"]);
    expect(pick("receive_dm_comment:*")).toEqual(["receive_dm_comment:comment_received|dm_sent"]);
  });

  test("workflow:state selects one handler", () => {
    expect(pick("direct_message_after_comment:email_received")).toEqual(["direct_message_after_comment:email_received"]);
  });

  test("*:state selects that state in every workflow that handles it", () => {
    expect(pick("*:awaiting_email")).toEqual(["direct_message_after_comment:awaiting_email"]);
  });

  test("comma-separated and repeated selectors are combined", () => {
    expect(pick("receive_dm_comment:dm_sent,direct_message_after_comment:email_received")).toEqual([
      "receive_dm_comment:dm_sent",
      "direct_message_after_comment:email_received",
    ]);
    expect(pick(["receive_dm_comment:dm_sent", "direct_message_after_comment:email_received"])).toEqual([
      "receive_dm_comment:dm_sent",
      "direct_message_after_comment:email_received",
    ]);
  });

  test("! excludes, after all includes", () => {
    expect(pick("*,!direct_message_after_comment")).toEqual(["receive_dm_comment:comment_received|dm_sent"]);
    expect(pick("!receive_dm_comment:dm_sent")).toEqual([
      "receive_dm_comment:comment_received",
      "direct_message_after_comment:awaiting_email|email_received",
    ]);
  });

  test("@group expands to the group's selectors", () => {
    expect(pick("@comments")).toEqual(["receive_dm_comment:comment_received|dm_sent"]);
    expect(pick("@direct-messages")).toEqual(["direct_message_after_comment:awaiting_email|email_received"]);
    expect(pick("@reply-validation,@confirmations")).toEqual(["direct_message_after_comment:awaiting_email|email_received"]);
  });

  test("groups can include other groups", () => {
    const groups = { ...HANDLER_GROUPS, everything: ["@comments", "@direct-messages"] };
    expect(pick("@everything", groups)).toEqual(ALL);
  });

  test("the built-in groups together cover every handler, so no work is left without a role", () => {
    expect(pick(Object.keys(HANDLER_GROUPS).map((g) => `@${g}`))).toEqual(ALL);
  });

  test.each([
    ["no_such_workflow", /Unknown workflow "no_such_workflow"/],
    ["receive_dm_comment:no_such_state", /has no handler for state "no_such_state"/],
    ["receive_dm_comment:completed", /has no handler for state "completed"/],
    ["*:no_such_state", /No workflow has a handler for state "no_such_state"/],
    ["@no_such_group", /Unknown handler group "@no_such_group"/],
    ["a:b:c", /Invalid handler selector/],
  ])("%p is rejected at startup", (spec, error) => {
    expect(() => selectHandlers(spec, WORKFLOWS, HANDLER_GROUPS)).toThrow(error);
  });

  test("a group that includes itself is rejected", () => {
    expect(() => selectHandlers("@loop", WORKFLOWS, { loop: ["@loop"] })).toThrow(/includes itself/);
  });
});
