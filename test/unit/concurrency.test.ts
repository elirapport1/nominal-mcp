/** Bounded parallelism and narrow retry. */
import { describe, expect, it } from "vitest";
import { mapSettled, withRetry, MAX_OUTBOUND_CONCURRENCY } from "../../src/util/concurrency.js";

describe("mapSettled", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapSettled(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      4,
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually parallel, not serialized
  });

  it("stays under the Workers outbound connection cap by default", () => {
    // Workers allow 6 simultaneous connections; we leave headroom for the
    // metadata lookup that precedes a fan-out.
    expect(MAX_OUTBOUND_CONCURRENCY).toBeLessThan(6);
  });

  it("preserves input order regardless of completion order", async () => {
    const r = await mapSettled([30, 5, 20, 1], async (ms) => {
      await new Promise((res) => setTimeout(res, ms));
      return ms;
    });
    expect(r.map((x) => (x.status === "fulfilled" ? x.value : null))).toEqual([30, 5, 20, 1]);
  });

  it("isolates failures instead of failing the batch", async () => {
    const r = await mapSettled([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(r[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(r[1]!.status).toBe("rejected");
    expect(r[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("handles an empty list", async () => {
    expect(await mapSettled([], async () => 1)).toEqual([]);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("retries a transient failure and succeeds", async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        if (++n === 1) throw new Error("503");
        return "ok";
      },
      { retryable: () => true, sleep: noSleep, random: () => 0.5 },
    );
    expect(v).toBe("ok");
    expect(n).toBe(2);
  });

  it("does not retry what the caller must fix", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("400");
        },
        { retryable: () => false, sleep: noSleep },
      ),
    ).rejects.toThrow("400");
    expect(n).toBe(1);
  });

  it("gives up after the attempt budget and rethrows the last error", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error(`fail-${n}`);
        },
        { retryable: () => true, attempts: 3, sleep: noSleep, random: () => 0 },
      ),
    ).rejects.toThrow("fail-3");
    expect(n).toBe(3);
  });

  it("applies jitter rather than a fixed backoff", async () => {
    const delays: number[] = [];
    await withRetry(
      async () => {
        if (delays.length < 2) throw new Error("retry");
        return 1;
      },
      {
        retryable: () => true,
        attempts: 5,
        baseDelayMs: 100,
        random: () => 0.5,
        sleep: async (ms) => { delays.push(ms); },
      },
    );
    // full jitter, doubling base: 100*1*0.5, 100*2*0.5
    expect(delays).toEqual([50, 100]);
  });
});
