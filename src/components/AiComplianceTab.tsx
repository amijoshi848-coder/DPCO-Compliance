import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Globe,
  Loader2,
  Search,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type {
  AiChatHistoryTurn,
  AiGroundingSource,
  GlobalSearchResponse,
  GlobalSearchResultItem,
  SearchResultCategory,
} from '../types/compliance';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: AiGroundingSource[];
  timestamp: string;
}

interface AiComplianceTabProps {
  onNavigateToResult: (
    tab: 'schedule_formulations' | 'retail_prices' | 'new_product',
    searchKeyword: string,
    category?: SearchResultCategory
  ) => void;
}

const STARTER_PROMPTS = [
  'Summarize all active Ceiling Prices and recent price revisions in our registry.',
  'If we already manufacture Atorvastatin 10mg Tablet, what Form I & Form 1A steps apply to launching Atorvastatin 10mg + Ranitidine 20mg?',
  'List post-16 July 2026 Retail Price circulars available for Form 1A reference and their expiry windows.',
  'Search latest NPPA ceiling price revision circulars and DPCO 2013 Para 11 guidelines.',
];

const CATEGORY_LABELS: Array<{ id: 'all' | SearchResultCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'ceiling', label: 'Ceiling' },
  { id: 'retail', label: 'Retail (1A)' },
  { id: 'nlem', label: 'NLEM 2022' },
  { id: 'nppa_log', label: 'NPPA Logs' },
  { id: 'history', label: 'History' },
];

function categoryStyle(category: SearchResultCategory): {
  label: string;
  className: string;
} {
  switch (category) {
    case 'ceiling':
      return {
        label: 'Ceiling Price',
        className: 'bg-[#EEF2FF] text-indigo-900 border-indigo-200',
      };
    case 'retail':
      return {
        label: 'Retail Price (1A)',
        className: 'bg-[#ECFDF5] text-emerald-900 border-emerald-200',
      };
    case 'nlem':
      return {
        label: 'NLEM 2022',
        className: 'bg-[#F5F3FF] text-violet-900 border-violet-200',
      };
    case 'nppa_log':
      return {
        label: 'NPPA Circular / Minutes',
        className: 'bg-[#FFF7ED] text-orange-900 border-orange-200',
      };
    case 'history':
      return {
        label: 'Revision Log',
        className: 'bg-[#FFF1F2] text-rose-900 border-rose-200',
      };
  }
}

function cleanBulletLines(text: string) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-slate-800">
      {lines.map((rawLine, idx) => {
        const trimmed = rawLine.trim();
        if (!trimmed) return <div key={idx} className="h-1" />;

        const isBullet = /^([-*]|\d+\.)\s+/.test(trimmed);
        const content = isBullet ? trimmed.replace(/^([-*]|\d+\.)\s+/, '') : trimmed;

        const parts = content.split(/(\*\*[^*]+\*\*)/g);
        const rendered = parts.map((part, pIdx) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return (
              <strong key={pIdx} className="font-semibold text-slate-900">
                {part.slice(2, -2)}
              </strong>
            );
          }
          return <React.Fragment key={pIdx}>{part}</React.Fragment>;
        });

        if (isBullet) {
          return (
            <div key={idx} className="flex items-start gap-2 pl-1.5">
              <span className="text-indigo-700 font-semibold mt-0.5">•</span>
              <div className="flex-1">{rendered}</div>
            </div>
          );
        }

        if (trimmed.startsWith('### ') || trimmed.startsWith('## ')) {
          return (
            <h4 key={idx} className="font-display font-semibold text-indigo-950 pt-1">
              {trimmed.replace(/^#+\s+/, '')}
            </h4>
          );
        }

        return <p key={idx}>{rendered}</p>;
      })}
    </div>
  );
}

