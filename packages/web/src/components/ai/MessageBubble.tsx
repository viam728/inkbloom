import React from 'react';
import type { AIMessage } from '@/types';

interface MessageBubbleProps {
  message: AIMessage;
  isStreaming?: boolean;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isStreaming }) => {
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

export default MessageBubble;
