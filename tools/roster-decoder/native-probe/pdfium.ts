import { PDFiumLibrary } from "./vendor/parser.js";
import {
  checkProbe,
  probeBytes,
  probeFailure,
  probeResult,
  readProbeRequest,
} from "./probe-worker.ts";

const library = await PDFiumLibrary.init({
  wasmBinary: await Deno.readFile(
    new URL("./vendor/parser.wasm", import.meta.url),
  ),
});

Deno.serve(async (request) => {
  const { body, isolation } = await readProbeRequest<{ base64: string }>(
    request,
  );
  let document;
  try {
    document = await library.loadDocument(probeBytes(body.base64));
    const pageCount = document.getPageCount();
    checkProbe(pageCount >= 1 && pageCount <= 20, "page_limit");
    let pixels = 0;
    let pages = 0;
    for (const page of document.pages()) {
      try {
        const image = await page.render({
          scale: 4 / 3,
          render: (raster: { data: Uint8Array }) =>
            Promise.resolve(raster.data),
          renderFormFields: false,
        });
        pixels += image.width * image.height;
        checkProbe(pixels <= 16000000, "pixel_limit");
        checkProbe(
          image.data.length === image.width * image.height * 4,
          "raster_bytes",
        );
        pages++;
      } finally {
        page.close();
      }
    }
    return probeResult({ ok: true, pages, pixels }, isolation);
  } catch (error) {
    return probeFailure(error, isolation);
  } finally {
    document?.destroy();
  }
});
