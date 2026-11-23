import { useMemo, useRef, useState } from 'react';
import './App.css';

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

function Sidebar({ active, setActive, collapsed, setCollapsed }) {
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="brand-row"><div className="brand-mark"><span>⌬</span></div>{!collapsed && <span className="brand-name">Lexi<span>Lab</span></span>}<button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar">‹</button></div>
    <button className="new-analysis" onClick={() => setActive('intelligence')}><Icon>＋</Icon>{!collapsed && <span>New Analysis</span>}</button>
    <nav className="primary-nav" aria-label="Primary navigation">{navItems.map(([id, label, glyph]) => <button key={id} className={`nav-item ${active === id ? 'active' : ''}`} onClick={() => setActive(id)} title={label}><Icon>{glyph}</Icon>{!collapsed && <span>{label}</span>}</button>)}</nav>
    <div className="sidebar-spacer" />
    <button className="nav-item" onClick={() => setActive('history')} title="History"><Icon>◴</Icon>{!collapsed && <span>History</span>}</button>
    <button className="nav-item" onClick={() => setActive('settings')} title="Settings"><Icon>⚙</Icon>{!collapsed && <span>Settings</span>}</button>
    {!collapsed && <div className="sidebar-footer"><div className="help-icon">?</div><div><strong>Need help?</strong><small>Visit our help centre</small></div><span>›</span></div>}
  </aside>;
}

function DocumentPage() {
  return <div className="document-page"><div className="doc-issue">25th Anniversary Issue</div><h2>A (Very)<br />Brief History of<br />Artificial Intelligence</h2><div className="doc-author">Bruce G. Buchanan</div><div className="doc-columns"><p><b>▪</b> In this brief history, the beginnings of artificial intelligence are traced in philosophy, fiction, and mathematics. Early computer developments, leading into AI, and some of the main ideas that have sustained it since 1956 are described.</p><p><b>▪</b> The history of AI is a history of fantastical possibilities, of over-optimism, of frustration, of extreme success and of frustration. It is a story of the evolution of ideas.</p></div><div className="drop-cap">T</div><div className="doc-columns lower"><p>he field has grown from philosophical roots into a practical discipline. Problem solving, knowledge representation, learning, and expert systems remain central themes.</p><p>Research continues to evolve as new methods and technologies emerge, with each generation bringing fresh questions about intelligence and machines.</p></div><div className="doc-footer"><span>Copyright © 2005, American Association for Artificial Intelligence.</span><span>WINTER 2005 &nbsp; 5</span></div></div>;
}

function ChatPanel({ messages, setMessages }) {
  const [draft, setDraft] = useState('');
  const sendMessage = (text = draft) => { if (!text.trim()) return; setMessages((items) => [...items, { type: 'user', text: text.trim() }, { type: 'ai', text: 'This document traces the origins and evolution of artificial intelligence, from its philosophical roots to the foundational research ideas established in the mid-20th century.', source: 'Source: Page 1' }]); setDraft(''); };
  return <section className="chat-panel"><div className="chat-tools"><button aria-label="Share">⇧</button><button aria-label="Download">⇩</button><button aria-label="Info">ⓘ</button></div><div className="messages">{messages.map((message, index) => message.type === 'user' ? <div className="user-message" key={index}><div>{message.text}</div><time>10:24 AM</time></div> : <div className="ai-message" key={index}><div className="ai-avatar">✦</div><div className="ai-card"><p>{message.text}</p><span className="source-chip">▣ &nbsp;{message.source}</span><time>10:24 AM</time></div></div>)}<div className="suggested"><h3><Icon>✦</Icon> Suggested questions</h3>{suggestions.map((item) => <button key={item} onClick={() => sendMessage(item)}><Icon>◯</Icon>{item}</button>)}</div></div><form className="chat-input" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><button type="button" aria-label="Attach">⌕</button><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask anything about this document..." /><button className="send-button" type="submit" aria-label="Send">➤</button></form></section>;
}

function App() {
  const [active, setActive] = useState('chat'); const [collapsed, setCollapsed] = useState(false); const [search, setSearch] = useState(''); const fileInput = useRef(null);
  const [messages, setMessages] = useState([{ type: 'user', text: 'What is this document about?' }, { type: 'ai', text: 'This document provides a concise history of artificial intelligence (AI), covering its early philosophical and mathematical roots, key developments since 1956, and major research areas such as problem solving, knowledge representation, and expert systems.', source: 'Source: Page 1' }]);
  const filteredSuggestions = useMemo(() => suggestions.filter((item) => item.toLowerCase().includes(search.toLowerCase())), [search]); const pageTitle = active === 'chat' ? 'Chat with Documents' : navItems.find((item) => item[0] === active)?.[1] || 'Workspace';
  return <div className="app-shell"><Sidebar active={active} setActive={setActive} collapsed={collapsed} setCollapsed={setCollapsed} /><main className="main-content"><header className="topbar"><div className="mobile-title"><div className="brand-mark"><span>⌬</span></div><b>LexiLab</b></div><label className="search-box"><Icon>⌕</Icon><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents..." /></label><div className="top-actions"><button aria-label="Notifications">♧<span className="notification-dot" /></button><button className="avatar" aria-label="Open profile">R</button></div></header><div className="workspace"><div className="workspace-heading"><div><p className="eyebrow">{pageTitle}</p><h1>Understand. Analyze. Transform.</h1><p className="subheading">Ask questions, discover insights and turn every document into clear next steps.</p></div><button className="primary-button" onClick={() => fileInput.current?.click()}><Icon>＋</Icon>New analysis</button><input ref={fileInput} type="file" accept=".pdf,.doc,.docx,.txt" hidden /></div><div className="document-toolbar"><button className="document-select"><span className="pdf-badge">PDF</span>AI_History_Review.pdf <span>⌄</span></button><div className="page-control"><button>‹</button><b>1</b><span>/ 24</span><button>›</button></div><div className="zoom-control"><button>−</button><span>100%</span><button>＋</button></div></div><div className="content-grid"><section className="preview-panel"><div className="preview-scroll"><DocumentPage /></div></section><ChatPanel messages={messages} setMessages={setMessages} /></div>{filteredSuggestions.length === 0 && search && <div className="search-empty">No matching questions for “{search}”.</div>}</div></main></div>;
}

export default App;
