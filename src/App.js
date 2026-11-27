import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
import mammoth from 'mammoth/mammoth.browser';
import './App.css';

// pdf.js needs its worker file. Bundling it with the app (webpack 5 asset) works locally and on GitHub Pages.
const PDF_WORKER_BUNDLED = new URL('pdfjs-dist/legacy/build/pdf.worker.min.js', import.meta.url).toString();
const PDF_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_BUNDLED;

// Single place where every PDF in the app is read (chat, summarizer, comparison, intelligence). Falls back to a CDN copy of the worker if the bundled one cannot load.
async function extractPdfPages(arrayBuffer) {
  const read = async () => {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)) }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim());
    }
    return pages;
  };
  try { return await read(); } catch (firstError) {
    console.error('PDF read failed with bundled worker:', firstError);
    if (pdfjsLib.GlobalWorkerOptions.workerSrc === PDF_WORKER_CDN) throw firstError;
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN;
    try { return await read(); } catch (secondError) { console.error('PDF read failed with CDN worker:', secondError); throw new Error(`${firstError?.message || firstError} | ${secondError?.message || secondError}`); }
  }
}

const navItems = [
  ['overview', 'Overview', '⌂'], ['intelligence', 'Document Intelligence', '✦'],
  ['chat', 'Chat with Documents', '◌'], ['summary', 'Smart Summarizer', '▤'],
  ['compare', 'Document Comparison', '◫'], ['writing', 'Writing Studio', '✎'],
];
const suggestions = [
  'What are the key milestones in the history of AI?',
  'How has the focus of AI research changed over time?',
  'What are the main challenges mentioned in the document?',
];

function Icon({ children, className = '' }) { return <span className={`icon ${className}`} aria-hidden="true">{children}</span>; }

const SAMPLE_PAGES = [
  'A (Very) Brief History of Artificial Intelligence. Bruce G. Buchanan. In this brief history, the beginnings of artificial intelligence are traced in philosophy, fiction, and mathematics. Early computer developments, leading into AI, and some of the main ideas that have sustained it since 1956 are described. The history of AI is a history of fantastical possibilities, of over-optimism, of frustration, of extreme success and of frustration. It is a story of the evolution of ideas. The field has grown from philosophical roots into a practical discipline. Problem solving, knowledge representation, learning, and expert systems remain central themes. Research continues to evolve as new methods and technologies emerge, with each generation bringing fresh questions about intelligence and machines.',
];

const STOP_WORDS = new Set('a an the and or but if then of to in on at by for with from as is are was were be been being it its this that these those i you he she we they what which who whom whose when where why how do does did can could should would will shall may might must about into over under than so such not no yes me my your our their there here also very tell explain please give show document pdf file text'.split(' '));
const stem = (word) => word.replace(/(ing|ed|es|s)$/i, '');
const tokenize = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map(stem);
const splitSentences = (text, minLength = 25) => text.split(/\n+/).flatMap((line) => (line.replace(/\s+/g, ' ').match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]*/g) || [])).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > minLength);

function splitIntoPages(text, size = 3000) {
  const clean = text.replace(/\r/g, '');
  const pages = [];
  for (let start = 0; start < clean.length; start += size) pages.push(clean.slice(start, start + size));
  return pages.length ? pages : [''];
}

// Question-specific answering: scores every sentence in the document against the question and returns the best matches with their page numbers.
function answerQuestion(question, pages) {
  const sentences = [];
  pages.forEach((pageText, pageIndex) => splitSentences(pageText).forEach((sentence) => sentences.push({ page: pageIndex + 1, text: sentence, tokens: new Set(tokenize(sentence)) })));
  if (!sentences.length) return { text: 'I could not find any readable text in this document. It may be a scanned PDF.', pages: [] };
  const lowered = question.toLowerCase();
  const queryTokens = [...new Set(tokenize(question))];
  if (!queryTokens.length || /(summar|overview|\bwhole\b|what\s+is\s+(this|the)\s+(document|pdf|file)\s+about)/.test(lowered)) {
    const lead = sentences.slice(0, 4);
    return { text: `Here is the opening of the document: ${lead.map((item) => item.text).join(' ')}`, pages: [...new Set(lead.map((item) => item.page))] };
  }
  const documentFrequency = {};
  sentences.forEach((item) => queryTokens.forEach((token) => { if (item.tokens.has(token)) documentFrequency[token] = (documentFrequency[token] || 0) + 1; }));
  const scored = sentences.map((item, index) => {
    const score = queryTokens.reduce((sum, token) => sum + (item.tokens.has(token) ? Math.log(1 + sentences.length / (1 + (documentFrequency[token] || 0))) : 0), 0);
    return { ...item, index, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!scored.length) return { text: `I could not find anything about "${question.trim()}" in this document. Try using words that appear in the document.`, pages: [] };
  const best = scored.sort((a, b) => a.index - b.index);
  return { text: best.map((item) => item.text).join(' '), pages: [...new Set(best.map((item) => item.page))] };
}

// Extractive summariser: scores sentences by how many of the document's frequent words they contain, then keeps the best ones in reading order.
function buildSummary(pages, type, lengthLabel, unit = 'Page', takeawayCount = 3) {
  const sentences = [];
  pages.forEach((pageText, pageIndex) => splitSentences(pageText, 20).forEach((text) => sentences.push({ page: pageIndex + 1, text, tokens: tokenize(text) })));
  if (!sentences.length) return { text: '', takeaways: [] };
  const frequency = {};
  sentences.forEach((item) => item.tokens.forEach((token) => { frequency[token] = (frequency[token] || 0) + 1; }));
  const maxFrequency = Math.max(...Object.values(frequency), 1);
  sentences.forEach((item, index) => {
    const base = item.tokens.reduce((sum, token) => sum + frequency[token] / maxFrequency, 0);
    item.index = index;
    item.score = item.tokens.length ? (base / Math.sqrt(item.tokens.length)) * (index === 0 ? 1.2 : 1) : 0;
  });
  const lengthWords = /Short/.test(lengthLabel) ? 100 : /Long/.test(lengthLabel) ? 500 : 250;
  const multiplier = { 'Quick Summary': 0.5, 'Detailed Summary': 1.6, 'Bullet Points': 1, 'Executive Summary': 0.7, 'Chapter-wise': 1.2 }[type] || 1;
  const pick = (pool, wordBudget, minCount = 2) => {
    const chosen = []; let words = 0;
    [...pool].sort((a, b) => b.score - a.score).forEach((item) => { const count = item.text.split(/\s+/).length; if (chosen.length < minCount || words + count <= wordBudget) { chosen.push(item); words += count; } });
    return chosen.sort((a, b) => a.index - b.index);
  };
  const takeaways = [...sentences].sort((a, b) => b.score - a.score).slice(0, takeawayCount).sort((a, b) => a.index - b.index).map((item) => item.text);
  const budget = lengthWords * multiplier;
  if (type === 'Chapter-wise') {
    const groups = [];
    if (pages.length > 1) { const size = Math.ceil(pages.length / Math.min(8, pages.length)); for (let start = 0; start < pages.length; start += size) { const from = start + 1; const to = Math.min(start + size, pages.length); groups.push({ title: from === to ? `${unit} ${from}` : `${unit}s ${from}–${to}`, items: sentences.filter((item) => item.page >= from && item.page <= to) }); } }
    else { const size = Math.max(8, Math.ceil(sentences.length / 8)); for (let start = 0; start < sentences.length; start += size) groups.push({ title: `Part ${groups.length + 1}`, items: sentences.slice(start, start + size) }); }
    const perGroup = budget / Math.max(groups.length, 1);
    return { text: groups.filter((group) => group.items.length).map((group) => `${group.title}\n${pick(group.items, perGroup, 1).map((item) => `• ${item.text}`).join('\n')}`).join('\n\n'), takeaways };
  }
  const chosen = pick(sentences, budget, type === 'Quick Summary' ? 2 : 3);
  const text = type === 'Bullet Points' ? chosen.map((item) => `• ${item.text}`).join('\n') : chosen.map((item) => item.text).join(' ');
  return { text, takeaways };
}

async function extractDocumentText(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'txt') return file.text();
  if (extension === 'pdf') return (await extractPdfPages(await file.arrayBuffer())).join('\n');
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value || '';
}

// ---------- Settings, small utilities ----------
const DEFAULT_SETTINGS = { name: 'R', theme: 'Light', size: 'Default', emailNotifications: true, email: '' };
const SIZE_SCALE = { Compact: 0.85, Default: 0.92, Large: 1, 'Extra large': 1.1 };
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('lexilab-settings') || '{}') }; } catch (error) { return { ...DEFAULT_SETTINGS }; }
}
const initialOf = (name) => ((name || '').trim()[0] || 'R').toUpperCase();
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fileExtension = (name) => (name.includes('.') ? name.split('.').pop().toUpperCase() : 'FILE');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (error) {
    try {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (fallbackError) { return false; }
  }
}
function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Document analysis (Document Intelligence tab) ----------
const EXTRA_STOP_WORDS = new Set('one two also use used using may many much make made new like way well first however within across among could would since each other more most some such than then them these those been have has had were was will the and for are but not you all any can her his its our out their who why how get got let just only own same too very'.split(' '));
const ENGLISH_MARKERS = new Set('the of and to in is that for with as on are by this be an it from at or was'.split(' '));
const FIRST_NAMES = new Set('john james robert michael william david richard joseph thomas charles mary patricia jennifer linda elizabeth barbara susan jessica sarah karen emily emma olivia sophia daniel matthew anthony mark paul steven andrew peter george bruce alan allen marvin claude herbert alexander ada grace rahul priya amit raj anil sunil ravi sanjay deepak neha pooja anjali rohit vikram arjun riddhi'.split(' '));
const PLACES = ['United States', 'United Kingdom', 'USA', 'UK', 'India', 'Mumbai', 'Delhi', 'Bangalore', 'Pune', 'Chennai', 'Kolkata', 'London', 'Paris', 'Berlin', 'Tokyo', 'Beijing', 'Shanghai', 'New York', 'California', 'Boston', 'Cambridge', 'Stanford', 'Dartmouth', 'Pittsburgh', 'Seattle', 'Texas', 'China', 'Japan', 'Germany', 'France', 'Canada', 'Australia', 'Russia', 'Europe', 'Asia', 'Africa', 'America', 'Singapore', 'Dubai', 'Italy', 'Spain', 'Brazil'];
const DATE_PATTERN = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:1[5-9]|20)\d{2}\b/g;
const MONEY_PATTERN = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|thousand|crore|lakh|k|m|bn))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|INR|GBP|dollars|euros|rupees)\b/gi;
const ORG_PATTERN = /\b(?:[A-Z][A-Za-z&]+\s){1,4}(?:Inc|Ltd|LLC|Corp|Corporation|Company|University|Institute|Association|Foundation|Society|Laboratory|Laboratories|Labs|Bank|Agency|Department|College|School)\b\.?/g;

