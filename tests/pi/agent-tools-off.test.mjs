// pi agent tools: off leaves pstack's subagent tools and /pstack-agents out; the rest of the extension is unchanged.
import { expect, test } from "bun:test";

import { useWorld } from "./harness.mjs";

const setup = useWorld();
const registered = (sheet) => {
  const { pi } = setup({ sheet });
  return { tools: [...pi.tools.keys()], commands: [...pi.commands.keys()] };
};
const only = (a, b) => a.filter((name) => !b.includes(name)).sort();

test("pi agent tools: off drops exactly the four agent tools and /pstack-agents", () => {
  const on = registered("bug-fix: opus\n");
  const off = registered("bug-fix: opus\npi agent tools: off\n");
  expect(only(on.tools, off.tools)).toEqual(["agent", "list_agents", "send_message", "stop_agent"]);
  expect(only(on.commands, off.commands)).toEqual(["pstack-agents"]);
  expect(only(off.tools, on.tools)).toEqual([]);
  expect(only(off.commands, on.commands)).toEqual([]);
});

// A Wonderbase (T3 Code fork) thread starts subagents with T3's delegate_task, which makes a child
// thread the sidebar shows; a pstack pi child process would be invisible there.
test("a Wonderbase thread leaves subagents to delegate_task", () => {
  const { pi } = setup({ settings: { t3ThreadId: "thread-1" } });
  for (const name of ["agent", "list_agents", "send_message", "stop_agent"]) expect(pi.tools.has(name)).toBe(false);
  expect(pi.commands.has("pstack-agents")).toBe(false);
  expect(pi.tools.has("schedule_wakeup")).toBe(true);
});
