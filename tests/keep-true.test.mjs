// keep-true's check-outcome.sh, run for real against a local origin and a
// fake bb that records every message it is asked to send.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../plugins/pstack/skills/keep-true/scripts/check-outcome.sh", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pstack-keep-true-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const bin = join(root, "bin");
const told = join(root, "told.log");
mkdirSync(bin);
writeFileSync(
  join(bin, "bb"),
  `#!/bin/sh\n[ -e "${root}/bb-fails" ] && exit 1\n{ echo "ARGS: $*"; cat; echo "---"; } >> "${told}"\n`,
);
chmodSync(join(bin, "bb"), 0o755);

const origin = join(root, "origin.git");
const work = join(root, "work");
const clone = join(root, "clone");
git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
git(root, "clone", "--quiet", origin, work);
for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) git(work, "config", k, v);

function publish(proofBody) {
  const dir = join(work, ".agents/outcomes/demo");
  if (proofBody === null) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proof"), `#!/bin/sh\n${proofBody}\n`);
    chmodSync(join(dir, "proof"), 0o755);
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "change");
  git(work, "push", "--quiet", "origin", "HEAD:main");
}

publish("echo ok");
git(root, "clone", "--quiet", origin, clone);

function check() {
  rmSync(told, { force: true });
  const r = spawnSync("bash", [script], {
    cwd: clone,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      OUTCOME: "demo",
      KEEPER: "thr_keeper",
      BB_AUTOMATION_ID: "aut_1",
      KEEP_TRUE_STATE: join(root, "state"),
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, told: existsSync(told) ? readFileSync(told, "utf8") : "" };
}

describe("check-outcome.sh", () => {
  test("stays silent while the proof passes", () => {
    expect(check()).toMatchObject({ status: 0, out: "", told: "" });
  });

  test("tells the keeper once when the proof starts failing, with its output", () => {
    publish('echo "parity gap: settings screen"; exit 3');
    const first = check();
    expect(first).toMatchObject({ status: 0, out: "told thr_keeper: demo broke (exit 3)\n" });
    expect(first.told).toContain("ARGS: thread tell thr_keeper --mode auto --message-file -");
    expect(first.told).toContain("[keep-true] demo broke at origin/main");
    expect(first.told).toContain("parity gap: settings screen");
    expect(check()).toMatchObject({ status: 0, out: "", told: "" });
  });

  test("tells the keeper once when the proof passes again", () => {
    publish("echo ok");
    const first = check();
    expect(first.status).toBe(0);
    expect(first.told).toContain("[keep-true] demo holds again at origin/main");
    expect(check()).toMatchObject({ status: 0, out: "", told: "" });
  });

  test("checks the remote default branch, not the clone's working tree", () => {
    writeFileSync(join(clone, ".agents/outcomes/demo/proof"), "#!/bin/sh\nexit 1\n");
    expect(check()).toMatchObject({ status: 0, told: "" });
    git(clone, "checkout", "--quiet", "--", ".");
  });

  test("treats a missing proof as a break", () => {
    publish(null);
    const r = check();
    expect(r.told).toContain("demo broke");
    expect(r.told).toContain(".agents/outcomes/demo/proof is missing or not executable");
  });

  test("fails the run and keeps the old state when bb cannot deliver the message", () => {
    publish("echo ok");
    writeFileSync(join(root, "bb-fails"), "");
    const failed = check();
    expect(failed.status).not.toBe(0);
    expect(failed.err).toContain("bb thread tell thr_keeper failed");
    rmSync(join(root, "bb-fails"));
    expect(check().told).toContain("demo holds again");
  });

  test("removes its temporary worktree", () => {
    expect(git(clone, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
