/**
 * Office-style ribbon (WO-39): tab strip → groups → controls, visually
 * modeled on the Microsoft Office ribbon (layout, grouping, naming,
 * shortcuts) with our own plain glyph icons — no Microsoft artwork.
 *
 * Honesty rule (spec §22.4): a control is either
 *  - `move`: an existing, fully-wired app control physically re-homed into
 *    the ribbon (listeners and ids survive the move), optionally re-labeled;
 *  - `action`: a new working control calling into the app; or
 *  - `ph`: a placeholder for the real Office control at its real ribbon
 *    position, rendered disabled with a "Not yet implemented" tooltip.
 * No control ever fakes success.
 */

export interface RibbonAction {
  kind: "action";
  label: string;
  icon?: string;
  title?: string;
  big?: boolean;
  onClick: () => void;
}

export interface RibbonMove {
  kind: "move";
  /** id of the existing element to re-home (listeners survive) */
  id: string;
  /** optional Office-style re-label (buttons only) */
  label?: string;
  icon?: string;
  big?: boolean;
  title?: string;
}

export interface RibbonPlaceholder {
  kind: "ph";
  label: string;
  icon?: string;
  big?: boolean;
}

export type RibbonControl = RibbonAction | RibbonMove | RibbonPlaceholder;

export interface RibbonGroup {
  name: string;
  controls: RibbonControl[];
}

export interface RibbonTab {
  name: string;
  groups: RibbonGroup[];
}

const CSS = `
#ribbon { background: #f3f1ec; border-bottom: 1px solid #d5d2c8; font-size: 13px; user-select: none; }
#ribbon .rb-tabs { display: flex; gap: 2px; padding: 4px 8px 0; align-items: flex-end; }
#ribbon .rb-tab { border: 1px solid transparent; border-bottom: none; background: none;
  padding: 4px 14px; cursor: pointer; font: inherit; border-radius: 4px 4px 0 0; color: #444; }
#ribbon .rb-tab.active { background: #fbfaf7; border-color: #d5d2c8; color: #1a1a1a; font-weight: 600; }
#ribbon .rb-qat { margin-left: auto; display: flex; gap: 2px; align-items: center; padding-bottom: 2px; }
#ribbon .rb-qat button { font-size: 14px; padding: 2px 8px; }
#ribbon .rb-panel { display: none; background: #fbfaf7; padding: 4px 8px 2px; }
#ribbon .rb-panel.active { display: flex; gap: 4px; align-items: stretch; overflow-x: auto; }
#ribbon .rb-group { display: flex; flex-direction: column; border-right: 1px solid #e2dfd6; padding: 0 8px 0 4px; min-width: 56px; }
#ribbon .rb-group:last-child { border-right: none; }
#ribbon .rb-controls { display: flex; gap: 3px; align-items: center; flex: 1; flex-wrap: wrap; max-height: 64px; align-content: flex-start; }
#ribbon .rb-gname { text-align: center; font-size: 10.5px; color: #8a8578; padding: 1px 0 2px; }
#ribbon .rb-controls button, #ribbon .rb-controls select {
  font: inherit; background: none; border: 1px solid transparent; border-radius: 4px;
  padding: 3px 7px; cursor: pointer; color: #222; }
#ribbon .rb-controls select { background: #fff; border-color: #d5d2c8; max-width: 150px; }
#ribbon .rb-controls button:hover:not(:disabled) { background: #eceade; border-color: #d8d4c4; }
#ribbon .rb-controls button.active { background: #e3e0d0; border-color: #c9c4ae; }
#ribbon .rb-controls button:disabled { color: #b5b0a2; cursor: default; }
#ribbon .rb-big { display: flex; flex-direction: column; align-items: center; min-width: 46px;
  padding: 2px 6px !important; line-height: 1.15; max-height: none; }
#ribbon .rb-big .rb-ico { font-size: 19px; }
#ribbon .rb-big .rb-lbl { font-size: 11px; white-space: pre-line; text-align: center; }
`;

function makeButton(label: string, icon: string | undefined, big: boolean | undefined, title: string | undefined): HTMLButtonElement {
  const b = document.createElement("button");
  if (big) {
    b.className = "rb-big";
    b.innerHTML = `<span class="rb-ico">${icon ?? ""}</span><span class="rb-lbl"></span>`;
    (b.querySelector(".rb-lbl") as HTMLElement).textContent = label;
  } else {
    b.textContent = icon ? `${icon} ${label}` : label;
  }
  if (title) b.title = title;
  return b;
}

export function buildRibbon(mount: HTMLElement, tabs: RibbonTab[], qatIds: string[] = []): void {
  if (!document.getElementById("ribbon-css")) {
    const style = document.createElement("style");
    style.id = "ribbon-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  mount.innerHTML = "";
  const tabStrip = document.createElement("div");
  tabStrip.className = "rb-tabs";
  const panels: HTMLElement[] = [];

  tabs.forEach((tab, ti) => {
    const tb = document.createElement("button");
    tb.className = "rb-tab" + (ti === 0 ? " active" : "");
    tb.textContent = tab.name;
    tb.dataset.tab = tab.name;
    tb.addEventListener("click", () => {
      tabStrip.querySelectorAll(".rb-tab").forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tb.classList.add("active");
      panels[ti]!.classList.add("active");
    });
    tabStrip.appendChild(tb);

    const panel = document.createElement("div");
    panel.className = "rb-panel" + (ti === 0 ? " active" : "");
    panel.dataset.panel = tab.name;
    for (const group of tab.groups) {
      const g = document.createElement("div");
      g.className = "rb-group";
      const ctl = document.createElement("div");
      ctl.className = "rb-controls";
      for (const c of group.controls) {
        if (c.kind === "ph") {
          const b = makeButton(c.label, c.icon, c.big, `${c.label} — not yet implemented in Casserole`);
          b.disabled = true;
          b.dataset.ph = "1";
          ctl.appendChild(b);
        } else if (c.kind === "action") {
          const b = makeButton(c.label, c.icon, c.big, c.title ?? c.label);
          b.addEventListener("click", c.onClick);
          ctl.appendChild(b);
        } else {
          const el = document.getElementById(c.id);
          if (!el) continue; // honest: a missing control is simply not shown
          if (c.label && el instanceof HTMLButtonElement) {
            if (c.big) {
              el.classList.add("rb-big");
              el.innerHTML = `<span class="rb-ico">${c.icon ?? ""}</span><span class="rb-lbl"></span>`;
              (el.querySelector(".rb-lbl") as HTMLElement).textContent = c.label;
            } else {
              el.textContent = c.icon ? `${c.icon} ${c.label}` : c.label;
            }
          }
          if (c.title) el.title = c.title;
          ctl.appendChild(el); // physical move — listeners survive
        }
      }
      const name = document.createElement("div");
      name.className = "rb-gname";
      name.textContent = group.name;
      g.appendChild(ctl);
      g.appendChild(name);
      panel.appendChild(g);
    }
    panels.push(panel);
  });

  // quick access (undo/redo etc.) on the tab row, like Office's QAT
  const qat = document.createElement("div");
  qat.className = "rb-qat";
  for (const id of qatIds) {
    const el = document.getElementById(id);
    if (el) qat.appendChild(el);
  }
  tabStrip.appendChild(qat);

  mount.appendChild(tabStrip);
  panels.forEach((p) => mount.appendChild(p));
}
