import { describe, expect, test } from "bun:test";
import { containsKeyword } from "../src/utils/keywords";

describe("containsKeyword", () => {
  test.each([
    ["pricing", true],
    ["Pricing?", true],
    ["what's the PRICING on this", true],
    ["pricing!!!", true],
    ["#pricing", true],
    ["price list please", false],
    ["pricings", false],
    ["repricing", false],
    ["", false],
  ])("%p -> %p for [pricing]", (text, expected) => {
    expect(containsKeyword(text, ["pricing"])).toBe(expected);
  });

  test("any keyword of the list matches, and phrases match as a whole", () => {
    expect(containsKeyword("how much is it", ["pricing", "how much"])).toBe(true);
    expect(containsKeyword("how muchness", ["how much"])).toBe(false);
  });

  test("keywords are matched literally, not as patterns", () => {
    expect(containsKeyword("a+b", ["a+b"])).toBe(true);
    expect(containsKeyword("aab", ["a+b"])).toBe(false);
  });

  test("an empty keyword list matches nothing", () => {
    expect(containsKeyword("pricing", [])).toBe(false);
  });
});
