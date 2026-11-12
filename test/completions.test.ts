import { describe, expect, test } from "bun:test";
import { CompletionModel, type CompletionTimers } from "../src/completions";
import { createClient, type Transport, type ZetaRole } from "@fulcrum/zeta";
import { createCommandController, createUnavailableCommandController, type CommandController, type CommandRequest, type CompletionRow } from "../src/commands";
import { createWriteClient } from "../src/write-client";

const rows: CompletionRow[] = [
  { trigger: "/", name: "status", description: "show status", sourceBadge: "builtin" },
  { trigger: "/", name: "story", description: "write story", sourceBadge: "project" },
];

function controller(reply: (value: string) => Promise<CompletionRow[]> = async () => rows): CommandController {
  return { prepareComposerInput: async (text) => ({ kind: "send", text }), completions: reply, refreshCatalog: async () => {} };
}

async function opened(value = "/st") {
  const model = new CompletionModel(controller());
  model.update(value, value.length);
  await Promise.resolve();
  return model;
}

test("one snapshot owns rows, wrapping, escape, and keyboard acceptance", async () => {
  const model = await opened();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 0 });
  expect(model.key("ArrowUp").handled).toBe(true);
  expect(model.getSnapshot().activeIndex).toBe(1);
  expect(model.key("ArrowDown").handled).toBe(true);
  expect(model.key("Tab")).toEqual({ handled: true, accepted: { value: "/status ", caret: 8 } });
  expect(model.getSnapshot().open).toBe(false);

  model.update("/st", 3);
  await Promise.resolve();
  expect(model.key("Escape")).toEqual({ handled: true });
  expect(model.getSnapshot().open).toBe(false);
});

test("slash insertion preserves existing separators and text after the caret", async () => {
  const model = await opened("/st next");
  model.update("/st next", 3);
  await Promise.resolve();
  expect(model.key("Enter").accepted).toEqual({ value: "/status next", caret: 7 });
});

test("dollar insertion replaces only the active token and always includes its trailing space", async () => {
  const skill = [{ ...rows[0], trigger: "$" as const, name: "review" }];
  const model = new CompletionModel(controller(async () => skill));
  model.update("ask $re later", 7);
  await Promise.resolve();
  expect(model.choose(0)).toEqual({ value: "ask $review later", caret: 11 });
});

