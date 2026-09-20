import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { encodeKittyPlaceholderGrid, encodeKittyVirtualPlacement } from "@oh-my-pi/pi-tui/kitty-graphics";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const imageId = 424242;
const placeholder = "\u{10eeee}";

if (process.argv.includes("--emit")) {
  const escape = "\u001b";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
  const kittyTransmit = `${escape}Ptmux;${escape}${escape}_Ga=t,f=100,i=${imageId},m=0,q=2;${png}${escape}${escape}\\${escape}\\`;
  const placement = encodeKittyVirtualPlacement({ imageId, placementId: 1, columns: 1, rows: 1 });
  const grid = encodeKittyPlaceholderGrid({ imageId, placementId: 1, columns: 1, rows: 1 });
  process.stdout.write(`${kittyTransmit}${placement}${grid.join("\n")}\n`);
  await Promise.withResolvers<void>().promise;
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const run = async (...args: string[]): Promise<string> => {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed:\n${stderr}`);
  return stdout;
};

const waitFor = async (check: () => Promise<boolean>, description: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
};

const tmux = Bun.which("tmux");
const python = Bun.which("python3");
assert(tmux !== null, "tmux is required");
assert(python !== null, "python3 is required to create the isolated tmux client PTY");

const directory = await mkdtemp(join(tmpdir(), "omp-hidden-image-"));
const socketDirectory = join(tmpdir(), "agent-tmux-sockets");
await mkdir(socketDirectory, { recursive: true });
const socket = join(socketDirectory, `${directory.slice(directory.lastIndexOf("/") + 1)}.sock`);
const session = "image-repro";
const currentFile = Bun.fileURLToPath(import.meta.url);
const tmuxArgs = (...args: string[]): string[] => [tmux!, "-S", socket, ...args];
const output: Uint8Array[] = [];
const errors: Uint8Array[] = [];
let client: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

try {
  await run(...tmuxArgs("-f", "/dev/null", "new-session", "-d", "-s", session, "-n", "visible", "sh"));
  await run(...tmuxArgs("set-option", "-g", "allow-passthrough", "on"));

  const attach = tmuxArgs("attach-session", "-t", session);
  const ptyBridge = `
import fcntl, os, pty, select, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
try:
    while True:
        ready, _, _ = select.select([master], [], [])
        if not ready:
            continue
        data = os.read(master, 65536)
        if not data:
            break
        os.write(1, data)
except OSError:
    pass
finally:
    process.terminate()
    process.wait()
`;
  client = Bun.spawn([python!, "-u", "-c", ptyBridge, ...attach], {
    env: { ...process.env, TERM: "xterm-256color" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const outputDone = (async () => {
    const reader = client!.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output.push(value);
    }
  })();
  const errorsDone = (async () => {
    const reader = client!.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      errors.push(value);
    }
  })();

  await waitFor(async () => {
    if (client!.exitCode !== null) {
      await Promise.all([outputDone, errorsDone]);
      const diagnostic = Buffer.concat([...output, ...errors].map((chunk) => Buffer.from(chunk))).toString("utf8");
      throw new Error(`PTY bridge exited before tmux attached (exit ${client!.exitCode})\n${diagnostic}`);
    }
    return (
      (await run(...tmuxArgs("list-clients", "-t", session, "-F", "#{client_tty}")).catch(() => "")).trim().length > 0
    );
  }, "tmux client");
  const clientTty = (await run(...tmuxArgs("list-clients", "-F", "#{client_tty}"))).trim();
  const bytesSince = (index: number): string =>
    Buffer.concat(output.slice(index).map((chunk) => Buffer.from(chunk))).toString("utf8");

  const hiddenStart = output.length;
  await run(...tmuxArgs("new-window", "-d", "-t", session, "-n", "hidden", "bun", currentFile, "--emit"));
  await waitFor(
    async () => (await run(...tmuxArgs("capture-pane", "-p", "-e", "-t", `${session}:hidden`))).includes(placeholder),
    "hidden pane placeholder",
  );
  const whileHidden = bytesSince(hiddenStart);

  const switchStart = output.length;
  await run(...tmuxArgs("switch-client", "-c", clientTty, "-t", `${session}:hidden`));
  await waitFor(async () => bytesSince(switchStart).includes(placeholder), "placeholder replay after window selection");
  const afterSwitch = bytesSince(switchStart);

  const visibleStart = output.length;
  await run(...tmuxArgs("new-window", "-t", session, "-n", "visible-image", "bun", currentFile, "--emit"));
  await waitFor(async () => bytesSince(visibleStart).includes(String(imageId)), "visible Kitty transmit");
  const whileVisible = bytesSince(visibleStart);

  assert(!whileHidden.includes(String(imageId)), "hidden window unexpectedly forwarded the Kitty transmit");
  assert(!afterSwitch.includes(String(imageId)), "tmux unexpectedly replayed the Kitty transmit");
  assert(afterSwitch.includes(placeholder), "tmux did not replay the retained placeholder");
  assert(whileVisible.includes(String(imageId)), "visible window did not forward the Kitty transmit");
  assert(whileVisible.includes(placeholder), "visible window did not forward the placeholder");

  const budget = new ImageBudget();
  budget.beginPass();
  const budgetImageId = budget.acquireId("repro-image");
  assert(budget.shouldTransmit(budgetImageId), "new OMP image should require transmission");
  budget.enqueueTransmit(budgetImageId, "image payload");
  assert(budget.takeTransmits().length === 1, "OMP should emit the initial payload");
  assert(!budget.shouldTransmit(budgetImageId), "OMP should consider the dropped payload transmitted");

  console.log("PASS: visible tmux window forwarded the Kitty transmit and placeholder");
  console.log("PASS: hidden tmux window retained the placeholder but did not forward the Kitty transmit");
  console.log("PASS: selecting the hidden window replayed the placeholder but not the Kitty transmit");
  console.log("PASS: OMP ImageBudget still considers the dropped transmit resident");
  console.log(
    "\nBUG REPRODUCED: the selected window has an unresolved image placeholder and OMP will not retransmit its data",
  );
} finally {
  if (client !== undefined) client.kill();
  await run(...tmuxArgs("kill-server")).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
