/**
 * Casserole presentation model (spec §8) — v0 subset per ADR-0007.
 * Slides hold typed, editable elements on a 1600×900 logical canvas
 * (scene-graph seed, §8.1). AI/import paths must create these elements, never
 * flattened images (§8.2). All geometry is in logical units; renderers scale.
 */

export const DECK_SCHEMA_VERSION = "1.0";
export const CANVAS_W = 1600;
export const CANVAS_H = 900;

export type ElementKind = "text" | "rect";
export type TextAlign = "left" | "center" | "right";

export interface SlideElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** text elements */
  text?: string;
  size?: number; // font size in logical units
  bold?: boolean;
  align?: TextAlign;
  color?: string;
  /** rect elements */
  fill?: string;
}

export interface Slide {
  id: string;
  elements: SlideElement[];
}

export interface DeckModel {
  schemaVersion: string;
  slides: Slide[];
}

let counter = 0;
export function newElemId(): string {
  counter += 1;
  return `e${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function newSlide(elements: SlideElement[] = []): Slide {
  return { id: newElemId(), elements };
}

export function newDeck(): DeckModel {
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    slides: [
      newSlide([
        textElement({ x: 160, y: 300, w: 1280, h: 160, text: "Title slide", size: 88, bold: true, align: "center" }),
        textElement({ x: 160, y: 500, w: 1280, h: 80, text: "Subtitle", size: 40, align: "center", color: "#666666" }),
      ]),
    ],
  };
}

export function textElement(props: Partial<SlideElement> & Pick<SlideElement, "x" | "y" | "w" | "h">): SlideElement {
  return {
    id: newElemId(),
    kind: "text",
    text: "Text",
    size: 36,
    bold: false,
    align: "left",
    color: "#222222",
    ...props,
  };
}

export function rectElement(props: Partial<SlideElement> & Pick<SlideElement, "x" | "y" | "w" | "h">): SlideElement {
  return { id: newElemId(), kind: "rect", fill: "#dbe7f0", ...props };
}

// ---------- operations (mutate in place, like the document engine) ----------

export function addSlide(deck: DeckModel, afterIndex: number): number {
  const slide = newSlide([
    textElement({ x: 120, y: 80, w: 1360, h: 110, text: "Slide title", size: 60, bold: true }),
    textElement({ x: 120, y: 260, w: 1360, h: 540, text: "Body text", size: 36 }),
  ]);
  const at = Math.min(Math.max(afterIndex + 1, 0), deck.slides.length);
  deck.slides.splice(at, 0, slide);
  return at;
}

export function removeSlide(deck: DeckModel, index: number): void {
  if (deck.slides.length <= 1) {
    deck.slides[0] = newSlide();
    return;
  }
  deck.slides.splice(index, 1);
}

export function duplicateSlide(deck: DeckModel, index: number): number {
  const src = deck.slides[index];
  if (!src) return index;
  const copy: Slide = {
    id: newElemId(),
    elements: src.elements.map((e) => ({ ...e, id: newElemId() })),
  };
  deck.slides.splice(index + 1, 0, copy);
  return index + 1;
}

export function moveSlide(deck: DeckModel, from: number, to: number): void {
  const [s] = deck.slides.splice(from, 1);
  if (s) deck.slides.splice(Math.min(Math.max(to, 0), deck.slides.length), 0, s);
}

export function addElement(deck: DeckModel, slideIndex: number, element: SlideElement): void {
  deck.slides[slideIndex]?.elements.push(element);
}

export function removeElement(deck: DeckModel, slideIndex: number, elementId: string): void {
  const slide = deck.slides[slideIndex];
  if (!slide) return;
  slide.elements = slide.elements.filter((e) => e.id !== elementId);
}

export function updateElement(
  deck: DeckModel,
  slideIndex: number,
  elementId: string,
  patch: Partial<SlideElement>
): void {
  const el = deck.slides[slideIndex]?.elements.find((e) => e.id === elementId);
  if (!el) return;
  Object.assign(el, patch, { id: el.id, kind: el.kind });
  clampElement(el);
}

export function clampElement(el: SlideElement): void {
  el.w = Math.max(40, Math.min(el.w, CANVAS_W));
  el.h = Math.max(40, Math.min(el.h, CANVAS_H));
  el.x = Math.max(0, Math.min(el.x, CANVAS_W - el.w));
  el.y = Math.max(0, Math.min(el.y, CANVAS_H - el.h));
}

// ---------- validation + serialization ----------

export function validateDeck(deck: DeckModel): string[] {
  const errors: string[] = [];
  if (deck.schemaVersion !== DECK_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${deck.schemaVersion}`);
  if (deck.slides.length === 0) errors.push("deck has no slides");
  const ids = new Set<string>();
  deck.slides.forEach((s, si) => {
    if (ids.has(s.id)) errors.push(`duplicate slide id ${s.id}`);
    ids.add(s.id);
    s.elements.forEach((e) => {
      if (ids.has(e.id)) errors.push(`duplicate element id ${e.id}`);
      ids.add(e.id);
      if (e.kind !== "text" && e.kind !== "rect") errors.push(`slide ${si}: unknown element kind`);
      if (e.x < 0 || e.y < 0 || e.x + e.w > CANVAS_W || e.y + e.h > CANVAS_H) {
        errors.push(`slide ${si}: element ${e.id} outside canvas`);
      }
    });
  });
  return errors;
}

export function deckToJSON(deck: DeckModel): string {
  return JSON.stringify(deck, null, 2);
}

export function deckFromJSON(json: string): DeckModel {
  const deck = JSON.parse(json) as DeckModel;
  const errors = validateDeck(deck);
  if (errors.length > 0) throw new Error(`Invalid deck: ${errors.join("; ")}`);
  return deck;
}
