import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../../..");
const require = createRequire(path.join(root, "package.json"));
const dotenv = require("dotenv");
const Redis = require("ioredis");
const { PrismaClient } = require("@prisma/client");
const { chromium } = require("playwright");
dotenv.config({ path: path.join(root, "backend/.env"), quiet: true });

const baseUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const prisma = new PrismaClient();
const token = crypto.randomBytes(32).toString("hex");

async function main() {
  const user = await prisma.user.findFirst({ where: { status: "active" }, orderBy: { createdAt: "asc" } });
  if (!user) throw new Error("No active user found for screenshot auth");

  await redis.set(
    `agenthub:session:${token}`,
    JSON.stringify({ userId: user.id, username: user.username }),
    "EX",
    30 * 60,
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const loginContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await loginPage.locator(".authPanel").waitFor({ timeout: 20000 });
    await loginPage.screenshot({ path: path.join(__dirname, "01-login.png"), fullPage: true });
    await loginContext.close();

    const appContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await appContext.addCookies([
      {
        name: "agenthub_session",
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await appContext.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.locator(".agenthubShell").waitFor({ timeout: 30000 });

    const demoButton = page.locator(".sessionItem").filter({ hasText: /Acceptance Demo|Codex Workbench/i }).first();
    if (await demoButton.count()) {
      await demoButton.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    await page.getByRole("button", { name: /审查|Diff/ }).click().catch(() => undefined);
    await page.waitForTimeout(1000);
    await page.mouse.move(520, 36);
    await page.screenshot({ path: path.join(__dirname, "02-workbench-diff-desktop.png"), fullPage: false });

    await page.getByRole("button", { name: /Artifacts/ }).click();
    await page.waitForTimeout(1000);
    await page.mouse.move(520, 36);
    await page.screenshot({ path: path.join(__dirname, "03-workbench-artifacts-desktop.png"), fullPage: false });

    const metrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      shellScrollWidth: document.querySelector(".agenthubShell")?.scrollWidth ?? 0,
      shellClientWidth: document.querySelector(".agenthubShell")?.clientWidth ?? 0,
      timelineScrollWidth: document.querySelector(".timeline")?.scrollWidth ?? 0,
      timelineClientWidth: document.querySelector(".timeline")?.clientWidth ?? 0,
      inlineDiffTables: document.querySelectorAll(".timeline .diffMessagePart .unifiedDiff").length,
      inlineArtifactFrames: document.querySelectorAll(
        ".timeline .artifactMessageFrame,.timeline .artifactMessageMedia,.timeline .artifactMessageText",
      ).length,
      leftRailWidth: Math.round(document.querySelector(".sessionRail")?.getBoundingClientRect().width ?? 0),
      inspectorWidth: Math.round(document.querySelector(".inspector")?.getBoundingClientRect().width ?? 0),
    }));
    console.log(JSON.stringify(metrics, null, 2));
    await appContext.close();
  } finally {
    await browser.close();
    await redis.del(`agenthub:session:${token}`).catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  await redis.del(`agenthub:session:${token}`).catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  console.error(error);
  process.exit(1);
});
