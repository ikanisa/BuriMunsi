type Isolation = Record<string, string>;

const isolationChecks = [
  ["network", () => fetch("http://127.0.0.1:9/")],
  ["environment", () => Deno.env.get("QUAL_ISOLATION_SENTINEL")],
  ["file_read", () => Deno.readTextFile("/etc/hostname")],
  [
    "file_write",
    () => Deno.writeTextFile("/tmp/collect-roster-probe-forbidden", "probe"),
  ],
  ["run", () => new Deno.Command("/bin/true").output()],
] as const;

export async function readProbeRequest<Body>(request: Request) {
  const body: Body = await request.json();
  const isolation: Isolation = {};
  for (const [name, probe] of isolationChecks) {
    try {
      await probe();
      isolation[name] = "ALLOWED";
    } catch (error) {
      isolation[name] = (error as Error).name;
    }
  }
  return { body, isolation };
}

export function probeResult(
  summary: Record<string, unknown>,
  isolation: Isolation,
) {
  return Response.json({ ...summary, isolation });
}

export function probeFailure(
  error: unknown,
  isolation: Isolation,
  diagnosticCount?: number,
) {
  return Response.json({
    ok: false,
    error: String(error).slice(0, 200),
    diagnostic_count: diagnosticCount,
    isolation,
  }, { status: 422 });
}

export function probeBytes(base64: string) {
  return Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
}

export function checkProbe(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw Error(code);
}
