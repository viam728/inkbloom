import React from 'react';
import type { AIMessage } from '@/types';
import DraftConfigCard from './cards/DraftConfigCard';
import DraftResultCard from './cards/DraftResultCard';

interface MessageBubbleProps {
  message: AIMessage;
  isStreaming?: boolean;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isStreaming }) => {
  // 带卡片的消息：外层保持 assistant 侧布局，内部按 kind 渲染结构化卡片
  if (message.card) return <CardMessage message={message} />;

  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-neutral-700 text-neutral-200 rounded-bl-sm'
        }`}
      >
        {message.content}
        {message.toolExecutions && message.toolExecutions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.toolExecutions.map((t, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/10 border border-white/10 text-neutral-300"
              >
                ⚙ {t.label}
              </span>
            ))}
          </div>
        )}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-neutral-300 ml-0.5 animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
};

/** 卡片消息：引导文案 + 工具徽章 + 结构化卡片（P0-1） */
const CardMessage: React.FC<{ message: AIMessage }> = ({ message }) => {
  const card = message.card!;
  return (
    <div className="flex justify-start mb-3">
      <div className="w-full max-w-[92%]">
        {message.content && (
          <div className="bg-neutral-700 text-neutral-200 rounded-lg rounded-bl-sm px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </div>
        )}
        {message.toolExecutions && message.toolExecutions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.toolExecutions.map((t, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/10 border border-white/10 text-neutral-300"
              >
                ⚙ {t.label}
              </span>
            ))}
          </div>
        )}
        <div className="mt-1.5">
          {card.kind === 'draft_config' ? (
            <DraftConfigCard messageId={message.id} card={card} />
          ) : (
            <DraftResultCard messageId={message.id} card={card} />
          )}
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;
