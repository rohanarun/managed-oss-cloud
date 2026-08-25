import { constants } from "node:fs";
import { access } from "node:fs/promises";

const chromiumCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

export async function findChromiumExecutable() {
  for (const candidate of chromiumCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit cross-platform browser candidates.
    }
  }
  throw new Error("Google Chrome or Chromium is required for real product tutorial verification.");
}

function renderedInputValue(element, value) {
  if (element.type === "datetime-local") {
    const date = new Date(String(value));
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60_000)).toISOString().slice(0, 16);
  }
  if (element.dataset.json === "true") return JSON.stringify(value, null, 2);
  return String(value);
}

export async function fillGuidedActionForm(page, input) {
  for (const [name, value] of Object.entries(input)) {
    const control = page.locator("#field-" + name);
    if (await control.count() !== 1) throw new Error(`The guided workflow is missing the ${name} control.`);
    const kind = await control.evaluate((element) => ({ tagName: element.tagName, type: element.type, json: element.dataset.json }));
    if (kind.type === "checkbox") await control.setChecked(value === true);
    else if (kind.tagName === "SELECT") await control.selectOption(String(value));
    else await control.fill(await control.evaluate(renderedInputValue, value));
  }
}

async function installPointer(page) {
  await page.evaluate(() => {
    if (document.getElementById("managed-oss-tutorial-pointer")) return;
    const style = document.createElement("style");
    style.textContent = `
      #managed-oss-tutorial-pointer {
        position: fixed;
        z-index: 2147483647;
        width: 22px;
        height: 22px;
        left: 0;
        top: 0;
        border: 3px solid white;
        border-radius: 999px;
        background: rgba(19, 92, 255, .88);
        box-shadow: 0 4px 18px rgba(0, 0, 0, .32);
        pointer-events: none;
        transform: translate(-80px, -80px);
        transition: transform 280ms cubic-bezier(.2,.8,.2,1), box-shadow 140ms ease;
      }
      #managed-oss-tutorial-pointer[data-clicking="true"] {
        box-shadow: 0 0 0 13px rgba(19, 92, 255, .22), 0 4px 18px rgba(0, 0, 0, .32);
      }
    `;
    const pointer = document.createElement("div");
    pointer.id = "managed-oss-tutorial-pointer";
    document.head.append(style);
    document.body.append(pointer);
  });
}

async function click(page, locator, animatePointer) {
  if (animatePointer) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box) {
      await page.evaluate(({ x, y }) => {
        const pointer = document.getElementById("managed-oss-tutorial-pointer");
        if (pointer) pointer.style.transform = `translate(${x - 11}px, ${y - 11}px)`;
      }, { x: box.x + (box.width / 2), y: box.y + (box.height / 2) });
      await page.waitForTimeout(360);
      await page.evaluate(() => document.getElementById("managed-oss-tutorial-pointer")?.setAttribute("data-clicking", "true"));
      await page.waitForTimeout(120);
    }
  }
  await locator.click();
  if (animatePointer) {
    await page.evaluate(() => document.getElementById("managed-oss-tutorial-pointer")?.setAttribute("data-clicking", "false"));
    await page.waitForTimeout(180);
  }
}

function actionRecords(result) {
  return [...(Array.isArray(result?.records) ? result.records : []), ...(result?.record ? [result.record] : [])];
}

export async function runProductTutorialWorkflow(page, { product, webKey, animatePointer = false, onStep = async () => {}, pause = async () => {} }) {
  const steps = [];
  const mark = async (id, label, fact) => {
    const step = { id, label, fact, observedAt: new Date().toISOString() };
    steps.push(step);
    await onStep(step);
    await pause(step);
  };

  await page.goto(product.url, { waitUntil: "networkidle" });
  if (animatePointer) await installPointer(page);
  await page.locator("#product-name").waitFor({ state: "visible" });
  await mark("overview", `Meet ${product.name}`, `Open the real ${product.name} workspace and identify its core workflow.`);

  await mark("connect", "Connect the workspace", "Authenticate this browser to the isolated shared backend and load durable records.");
  await click(page, page.locator("#connect-trigger"), animatePointer);
  await page.locator("#web-key").fill(webKey);
  await click(page, page.locator("#connect"), animatePointer);
  await page.locator("#connection-state").filter({ hasText: "Connected" }).waitFor();
  await page.locator("#recent-records .record-card").first().waitFor();

  await mark("configure", product.primaryActionTitle, "Complete the guided, contract-validated form for the product's primary workflow.");
  await click(page, page.locator("#primary-action"), animatePointer);
  await page.locator("#action-dialog[open]").waitFor();
  await fillGuidedActionForm(page, product.tutorialInput);

  await mark("execute", "Run the real workflow", "Submit the action to the shared backend and require a successful durable result.");
  const responsePromise = page.waitForResponse((response) => response.url().includes("/product-api/actions/") && response.request().method() === "POST");
  await click(page, page.locator("#action-execute"), animatePointer);
  const actionResponse = await responsePromise;
  const result = await actionResponse.json();
  if (actionResponse.status() !== 200) throw new Error(`${product.slug} returned HTTP ${actionResponse.status()}: ${result?.error ?? "unknown action error"}`);
  const durable = actionRecords(result).find((record) => record.moduleId === product.moduleId && (!product.primaryRecordType || record.recordType === product.primaryRecordType));
  if (!durable?.id || !durable.title) throw new Error(`${product.slug} did not return its titled primary durable record.`);
  await page.locator("#action-result:not([hidden])").waitFor();
  await page.locator("#action-result-json").filter({ hasText: durable.id }).waitFor();

  const detailResponse = await page.request.get(product.url + "product-api/records/" + encodeURIComponent(durable.id), {
    headers: { "X-Product-Web-Key": webKey },
  });
  if (detailResponse.status() !== 200) throw new Error(`${product.slug} could not read the created record back.`);
  const detailBody = await detailResponse.json();
  const detailRecord = detailBody.record ?? detailBody;
  if (detailRecord.id !== durable.id || detailRecord.moduleId !== product.moduleId) throw new Error(`${product.slug} returned the wrong durable record detail.`);

  await mark("inspect", "Inspect the saved record", "Search the product record view and reopen the exact record returned by the workflow.");
  await click(page, page.locator("#action-close"), animatePointer);
  await click(page, page.locator('[data-view="records"]'), animatePointer);
  await page.locator("#record-query").fill(String(durable.title));
  await page.waitForTimeout(420);
  const card = page.locator("#record-grid .record-card").filter({ hasText: String(durable.title) }).first();
  await card.waitFor();
  await click(page, card, animatePointer);
  await page.locator("#record-dialog[open]").waitFor();
  await page.locator("#record-detail-json").filter({ hasText: durable.id }).waitFor();
  await pause({ id: "complete", label: "Verified", fact: "The exact durable record is visible in the product UI." });

  return {
    product: { slug: product.slug, name: product.name, moduleId: product.moduleId },
    action: { id: product.primaryActionId, title: product.primaryActionTitle, httpStatus: actionResponse.status() },
    record: { id: durable.id, recordType: durable.recordType, title: durable.title, state: durable.state },
    detail: { httpStatus: detailResponse.status(), matched: true },
    steps,
  };
}