function countValues(list) {
  const counts = new Map();
  list.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

function analyzeDocument(pages) {
  const text = pages.join('\n');
  const words = text.match(/[A-Za-z0-9'’-]+/g) || [];
  const sentences = pages.flatMap((page) => splitSentences(page, 10));
  const lowerWords = (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []);
  const isStop = (word) => STOP_WORDS.has(word) || EXTRA_STOP_WORDS.has(word) || word.length < 4;
  const keywordCounts = countValues(lowerWords.filter((word) => !isStop(word)));
  const repeated = keywordCounts.filter((item) => item.count >= 2);
  const keywords = (repeated.length >= 6 ? repeated : keywordCounts).slice(0, 15);
  const phrases = [];
  sentences.forEach((sentence) => {
    const tokens = sentence.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
    for (let index = 0; index < tokens.length - 1; index += 1) if (!isStop(tokens[index]) && !isStop(tokens[index + 1])) phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  });
  const phraseCounts = countValues(phrases).filter((item) => item.count >= 2).slice(0, 8);
  const allWords = text.toLowerCase().match(/[a-z']+/g) || [];
  const english = allWords.length ? allWords.filter((word) => ENGLISH_MARKERS.has(word)).length / allWords.length > 0.05 : false;
  const unique = (matches) => countValues((matches || []).map((item) => item.trim()));
  const people = [
    ...(text.match(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sir)\.?\s[A-Z][a-z]+(?:\s[A-Z][a-z]+)?/g) || []),
    ...(text.match(/\b[A-Z][a-z]+\s[A-Z]\.\s[A-Z][a-z]+\b/g) || []),
    ...((text.match(/\b[A-Z][a-z]+\s[A-Z][a-z]+\b/g) || []).filter((name) => FIRST_NAMES.has(name.split(' ')[0].toLowerCase()))),
  ];
  const locations = PLACES.flatMap((place) => { const found = text.match(new RegExp(`\\b${place}\\b`, 'g')); return found || []; });
  const entities = { People: unique(people), Organisations: unique(text.match(ORG_PATTERN)), Locations: unique(locations), Dates: unique(text.match(DATE_PATTERN)), Money: unique(text.match(MONEY_PATTERN)) };
  const topic = phraseCounts[0]?.value || keywords[0]?.value || '—';
  return {
    pages: pages.length, words: words.length, characters: text.length, sentences: sentences.length,
    avgSentence: sentences.length ? Math.round(words.length / sentences.length) : 0,
    readingMinutes: Math.max(1, Math.ceil(words.length / 200)), uniqueWords: new Set(lowerWords).size,
    language: english ? 'English' : words.length ? 'Unknown' : '—',
    topic: topic.charAt(0).toUpperCase() + topic.slice(1), keywords, phrases: phraseCounts, entities,
    takeaways: buildSummary(pages, 'Quick Summary', 'Short (~ 100 words)', 'Page', 5).takeaways,
  };
}

// ---------- Writing Studio (rule-based transformations, no AI model) ----------
const matchCase = (original, replacement) => (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase() ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement);
const applyRules = (text, rules) => rules.reduce((current, [pattern, replacement]) => current.replace(pattern, (match) => matchCase(match, replacement)), text);
const CONTRACT = [[/\bdo not\b/gi, "don't"], [/\bdoes not\b/gi, "doesn't"], [/\bdid not\b/gi, "didn't"], [/\bcannot\b/gi, "can't"], [/\bwill not\b/gi, "won't"], [/\bis not\b/gi, "isn't"], [/\bare not\b/gi, "aren't"], [/\bwould not\b/gi, "wouldn't"], [/\bshould not\b/gi, "shouldn't"], [/\bhave not\b/gi, "haven't"], [/\bit is\b/gi, "it's"], [/\bthat is\b/gi, "that's"], [/\bwe are\b/gi, "we're"], [/\bthey are\b/gi, "they're"], [/\byou are\b/gi, "you're"]];
const EXPAND = [[/\bdon't\b/gi, 'do not'], [/\bdoesn't\b/gi, 'does not'], [/\bdidn't\b/gi, 'did not'], [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\bisn't\b/gi, 'is not'], [/\baren't\b/gi, 'are not'], [/\bwouldn't\b/gi, 'would not'], [/\bshouldn't\b/gi, 'should not'], [/\bhaven't\b/gi, 'have not'], [/\bit's\b/gi, 'it is'], [/\bthat's\b/gi, 'that is'], [/\bwe're\b/gi, 'we are'], [/\bthey're\b/gi, 'they are'], [/\byou're\b/gi, 'you are'], [/\bI'm\b/g, 'I am'], [/\bI've\b/g, 'I have']];
const FORMAL = [[/\ba lot of\b/gi, 'a great deal of'], [/\blots of\b/gi, 'many'], [/\bkind of\b/gi, 'somewhat'], [/\bsort of\b/gi, 'somewhat'], [/\bpretty good\b/gi, 'quite good'], [/\bthanks\b/gi, 'thank you'], [/\bguys\b/gi, 'team'], [/\bkids\b/gi, 'children'], [/\bbuy\b/gi, 'purchase'], [/\bhelp\b/gi, 'assist'], [/\bneed to\b/gi, 'must'], [/\bwant to\b/gi, 'wish to'], [/\balso\b/gi, 'additionally'], [/\bon time\b/gi, 'on schedule'], [/\bworked hard\b/gi, 'worked diligently'], [/\b(?:really|very|just|basically|actually)\s+/gi, '']];
const FRIENDLY = [[/\bin order to\b/gi, 'to'], [/\bhowever\b,?/gi, 'but'], [/\btherefore\b,?/gi, 'so'], [/\badditionally\b,?/gi, 'also'], [/\butilize\b/gi, 'use'], [/\bapproximately\b/gi, 'about'], [/\bregarding\b/gi, 'about'], [/\bpurchase\b/gi, 'buy'], [/\bassist\b/gi, 'help'], [/\brequire\b/gi, 'need']];
const CONCISE = [[/\bin order to\b/gi, 'to'], [/\bdue to the fact that\b/gi, 'because'], [/\bat this point in time\b/gi, 'now'], [/\ba number of\b/gi, 'several'], [/\bin the event that\b/gi, 'if'], [/\bwith regard to\b/gi, 'about'], [/\bfor the purpose of\b/gi, 'for'], [/\b(?:really|very|just|basically|actually|quite|extremely)\s+/gi, ''], [/\bit is important to note that\b/gi, ''], [/\bthe fact that\b/gi, 'that']];
const SIMPLE = [[/\butilize\b/gi, 'use'], [/\bapproximately\b/gi, 'about'], [/\bdemonstrate\b/gi, 'show'], [/\bcommence\b/gi, 'start'], [/\bpurchase\b/gi, 'buy'], [/\bassist\b/gi, 'help'], [/\brequire\b/gi, 'need'], [/\bnumerous\b/gi, 'many'], [/\bsufficient\b/gi, 'enough'], [/\badditional\b/gi, 'more'], [/\bsubsequently\b/gi, 'then'], [/\btherefore\b/gi, 'so'], [/\bhowever\b/gi, 'but'], [/\bindividuals\b/gi, 'people'], [/\bendeavor\b/gi, 'try'], [/\bfacilitate\b/gi, 'help'], [/\bobtain\b/gi, 'get'], [/\bin order to\b/gi, 'to'], [/\bwas completed\b/gi, 'was finished'], [/\bensure\b/gi, 'make sure']];
const TYPOS = [[/\bteh\b/gi, 'the'], [/\brecieve\b/gi, 'receive'], [/\bdefinately\b/gi, 'definitely'], [/\bseperate\b/gi, 'separate'], [/\boccured\b/gi, 'occurred'], [/\bwich\b/gi, 'which'], [/\balot\b/gi, 'a lot'], [/\bdont\b/gi, "don't"], [/\bcant\b/gi, "can't"], [/\bwont\b/gi, "won't"], [/\bdoesnt\b/gi, "doesn't"], [/\bthier\b/gi, 'their'], [/\buntill\b/gi, 'until'], [/\bbecuase\b/gi, 'because'], [/\bthier\b/gi, 'their'], [/\bim\b/g, "I'm"], [/\bive\b/g, "I've"], [/\bi\b/g, 'I'], [/\bi'm\b/g, "I'm"], [/\bi've\b/g, "I've"], [/\bi'll\b/g, "I'll"]];
function fixGrammar(text) {
  let result = applyRules(text.replace(/\s+/g, ' ').trim(), TYPOS);
  result = result.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:!?])(?=[A-Za-z])/g, '$1 ').replace(/([a-z])\.(?=[A-Z])/g, '$1. ').replace(/\b(\w+)\s+\1\b/gi, '$1');
  result = result.replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead, letter) => lead + letter.toUpperCase());
  return result && !/[.!?]$/.test(result) ? `${result}.` : result;
}
function splitLongSentences(text) {
  return text.replace(/[^.!?]+[.!?]*/g, (sentence) => (sentence.trim().split(/\s+/).length > 25 ? sentence.replace(/,\s+(and|but|so)\s+/i, '. ').replace(/;\s+/, '. ') : sentence));
}
function transformText(text, action, tone) {
  if (!text.trim()) return '';
  if (action === 'Fix Grammar') return fixGrammar(text);
  if (action === 'Convert to Bullet Points') return splitSentences(fixGrammar(text), 3).map((sentence) => `• ${sentence}`).join('\n');
  if (action === 'Simplify Text') return fixGrammar(splitLongSentences(applyRules(text, SIMPLE)));
  const base = tone === 'Professional' ? applyRules(applyRules(text, EXPAND), FORMAL) : tone === 'Friendly' ? applyRules(applyRules(text, FRIENDLY), CONTRACT) : applyRules(applyRules(text, EXPAND), CONCISE);
  return fixGrammar(base);
}

function Sidebar({ active, setActive, collapsed, setCollapsed, onHelp }) {
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="brand-row"><div className="brand-mark"><span>⌬</span></div>{!collapsed && <span className="brand-name">Lexi<span>Lab</span></span>}<button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar">‹</button></div>
    <button className="new-analysis" onClick={() => setActive('intelligence')}><Icon>＋</Icon>{!collapsed && <span>New Analysis</span>}</button>
    <nav className="primary-nav" aria-label="Primary navigation">{navItems.map(([id, label, glyph]) => <button key={id} className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => setActive(id)} title={label}><Icon>{glyph}</Icon>{!collapsed && <span>{label}</span>}</button>)}</nav>
    <div className="sidebar-spacer" />
    <button className="nav-item" onClick={() => setActive('history')} title="History"><Icon>◴</Icon>{!collapsed && <span>History</span>}</button>
    <button className="nav-item" onClick={() => setActive('settings')} title="Settings"><Icon>⚙</Icon>{!collapsed && <span>Settings</span>}</button>
    {!collapsed && <div className="sidebar-footer" role="button" tabIndex={0} onClick={onHelp} onKeyDown={(event) => { if (event.key === 'Enter') onHelp(); }}><div className="help-icon">?</div><div><strong>Need help?</strong><small>Visit our help centre</small></div><span>›</span></div>}
  </aside>;
}

