'use client'

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown for assistant replies.
 *
 * Models answer in markdown whether or not you asked them to, so rendering it
 * as plain text shows the user `**bold**` and `- item` verbatim. That is not a
 * cosmetic problem: numbered steps and code blocks stop being scannable.
 *
 * ── Two decisions worth stating ────────────────────────────────────────────
 *
 * 1. Every element is mapped explicitly rather than using a typography plugin.
 *    A plugin styles for an article; this is a chat bubble, and the spacing
 *    scale is different — tighter paragraphs, looser lists, and no top margin
 *    on the first child or every reply starts with a gap.
 *
 * 2. `memo` on the message content. During streaming the parent re-renders on
 *    every token, and re-parsing the whole markdown tree each time is the one
 *    thing here that could make a long reply stutter. The comparison is on the
 *    string, so a token that does not change the text costs nothing.
 *
 * No `rehype-raw`: raw HTML from a model output is not rendered. react-markdown
 * escapes it by default and that default is load-bearing — the text being
 * rendered came from a third party.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,

        strong: ({ children }) => (
          <strong className="font-semibold text-text">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => <del className="text-faint line-through">{children}</del>,

        // `list-outside` with padding, so wrapped lines align under the text
        // rather than under the bullet.
        ul: ({ children }) => (
          <ul className="mb-4 list-outside list-disc space-y-1.5 pl-5 last:mb-0 marker:text-faint">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-4 list-outside list-decimal space-y-1.5 pl-5 last:mb-0 marker:text-faint">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="pl-1 leading-[1.7]">{children}</li>,

        h1: ({ children }) => (
          <h1 className="mb-3 mt-6 text-lg font-semibold first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 mt-6 text-base font-semibold first:mt-0">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mb-2 mt-5 text-[15px] font-semibold first:mt-0">{children}</h3>
        ),

        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            // `noreferrer` alongside `noopener`: the destination is model
            // output, so it should not learn where the user came from.
            rel="noopener noreferrer"
            className="text-clay underline decoration-clay/35 underline-offset-2 hover:decoration-clay"
          >
            {children}
          </a>
        ),

        blockquote: ({ children }) => (
          <blockquote className="mb-4 border-l-2 border-line pl-4 text-muted last:mb-0">
            {children}
          </blockquote>
        ),

        hr: () => <hr className="my-6 border-line" />,

        code: ({ className, children, ...props }) => {
          // react-markdown gives inline and fenced code the same component.
          // A language class means it came from a fence.
          const fenced = /language-(\w+)/.exec(className ?? '')

          if (!fenced) {
            return (
              <code
                className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-text"
                {...props}
              >
                {children}
              </code>
            )
          }

          return (
            <code className="block font-mono text-[13px] leading-relaxed" {...props}>
              {children}
            </code>
          )
        },

        pre: ({ children }) => (
          // `overflow-x-auto` on the block, never on the page. A long line of
          // code must not make the whole conversation scroll sideways.
          <pre className="mb-4 overflow-x-auto rounded-xl border border-line bg-surface p-3.5 last:mb-0">
            {children}
          </pre>
        ),

        // GFM tables. Same rule as code: the table scrolls, the page does not.
        table: ({ children }) => (
          <div className="mb-4 overflow-x-auto last:mb-0">
            <table className="w-full border-collapse text-left text-[13px]">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
        th: ({ children }) => (
          <th className="px-3 py-2 font-medium text-muted">{children}</th>
        ),
        td: ({ children }) => <td className="border-b border-line/50 px-3 py-2">{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
})
