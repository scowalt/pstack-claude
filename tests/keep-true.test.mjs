// keep-true's check-outcome.sh, run for real against a local origin and a
// fake bb that records every thread it opens and every message it sends.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const archived = join(root, "archived");
const spawned = join(root, "spawned");
mkdirSync(bin);
writeFileSync(
  join(bin, "bb"),
  `#!/bin/sh
[ -e "${root}/bb-fails" ] && exit 1
{ echo "ARGS: $*"; cat; echo "---"; } >> "${told}"
if [ "$1 $2" = "thread tell" ] && grep -qx "$3" "${archived}" 2>/dev/null; then echo "Thread is archived" >&2; exit 1; fi
if [ "$1 $2" = "thread spawn" ]; then
  n=$(( $(cat "${spawned}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${spawned}"
  printf '{"id":"thr_repair%s","status":"starting","projectId":"proj_1","environment":{"id":"env_%s"}}\\n' "$n" "$n"
fi
exit 0
`,
);
chmodSync(join(bin, "bb"), 0o755);
const archive = (thread) => appendFileSync(archived, `${thread}\n`);

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

function check(extraEnv = {}) {
  rmSync(told, { force: true });
  const r = spawnSync("bash", [script], {
    cwd: clone,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      OUTCOME: "demo",
      BB_PROJECT_ID: "proj_1",
      BB_AUTOMATION_ID: "aut_1",
      KEEP_TRUE_STATE: join(root, "state"),
      ...extraEnv,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, told: existsSync(told) ? readFileSync(told, "utf8") : "" };
}

describe("check-outcome.sh", () => {
  test("stays silent while the proof passes, from its first run", () => {
    expect(check()).toMatchObject({ status: 0, out: "", err: "", told: "" });
  });

  test("opens one repair thread in the project when the proof starts failing, with its output", () => {
    publish('echo "parity gap: settings screen"; exit 3');
    const first = check();
    expect(first).toMatchObject({ status: 0, out: "opened thr_repair1: demo broke (exit 3)\n" });
    expect(first.told).toContain(
      "ARGS: thread spawn --project proj_1 --new-environment worktree --title keep-true: demo broke --json --prompt-file -",
    );
    expect(first.told).toContain("[keep-true] demo broke at origin/main");
    expect(first.told).toContain("Repair steps for .agents/outcomes/demo");
    expect(first.told).toContain("parity gap: settings screen");
    expect(check()).toMatchObject({ status: 0, out: "", told: "" });
  });

  test("tells the repair thread once when the proof passes again", () => {
    publish("echo ok");
    const first = check();
    expect(first).toMatchObject({ status: 0, out: "told thr_repair1: demo holds again\n" });
    expect(first.told).toContain("ARGS: thread tell thr_repair1 --mode auto --message-file -");
    expect(first.told).toContain("[keep-true] demo holds again at origin/main");
    expect(check()).toMatchObject({ status: 0, out: "", told: "" });
  });

  test("alerts and recovers after the setup thread is archived, as thr_3q6f6r2iya's was", () => {
    archive("thr_3q6f6r2iya");
    const setupThread = { KEEPER: "thr_3q6f6r2iya" };
    publish("exit 1");
    expect(check(setupThread)).toMatchObject({ status: 0, out: "opened thr_repair2: demo broke (exit 1)\n" });
    archive("thr_repair2");
    publish("echo ok");
    const recovered = check(setupThread);
    expect(recovered.status).toBe(0);
    expect(recovered.out).toContain("its repair thread thr_repair2 is gone");
    expect(check(setupThread)).toMatchObject({ status: 0, out: "", told: "" });
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

  test("fails the run and keeps the old state when bb cannot open the repair thread", () => {
    publish("echo ok");
    expect(check().status).toBe(0);
    publish("exit 2");
    writeFileSync(join(root, "bb-fails"), "");
    const failed = check();
    expect(failed.status).not.toBe(0);
    expect(failed.err).toContain("bb thread spawn failed");
    rmSync(join(root, "bb-fails"));
    expect(check().told).toContain("demo broke");
  });

  test("removes its temporary worktree", () => {
    expect(git(clone, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
