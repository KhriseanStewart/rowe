import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ChatMarkdownProps = {
  text: string
  tone: 'user' | 'assistant'
}

function ChatMarkdown({ text, tone }: ChatMarkdownProps): React.JSX.Element {
  return (
    <div className={tone === 'user' ? 'chat-md chat-md-user' : 'chat-md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default ChatMarkdown
