/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * Browser module of the review page view (bundled by `../assets.ts`).
 *
 * Renders one PDF page with pdf.js into the canvas, draws the Docling chunk
 * boxes from the page's JSON data block over it, and links boxes and the
 * server-rendered cards: hover highlights, click selects and scrolls, a
 * "show boxes" toggle (remembered in localStorage), `#chunk-<n>` / `#wire-<n>`
 * deep links. pdf.js is imported at runtime from `data-pdfjs-url` (a
 * non-literal specifier, so it stays out of the bundle).
 */

import type * as PdfJs from "pdfjs-dist";

import { bboxToPercent, type PageSize } from "../geometry.ts";
import type { PageViewBox, PageViewData } from "../page-view-model.ts";

const TOGGLE_STORAGE_KEY = "review.pageView.showBoxes";
const CHUNK_TYPES = new Set(["text", "table", "key_value", "picture"]);

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Page view element #${id} is missing.`);
  return found as T;
}

function readStoredToggle(): boolean | null {
  try {
    const value = window.localStorage.getItem(TOGGLE_STORAGE_KEY);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function storeToggle(value: boolean): void {
  try {
    window.localStorage.setItem(TOGGLE_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage may be blocked; the toggle still works for this page.
  }
}

class PageView {
  readonly #root = element<HTMLElement>("page-view");
  readonly #canvas = element<HTMLCanvasElement>("page-canvas");
  readonly #boxLayer = element<HTMLElement>("page-boxes");
  readonly #status = element<HTMLElement>("page-status");
  readonly #data: PageViewData = JSON.parse(element<HTMLScriptElement>("page-view-data").textContent ?? "{}");
  readonly #boxesByTarget = new Map<string, HTMLElement[]>();

  start(): void {
    this.#wireToggle();
    this.#wirePicker();
    this.#wireCards();
    window.addEventListener("hashchange", () => this.#selectFromHash());
    this.#selectFromHash();
    this.#render().catch((error: unknown) => {
      this.#status.textContent = `Could not render the page: ${error instanceof Error ? error.message : String(error)}`;
      this.#status.classList.add("error-panel");
    });
  }

  async #render(): Promise<void> {
    const started = performance.now();
    const pdfjs = await import(this.#root.dataset.pdfjsUrl!) as typeof PdfJs;
    pdfjs.GlobalWorkerOptions.workerSrc = this.#root.dataset.pdfjsWorkerUrl!;
    // The API serves the whole file (no range requests in v1).
    const pdf = await pdfjs.getDocument({ url: this.#root.dataset.pdfUrl!, disableRange: true }).promise;
    const page = await pdf.getPage(this.#data.page);
    const unscaled = page.getViewport({ scale: 1 });
    const pageSize: PageSize = { width: unscaled.width, height: unscaled.height };
    this.#drawBoxes(pageSize);

    const cssWidth = Math.max(this.#canvas.parentElement?.clientWidth ?? unscaled.width, 200);
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: cssWidth / unscaled.width });
    this.#canvas.width = Math.floor(viewport.width * outputScale);
    this.#canvas.height = Math.floor(viewport.height * outputScale);
    this.#canvas.style.aspectRatio = `${unscaled.width} / ${unscaled.height}`;
    await page.render({
      canvas: this.#canvas,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise;

    const [x0, y0] = page.view;
    const offset = page.rotate !== 0 || x0 !== 0 || y0 !== 0;
    const elapsed = Math.round(performance.now() - started);
    this.#root.dataset.renderMs = String(elapsed);
    this.#status.textContent = offset
      ? "Boxes may be offset: this page is rotated or its crop box does not start at (0, 0)."
      : `${this.#data.boxes.length} boxes · rendered in ${elapsed} ms`;
  }

  #drawBoxes(pageSize: PageSize): void {
    // Chunks can still share one bbox (text split from one Docling item; table parts from
    // runs before normalizer v6, or whose cells have no bboxes): draw one box per distinct
    // geometry, labelled with every chunk it stands for. v6 table parts have their own boxes.
    const groups = new Map<string, PageViewBox[]>();
    for (const box of this.#data.boxes) {
      const key = `${box.bbox.l},${box.bbox.t},${box.bbox.r},${box.bbox.b}`;
      groups.set(key, [...(groups.get(key) ?? []), box]);
    }
    const fragment = document.createDocumentFragment();
    for (const group of groups.values()) {
      const element = this.#boxElement(group, pageSize);
      for (const box of group) {
        const list = this.#boxesByTarget.get(box.targetId) ?? [];
        list.push(element);
        this.#boxesByTarget.set(box.targetId, list);
      }
      fragment.append(element);
    }
    this.#boxLayer.replaceChildren(fragment);
    // A deep link selected before the boxes existed.
    const selected = document.querySelector<HTMLElement>(".page-card.selected");
    if (selected?.dataset.targetId) this.#setBoxState(selected.dataset.targetId, "selected", true);
  }

  #boxElement(group: readonly PageViewBox[], pageSize: PageSize): HTMLElement {
    const first = group[0]!;
    const percent = bboxToPercent({ page: this.#data.page, ...first.bbox }, pageSize);
    const matched = group.some((box) => box.matched);
    const element = document.createElement("div");
    element.className = `page-box${CHUNK_TYPES.has(first.type) ? ` type-${first.type}` : ""}${matched ? "" : " unmatched"}`;
    element.style.left = `${percent.left}%`;
    element.style.top = `${percent.top}%`;
    element.style.width = `${percent.width}%`;
    element.style.height = `${percent.height}%`;
    const targetIds = [...new Set(group.map((box) => box.targetId))];
    element.dataset.targetId = targetIds.join(" ");
    element.title = group.map((box) => box.matched
      ? `Chunk ${box.label} (${box.type}, Docling w${box.wireChunkIndex})`
      : `Docling chunk w${box.wireChunkIndex} (${box.type}), no candidate`).join("\n")
      + (targetIds.length > 1 ? "\nClick again for the next chunk." : "");
    const label = document.createElement("span");
    label.className = "page-box-label";
    label.textContent = group.map((box) => box.label).join(", ");
    element.append(label);
    element.addEventListener("mouseenter", () => targetIds.forEach((id) => this.#highlight(id, true)));
    element.addEventListener("mouseleave", () => targetIds.forEach((id) => this.#highlight(id, false)));
    element.addEventListener("click", () => {
      // Cycle through the chunks sharing this box, starting after the selected one.
      const current = targetIds.findIndex((id) => document.getElementById(id)?.classList.contains("selected"));
      this.#select(targetIds[(current + 1) % targetIds.length]!, true);
    });
    return element;
  }

  #wireCards(): void {
    for (const card of document.querySelectorAll<HTMLElement>(".page-card[data-target-id]")) {
      const targetId = card.dataset.targetId!;
      card.addEventListener("mouseenter", () => this.#highlight(targetId, true));
      card.addEventListener("mouseleave", () => this.#highlight(targetId, false));
      card.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("a, summary, button")) return;
        this.#select(targetId, false);
      });
    }
  }

  #wireToggle(): void {
    const toggle = element<HTMLInputElement>("toggle-boxes");
    toggle.checked = readStoredToggle() ?? true;
    const apply = (): void => {
      this.#root.classList.toggle("boxes-hidden", !toggle.checked);
    };
    apply();
    toggle.addEventListener("change", () => {
      apply();
      storeToggle(toggle.checked);
    });
  }

  #wirePicker(): void {
    const picker = document.getElementById("page-picker") as HTMLSelectElement | null;
    picker?.addEventListener("change", () => picker.form?.submit());
  }

  #highlight(targetId: string, on: boolean): void {
    document.getElementById(targetId)?.classList.toggle("active", on);
    this.#setBoxState(targetId, "active", on);
  }

  #select(targetId: string, scrollCard: boolean): void {
    for (const previous of document.querySelectorAll<HTMLElement>(".page-card.selected, .page-box.selected")) {
      previous.classList.remove("selected");
    }
    const card = document.getElementById(targetId);
    card?.classList.add("selected");
    this.#setBoxState(targetId, "selected", true);
    if (scrollCard) card?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (card && window.location.hash !== `#${targetId}`) history.replaceState(null, "", `#${targetId}`);
  }

  #setBoxState(targetId: string, state: "active" | "selected", on: boolean): void {
    for (const box of this.#boxesByTarget.get(targetId) ?? []) box.classList.toggle(state, on);
  }

  #selectFromHash(): void {
    const match = /^#((?:chunk|wire)-\d+)$/.exec(window.location.hash);
    if (match && document.getElementById(match[1]!)) this.#select(match[1]!, true);
  }
}

new PageView().start();