export default function AiComplianceTab({ onNavigateToResult }: AiComplianceTabProps) {
  // Unified Search State
  const [searchQuery, setSearchQuery] = useState('Atorvastatin');
  const [searchCategory, setSearchCategory] = useState<'all' | SearchResultCategory>('all');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GlobalSearchResultItem[]>([]);
  const [totalHits, setTotalHits] = useState(0);

  // AI Assistant State
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [promptInput, setPromptInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-ai',
      role: 'assistant',
      text: 'Ask any regulatory question across your **Ceiling Prices**, **Form 1A Retail Prices**, **NLEM 2022 schedule**, **Existing Manufacturer Form I rules**, or enable **Live Web Search** to query recent NPPA notifications and DPCO 2013 circulars.',
      timestamp: new Date().toISOString(),
    },
  ]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setTotalHits(0);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch<GlobalSearchResponse>(
          `/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(searchCategory)}`
        );
        if (!cancelled) {
          setSearchResults(res.results);
          setTotalHits(res.total);
        }
      } catch {
        if (!cancelled) {
          setSearchResults([]);
          setTotalHits(0);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchCategory]);

  async function sendQuestion(customPrompt?: string) {
    const text = (customPrompt ?? promptInput).trim();
    if (!text || asking) return;

    setAiError(null);
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    };
    const nextHistory: AiChatHistoryTurn[] = messages
      .filter((m) => m.id !== 'welcome-ai')
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    if (!customPrompt) setPromptInput('');
    setAsking(true);

    try {
      const res = await apiFetch<{ reply: string; sources: AiGroundingSource[] }>('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          history: nextHistory,
          useWebSearch,
        }),
      });
      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: res.reply,
        sources: res.sources,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to reach AI compliance service.');
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left: Unified Cross-Registry Search */}
      <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
        <div className="pb-4 border-b border-slate-200">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Unified Registry Search
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Search simultaneously across Ceiling Prices, Retail Prices (Form 1A), NLEM 2022, NPPA Circulars, and Revision History.
          </p>
        </div>

        <div className="mt-4 relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search medicine, S.O. number, NLEM section..."
            className="w-full pl-9 pr-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {CATEGORY_LABELS.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSearchCategory(cat.id)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                searchCategory === cat.id
                  ? 'bg-[#EEF2FF] text-indigo-950 border-indigo-200 font-semibold'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
          <span>
            {searching
              ? 'Searching compliance registry…'
              : searchQuery.trim()
                ? `${totalHits} match(es) across registry`
                : 'Enter a keyword to search'}
          </span>
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-indigo-700 hover:underline font-medium cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mt-3 space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
          {searchResults.length === 0 && !searching && searchQuery.trim() ? (
            <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg">
              No matching entries in your local registry. Try asking the AI Assistant with Live Web Search enabled.
            </div>
          ) : (
            searchResults.map((hit) => {
              const badge = categoryStyle(hit.category);
              return (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() =>
                    onNavigateToResult(hit.tabTarget, hit.searchKeyword, hit.category)
                  }
                  className="w-full text-left p-3.5 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-[#FBFBFF] transition-colors cursor-pointer group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded border ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-indigo-700 shrink-0" />
                  </div>
                  <div className="text-sm font-semibold text-slate-900 mt-1.5">
                    {hit.title}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5 line-clamp-2">
                    {hit.subtitle}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 mt-1.5 tabular-nums">
                    {hit.meta}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* Right: AI Compliance Assistant + Live NPPA Web Search Grounding */}
      <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl flex flex-col min-h-[660px]">
        <div className="p-6 pb-4 border-b border-indigo-100 bg-[#FBFBFF] rounded-t-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-700" />
              <h2 className="font-display text-lg font-semibold text-indigo-950">
                DPCO Compliance AI Assistant
              </h2>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              Grounded in your live NPPA registry, NLEM 2022 schedule, company portfolio, and optional Google Web Search.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setUseWebSearch((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                useWebSearch
                  ? 'bg-[#ECFDF5] text-emerald-900 border-emerald-200'
                  : 'bg-white text-slate-600 border-slate-300'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              {useWebSearch ? 'Web Search: On' : 'Web Search: Off'}
            </button>
            <button
              type="button"
              onClick={() =>
                setMessages((prev) => prev.slice(0, 1))
              }
              title="Clear conversation"
              className="p-1.5 text-slate-500 hover:text-rose-700 border border-slate-200 bg-white rounded-lg cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Starter Prompts */}
        <div className="px-6 py-3 bg-[#F5F3FF]/60 border-b border-violet-100">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-950 mb-2">
            Quick Compliance Prompts
          </div>
          <div className="flex flex-wrap gap-2">
            {STARTER_PROMPTS.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                disabled={asking}
                onClick={() => void sendQuestion(prompt)}
                className="text-left px-3 py-1.5 text-xs font-medium text-indigo-950 bg-white hover:bg-[#EEF2FF] border border-indigo-100 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation Feed */}
        <div className="flex-1 p-6 space-y-4 overflow-y-auto max-h-[420px]">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-xl p-4 border ${
                msg.role === 'user'
                  ? 'bg-[#EEF2FF] border-indigo-100 ml-6'
                  : 'bg-white border-slate-200 mr-2'
              }`}
            >
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500 mb-1.5">
                <span className={msg.role === 'user' ? 'text-indigo-900' : 'text-violet-900'}>
                  {msg.role === 'user' ? 'You' : 'DPCO Compliance AI'}
                </span>
                <span className="font-mono tabular-nums">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {msg.role === 'user' ? (
                <p className="text-sm text-slate-900">{msg.text}</p>
              ) : (
                cleanBulletLines(msg.text)
              )}

              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                    Verified Web Sources
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {msg.sources.map((src, sIdx) => (
                      <a
                        key={sIdx}
                        href={src.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-900 bg-[#EEF2FF] hover:bg-indigo-100 border border-indigo-100 rounded-md"
                      >
                        <span className="max-w-[220px] truncate">{src.title}</span>
                        <ArrowUpRight className="w-3 h-3 shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}

          {asking && (
            <div className="rounded-xl p-4 border border-violet-100 bg-[#F5F3FF]/60 flex items-center gap-2.5 text-xs font-medium text-violet-950">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-700" />
              Analyzing registry records{useWebSearch ? ' and searching NPPA/web references' : ''}…
            </div>
          )}

          {aiError && (
            <div className="rounded-xl p-3.5 border border-rose-200 bg-[#FFF1F2] text-xs text-rose-900">
              {aiError}
            </div>
          )}
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendQuestion();
          }}
          className="p-4 border-t border-slate-200 bg-[#FBFBFF] rounded-b-xl flex items-center gap-3"
        >
          <input
            type="text"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder="Ask about ceiling prices, Form I, Form 1A, NLEM 2022, or NPPA circulars..."
            className="flex-1 px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
          />
          <button
            type="submit"
            disabled={asking || !promptInput.trim()}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 disabled:opacity-60 cursor-pointer shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            Ask AI
          </button>
        </form>
      </section>
    </div>
  );
}
