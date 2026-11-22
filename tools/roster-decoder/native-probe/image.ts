// Compare the pinned image probe modes using only preserved synthetic fixtures.
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickImage,
  MagickReadSettings,
  ResourceLimits,
} from "./vendor/parser.js";
import {
  checkProbe,
  probeBytes,
  probeFailure,
  probeResult,
  readProbeRequest,
} from "./probe-worker.ts";

type ImageProbe = {
  base64: string;
  format: "Jpeg" | "Png" | "WebP" | "APng";
  strict: boolean;
};

type PixelCollection = {
  toByteArray(
    x: number,
    y: number,
    width: number,
    height: number,
    mapping: string,
  ): Uint8Array | null;
};

type ImageFrame = {
  width: number;
  height: number;
  getPixels(read: (pixels: PixelCollection) => void): void;
};

await initializeImageMagick(
  await Deno.readFile(new URL("./vendor/parser.wasm", import.meta.url)),
);
ResourceLimits.width = 16000n;
ResourceLimits.height = 16000n;
ResourceLimits.area = 16000000n;
ResourceLimits.listLength = 20n;
ResourceLimits.disk = 0n;
ResourceLimits.memory = 256n * 1024n * 1024n;
ResourceLimits.time = 4n;

function requireWarningFreeJpeg(data: Uint8Array) {
  const image = MagickImage.create();
  let warned = false;
  try {
    image.onWarning = () => {
      warned = true;
    };
    image.read(data, new MagickReadSettings({ format: MagickFormat.Jpeg }));
    checkProbe(!warned, "jpeg_decode_warning");
  } finally {
    image.dispose();
  }
}

Deno.serve(async (request) => {
  const { body, isolation } = await readProbeRequest<ImageProbe>(request);
  try {
    checkProbe(
      ["Jpeg", "Png", "WebP", "APng"].includes(body.format),
      "probe_format",
    );
    checkProbe(typeof body.strict === "boolean", "probe_mode");
    const data = probeBytes(body.base64);
    checkProbe(
      data.length > 0 && data.length <= 5 * 1024 * 1024,
      "input_limit",
    );
    if (body.strict && body.format === "Jpeg") requireWarningFreeJpeg(data);

    const summary = ImageMagick.readCollection(
      data,
      MagickFormat[body.format],
      (images: Iterable<ImageFrame> & { length: number }) => {
        checkProbe(images.length >= 1 && images.length <= 20, "frame_limit");
        let pixels = 0;
        for (const image of images) {
          const { width, height } = image;
          checkProbe(
            width > 0 && width <= 16000 && height > 0 && height <= 16000,
            "dimensions",
          );
          pixels += width * height;
          checkProbe(pixels <= 16000000, "pixel_limit");
          image.getPixels((values) => {
            const rgba = values.toByteArray(0, 0, width, height, "RGBA");
            checkProbe(
              rgba?.length === width * height * 4,
              "pixel_materialization",
            );
          });
        }
        return { frames: images.length, pixels };
      },
    );
    return probeResult({ ok: true, ...summary }, isolation);
  } catch (error) {
    return probeFailure(error, isolation);
  }
});
