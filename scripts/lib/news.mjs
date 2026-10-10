// Google News RSS: headline, source, time and link only (no article text).

const LOCALES = {
  tw: 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  us: 'hl=en-US&gl=US&ceid=US:en',
};

export const NEWS_QUERIES = { tw: '台股 when:1d', us: 'stock market when:1d' };

export const newsUrl = (query, locale) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${LOCALES[locale]}`;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

// Single pass so "&amp;lt;" becomes "&lt;", not "<".
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  const inner = m[2].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  return { attrs: m[1], text: decodeEntities(inner).replace(/\s+/g, ' ').trim() };
}

export function parseRss(xml, limit = 12) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml ?? ''))) && items.length < limit) {
    const body = m[1];
    let title = tag(body, 'title')?.text ?? '';
    const link = tag(body, 'link')?.text || tag(body, 'guid')?.text || '';
    let source = tag(body, 'source')?.text ?? '';
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    } else if (!source) {
      const parts = title.match(/^(.*\S)\s+-\s+([^-]+)$/);
      if (parts) [, title, source] = parts;
    }
    const raw = tag(body, 'pubDate')?.text ?? '';
    const t = Date.parse(raw);
    const pubDate = Number.isNaN(t) ? raw : new Date(t).toISOString().replace('.000Z', 'Z');
    if (title && /^https?:\/\//.test(link)) items.push({ title, link, source, pubDate });
  }
  return items;
}
