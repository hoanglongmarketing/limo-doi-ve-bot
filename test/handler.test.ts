import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReply, stripMention } from "../src/handler.ts";

test("bỏ @tên bot ở đầu tin", () => {
  assert.equal(stripMention("@Bot HL Support đổi vé ABC123", ["Bot HL Support"]), "đổi vé ABC123");
  assert.equal(stripMention("@bot hl support: ping", ["Bot HL Support"]), "ping");
  assert.equal(stripMention("ping", ["Bot HL Support"]), "ping");
});

test("trả lời ping và hướng dẫn", () => {
  assert.equal(buildReply("ping", "Ngọc Anh"), "pong 🏓");
  assert.match(buildReply("", "Ngọc Anh"), /bot đổi vé LIMO/);
  assert.match(buildReply("đổi vé ABC", "Việt"), /«đổi vé ABC»/);
});
