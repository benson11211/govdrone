import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SEEN_PATH = path.join(ROOT_DIR, 'data', 'seen.json');

const KEYWORD = process.env.PCC_KEYWORD ?? '\u7121\u4eba\u6a5f';
const LOOKBACK_DAYS = Number.parseInt(process.env.PCC_LOOKBACK_DAYS ?? '7', 10);
const TZ = process.env.TZ ?? 'Asia/Taipei';
const SEARCH_URL = buildSearchUrl({ keyword: KEYWORD, lookbackDays: LOOKBACK_DAYS, timeZone: TZ });

async function main() {
  console.log(`Search URL: ${SEARCH_URL}`);

  const tenders = await fetchTenders(SEARCH_URL, KEYWORD);
  console.log(`Fetched ${tenders.length} matching tenders`);

  const seen = await readSeen();
  const seenIds = new Set(seen.map((item) => item.id));
  const newTenders = tenders.filter((item) => !seenIds.has(item.id));

  if (newTenders.length === 0) {
    console.log('No new tenders found');
    return;
  }

  console.log(`Found ${newTenders.length} new tenders`);
  await sendEmail(newTenders);

  const merged = mergeSeen(seen, tenders);
  await fs.writeFile(SEEN_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(`Updated ${SEEN_PATH}`);
}

function buildSearchUrl({ keyword, lookbackDays, timeZone }) {
  const today = new Date();
  const end = formatDate(today, timeZone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - lookbackDays + 1);
  const start = formatDate(startDate, timeZone);
  const url = new URL('https://web.pcc.gov.tw/prkms/tender/common/basic/readTenderBasic');
  url.search = new URLSearchParams({
    firstSearch: 'true',
    searchType: 'basic',
    isBinding: 'N',
    isLogIn: 'N',
    orgName: '',
    orgId: '',
    tenderName: keyword,
    tenderId: '',
    tenderType: 'TENDER_DECLARATION',
    tenderWay: 'TENDER_WAY_ALL_DECLARATION',
    dateType: 'isNow',
    tenderStartDate: start,
    tenderEndDate: end,
    radProctrgCate: '',
    policyAdvocacy: ''
  }).toString();
  return url.toString();
}

function formatDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}/${month}/${day}`;
}

async function fetchTenders(searchUrl, keyword) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});

    const { rowCount, matches } = await page.evaluate((currentKeyword) => {
      const normalize = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
      const rows = Array.from(document.querySelectorAll('tr'));
        const parsed = rows
        .map((row) => {
          const rowText = normalize(row.innerText);
          if (!rowText || !rowText.includes(currentKeyword)) {
            return null;
          }

          const links = Array.from(row.querySelectorAll('a'));
          const titleLink =
            links.find((link) => normalize(link.textContent).includes(currentKeyword)) ??
            links.find((link) => /\d/.test(normalize(link.textContent))) ??
            links[0];

          const title = titleLink ? normalize(titleLink.textContent) : rowText;
          const href = titleLink?.getAttribute('href') ?? '';
          const onclick = titleLink?.getAttribute('onclick') ?? '';
          const rawUrl = href || extractUrlFromOnclick(onclick) || '';
          const url = rawUrl ? new URL(rawUrl, window.location.origin).toString() : window.location.href;
          const id = `${title}__${url}`;

          return {
            id,
            title,
            url,
            summary: rowText
          };
        })
        .filter(Boolean);

      return {
        rowCount: rows.length,
        matches: Array.from(new Map(parsed.map((item) => [item.id, item])).values())
      };

      function extractUrlFromOnclick(onclickValue) {
        const match = onclickValue.match(/['"]([^'"]+)['"]/);
        return match ? match[1] : '';
      }
    }, keyword);

    console.log(`Total result rows scanned: ${rowCount}`);

    return matches;
  } finally {
    await browser.close();
  }
}

async function readSeen() {
  try {
    const content = await fs.readFile(SEEN_PATH, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function mergeSeen(existing, latest) {
  const merged = new Map();
  for (const item of [...existing, ...latest]) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values()).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
}

async function sendEmail(tenders) {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
    EMAIL_FROM,
    EMAIL_TO
  } = process.env;

  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO'].filter(
    (name) => !process.env[name]
  );

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true' || Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  const subject = `[PCC] 發現 ${tenders.length} 筆新的「${KEYWORD}」標案`;
  const text = tenders
    .map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.summary}`)
    .join('\n\n');

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


