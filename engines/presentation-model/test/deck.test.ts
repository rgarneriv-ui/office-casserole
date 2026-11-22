import { strict as assert } from "node:assert";
import test from "node:test";
import {
  CANVAS_W,
  addElement,
  addSlide,
  deckFromJSON,
  deckToJSON,
  duplicateSlide,
  moveSlide,
  newDeck,
  rectElement,
  removeElement,
  removeSlide,
  textElement,
  updateElement,
  validateDeck,
} from "../src/model";
import { History } from "../../document-model/src/history";

test("new deck is valid and has a title slide", () => {
  const deck = newDeck();
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0]!.elements[0]!.text, "Title slide");
  assert.deepEqual(validateDeck(deck), []);
});

test("slide operations: add, duplicate, move, remove", () => {
  const deck = newDeck();
  const at = addSlide(deck, 0);
  assert.equal(at, 1);
  assert.equal(deck.slides.length, 2);

  const dup = duplicateSlide(deck, 1);
  assert.equal(dup, 2);
  assert.equal(deck.slides.length, 3);
  // duplicated elements get fresh ids
  const ids = new Set(deck.slides.flatMap((s) => [s.id, ...s.elements.map((e) => e.id)]));
  assert.equal(ids.size, deck.slides.reduce((n, s) => n + 1 + s.elements.length, 0));

  moveSlide(deck, 2, 0);
  assert.deepEqual(validateDeck(deck), []);

  removeSlide(deck, 0);
  removeSlide(deck, 0);
  removeSlide(deck, 0); // last slide: resets, never empties
  assert.equal(deck.slides.length, 1);
  assert.deepEqual(validateDeck(deck), []);
});

test("element operations: add, update with clamping, remove", () => {
  const deck = newDeck();
  const rect = rectElement({ x: 100, y: 100, w: 300, h: 200 });
  addElement(deck, 0, rect);
  assert.equal(deck.slides[0]!.elements.length, 3);

  // update cannot push an element off-canvas or change id/kind
  updateElement(deck, 0, rect.id, { x: 99999, kind: "text" as never, id: "hacked" as never });
  const el = deck.slides[0]!.elements.find((e) => e.id === rect.id)!;
  assert.equal(el.kind, "rect");
  assert.equal(el.x, CANVAS_W - el.w);
  assert.deepEqual(validateDeck(deck), []);

  removeElement(deck, 0, rect.id);
  assert.equal(deck.slides[0]!.elements.length, 2);
});

test("JSON round-trip preserves the deck; invalid decks rejected", () => {
  const deck = newDeck();
  addSlide(deck, 0);
  addElement(deck, 1, textElement({ x: 10, y: 10, w: 400, h: 100, text: "hello" }));
  const restored = deckFromJSON(deckToJSON(deck));
  assert.deepEqual(restored, deck);
  assert.throws(() => deckFromJSON(JSON.stringify({ schemaVersion: "9.9", slides: [] })));
  assert.throws(() =>
    deckFromJSON(
      JSON.stringify({
        schemaVersion: "1.0",
        slides: [{ id: "s", elements: [{ id: "e", kind: "text", x: -5, y: 0, w: 100, h: 100 }] }],
      })
    )
  );
});

test("generic History works over decks (undo restores slide count)", () => {
  let deck = newDeck();
  const h = new History<ReturnType<typeof newDeck>>();
  h.checkpoint(deck);
  addSlide(deck, 0);
  assert.equal(deck.slides.length, 2);
  deck = h.undo(deck)!;
  assert.equal(deck.slides.length, 1);
  deck = h.redo(deck)!;
  assert.equal(deck.slides.length, 2);
});