test("selection and ime leave normal textarea behavior untouched", async () => {
  const model = await opened();
  expect(model.key("Enter", true)).toEqual({ handled: false });
  model.update("/st", 0, 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("stale catalog replies cannot reopen a changed token", async () => {
  let resolve!: (rows: CompletionRow[]) => void;
  const model = new CompletionModel(controller(() => new Promise((done) => { resolve = done; })));
  model.update("/st", 3);
  model.update("ordinary text", 13);
  resolve(rows);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("pointer acceptance uses the chosen row without changing focus itself", async () => {
  const model = await opened();
  expect(model.choose(1)).toEqual({ value: "/story ", caret: 7 });
  expect(model.getSnapshot().open).toBe(false);
});

test("escape stays closed when a select event repeats the same one-shot input", async () => {
  const model = await opened("/st");
  expect(model.key("Escape")).toEqual({ handled: true });
  model.select("/st", 3, 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  model.update("/sta", 4, 4);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(true);
});

test("shift+tab and shift+enter keep their normal meaning and never accept", async () => {
  for (const key of ["Tab", "Enter"]) {
    const model = await opened("/st");
    expect(model.key(key, false, true)).toEqual({ handled: false });
    expect(model.getSnapshot().open).toBe(false);
  }
});

test("a repeated select event keeps the active row", async () => {
  const model = await opened("/st");
  model.key("ArrowDown");
  model.select("/st", 3, 3);
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 1 });
});

test("a new command source answers the token being typed, but never reopens an Escape-closed menu", async () => {
  const model = new CompletionModel(controller(async () => []));
  model.update("/st", 3);
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  model.setController(controller(), { value: "/st", caret: 3 });
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ open: true, rows, activeIndex: 0 });

  expect(model.key("Escape")).toEqual({ handled: true });
  model.setController(controller(), { value: "/st", caret: 3 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);

  model.update("", 0);
  model.setController(controller(), { value: "", caret: 0 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
});

test("a new command source asks about the field's text, not the input before a submit cleared it", async () => {
  const model = new CompletionModel(controller(async () => []));
  model.update("/status", 7);
  await Promise.resolve();
  // The submit consumed the draft with no input event, so only the field knows it is empty now.
  const asked: string[] = [];
  model.setController(controller(async (value) => { asked.push(value); return rows; }), { value: "", caret: 0 });
  await Promise.resolve();
  expect(model.getSnapshot().open).toBe(false);
  expect(asked).toEqual([]);
});

describe("@path completion", () => {
  /** A fake clock for the model's timers: `advance` fires each due timer at its own time, then lets replies settle. */
  function fakeClock() {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; run(): void }>();
    const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
    const api: CompletionTimers = {
      setTimer(run, ms) { timers.set(++next, { at: now + ms, run }); return next; },
      clearTimer(timer) { timers.delete(timer as number); },
    };
    return {
      api,
      now: () => now,
      pending: () => timers.size,
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          timers.delete(due[0]);
          now = due[1].at;
          due[1].run();
          await settle();
        }
        now = end;
        await settle();
      },
    };
  }

  // Shaped like zeta 54b9f211 tests/test_server_path_completion.py:60-118 after @fulcrum/zeta turned code points into UTF-16 units.
  const folder: CompletionRow = { trigger: "@", text: '"😀 my folder/', display: '@"😀 my folder/', kind: "directory", startPosition: -3 };
  const file: CompletionRow = { trigger: "@", text: '"😀file name.txt"', display: '@"😀file name.txt"', kind: "file", startPosition: -3 };

  type Launch = { at: number; text: string; signal?: AbortSignal };
  function recorder(clock: ReturnType<typeof fakeClock>, reply: (text: string) => Promise<CompletionRow[]> = async () => [folder, file]) {
    const launches: Launch[] = [];
    const commands = controller(async (text, options) => { launches.push({ at: clock.now(), text, signal: options?.signal }); return reply(text); });
    return { launches, commands };
  }

  test("@ waits for 100 ms without input, then asks once with the newest text", async () => {
    const clock = fakeClock();
    const { launches, commands } = recorder(clock);
    const model = new CompletionModel(commands, clock.api);
    model.update("see @s", 6);
    await clock.advance(99);
    model.update("see @sr", 7);
    await clock.advance(99);
    expect(launches).toEqual([]);
    await clock.advance(1);
    expect(launches.map(({ at, text }) => ({ at, text }))).toEqual([{ at: 199, text: "see @sr" }]);
    expect(model.getSnapshot()).toEqual({ open: true, rows: [folder, file], activeIndex: 0 });
  });

  test("continuous typing never queues stale lookups and never starts more than 10 in any second", async () => {
    for (const gaps of [[50], [100], [99, 1, 100, 101, 0, 150], [100, 0, 100, 1]]) {
      const clock = fakeClock();
      const { launches, commands } = recorder(clock);
      const model = new CompletionModel(commands, clock.api);
      let text = "@";
      const at = new Map<number, string>();
      for (let index = 0; clock.now() < 3_000; index++) {
        text += "a";
        model.update(text, text.length);
        at.set(clock.now(), text);
        await clock.advance(gaps[index % gaps.length]!);
      }
      await clock.advance(1_000);
      for (const launch of launches) {
        // Each lookup carries the newest text at its launch: the last input before it (a timer due at an input's time fires first).
        const newest = [...at].filter(([time]) => time < launch.at).at(-1)![1];
        expect({ gaps, launch: launch.text }).toEqual({ gaps, launch: newest });
        expect(launches.filter((other) => other.at >= launch.at && other.at < launch.at + 1_000).length).toBeLessThanOrEqual(10);
      }
      expect(launches.at(-1)?.text).toBe(text);
      if (gaps[0] === 50) expect(launches.length).toBe(1);
    }
  });

  test("a newer input aborts the lookup in flight, and only the newest reply opens the list", async () => {
    const clock = fakeClock();
    const replies: Array<(rows: CompletionRow[]) => void> = [];
    const { launches, commands } = recorder(clock, () => new Promise((done) => replies.push(done)));
    const model = new CompletionModel(commands, clock.api);
    model.update("@sr", 3);
    await clock.advance(100);
    expect(launches.length).toBe(1);
    model.update("@src", 4);
    expect(launches[0]!.signal!.aborted).toBe(true);
    await clock.advance(100);
    replies[1]!([file]);
    await clock.advance(0);
    replies[0]!([folder]);
    await clock.advance(0);
    expect(model.getSnapshot().rows).toEqual([file]);
  });

  test("accepting a path keeps the suffix and adds no space; a directory continues with one lookup, a file closes", async () => {
    const clock = fakeClock();
    const { launches, commands } = recorder(clock);
    const model = new CompletionModel(commands, clock.api);
    model.update("see @😀f tail", 8);
    await clock.advance(100);
    expect(model.choose(0)).toEqual({ value: 'see @"😀 my folder/ tail', caret: 19 });
    await clock.advance(100);
    expect(launches.map(({ text }) => text)).toEqual(["see @😀f", 'see @"😀 my folder/']);
    expect(model.getSnapshot().open).toBe(true);

    model.update("see @😀f tail", 8);
    await clock.advance(100);
    model.key("ArrowDown");
    expect(model.key("Enter")).toEqual({ handled: true, accepted: { value: 'see @"😀file name.txt" tail', caret: 22 } });
    await clock.advance(1_000);
    expect(launches.length).toBe(3);
    expect(model.getSnapshot().open).toBe(false);
  });

  test("the field's select echo of an accepted file does not reopen the list", async () => {
    const clock = fakeClock();
    const plain: CompletionRow = { trigger: "@", text: "app.ts", display: "@app.ts", kind: "file", startPosition: -2 };
    const { launches, commands } = recorder(clock, async () => [plain]);
    const model = new CompletionModel(commands, clock.api);
    model.update("@ap", 3);
    await clock.advance(100);
    expect(model.choose(0)).toEqual({ value: "@app.ts", caret: 7 });
    model.select("@app.ts", 7, 7);
    await clock.advance(1_000);
    expect(launches.length).toBe(1);
    expect(model.getSnapshot().open).toBe(false);
  });

  test("a selected range asks nothing", async () => {
    const clock = fakeClock();
    const { launches, commands } = recorder(clock);
    const model = new CompletionModel(commands, clock.api);
    model.update("@src", 1, 4);
    await clock.advance(1_000);
    expect(launches).toEqual([]);
  });

  test("composition asks nothing until it ends, then asks once about the committed text", async () => {
    const clock = fakeClock();
    const { launches, commands } = recorder(clock);
    const model = new CompletionModel(commands, clock.api);
    model.update("@sr", 3);
    await clock.advance(100);
    expect(model.getSnapshot().open).toBe(true);
    model.update("@srx", 4);
    model.startComposition();
    expect(launches.length).toBe(1);
    model.update("@srxy", 5);
    model.select("@srxy", 5, 5);
    await clock.advance(1_000);
    expect(model.getSnapshot().open).toBe(false);
    expect(model.key("Enter", true)).toEqual({ handled: false });
    expect(launches.length).toBe(1);
    model.endComposition("@src", 4);
    await clock.advance(1_000);
    expect(launches.map(({ text }) => text)).toEqual(["@sr", "@src"]);
  });

  test("close is the teardown: it aborts the lookup in flight, clears the waiting one, and publishes nothing after", async () => {
    const clock = fakeClock();
    let release!: (rows: CompletionRow[]) => void;
    const { launches, commands } = recorder(clock, () => new Promise((done) => { release = done; }));
    const model = new CompletionModel(commands, clock.api);
    model.update("@sr", 3);
    await clock.advance(100);
    expect(launches.length).toBe(1);
    model.close();
    expect(launches[0]!.signal!.aborted).toBe(true);
    model.update("@src", 4);
    expect(clock.pending()).toBe(1);
    model.close();
    expect(clock.pending()).toBe(0);
    let calls = 0;
    model.subscribe(() => calls++);
    release([folder]);
    await clock.advance(1_000);
    expect(launches.length).toBe(1);
    expect(calls).toBe(0);
  });
});

describe("@path through the packed zeta client and the write gate", () => {
  /** A real ZetaClient with one pending slot, the app's write gate, and the app's exact three-argument adapter. */
  async function wired() {
    const sent: Array<{ id: number; method: string; params: Record<string, unknown>; firstAborted?: boolean }> = [];
    const signals: Array<AbortSignal | undefined> = [];
    let deliver!: (text: string) => void;
    const transport: Transport = {
      onMessage(callback) { deliver = callback; },
      onClose() {},
      close() {},
      send(text) {
        const frame = JSON.parse(text);
        sent.push({ ...frame, firstAborted: signals[0]?.aborted });
        // Zeta 54b9f211 tests/test_server_path_completion.py:204-221: hello negotiates path_completion for a controller.
        if (frame.method === "hello") queueMicrotask(() => deliver(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { protocol_version: "1.2", capabilities: { features: ["path_completion"], requests: ["path_complete"] } } })));
      },
    };
    const client = createClient(transport, (flush) => flush(), undefined, { maxPendingRequests: 1 });
    await client.hello(["path_completion"]);
    const state: { client: typeof client; authority: ZetaRole } = { client, authority: "controller" };
    const writeClient = createWriteClient(() => state).get()!;
    const outcomes: Array<Promise<string>> = [];
    const adapter: CommandRequest = (method, params, options) => writeClient.request(method, params, options);
    const watched: CommandRequest = (method, params, options) => {
      signals.push(options?.signal);
      const reply = adapter(method, params, options);
      outcomes.push(reply.then(() => "resolved", (error: Error) => error.name));
      return reply;
    };
    const commands = createCommandController("session-1", watched, { features: new Set(writeClient.features), requests: new Set(["path_complete"]) });
    const reply = (id: number, entries: unknown[]) => deliver(JSON.stringify({ jsonrpc: "2.0", id, result: { entries, truncated: false } }));
    const paths = () => sent.filter((frame) => frame.method === "path_complete");
    return { state, commands, signals, outcomes, reply, paths };
  }
  const clock = () => {
    const timers = new Set<() => void>();
    return {
      api: { setTimer: (run: () => void) => { timers.add(run); return run; }, clearTimer: (run: unknown) => { timers.delete(run as () => void); } } satisfies CompletionTimers,
      async fire() { const due = [...timers]; timers.clear(); for (const run of due) run(); for (let index = 0; index < 5; index++) await Promise.resolve(); },
      pending: () => timers.size,
    };
  };
  // Zeta 54b9f211 tests/test_server_path_completion.py:60-118: one directory row for the typed `@src`.
  const src = [{ text: "src/", start_position: -3, display: "@src/", kind: "directory" }];

  test("a superseded lookup is aborted before the next one reaches the wire, so the next one is sent and alone opens the list", async () => {
    const { commands, signals, outcomes, reply, paths } = await wired();
    const timers = clock();
    const model = new CompletionModel(commands, timers.api);
    model.update("see @sr", 7);
    await timers.fire();
    model.update("see @src", 8);
    await timers.fire();
    expect(paths().map(({ params }) => params.text_before_cursor)).toEqual(["see @sr", "see @src"]);
    expect(paths()[1]!.firstAborted).toBe(true);
    expect(await outcomes[0]).toBe("AbortError");
    expect(signals[1]?.aborted).toBe(false);
    reply(paths()[0]!.id, [{ text: "srv/", start_position: -2, display: "@srv/", kind: "directory" }]);
    reply(paths()[1]!.id, src);
    expect(await outcomes[1]).toBe("resolved");
    await timers.fire();
    expect(model.getSnapshot()).toEqual({ open: true, activeIndex: 0, rows: [{ trigger: "@", text: "src/", display: "@src/", kind: "directory", startPosition: -3 }] });
  });

  test("an observer never sends path_complete: the write gate refuses at launch, and a new unavailable source aborts the lookup in flight", async () => {
    const first = await wired();
    const timers = clock();
    const model = new CompletionModel(first.commands, timers.api);
    model.update("@sr", 3);
    first.state.authority = "observer";
    await timers.fire();
    expect(first.paths()).toEqual([]);
    expect(model.getSnapshot().open).toBe(false);
    await timers.fire();
    expect(timers.pending()).toBe(0);

    const second = await wired();
    const switched = new CompletionModel(second.commands, timers.api);
    switched.update("@sr", 3);
    await timers.fire();
    expect(second.paths().length).toBe(1);
    switched.setController(createUnavailableCommandController("you are observing this run"), { value: "@sr", caret: 3 });
    expect(second.signals[0]?.aborted).toBe(true);
    await timers.fire();
    second.reply(second.paths()[0]!.id, src);
    await timers.fire();
    expect(second.paths().length).toBe(1);
    expect(switched.getSnapshot().open).toBe(false);
  });
});
