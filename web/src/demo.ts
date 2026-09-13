// The scripted Telegram conversation in the hero: shows what the bot does before anyone connects a wallet.
import { h, prefersReducedMotion } from "./format";

type Step =
  | { kind: "me"; text: string }
  | { kind: "bot" | "ok"; lines: string[]; meta?: string; pay?: string }
  | { kind: "typing"; ms: number }
  | { kind: "pause"; ms: number };

const SCRIPT: Step[] = [
  { kind: "me", text: "/watch cookie.cook" },
  { kind: "typing", ms: 900 },
  { kind: "bot", lines: ["Watching cookie.cook.", "Every transfer lands here within seconds."] },
  { kind: "pause", ms: 1600 },
  { kind: "typing", ms: 700 },
  { kind: "bot", lines: ["📥 Incoming · cookie.cook", "+12,500 COOK  ($0.88)", "memo: gm bakers"], meta: "View on Cookiescan" },
  { kind: "pause", ms: 1800 },
  { kind: "me", text: "/tip cookie.cook 500" },
  { kind: "typing", ms: 800 },
  { kind: "bot", lines: ["@andy wants to tip 500 COOK to cookie.cook", "Waiting for the payment…"], pay: "Pay with Nightly" },
  { kind: "pause", ms: 2000 },
  { kind: "ok", lines: ["✓ @andy tipped 500 COOK to cookie.cook"], meta: "Confirmed on Cookie Chain" },
  { kind: "pause", ms: 3200 },
];

const MAX_VISIBLE = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bubble(step: Exclude<Step, { kind: "typing" | "pause" }>): HTMLLIElement {
  if (step.kind === "me") return h("li", { class: "msg me" }, step.text);
  const li = h("li", { class: `msg ${step.kind}` });
  step.lines.forEach((line, i) => {
    if (i) li.append(h("br"));
    li.append(i === 0 && step.kind === "bot" && step.lines.length > 1 ? h("b", {}, line) : line);
  });
  if (step.pay) li.append(h("br"), h("span", { class: "pay" }, step.pay));
  if (step.meta) li.append(h("span", { class: "meta" }, step.meta));
  return li;
}

function push(list: HTMLElement, node: HTMLElement) {
  list.append(node);
  const bubbles = [...list.children].filter((c) => !c.classList.contains("leaving"));
  for (const old of bubbles.slice(0, Math.max(0, bubbles.length - MAX_VISIBLE))) {
    old.classList.add("leaving");
    setTimeout(() => old.remove(), 350);
  }
}

export async function startChatDemo(list: HTMLElement, status: HTMLElement): Promise<void> {
  if (prefersReducedMotion()) {
    for (const step of SCRIPT) if (step.kind !== "typing" && step.kind !== "pause") push(list, bubble(step));
    return;
  }
  for (;;) {
    for (const step of SCRIPT) {
      if (document.hidden) await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
      if (step.kind === "pause") {
        await sleep(step.ms);
      } else if (step.kind === "typing") {
        status.textContent = "typing…";
        const dots = h("li", { class: "msg bot typing" }, h("i"), h("i"), h("i"));
        push(list, dots);
        await sleep(step.ms);
        dots.remove();
        status.textContent = "bot";
      } else {
        push(list, bubble(step));
        await sleep(step.kind === "me" ? 500 : 300);
      }
    }
    for (const c of [...list.children]) c.classList.add("leaving");
    await sleep(400);
    list.replaceChildren();
  }
}
