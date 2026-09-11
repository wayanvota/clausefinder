import test from "node:test";
import assert from "node:assert/strict";
import { stripHtml } from "./html-utils.mjs";

test("stripHtml removes script and style elements with whitespace before closing brackets", () => {
  const hostile = "Safe<script>alert(1)</script ><style>body{display:none}</style >Text";
  assert.equal(stripHtml(hostile), "Safe Text");
});

test("stripHtml retains ordinary text and decodes common entities", () => {
  assert.equal(stripHtml("<p>FAR &amp; DFARS</p>"), "FAR & DFARS");
});
