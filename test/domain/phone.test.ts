import { describe, expect, it } from "vitest";
import { parsePhoneNumber } from "../../src/domain/phone.ts";

describe("parsePhoneNumber", () => {
  it("accepts exactly 10 digits starting 6-9 and returns the +91 form", () => {
    expect(parsePhoneNumber("9800000000")).toEqual({
      ok: true,
      value: "+919800000000",
    });
  });

  it.each([
    ["9 digits", "980000000"],
    ["11 digits", "98000000000"],
    ["starts with 5", "5800000000"],
    ["has a space", "98 00000000"],
    ["has a country code", "+919800000000"],
    ["has a trailing newline", "9800000000\n"],
    ["empty string", ""],
    ["null", null],
    ["a number, not a string", 9800000000],
  ])("rejects input that %s", (_label, input) => {
    expect(parsePhoneNumber(input)).toEqual({ ok: false });
  });
});