function DocumentPage({ documentFile, documentText, documentPages, currentPage, zoom, isExtracting }) {
  const pageText = documentPages.length ? documentPages[currentPage - 1] : documentText;
  if (documentFile && (isExtracting || documentText)) return <div className="document-page extracted-document" style={{ zoom: zoom / 100 }}><div className="doc-issue">{documentFile.name}</div><h2>{isExtracting ? 'Reading document…' : 'Extracted document text'}</h2>{isExtracting ? <p className="extracting-copy">Extracting selectable text from your uploaded file.</p> : <div className="extracted-pdf-text">{pageText || 'No selectable text was found in this document. It may be a scanned PDF.'}</div>}<div className="doc-footer"><span>LexiLab frontend document preview</span><span>{documentFile.type || 'Document'}</span></div></div>;
  return <div className="document-page" style={{ zoom: zoom / 100 }}><div className="doc-issue">25th Anniversary Issue</div><h2>A (Very)<br />Brief History of<br />Artificial Intelligence</h2><div className="doc-author">Bruce G. Buchanan</div><div className="doc-columns"><p><b>▪</b> In this brief history, the beginnings of artificial intelligence are traced in philosophy, fiction, and mathematics. Early computer developments, leading into AI, and some of the main ideas that have sustained it since 1956 are described.</p><p><b>▪</b> The history of AI is a history of fantastical possibilities, of over-optimism, of frustration, of extreme success and of frustration. It is a story of the evolution of ideas.</p></div><div className="drop-cap">T</div><div className="doc-columns lower"><p>he field has grown from philosophical roots into a practical discipline. Problem solving, knowledge representation, learning, and expert systems remain central themes.</p><p>Research continues to evolve as new methods and technologies emerge, with each generation bringing fresh questions about intelligence and machines.</p></div><div className="doc-footer"><span>Copyright © 2005, American Association for Artificial Intelligence.</span><span>WINTER 2005 &nbsp; 5</span></div></div>;
}

function ChatPanel({ messages, setMessages, pages, isExtracting, onJumpToPage, onAsk, onAttach, fileName }) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const flash = (text) => { setNotice(text); setTimeout(() => setNotice(''), 2500); };
  const transcript = () => messages.map((message) => `${message.type === 'user' ? 'You' : 'LexiLab'}: ${message.text}${message.pages?.length ? ` [Pages: ${message.pages.join(', ')}]` : ''}`).join('\n\n');
  const share = async () => flash((await copyText(transcript())) ? 'Conversation copied to clipboard.' : 'Could not copy automatically.');
  const download = () => { downloadText('lexilab-chat.txt', transcript()); flash('Conversation downloaded.'); };
  const wordCount = pages.join(' ').split(/\s+/).filter(Boolean).length;
  const sendMessage = (text = draft) => {
    if (!text.trim()) return;
    const result = isExtracting ? { text: 'I am still reading the document. Please ask again in a moment.', pages: [] } : answerQuestion(text, pages);
    setMessages((items) => [...items, { type: 'user', text: text.trim(), time: nowTime() }, { type: 'ai', text: result.text, pages: result.pages, time: nowTime() }]);
    if (onAsk) onAsk(text.trim());
    setDraft('');
  };
  return <section className="chat-panel">
    <div className="chat-tools"><button type="button" aria-label="Copy conversation" title="Copy conversation" onClick={share}>⇧</button><button type="button" aria-label="Download conversation" title="Download conversation" onClick={download}>⇩</button><button type="button" aria-label="About this chat" title="About this chat" onClick={() => setShowInfo((value) => !value)}>ⓘ</button></div>
    {notice && <div className="chat-notice" role="status">{notice}</div>}
    {showInfo && <div className="chat-info">Chatting with <b>{fileName}</b> · {pages.length} page{pages.length === 1 ? '' : 's'} · {wordCount.toLocaleString()} words. Answers are picked from the document text itself, so they stay specific to what you ask. No AI model is involved.</div>}
    <div className="messages">{messages.map((message, index) => message.type === 'user' ? <div className="user-message" key={index}><div>{message.text}</div><time>{message.time}</time></div> : <div className="ai-message" key={index}><div className="ai-avatar">✦</div><div className="ai-card"><p>{message.text}</p>{message.pages?.length ? message.pages.map((pageNumber) => <button type="button" className="source-chip" key={pageNumber} onClick={() => onJumpToPage(pageNumber)}>▣ &nbsp;Source: Page {pageNumber}</button>) : message.source ? <span className="source-chip">▣ &nbsp;{message.source}</span> : null}<time>{message.time}</time></div></div>)}<div className="suggested"><h3><Icon>✦</Icon> Suggested questions</h3>{suggestions.map((item) => <button key={item} onClick={() => sendMessage(item)}><Icon>◯</Icon>{item}</button>)}</div></div>
    <form className="chat-input" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><button type="button" aria-label="Upload a document" title="Upload a document" onClick={onAttach}>＋</button><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask anything about this document..." /><button className="send-button" type="submit" aria-label="Send">➤</button></form>
  </section>;
}

