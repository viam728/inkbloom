import React, { useRef, useEffect, useState } from 'react';
import { Send, Sparkles, Trash2, Mic, MicOff } from 'lucide-react';
import { useAIStore } from '@/stores/ai-store';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import MessageBubble from './MessageBubble';
import ModelSelector from './ModelSelector';

/** 空状态下的灵感建议词 */
const SUGGESTIONS = [
  '帮我为反派设计一个反转动机',
  '润色一段打斗场面描写',
  '给主角设计一段内心独白',
  '构思下一章的情节走向',
];

/** 对话内「AI 起稿」入口：点击切换到全本创作工作流面板 */
const START_STORY_EVENT = 'inkbloom:open-story-workflow';

const AIChatPanel: React.FC = () => {
  const messages = useAIStore((s) => s.messages);
  const isStreaming = useAIStore((s) => s.isStreaming);
  const streamingContent = useAIStore((s) => s.streamingContent);
  const sendMessage = useAIStore((s) => s.sendMessage);
  const clearMessages = useAIStore((s) => s.clearMessages);

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 语音输入：转写结果增量追加到输入框
  const speechAccRef = useRef('');
  const speechBaseRef = useRef('');
  const { supported: speechSupported, listening, toggle: toggleSpeech } = useSpeechRecognition(
    (text, isFinal) => {
      if (isFinal) {
        speechAccRef.current += text;
        setInput(speechBaseRef.current + speechAccRef.current);
      }
    },
  );

  const handleToggleSpeech = () => {
    if (!listening) {
      speechBaseRef.current = input;
      speechAccRef.current = '';
    }
    toggleSpeech();
  };

  // 监听外部事件：灵感急救包等将内容投递到输入框
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text as string | undefined;
      if (text) {
        setInput(text);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener('inkbloom:chat-draft', handler);
    return () => window.removeEventListener('inkbloom:chat-draft', handler);
  }, []);

  // Auto-scroll to bottom when messages change or streaming updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [input]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/6">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shadow-md shadow-indigo-500/20">
            <Sparkles size={13} className="text-white" />
          </span>
          <span className="text-sm font-medium text-neutral-200">AI 助手</span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearMessages}
            className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="清空对话"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in-slow">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-pink-500/20 border border-white/8 flex items-center justify-center mb-4">
              <Sparkles size={22} className="text-brand-300" />
            </div>
            <p className="text-sm font-medium text-neutral-300 mb-1">你好！我是 AI 写作助手</p>
            <p className="text-xs text-neutral-500 mb-5">可以帮你构思情节、塑造角色、润色文字…</p>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent(START_STORY_EVENT))}
              className="w-full mb-3 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white text-sm font-medium flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-violet-600/20"
            >
              <Sparkles size={14} />
              AI 起稿 · 全本创作
            </button>
            <div className="flex flex-col gap-1.5 w-full px-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-left text-xs px-3 py-2 rounded-lg bg-white/4 border border-white/6 text-neutral-400 hover:text-brand-300 hover:border-brand-500/40 hover:bg-brand-500/8 transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {/* Streaming message */}
            {isStreaming && streamingContent && (
              <MessageBubble
                message={{
                  id: '__streaming__',
                  role: 'assistant',
                  content: streamingContent,
                  timestamp: new Date(),
                }}
                isStreaming
              />
            )}

            {/* Typing indicator when streaming but no content yet */}
            {isStreaming && !streamingContent && (
              <div className="flex justify-start mb-3 animate-fade-in">
                <div className="bg-surface-3 border border-white/6 text-neutral-200 rounded-lg rounded-bl-sm px-3 py-2 text-sm">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 一体化输入区：文本框 + 底部操作栏（模型选择 / 发送） */}
      <div className="px-3 pb-3 pt-1">
        <div className="rounded-xl bg-white/5 border border-white/10 focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/15 transition-all">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            rows={2}
            className="w-full bg-transparent text-neutral-200 text-sm px-3.5 pt-3 pb-1 outline-none resize-none placeholder-neutral-500"
          />
          {/* 底部操作栏 */}
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <ModelSelector />
              {speechSupported && (
                <button
                  onClick={handleToggleSpeech}
                  title={listening ? '停止语音输入' : '语音输入'}
                  className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full text-[11px] border transition-all ${
                    listening
                      ? 'bg-red-500/15 border-red-500/40 text-red-300 animate-pulse-soft'
                      : 'bg-white/4 border-white/8 text-neutral-500 hover:text-neutral-300 hover:border-white/15'
                  }`}
                >
                  {listening ? <MicOff size={12} /> : <Mic size={12} />}
                  {listening ? '收音中' : '语音'}
                </button>
              )}
            </div>
            <button
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
              title="发送"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:from-neutral-700 disabled:to-neutral-700 disabled:text-neutral-500 text-white transition-all shadow-lg shadow-indigo-600/20 disabled:shadow-none"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIChatPanel;
