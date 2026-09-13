import { describe, expect, it } from "vitest";

import { formatCents, parsePriceToCents } from "@/lib/auctions/price";
import {
  MAX_STARTING_PRICE_CENTS,
  MIN_STARTING_PRICE_CENTS,
} from "@/lib/auctions/config";

describe("parsePriceToCents", () => {
  it("parses a whole-dollar amount", () => {
    expect(parsePriceToCents("100")).toBe(10000);
  });

  it("parses a decimal amount", () => {
    expect(parsePriceToCents("99.99")).toBe(9999);
  });

  it("rejects more than two decimal places", () => {
    expect(parsePriceToCents("10.005")).toBeNull();
  });

  it("rejects zero", () => {
    expect(parsePriceToCents("0")).toBeNull();
  });

  it("rejects a negative amount", () => {
    expect(parsePriceToCents("-5")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(parsePriceToCents("abc")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parsePriceToCents("")).toBeNull();
  });

  it("rejects a value above the CHECK constraint bound", () => {
    const overCents = MAX_STARTING_PRICE_CENTS + 100;
    expect(parsePriceToCents(String(overCents / 100))).toBeNull();
  });

  it("accepts the minimum bound", () => {
    expect(parsePriceToCents("0.01")).toBe(MIN_STARTING_PRICE_CENTS);
  });

  it("round-trips through formatCents", () => {
    const cents = parsePriceToCents("1234.56");
    expect(cents).not.toBeNull();
    expect(formatCents(cents as number)).toBe("$1,234.56");
  });
});

describe("formatCents", () => {
  it("formats whole cents with two decimal places", () => {
    expect(formatCents(10000)).toBe("$100.00");
  });

  it("formats fractional cents", () => {
    expect(formatCents(9999)).toBe("$99.99");
  });
});