function PageHeader({ eyebrow, title, subtitle, action, onAction }) { return <div className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subheading">{subtitle}</p></div>{action && <button className="primary-button" onClick={onAction}><Icon>＋</Icon>{action}</button>}</div>; }
function StatCard({ icon, value, label }) { return <div className="stat-card"><div className="stat-icon">{icon}</div><strong>{value}</strong><span>{label}</span></div>; }
function DocumentRow({ name, pages, status, date }) { return <div className="document-row"><span className="pdf-badge">PDF</span><div><strong>{name}</strong><small>{pages} pages · {status}</small></div><time>{date}</time></div>; }
function Overview({ setActive, openFile, records }) { const uploads = records.filter((item) => item.type === 'Uploaded'); const uniqueDocuments = [...new Map(uploads.map((item) => [item.name, item])).values()]; const summaries = records.filter((item) => item.type.startsWith('Summarised')).length; const comparisons = records.filter((item) => item.type === 'Compared').length; return <div className="page-content"><PageHeader eyebrow="Overview" title="Understand. Analyze. Transform." subtitle="Turn your documents into clear insights, right in your browser." action="New Analysis" onAction={openFile} /><div className="stats-grid"><StatCard icon="▣" value={uniqueDocuments.length} label="Documents uploaded" /><StatCard icon="▤" value={records.length} label="Total actions" /><StatCard icon="✦" value={summaries} label="Summaries generated" /><StatCard icon="◫" value={comparisons} label="Comparisons run" /></div><div className="section-title-row"><h2>Quick Actions</h2></div><div className="quick-grid">{[['intelligence','▣','Analyse Document','Extract insights'],['chat','◌','Chat with Document','Ask questions'],['summary','▤','Summarise','Get a shorter version'],['compare','◫','Compare','Find differences']].map(([id, icon, title, copy]) => <button className="quick-card" key={id} onClick={() => setActive(id)}><span className="quick-icon">{icon}</span><span><strong>{title}</strong><small>{copy}</small></span><b>›</b></button>)}</div><div className="two-column"><section className="panel"><div className="panel-heading"><h2>Recent Documents</h2><button onClick={() => setActive('history')}>View all</button></div>{uniqueDocuments.length ? uniqueDocuments.slice(0, 4).map((item) => <DocumentRow key={item.name} name={item.name} pages="—" status={item.status} date={item.date} />) : <div className="empty-state"><div>▣</div><h2>No documents yet</h2><p>Upload a document to get started.</p></div>}</section><section className="panel"><div className="panel-heading"><h2>Recent Activity</h2></div>{records.length ? records.slice(0, 4).map((item, index) => <div className="activity-item" key={`${item.name}-${item.date}-${index}`}><i />{item.type} · {item.name}<time>{item.date}</time></div>) : <div className="empty-state"><div>◴</div><h2>No activity yet</h2><p>Your actions will appear here.</p></div>}</section></div></div>; }
function Intelligence({ openFile, selectedFile, fileError, onDrop, documentPages, isExtracting }) {
  const [tab, setTab] = useState('Overview');
  const pages = selectedFile ? documentPages : SAMPLE_PAGES;
  const analysis = useMemo(() => analyzeDocument(pages), [pages]);
  const label = selectedFile?.name || 'AI_History_Review.pdf';
  const entityNames = Object.keys(analysis.entities);
  const entityIcons = { People: '♙', Organisations: '▥', Locations: '⌖', Dates: '▣', Money: '▤' };
  const tabs = [['Overview', '▣'], ['Keywords', '⌘'], ['Entities', '♙'], ['Topics', '▤'], ['Insights', '✦']];
  const maxTopic = Math.max(...[...analysis.phrases, ...analysis.keywords].map((item) => item.count), 1);
  const statusText = isExtracting ? 'Reading…' : selectedFile ? 'Analysed' : 'Sample';
  const empty = <p>Nothing detected in this document.</p>;
  return <div className="page-content"><PageHeader eyebrow="Document Intelligence" title="Discover what's inside your documents." subtitle="Extract keywords, entities, topics and key insights from any file." action="Upload Document" onAction={openFile} />
    <div className="intelligence-grid">
      <section className="panel upload-panel">
        <div className="upload-box" onClick={openFile} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><div className="upload-icon">⇧</div><h2>{selectedFile ? 'Document selected' : 'Drop your document here'}</h2><p>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB · ready for analysis` : 'PDF, DOCX or TXT up to 25MB'}</p><button className="secondary-button" type="button">Browse files</button>{fileError ? <small className="file-error">{fileError}</small> : <small>{selectedFile ? 'Analysis is calculated from your document' : 'Showing the built-in sample document'}</small>}</div>
        <div className="analysis-nav">{tabs.map(([name, glyph]) => <button type="button" key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{glyph} {name}</button>)}</div>
      </section>
      <section className="analysis-results">
        <div className="panel document-banner"><span className="pdf-badge">{selectedFile ? fileExtension(selectedFile.name) : 'PDF'}</span><div><strong>{label}</strong><small>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB · ${analysis.pages} page${analysis.pages === 1 ? '' : 's'}` : 'Sample document · 1 page'}</small></div><span className="status-pill">{statusText}</span></div>
        {tab === 'Overview' && <>
          <div className="panel"><div className="panel-heading"><h2>Document Overview</h2></div><div className="overview-list"><span>Pages <b>{analysis.pages}</b></span><span>Words <b>{analysis.words.toLocaleString()}</b></span><span>Reading time <b>{analysis.readingMinutes} min</b></span><span>Language <b>{analysis.language}</b></span><span>Main Topic <b>{analysis.topic}</b></span></div></div>
          <div className="panel"><div className="panel-heading"><h2>Extracted Keywords</h2></div>{analysis.keywords.length ? <div className="chips">{analysis.keywords.slice(0, 8).map((item) => <span key={item.value}>{item.value}</span>)}</div> : empty}</div>
          <div className="panel"><div className="panel-heading"><h2>Named Entities</h2></div><div className="entity-grid">{entityNames.map((name) => <div key={name}><span>{entityIcons[name]}</span><small>{name}</small><b>{analysis.entities[name].length}</b></div>)}</div></div>
        </>}
        {tab === 'Keywords' && <div className="panel"><div className="panel-heading"><h2>Keywords</h2></div>{analysis.keywords.length ? <div className="chips">{analysis.keywords.map((item) => <span key={item.value}>{item.value} · {item.count}</span>)}</div> : empty}{analysis.phrases.length > 0 && <><h3 className="sub-title">Frequent phrases</h3><div className="chips">{analysis.phrases.map((item) => <span key={item.value}>{item.value} · {item.count}</span>)}</div></>}</div>}
        {tab === 'Entities' && entityNames.map((name) => <div className="panel" key={name}><div className="panel-heading"><h2>{name}</h2></div>{analysis.entities[name].length ? <div className="chips">{analysis.entities[name].slice(0, 12).map((item) => <span key={item.value}>{item.value}{item.count > 1 ? ` · ${item.count}` : ''}</span>)}</div> : empty}</div>)}
        {tab === 'Topics' && <div className="panel"><div className="panel-heading"><h2>Main Topics</h2></div>{(analysis.phrases.length ? analysis.phrases : analysis.keywords.slice(0, 6)).length ? (analysis.phrases.length ? analysis.phrases : analysis.keywords.slice(0, 6)).map((item) => <div className="bar-row" key={item.value}><span>{item.value}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(8, (item.count / maxTopic) * 100)}%` }} /></div><b>{item.count}</b></div>) : empty}</div>}
        {tab === 'Insights' && <>
          <div className="panel"><div className="panel-heading"><h2>Key Insights</h2></div>{analysis.takeaways.length ? analysis.takeaways.map((item) => <p className="check-line" key={item}>✓ {item}</p>) : empty}</div>
          <div className="panel"><div className="panel-heading"><h2>Document Statistics</h2></div><div className="overview-list"><span>Sentences <b>{analysis.sentences}</b></span><span>Average sentence length <b>{analysis.avgSentence} words</b></span><span>Unique words <b>{analysis.uniqueWords.toLocaleString()}</b></span><span>Characters <b>{analysis.characters.toLocaleString()}</b></span></div></div>
        </>}
        <p className="heuristic-note">Entities are detected with simple pattern rules, so treat them as hints rather than exact results.</p>
      </section>
    </div></div>;
}

function SummaryPage({ openFile, selectedFile, documentText, documentPages, fileError, onDrop, onSummary }) { const [type, setType] = useState('Detailed Summary'); const [length, setLength] = useState('Medium (~ 250 words)'); const [summaryText, setSummaryText] = useState(''); const [takeaways, setTakeaways] = useState([]); const [copied, setCopied] = useState(false); const label = selectedFile?.name || 'Select a document first'; const generate = () => { if (!selectedFile || !documentText) return; const pages = documentPages.length ? documentPages : [documentText]; const result = buildSummary(pages, type, length, selectedFile.name.toLowerCase().endsWith('.pdf') ? 'Page' : 'Part'); setSummaryText(result.text || 'No readable sentences were found in this document.'); setTakeaways(result.takeaways); onSummary(selectedFile.name, type); }; return <div className="page-content"><PageHeader eyebrow="Smart Summarizer" title="Long documents. Clear insights." subtitle="Generate concise and meaningful summaries from your files." action="Upload Document" onAction={openFile} /><div className="summary-grid"><section className="panel summary-controls"><div className="document-banner upload-mini" onClick={openFile} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><span className="pdf-badge">{selectedFile ? selectedFile.name.split('.').pop().toUpperCase() : 'FILE'}</span><div><strong>{label}</strong><small>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB · selected locally` : 'Click to upload a PDF, DOCX or TXT'}</small></div></div>{fileError && <div className="file-error summary-error">{fileError}</div>}<h3>Summary Type</h3>{['Quick Summary','Detailed Summary','Bullet Points','Executive Summary','Chapter-wise'].map((x) => <label className={`radio-row ${type === x ? 'selected' : ''}`} key={x}><input type="radio" checked={type === x} onChange={() => { setType(x); setSummaryText(''); }} />{x}</label>)}<label className="field-label">Summary Length<select value={length} onChange={(event) => { setLength(event.target.value); setSummaryText(''); }}><option>Short (~ 100 words)</option><option>Medium (~ 250 words)</option><option>Long (~ 500 words)</option></select></label><button className="primary-button full-button" disabled={!selectedFile || !documentText} onClick={generate}>{summaryText ? 'Regenerate Summary' : 'Generate Summary'}</button></section><section className="panel result-panel"><div className="panel-heading"><h2>{summaryText ? `Summary (${type})` : 'Summary'}</h2><div><button type="button" disabled={!summaryText} onClick={async () => { if (await copyText(summaryText)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }}>{copied ? 'Copied ✓' : 'Copy'}</button><button type="button" disabled={!summaryText} onClick={() => downloadText(`${(selectedFile?.name || 'summary').replace(/\.[^.]+$/, '')}-summary.txt`, summaryText)}>Download</button></div></div>{summaryText ? <><p className="generated-summary">{summaryText}</p><h3>Key Takeaways</h3>{takeaways.map((x) => <p className="check-line" key={x}>✓ {x}</p>)}</> : <div className="summary-empty"><div>✦</div><h3>{selectedFile ? (documentText ? 'Ready to summarise' : 'Waiting for document text') : 'Upload a document first'}</h3><p>{selectedFile ? 'Choose a summary format and generate a summary from the extracted text.' : 'The summary will be generated from your uploaded file.'}</p></div>}</section></div></div>; }
function Comparison({ onCompared }) { const [fileA, setFileA] = useState(null); const [fileB, setFileB] = useState(null); const [compared, setCompared] = useState(null); const [comparing, setComparing] = useState(false); const [error, setError] = useState(''); const inputA = useRef(null); const inputB = useRef(null); const pick = (ref) => ref.current?.click(); const choose = (event, setter) => { const file = event.target.files?.[0]; if (file) { setter(file); setCompared(null); setError(''); } }; const compare = async () => { if (!fileA || !fileB) return; setComparing(true); setError(''); try { const [textA, textB] = await Promise.all([extractDocumentText(fileA), extractDocumentText(fileB)]); const wordsA = new Set((textA.toLowerCase().match(/[a-z0-9]+/g) || [])); const wordsB = new Set((textB.toLowerCase().match(/[a-z0-9]+/g) || [])); const addedWords = [...wordsB].filter((word) => !wordsA.has(word)); const removedWords = [...wordsA].filter((word) => !wordsB.has(word)); const union = new Set([...wordsA, ...wordsB]).size; const common = [...wordsA].filter((word) => wordsB.has(word)).length; const linesA = textA.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const linesB = textB.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); const changedLines = linesB.filter((line) => !linesA.includes(line)).slice(0, 5); const result = { similarity: union ? Math.round((common / union) * 100) : 0, added: addedWords.length, removed: removedWords.length, modified: changedLines.length, additions: addedWords.slice(0, 8), removals: removedWords.slice(0, 8), changedLines }; setCompared(result); onCompared(fileA.name, fileB.name); } catch (comparisonError) { console.error('Comparison read error:', comparisonError); setError(`These documents could not be read for comparison (${comparisonError?.message || 'unknown error'}). Please try another PDF, DOCX or TXT file.`); } finally { setComparing(false); } }; const labelA = fileA?.name || 'Select first document'; const labelB = fileB?.name || 'Select second document'; return <div className="page-content"><PageHeader eyebrow="Document Comparison" title="See what changed." subtitle="Compare two documents and instantly identify differences." /><div className="compare-selectors"><button className="file-select uploadable" onClick={() => pick(inputA)}><span className="pdf-badge">{fileA ? fileA.name.split('.').pop().toUpperCase() : 'FILE'}</span><span><b>{labelA}</b><small>{fileA ? `${(fileA.size / 1024 / 1024).toFixed(2)} MB · selected locally` : 'Click to upload PDF, DOCX or TXT'}</small></span><span>⌄</span></button><input ref={inputA} hidden type="file" accept=".pdf,.docx,.txt" onChange={(event) => choose(event, setFileA)} /><button type="button" className="swap-button" title="Swap documents" onClick={() => { setFileA(fileB); setFileB(fileA); setCompared(null); setError(''); }}>⇄</button><button className="file-select uploadable" onClick={() => pick(inputB)}><span className="pdf-badge">{fileB ? fileB.name.split('.').pop().toUpperCase() : 'FILE'}</span><span><b>{labelB}</b><small>{fileB ? `${(fileB.size / 1024 / 1024).toFixed(2)} MB · selected locally` : 'Click to upload PDF, DOCX or TXT'}</small></span><span>⌄</span></button><input ref={inputB} hidden type="file" accept=".pdf,.docx,.txt" onChange={(event) => choose(event, setFileB)} /><button className="primary-button" disabled={!fileA || !fileB || comparing} onClick={compare}>{comparing ? 'Comparing…' : 'Compare'}</button></div>{error && <div className="compare-hint file-error">{error}</div>}{!fileA || !fileB ? <div className="compare-hint">Upload both documents above to enable comparison.</div> : compared && <div className="compare-hint success-note">Real comparison complete · based on extracted document text.</div>}<div className="two-column compare-panels"><section className="panel similarity-panel"><h2>Comparison Overview</h2><div className="similarity-circle">{compared ? `${compared.similarity}%` : '—'}<small>Similarity</small></div><div className="compare-stats"><b>{compared?.added ?? '—'}<small>Added</small></b><b>{compared?.removed ?? '—'}<small>Removed</small></b><b>{compared?.modified ?? '—'}<small>Changed lines</small></b></div></section><section className="panel"><h2>Major Changes</h2>{compared ? <ul className="change-list">{compared.additions.length ? <li><strong>Added words:</strong> {compared.additions.join(', ')}</li> : null}{compared.removals.length ? <li><strong>Removed words:</strong> {compared.removals.join(', ')}</li> : null}{compared.changedLines.length ? compared.changedLines.map((line) => <li key={line}>{line}</li>) : null}{!compared.additions.length && !compared.removals.length && !compared.changedLines.length ? <li>No text differences detected.</li> : null}</ul> : <p>Upload both documents and click Compare to calculate real differences.</p>}</section></div></div>; }
function WritingStudio() {
  const [text, setText] = useState('The project was completed on time and the team worked very hard to ensure all the requirements were met.');
  const [action, setAction] = useState('Rewrite');
  const [tone, setTone] = useState('Professional');
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const count = (value) => (value.trim() ? value.trim().split(/\s+/).length : 0);
  const generate = () => { const result = transformText(text, action, tone); setOutput(result); setNote(result.trim() === text.trim() ? 'No changes were needed for this action. Try another action or tone.' : ''); setCopied(false); };
  const copy = async () => { if (await copyText(output)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } };
  return <div className="page-content"><PageHeader eyebrow="Writing Studio" title="Make every word work better." subtitle="Rewrite, improve, simplify and transform your content." />
    <div className="writing-toolbar"><label>Action<select value={action} onChange={(event) => { setAction(event.target.value); setOutput(''); }}><option>Rewrite</option><option>Simplify Text</option><option>Fix Grammar</option><option>Convert to Bullet Points</option></select></label><label>Tone<select value={tone} disabled={action !== 'Rewrite'} onChange={(event) => { setTone(event.target.value); setOutput(''); }}><option>Professional</option><option>Friendly</option><option>Concise</option></select></label><button type="button" className="primary-button" onClick={generate} disabled={!text.trim()}>Generate</button></div>
    <div className="writing-grid">
      <section className="panel editor-panel"><div className="panel-heading"><h2>Original Text</h2><button type="button" onClick={() => { setText(''); setOutput(''); }}>Clear</button></div><textarea value={text} onChange={(event) => { setText(event.target.value); setOutput(''); }} placeholder="Paste or type your text here..." /><small>Words: {count(text)} · Characters: {text.length}</small></section>
      <section className="panel editor-panel"><div className="panel-heading"><h2>{action === 'Rewrite' ? `Rewritten (${tone})` : action}</h2><button type="button" disabled={!output} onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button></div>{note && <div className="chat-info">{note}</div>}<div className="rewrite-output">{output || 'Choose an action and press Generate. Your result will appear here.'}</div><small>Rule-based editing, not an AI model · Words: {count(output)}</small></section>
    </div></div>;
}

function History({ search, records, onDelete, onClear }) {
  const query = search.trim().toLowerCase();
  const filtered = records.map((item, index) => ({ item, index })).filter(({ item }) => item.name.toLowerCase().includes(query) || item.type.toLowerCase().includes(query));
  return <div className="page-content"><PageHeader eyebrow="History" title="Your recent work." subtitle="Find documents and actions from your LexiLab workspace." />
    <section className="panel history-panel">
      {records.length > 0 && <div className="history-tools"><span>{filtered.length} of {records.length} item{records.length === 1 ? '' : 's'}{query ? ` matching “${search.trim()}”` : ''}</span><button type="button" className="text-link" onClick={onClear}>Clear all</button></div>}
      {filtered.length ? filtered.map(({ item, index }) => <div className="history-row has-actions" key={`${item.name}-${item.date}-${index}`}><span className="pdf-badge">{item.extension || 'FILE'}</span><strong>{item.name}</strong><span>{item.type}</span><time>{item.date}</time><span className="status-pill">{item.status}</span><button type="button" className="row-delete" aria-label={`Remove ${item.name} from history`} title="Remove" onClick={() => onDelete(index)}>✕</button></div>) : <div className="empty-state"><div>⌕</div><h2>{records.length ? 'No matches' : 'No activity yet'}</h2><p>{records.length ? 'Try a different search term.' : 'Upload a document, ask a question or run a summary to see it here.'}</p></div>}
    </section></div>;
}

function Settings({ settings, onChange, onReset }) {
  const [savedAt, setSavedAt] = useState('');
  const change = (patch) => { onChange(patch); setSavedAt(nowTime()); };
  const emailInvalid = settings.email && !/^\S+@\S+\.\S+$/.test(settings.email);
  return <div className="page-content"><PageHeader eyebrow="Settings" title="Make LexiLab yours." subtitle="Manage your profile, preferences and notifications. Changes apply instantly and are saved in this browser." />
    <div className="settings-grid">
      <section className="panel setting-card"><div className="setting-icon">{initialOf(settings.name)}</div><div className="setting-body"><h2>Profile settings</h2><p>Your name and initial appear in the top-right corner.</p><label className="setting-field">Display name<input value={settings.name} maxLength={40} onChange={(event) => change({ name: event.target.value })} placeholder="Your name" /></label></div></section>
      <section className="panel setting-card"><div className="setting-icon">☾</div><div className="setting-body"><h2>Appearance</h2><p>Choose how LexiLab looks in this browser.</p><label className="setting-field">Theme<select value={settings.theme} onChange={(event) => change({ theme: event.target.value })}><option>Light</option><option>Dark</option><option>System default</option></select></label><label className="setting-field">Interface size<select value={settings.size} onChange={(event) => change({ size: event.target.value })}><option>Compact</option><option>Default</option><option>Large</option><option>Extra large</option></select></label></div></section>
      <section className="panel setting-card"><div className="setting-icon">♧</div><div className="setting-body"><h2>Notifications</h2><p>Show a dot on the bell when there is new activity.</p><label className="setting-check"><input type="checkbox" checked={settings.emailNotifications} onChange={(event) => change({ emailNotifications: event.target.checked })} />Enable notifications</label></div></section>
      <section className="panel setting-card"><div className="setting-icon">▣</div><div className="setting-body"><h2>Account settings</h2><p>Store the email associated with this browser workspace.</p><label className="setting-field">Email address<input type="email" value={settings.email} onChange={(event) => change({ email: event.target.value })} placeholder="you@example.com" /></label>{emailInvalid && <small className="file-error">That email address does not look right.</small>}</div></section>
    </div>
    <div className="settings-actions"><button type="button" className="secondary-button" onClick={() => { onReset(); setSavedAt(nowTime()); }}>Reset to defaults</button>{savedAt && <span className="success-note">Saved at {savedAt}</span>}</div>
  </div>;
}

const HELP_TOC = [
  ['about', 'What is LexiLab?'], ['who', 'Who can use it'], ['start', 'Quick start'], ['files', 'Files and privacy'],
  ['overview', 'Overview page'], ['chat', 'Chat with Documents'], ['intelligence', 'Document Intelligence'], ['summary', 'Smart Summarizer'],
  ['compare', 'Document Comparison'], ['writing', 'Writing Studio'], ['history', 'History'], ['settings', 'Settings'],
  ['topbar', 'Top bar and sidebar'], ['limits', 'What it cannot do'], ['faq', 'Questions and fixes'],
];

const HELP_AUDIENCE = [
  ['Students', 'Revise long readings, find where a topic is explained and pull out key points before an exam.'],
  ['Researchers', 'Skim papers and reports, spot the main keywords and dates, and compare two drafts.'],
  ['Business professionals', 'Summarise reports and meeting notes, and see what changed between two versions of a document.'],
  ['Writers and editors', 'Tidy grammar, simplify wording, change tone and check what was edited between drafts.'],
  ['Job seekers and learners', 'Turn study material or interview-question PDFs into quick answers and short summaries.'],
  ['Anyone with long documents', 'If you have a PDF, Word file or text file you do not want to read line by line, this is for you.'],
];

const HELP_GUIDES = [
  { id: 'overview', icon: '⌂', title: 'Overview', does: 'Your home screen. It shows how much you have done in this browser and gives one-click shortcuts to every tool.', steps: ['Read the four counters: documents uploaded, total actions, summaries generated and comparisons run.', 'Use the Quick Actions cards to jump straight to Analyse, Chat, Summarise or Compare.', 'Check Recent Documents and Recent Activity, then press View all to open History.'], best: 'Getting back into your work quickly and seeing what you did last.', notes: ['The counters come from your History, which is stored in this browser only.'] },
  { id: 'chat', icon: '◌', title: 'Chat with Documents', does: 'Ask questions about a document in plain words. LexiLab finds the sentences in your file that best match the question and shows which page they came from.', steps: ['Open the page. A built-in sample document is shown so you can try it straight away.', 'Press New analysis, the document name or the ＋ button to upload your own PDF, DOCX or TXT.', 'Type a question, or press one of the suggested questions.', 'Read the answer and press a “Source: Page N” tag to jump to that page in the viewer.', 'Use the ‹ › arrows to change page and − ＋ to zoom the page in or out.', 'Use the three buttons above the chat: copy the conversation, download it as a .txt file, or show details about the document.'], best: 'Finding where something is said, checking a fact, and studying with questions and answers.', notes: ['It works best when your question uses words that appear in the document.', 'Questions like “what is this document about?” or “summarise” return the opening of the document.', 'If nothing matches, it tells you so instead of guessing.'] },
  { id: 'intelligence', icon: '✦', title: 'Document Intelligence', does: 'Gives you a quick profile of a document before you read it: size, topic, important words, and the people, places, dates and amounts it mentions.', steps: ['Upload a file by dragging it onto the box or pressing Browse files.', 'Overview shows pages, words, reading time, language, main topic, top keywords and entity counts.', 'Keywords lists the most frequent words and phrases with how often each appears.', 'Entities lists people, organisations, locations, dates and money amounts that were found.', 'Topics shows the most repeated phrases as bars so you can see the main themes.', 'Insights shows the key sentences plus statistics such as average sentence length and unique words.'], best: 'Deciding whether a long document is worth reading, and spotting its main themes, dates and figures.', notes: ['Entities are found with simple pattern rules, so treat them as helpful hints and not exact results.', 'Language detection recognises English only.', 'Until you upload a file, this page analyses the sample document.'] },
  { id: 'summary', icon: '▤', title: 'Smart Summarizer', does: 'Creates a shorter version of your document by picking its most important sentences and keeping them in reading order.', steps: ['Upload a document (Upload Document button or drag and drop).', 'Choose a summary type: Quick, Detailed, Bullet Points, Executive or Chapter-wise.', 'Choose a length: Short (about 100 words), Medium (about 250) or Long (about 500).', 'Press Generate Summary.', 'Read the summary and the Key Takeaways, then press Copy or Download to keep it.'], best: 'Reports, articles, study notes and any long text where you want the main points fast.', notes: ['It selects existing sentences. It does not rewrite them, so nothing is invented.', 'A very short document may come back almost in full because there is little to cut.', 'Chapter-wise groups the summary by page for PDFs, and by parts for DOCX and TXT files.'] },
  { id: 'compare', icon: '◫', title: 'Document Comparison', does: 'Compares two documents and tells you how similar they are and what was added or removed.', steps: ['Press the first box and choose the original document.', 'Press the second box and choose the newer one. Use ⇄ to swap them if you picked them the wrong way round.', 'Press Compare.', 'Read the similarity percentage, the number of added and removed words, and examples of new lines in the second document.'], best: 'Two versions of a report, policy, resume or essay, when you need to see what changed.', notes: ['It compares words and lines, not fonts, layout or formatting.', 'Similarity is the share of unique words the two files have in common.', 'Two unrelated documents will simply show a low similarity.'] },
  { id: 'writing', icon: '✎', title: 'Writing Studio', does: 'Cleans up and reshapes text you type or paste. It does not need a file.', steps: ['Type or paste text into Original Text.', 'Pick an action: Rewrite, Simplify Text, Fix Grammar or Convert to Bullet Points.', 'For Rewrite, also pick a tone: Professional, Friendly or Concise.', 'Press Generate and read the result on the right.', 'Press Copy to use it. Word and character counts are shown under each box.'], best: 'Emails, notes, assignments and quick polishing of drafts.', notes: ['It follows fixed editing rules (contractions, wording swaps, common typos, spacing and capital letters). It is not an AI model, so always read the result before using it.', 'If nothing needed changing, it says so.'] },
  { id: 'history', icon: '◴', title: 'History', does: 'A log of what you have done: uploads, questions asked, summaries and comparisons, with the date and time of each.', steps: ['Open History from the sidebar, or type in the search box at the top to filter it.', 'Press ✕ on a row to remove one item, or Clear all to empty the list.'], best: 'Remembering which documents you worked on and what you did with them.', notes: ['History is saved in this browser only and keeps the latest 100 items.', 'It stores names and actions, not the contents of your files, so upload a file again to continue working on it.', 'Clear all cannot be undone.'] },
  { id: 'settings', icon: '⚙', title: 'Settings', does: 'Lets you personalise the app. Every change applies instantly and is remembered in this browser.', steps: ['Display name: the first letter appears in the avatar at the top right.', 'Theme: Light, Dark or System default (follows your device).', 'Interface size: Compact, Default, Large or Extra large, if the text feels too small or too big.', 'Notifications: switch the dot on the bell on or off.', 'Email address: stored for your reference and checked for a valid format.', 'Reset to defaults puts everything back to how it started.'], best: 'Making the app comfortable to read and look at.', notes: ['Settings do not follow you to another browser or device.'] },
];

function HelpPage({ setActive }) {
  const jump = (id) => { const target = document.getElementById(`help-${id}`); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return <div className="page-content"><PageHeader eyebrow="Help centre" title="How LexiLab works." subtitle="A complete guide to every page, who it is for and what to expect." />
    <div className="help-layout">
      <nav className="help-toc" aria-label="Help contents">{HELP_TOC.map(([id, label]) => <button type="button" key={id} onClick={() => jump(id)}>{label}</button>)}</nav>
      <div className="help-content">
        <section className="panel help-section" id="help-about"><h2>What is LexiLab?</h2><p>LexiLab is a document workspace that runs in your web browser. You open a PDF, Word (.docx) or text file and it helps you understand it faster: ask questions about it, see its keywords and key facts, get a summary, compare it with another version, and clean up your own writing.</p><p>There is no account to create and nothing to install. LexiLab works by finding and ranking the sentences that are already in your document, so what you see is always taken from your own text. It does not use a generative AI model, which means it never makes things up, but it also does not rewrite or reason beyond what your document says.</p></section>
        <section className="panel help-section" id="help-who"><h2>Who can use it</h2><p>Anyone who reads or writes long documents. Typical uses:</p><div className="help-audience">{HELP_AUDIENCE.map(([name, text]) => <div key={name}><b>{name}</b><span>{text}</span></div>)}</div></section>
        <section className="panel help-section" id="help-start"><h2>Quick start</h2><ol><li>Open <b>Chat with Documents</b> and try the built-in sample, or press <b>New analysis</b> and choose your own file.</li><li>Wait a moment while the text is read. A small message tells you when it is ready.</li><li>Ask a question in the chat, or switch to <b>Document Intelligence</b> or <b>Smart Summarizer</b> in the sidebar. The same uploaded file is used on those pages.</li><li>Use <b>Document Comparison</b> when you have two files, and <b>Writing Studio</b> when you just have text.</li></ol></section>
        <section className="panel help-section" id="help-files"><h2>Files and privacy</h2><p><b>Supported:</b> PDF files with selectable text, Word files (.docx) and plain text files (.txt), up to 25 MB each.</p><p><b>Not supported:</b> scanned PDFs that are only pictures of pages (there is no text to read), password-protected files, and the older Word .doc format. Save a .doc as .docx first.</p><p><b>Privacy:</b> your files are read inside your browser and are not sent to any server. Your settings and history are saved in this browser&apos;s local storage. They do not move to another browser or device, and clearing your browser data removes them.</p></section>
        {HELP_GUIDES.map((guide) => <section className="panel help-section help-guide" id={`help-${guide.id}`} key={guide.id}>
          <div className="help-guide-head"><span className="help-guide-icon">{guide.icon}</span><h2>{guide.title}</h2></div>
          <p>{guide.does}</p>
          <div className="help-label">How to use it</div><ol>{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <div className="help-label">Best for</div><p>{guide.best}</p>
          <div className="help-label">Good to know</div><ul>{guide.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          <button type="button" className="secondary-button help-open" onClick={() => setActive(guide.id)}>Open {guide.title}</button>
        </section>)}
        <section className="panel help-section" id="help-topbar"><h2>Top bar and sidebar</h2><ul><li><b>Search box:</b> filters your History as you type.</li><li><b>Bell:</b> shows your latest activity. A dot appears when there is something new (you can turn the dot off in Settings).</li><li><b>Avatar:</b> opens Settings.</li><li><b>New Analysis:</b> takes you to Document Intelligence to start with a fresh file.</li><li><b>Arrow at the top of the sidebar:</b> collapses the sidebar to give you more room.</li></ul></section>
        <section className="panel help-section" id="help-limits"><h2>What it cannot do</h2><ul><li>It does not generate new text with AI. Answers and summaries are sentences picked from your document.</li><li>It cannot read text inside images or scanned pages.</li><li>It cannot open .doc, password-protected or damaged files.</li><li>It does not store your files or sync across devices.</li><li>Entity detection, language detection and the Writing Studio use simple rules, so results are helpful but not perfect.</li></ul></section>
        <section className="panel help-section" id="help-faq"><h2>Questions and fixes</h2>
          <h3>Is my document uploaded anywhere?</h3><p>No. It is read inside your browser and is gone when you close or refresh the page.</p>
          <h3>My PDF says it could not be read.</h3><p>The message includes the reason. The most common causes are a scanned PDF with no selectable text, a password-protected file, or a damaged file. Try exporting it again, or saving the content as a .docx or .txt file.</p>
          <h3>The chat answered with a sentence copied from my document.</h3><p>That is how it works. It finds the best matching sentences and shows their page. Try using specific words from the document for sharper answers.</p>
          <h3>The text is too small or too big.</h3><p>Open Settings and change Interface size.</p>
          <h3>How do I start over?</h3><p>Use Reset to defaults in Settings, Clear all in History, or clear this site&apos;s data in your browser.</p>
        </section>
      </div>
    </div></div>;
}

function App() {
  const [active, setActive] = useState('chat');
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [documentText, setDocumentText] = useState('');
  const [documentPages, setDocumentPages] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [fileError, setFileError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [notifOpen, setNotifOpen] = useState(false);
  const fileInput = useRef(null);
  const totalPages = documentPages.length || SAMPLE_PAGES.length;
  const goToPage = (n) => setCurrentPage(Math.min(Math.max(1, n), totalPages));
  const changeZoom = (delta) => setZoom((z) => Math.min(200, Math.max(50, z + delta)));

  const [settings, setSettings] = useState(loadSettings);
  const updateSettings = (patch) => setSettings((current) => {
    const next = { ...current, ...patch };
    try { localStorage.setItem('lexilab-settings', JSON.stringify(next)); } catch (error) { /* storage unavailable */ }
    return next;
  });
  const [systemDark, setSystemDark] = useState(() => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => setSystemDark(event.matches);
    if (query.addEventListener) query.addEventListener('change', listener);
    return () => { if (query.removeEventListener) query.removeEventListener('change', listener); };
  }, []);
  const darkMode = settings.theme === 'Dark' || (settings.theme === 'System default' && systemDark);
  const scale = SIZE_SCALE[settings.size] || SIZE_SCALE.Default;
  useEffect(() => { document.body.style.background = darkMode ? '#18172a' : '#f7f6fd'; }, [darkMode]);

  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem('lexilab-history') || '[]'); } catch (error) { return []; } });
  useEffect(() => { try { localStorage.setItem('lexilab-history', JSON.stringify(history)); } catch (error) { /* storage unavailable */ } }, [history]);
  const addHistory = (name, type, status = 'Complete') => setHistory((items) => [{ name, type, status, extension: fileExtension(name), date: new Date().toLocaleString() }, ...items].slice(0, 100));
  const deleteHistory = (index) => setHistory((items) => items.filter((_item, position) => position !== index));
  const clearHistory = () => setHistory([]);
  const [seenCount, setSeenCount] = useState(() => Number(localStorage.getItem('lexilab-seen') || 0));
  const unread = Math.max(0, history.length - seenCount);
  const toggleNotifications = () => { const next = !notifOpen; setNotifOpen(next); if (next) { setSeenCount(history.length); try { localStorage.setItem('lexilab-seen', String(history.length)); } catch (error) { /* ignore */ } } };

  const [messages, setMessages] = useState([{ type: 'ai', text: 'Ask me anything about the sample document, or upload your own PDF, DOCX or TXT file to chat with it.', source: 'LexiLab', time: nowTime() }]);
  useEffect(() => { if (selectedFile) setMessages([{ type: 'ai', text: isExtracting ? `Reading ${selectedFile.name}…` : `Now chatting with ${selectedFile.name}. Ask a question about the uploaded document.`, source: isExtracting ? 'Preparing document' : 'Uploaded document', time: nowTime() }]); }, [selectedFile, isExtracting]);

  useEffect(() => { window.scrollTo(0, 0); }, [active]);

  const openFile = () => { setFileError(''); fileInput.current?.click(); };
  const handleFile = async (file) => {
    if (!file) return;
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'docx', 'txt'].includes(extension)) { setSelectedFile(null); setDocumentText(''); setDocumentPages([]); setFileError(extension === 'doc' ? 'Old .doc files cannot be read in the browser. Please save it as .docx, PDF or TXT.' : 'Unsupported file type. Please choose a PDF, DOCX or TXT document.'); return; }
    if (file.size > 25 * 1024 * 1024) { setSelectedFile(null); setDocumentText(''); setDocumentPages([]); setFileError('This file is larger than 25MB. Please choose a smaller document.'); return; }
    setSelectedFile(file); setDocumentText(''); setDocumentPages([]); setCurrentPage(1); setZoom(100); setFileError('');
    addHistory(file.name, 'Uploaded', 'Ready');
    setIsExtracting(true);
    try {
      if (extension === 'pdf') {
        const pageTexts = await extractPdfPages(await file.arrayBuffer());
        if (!pageTexts.some((text) => text.trim())) { setFileError('This PDF has no selectable text (it may be a scanned image), so it cannot be read in the browser.'); setSelectedFile(null); } else { setDocumentText(pageTexts.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join('\n\n')); setDocumentPages(pageTexts); }
      } else if (extension === 'txt') {
        const raw = await file.text(); setDocumentText(raw); setDocumentPages(splitIntoPages(raw));
      } else {
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        const raw = result.value || ''; setDocumentText(raw || 'No text was found in this DOCX file.'); setDocumentPages(splitIntoPages(raw));
      }
    } catch (error) {
      console.error('Document read error:', error);
      setFileError(`We could not read this document in the browser (${error?.message || 'unknown error'}). Please try another PDF, DOCX or TXT file.`);
    } finally { setIsExtracting(false); }
  };
  const handleDrop = (event) => { event.preventDefault(); handleFile(event.dataTransfer.files?.[0]); };
  const onSearch = (value) => { setSearch(value); if (value.trim()) setActive('history'); };

  const pageTitle = active === 'chat' ? 'Chat with Documents' : navItems.find((item) => item[0] === active)?.[1] || 'Workspace';
  const page = active === 'overview' ? <Overview setActive={setActive} openFile={openFile} records={history} />
    : active === 'intelligence' ? <Intelligence openFile={openFile} selectedFile={selectedFile} fileError={fileError} onDrop={handleDrop} documentPages={documentPages} isExtracting={isExtracting} />
    : active === 'summary' ? <SummaryPage openFile={openFile} selectedFile={selectedFile} documentText={documentText} fileError={fileError} onDrop={handleDrop} documentPages={documentPages} onSummary={(name, type) => addHistory(name, `Summarised · ${type}`)} />
    : active === 'compare' ? <Comparison onCompared={(a, b) => addHistory(`${a} vs ${b}`, 'Compared')} />
    : active === 'writing' ? <WritingStudio />
    : active === 'history' ? <History search={search} records={history} onDelete={deleteHistory} onClear={clearHistory} />
    : active === 'help' ? <HelpPage setActive={setActive} />
    : active === 'settings' ? <Settings settings={settings} onChange={updateSettings} onReset={() => updateSettings(DEFAULT_SETTINGS)} />
    : <div className="workspace">
      <div className="workspace-heading"><div><p className="eyebrow">{pageTitle}</p><h1>Understand. Analyze. Transform.</h1><p className="subheading">Ask questions, discover insights and turn every document into clear next steps.</p></div><button className="primary-button" onClick={openFile}><Icon>＋</Icon>New analysis</button></div>
      <div className="document-toolbar">
        <button type="button" className="document-select" title="Choose another document" onClick={openFile}><span className="pdf-badge">{selectedFile ? fileExtension(selectedFile.name) : 'PDF'}</span>{selectedFile?.name || 'AI_History_Review.pdf'} <span>⌄</span></button>
        <div className="page-control"><button type="button" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>‹</button><b>{currentPage}</b><span>/ {totalPages}</span><button type="button" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => goToPage(currentPage + 1)}>›</button></div>
        <div className="zoom-control"><button type="button" aria-label="Zoom out" disabled={zoom <= 50} onClick={() => changeZoom(-10)}>−</button><span>{zoom}%</span><button type="button" aria-label="Zoom in" disabled={zoom >= 200} onClick={() => changeZoom(10)}>＋</button></div>
      </div>
      <div className="content-grid">
        <section className="preview-panel"><div className="preview-scroll"><DocumentPage documentFile={selectedFile} documentText={documentText} documentPages={documentPages} currentPage={currentPage} zoom={zoom} isExtracting={isExtracting} /></div></section>
        <ChatPanel messages={messages} setMessages={setMessages} pages={documentPages.length ? documentPages : SAMPLE_PAGES} isExtracting={isExtracting} onJumpToPage={goToPage} onAttach={openFile} fileName={selectedFile?.name || 'AI_History_Review.pdf (sample)'} onAsk={(question) => addHistory(selectedFile?.name || 'AI_History_Review.pdf', `Asked · ${question.length > 40 ? `${question.slice(0, 40)}…` : question}`)} />
      </div>
    </div>;

  return <div className={`app-shell ${darkMode ? 'theme-dark' : ''}`} style={{ zoom: scale, minHeight: `calc(100vh / ${scale})` }}>
    <Sidebar active={active} setActive={setActive} collapsed={collapsed} setCollapsed={setCollapsed} onHelp={() => setActive('help')} />
    <main className="main-content">
      <header className="topbar">
        <div className="mobile-title"><div className="brand-mark"><span>⌬</span></div><b>LexiLab</b></div>
        <label className="search-box"><Icon>⌕</Icon><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search documents and activity..." /></label>
        <div className="top-actions">
          <div className="notif-wrap">
            <button type="button" aria-label="Notifications" onClick={toggleNotifications}>♧{settings.emailNotifications && unread > 0 && <span className="notification-dot" />}</button>
            {notifOpen && <><div className="notif-backdrop" onClick={() => setNotifOpen(false)} /><div className="notif-popover" role="dialog" aria-label="Notifications"><strong>Notifications</strong>{history.length ? history.slice(0, 5).map((item, index) => <div className="notif-item" key={`${item.name}-${item.date}-${index}`}><span>{item.type}</span><small>{item.name} · {item.date}</small></div>) : <p>You are all caught up. New activity will show here.</p>}<button type="button" className="text-link" onClick={() => { setNotifOpen(false); setSearch(''); setActive('history'); }}>View all activity</button></div></>}
          </div>
          <button type="button" className="avatar" aria-label="Open profile settings" title={settings.name || 'Profile'} onClick={() => setActive('settings')}>{initialOf(settings.name)}</button>
        </div>
      </header>
      <input ref={fileInput} type="file" accept=".pdf,.docx,.txt" hidden onChange={(event) => { handleFile(event.target.files?.[0]); event.target.value = ''; }} />
      {page}
    </main>
  </div>;
}

export default App;
