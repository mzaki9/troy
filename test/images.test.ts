import { describe, expect, test } from "bun:test";
import { toChatBody as anthropicToChat } from "../src/providers/anthropic";
import { wrapCommandCode } from "../src/providers/commandcode";
import { estimateTokens, extractImage, hasVision, splitContent } from "../src/providers/images";
import { inputToMessages } from "../src/providers/responses";

describe("images normalizer", () => {
  test("openai image_url object + bare string", () => {
    expect(extractImage({ type: "image_url", image_url: { url: "https://x/y.png" } })?.url).toBe("https://x/y.png");
    expect(extractImage({ type: "image_url", image_url: "https://x/y.png" })?.url).toBe("https://x/y.png");
  });
  test("openai detail preserved", () => {
    expect(extractImage({ type: "image_url", image_url: { url: "https://x/y.png", detail: "low" } })?.detail).toBe(
      "low",
    );
  });
  test("ai-sdk image shape (opencode)", () => {
    expect(extractImage({ type: "image", image: "data:image/png;base64,AAA" })?.url).toBe("data:image/png;base64,AAA");
  });
  test("claude base64 + url source", () => {
    expect(extractImage({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } })?.url).toBe(
      "data:image/png;base64,AAA",
    );
    expect(extractImage({ type: "image", source: { type: "url", url: "https://x/y.png" } })?.url).toBe(
      "https://x/y.png",
    );
  });
  test("responses input_image flatten", () => {
    expect(extractImage({ type: "input_image", image_url: "data:image/png;base64,AAA" })?.url).toBe(
      "data:image/png;base64,AAA",
    );
  });
  test("empty image_url is not vision", () => {
    expect(extractImage({ type: "image_url", image_url: {} })).toBeUndefined();
    expect(hasVision([{ role: "user", content: [{ type: "image_url", image_url: {} }] }])).toBe(false);
  });
  test("hasVision structured scan, no substring false-positives", () => {
    expect(hasVision([{ role: "user", content: "tell me about image_url handling" }])).toBe(false);
    expect(
      hasVision([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: "data:x" },
          ],
        },
      ]),
    ).toBe(true);
    expect(hasVision([{ role: "user", content: [{ type: "input_image", image_url: "data:x" }] }])).toBe(true);
  });
  test("estimateTokens excludes base64 inflation", () => {
    const big = "A".repeat(100_000);
    const est = estimateTokens([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${big}` } },
        ],
      },
    ]);
    expect(est).toBeLessThan(5000);
  });
  test("splitContent skips unknown parts", () => {
    expect(splitContent([{ type: "input_audio", data: "x" }])).toEqual([]);
  });
});

describe("bridge image mapping", () => {
  test("responses input_image → chat image_url with flattened url", () => {
    const msgs = inputToMessages(
      [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }] }],
      undefined,
    );
    expect(msgs[0].content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }]);
  });
  test("anthropic base64 source → chat image_url", () => {
    const body = anthropicToChat({
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
        },
      ],
    });
    const msgs = body.messages as { content: unknown }[];
    expect(JSON.stringify(msgs[0].content)).toContain("data:image/png;base64,AAA");
  });
  test("command-code vision keeps ai-sdk image, non-vision errors", () => {
    const vision = wrapCommandCode({
      model: "command-code/deepseek-vision",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: "data:image/png;base64,AAA" },
          ],
        },
      ],
    });
    expect(vision.error).toBeUndefined();
    expect(JSON.stringify(vision.body)).toContain("data:image/png;base64,AAA");
    const plain = wrapCommandCode({
      model: "command-code/mimo-v2.5-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
    });
    expect(plain.error).toContain("does not support image input");
  });
});
