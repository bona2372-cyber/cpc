const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── HTML에서 메타 데이터 추출 ──
function parsePageData(html, targetUrl) {
  const get = (pattern) => { const m = html.match(pattern); return m ? m[1].trim() : ''; };

  const title       = get(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const desc        = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)
                   || get(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i);
  const keywords    = get(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']{1,300})["']/i)
                   || get(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']keywords["']/i);
  const ogTitle     = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
  const ogDesc      = get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,300})["']/i);

  // h1 태그들
  const h1s = [...html.matchAll(/<h1[^>]*>([^<]{1,100})<\/h1>/gi)].map(m=>m[1].trim()).slice(0,5);

  // JSON-LD 구조화 데이터
  let jsonld = [];
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try { jsonld.push(JSON.parse(m[1])); } catch(e) {}
  }

  // 가격 패턴 추출 (원화)
  const priceMatches = [...html.matchAll(/[₩￦]?\s*([\d,]{3,9})\s*원/g)].map(m=>parseInt(m[1].replace(/,/g,''))).filter(p=>p>100&&p<100000000);
  const prices = [...new Set(priceMatches)].slice(0, 20);

  // 카테고리/네비 텍스트
  const navTexts = [...html.matchAll(/<(?:nav|header)[^>]*>([\s\S]{0,2000}?)<\/(?:nav|header)>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())
    .join(' ').slice(0, 500);

  return {
    url: targetUrl,
    title: ogTitle || title,
    description: ogDesc || desc,
    keywords,
    h1s,
    jsonld,
    prices,
    navTexts,
    avgPrice: prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
  };
}

// ── URL fetch (리다이렉트 최대 3회 따라가기) ──
function fetchUrl(targetUrl, redirectCount, callback) {
  if (redirectCount > 3) { callback(new Error('너무 많은 리다이렉트')); return; }
  let parsed;
  try { parsed = new URL(targetUrl); } catch(e) { callback(e); return; }
  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
      'Accept-Encoding': 'identity',
    },
    timeout: 8000,
  };
  const req = lib.request(options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const next = res.headers.location.startsWith('http') ? res.headers.location : parsed.origin + res.headers.location;
      fetchUrl(next, redirectCount + 1, callback);
      res.resume();
      return;
    }
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { if (data.length < 300000) data += chunk; });
    res.on('end', () => callback(null, data));
  });
  req.on('error', callback);
  req.on('timeout', () => { req.destroy(); callback(new Error('요청 시간 초과')); });
  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 크롤링 프록시 ──
  if (req.method === 'POST' && parsed.pathname === '/api/crawl') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let targetUrl;
      try { targetUrl = JSON.parse(body).url; } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'url 필드가 없습니다' }));
        return;
      }
      if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

      fetchUrl(targetUrl, 0, (err, html) => {
        if (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const pageData = parsePageData(html, targetUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pageData));
      });
    });
    return;
  }

  // ── 정적 파일 서빙 ──
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('✅ CPC 분석 서버 실행 중! (크롤링 기능 포함)');
  console.log('');
  console.log('👉 브라우저에서 열기: http://localhost:' + PORT);
  console.log('');
  console.log('종료: Ctrl + C');
});
