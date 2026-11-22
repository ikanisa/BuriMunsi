import createQpdf from "./vendor/parser.js";
import {
  checkProbe,
  probeBytes,
  probeFailure,
  probeResult,
  readProbeRequest,
} from "./probe-worker.ts";

type PdfObject = {
  value?: unknown;
  stream?: { dict: Record<string, unknown>; datafile?: unknown };
};

const output: string[] = [];
const errorOutput: string[] = [];
const wasm = await Deno.readFile(
  new URL("./vendor/parser.wasm", import.meta.url),
);
const wasmUrl = URL.createObjectURL(
  new Blob([wasm], { type: "application/wasm" }),
);
const library = await createQpdf({
  locateFile: () => wasmUrl,
  noInitialRun: true,
  print: (value: unknown) => output.push(String(value)),
  printErr: (value: unknown) => errorOutput.push(String(value)),
});
const activeKeys = ["/JavaScript", "/JS", "/EmbeddedFiles", "/Launch", "/AA"];
const activeActions = new Set<unknown>([
  "/JavaScript",
  "/Launch",
  "/SubmitForm",
  "/ImportData",
]);
const imageFilters = new Set<unknown>([
  "/DCTDecode",
  "/JPXDecode",
  "/JBIG2Decode",
  "/CCITTFaxDecode",
]);

function inspectPdfObjects(objects: Record<string, PdfObject>) {
  const names = Object.keys(objects);
  checkProbe(names.length - 1 <= 5000, "object_limit");
  const visited = new Set<string>();
  let events = 0;
  let streams = 0;
  let expanded = 0;

  function inspect(value: unknown, depth = 0) {
    checkProbe(++events <= 100000 && depth <= 40, "object_limit");
    if (typeof value === "string" && /^[0-9]+ [0-9]+ R$/.test(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      const object = objects["obj:" + value];
      if (object) inspect(object.value ?? object.stream?.dict, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    const dictionary = value as Record<string, unknown>;
    checkProbe(
      !activeKeys.some((key) => Object.hasOwn(dictionary, key)) &&
        !activeActions.has(dictionary["/S"]),
      "active_content",
    );
    for (const [key, item] of Object.entries(dictionary)) {
      if (key !== "/Parent") inspect(item, depth + 1);
    }
  }

  for (const name of names) {
    const { value, stream } = objects[name];
    inspect(value ?? stream?.dict);
    if (!stream) continue;
    checkProbe(++streams <= 2000, "stream_limit");
    const file = stream.datafile;
    checkProbe(
      typeof file === "string" && /^\/stream-[0-9]+$/.test(file),
      "stream_file_identity",
    );
    const size = library.FS.stat(file).size;
    if (!imageFilters.has(stream.dict["/Filter"])) {
      expanded += size;
      checkProbe(expanded <= 32 * 1024 * 1024, "stream_expansion_limit");
    }
  }

  return { objects: names.length - 1, streams, expanded_bytes: expanded };
}

Deno.serve(async (request) => {
  const { body, isolation } = await readProbeRequest<
    { base64: string; version?: boolean }
  >(request);
  try {
    const data = probeBytes(body.base64);
    checkProbe(
      data.length > 0 && data.length <= 5 * 1024 * 1024,
      "source_limit",
    );
    library.FS.writeFile("/input.pdf", data);
    if (body.version) {
      const code = library.callMain(["--version"]);
      return probeResult({
        ok: code === 0,
        code,
        output: library.diagnostics.join("\n"),
      }, isolation);
    }
    const code = library.callMain([
      "--json-output=2",
      "--json-key=qpdf",
      "--json-key=pages",
      "--json-key=encrypt",
      "--json-stream-data=file",
      "--json-stream-prefix=/stream",
      "--decode-level=generalized",
      "/input.pdf",
      "/output.json",
    ]);
    checkProbe(
      code === 0 && library.diagnostics.length === 0,
      "pdf_warning_or_error",
    );
    const size = library.FS.stat("/output.json").size;
    checkProbe(size <= 16 * 1024 * 1024, "json_expansion_limit");
    const metadata = JSON.parse(
      new TextDecoder().decode(library.FS.readFile("/output.json")),
    );
    checkProbe(metadata.qpdf?.[0]?.jsonversion === 2, "json_version");
    checkProbe(metadata.encrypt?.encrypted === false, "encrypted");
    checkProbe(
      Array.isArray(metadata.pages) && metadata.pages.length >= 1 &&
        metadata.pages.length <= 20,
      "page_limit",
    );
    const { objects, streams, expanded_bytes } = inspectPdfObjects(
      metadata.qpdf[1],
    );
    return probeResult({
      ok: true,
      objects,
      pages: metadata.pages.length,
      streams,
      expanded_bytes,
    }, isolation);
  } catch (error) {
    return probeFailure(error, isolation, library.diagnostics.length);
  }
});
